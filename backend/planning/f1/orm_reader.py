
"""Read-only ORM loader for F1.

This module performs SELECT queries only. It does not mutate database rows.
"""
from dataclasses import dataclass

from django.core.exceptions import ValidationError
from django.db.models import Prefetch

from demands.models import DeliveryDemand, DemandSourcingOption, SupplierRequest
from masterdata.models import SupplierItem
from planning.services.demand_provenance import known_demo_demands, requires_operational_provenance


@dataclass(frozen=True)
class F1ORMData:
    selected_demands: tuple
    supplier_items: tuple
    capacity_requests: tuple
    capacity_demands: tuple
    capacity_supplier_items: tuple


def _related_rows(instance, relation_name):
    """Return prefetched related rows without imposing business filters."""
    manager = getattr(instance, relation_name, None)
    if manager is None:
        return ()

    all_method = getattr(manager, "all", None)
    if callable(all_method):
        return tuple(all_method())

    try:
        return tuple(manager)
    except TypeError:
        return ()


def load_f1_orm_data(demand_ids) -> F1ORMData:
    """Load selected Demands and all capacity-relevant request history.

    Capacity history includes every Supplier's requests for every Demand
    whose requested_date is represented in the selected Demand set.

    Demand status is deliberately not used to filter capacity context.
    A cancelled or otherwise non-submitted Demand may still carry an
    unreleased Supplier commitment.

    Request-attempt replacement and partial-promise semantics remain the
    responsibility of the Capacity evaluator and its approved contract.
    """
    ids = tuple(sorted({int(value) for value in demand_ids}))

    if not ids:
        return F1ORMData((), (), (), (), ())

    selected = tuple(
        DeliveryDemand.objects
        .filter(pk__in=ids)
        .select_related("supplier", "cargo_category")
        .prefetch_related(
            "items__item",
            "supplier_confirmations",
            Prefetch(
                "items__sourcing_options",
                queryset=DemandSourcingOption.objects.filter(
                    option_type=DemandSourcingOption.OptionType.SELECTED_EXISTING,
                ).order_by("pk"),
                to_attr="f1_selected_sourcing_options",
            ),
        )
        .order_by("pk")
    )

    if not selected:
        return F1ORMData((), (), (), (), ())

    dates = {demand.requested_date for demand in selected}
    if not dates:
        return F1ORMData(selected, (), (), (), ())

    # Load complete Demand context for the relevant dates.
    # Do not filter by Demand.status or PlanningRun membership.
    contexts = {getattr(demand, "capstone_scenario", "") for demand in selected}
    if len(contexts) != 1:
        raise ValidationError("Mixed Capstone and operational Demands.")
    scenario = contexts.pop()
    context_demands = DeliveryDemand.objects.filter(requested_date__in=dates, capstone_scenario=scenario)
    if requires_operational_provenance(scenario):
        context_demands = context_demands.exclude(known_demo_demands())
    capacity_demands = tuple(
        context_demands
        .select_related("supplier", "cargo_category")
        .prefetch_related(
            "items__item",
            "supplier_confirmations",
        )
        .order_by("pk")
    )

    capacity_demand_ids = tuple(
        demand.pk for demand in capacity_demands
    )

    requests = tuple(
        SupplierRequest.objects
        .filter(demand_id__in=capacity_demand_ids)
        .select_related(
            "demand",
            "supplier",
            "supplier_confirmation",
            "supplier_confirmation__demand",
            "supplier_confirmation__supplier",
        )
        .prefetch_related(
            "item_promises__demand_item",
            "item_promises__supplier_item",
        )
        .order_by("demand_id", "attempt_no", "pk")
    )

    # These offers support Eligibility for selected Demands.
    selected_supplier_ids = {
        demand.supplier_id for demand in selected
    }
    selected_item_ids = {
        item.item_id
        for demand in selected
        for item in _related_rows(demand, "items")
    }

    offers = ()
    if selected_supplier_ids and selected_item_ids:
        offers = tuple(
            SupplierItem.objects
            .filter(
                supplier_id__in=selected_supplier_ids,
                item_id__in=selected_item_ids,
            )
            .select_related("supplier", "item")
            .order_by("supplier_id", "item_id")
        )

    # Capacity context must also include SupplierItems referenced by
    # historical Promise rows, including Suppliers outside the selected
    # Demand scope. These relations were prefetched above.
    capacity_supplier_items_by_id = {}

    for request in requests:
        for promise in _related_rows(request, "item_promises"):
            supplier_item = getattr(promise, "supplier_item", None)
            supplier_item_id = getattr(
                promise,
                "supplier_item_id",
                None,
            )

            if supplier_item is not None:
                key = getattr(supplier_item, "pk", supplier_item_id)
                if key is not None:
                    capacity_supplier_items_by_id[key] = supplier_item

    capacity_supplier_items = tuple(
        capacity_supplier_items_by_id[key]
        for key in sorted(capacity_supplier_items_by_id)
    )

    return F1ORMData(
        selected_demands=selected,
        supplier_items=offers,
        capacity_requests=requests,
        capacity_demands=capacity_demands,
        capacity_supplier_items=capacity_supplier_items,
    )
