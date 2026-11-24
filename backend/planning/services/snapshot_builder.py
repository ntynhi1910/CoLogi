
"""Build immutable, JSON-safe CP08 Demand snapshots from F1 ORM data."""

from datetime import date, datetime, time, timezone as datetime_timezone
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.utils import timezone

from planning.f1.adapter import validated_commitment_release
from planning.json_validators import validate_demand_snapshot


SNAPSHOT_SCHEMA_ID = "cologi://cp08/planning-run-demand-snapshot/1.1"
SNAPSHOT_SCHEMA_VERSION = "1.1"
MAX_SNAPSHOT_BYTES = 256 * 1024

MODEL_LABELS = {
    "DEMAND": "demands.DeliveryDemand",
    "DEMAND_ITEM": "demands.DemandItem",
    "DEMAND_SOURCING_OPTION": "demands.DemandSourcingOption",
    "SUPPLIER": "masterdata.Supplier",
    "SUPPLIER_ITEM": "masterdata.SupplierItem",
    "SUPPLIER_REQUEST": "demands.SupplierRequest",
    "SUPPLIER_CONFIRMATION": "demands.SupplierConfirmation",
    "SUPPLIER_ITEM_PROMISE": "demands.SupplierItemPromise",
    "ITEM": "masterdata.Item",
    "CARGO_CATEGORY": "masterdata.CargoCategory",
    "OUTLET": "masterdata.Outlet",
    "CAPACITY_DEMAND": "demands.DeliveryDemand",
    "CAPACITY_DEMAND_ITEM": "demands.DemandItem",
    "CAPACITY_SUPPLIER_REQUEST": "demands.SupplierRequest",
    "CAPACITY_SUPPLIER_CONFIRMATION": "demands.SupplierConfirmation",
    "CAPACITY_SUPPLIER_ITEM_PROMISE": "demands.SupplierItemPromise",
    "CAPACITY_SUPPLIER_ITEM": "masterdata.SupplierItem",
}


def _pk(value):
    if value is None:
        return None
    return str(value)


def _decimal(value):
    if value is None:
        return None

    number = Decimal(value)
    if not number.is_finite():
        raise ValidationError("Snapshot Decimal values must be finite.")

    return str(number)


def _date(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        raise ValidationError("Expected DATE, received DATETIME.")
    return value.isoformat()


def _time(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        raise ValidationError("Expected TIME, received DATETIME.")
    return value.isoformat()


def _timestamp(value):
    if value is None:
        return None

    if timezone.is_naive(value):
        raise ValidationError("Snapshot timestamps must be timezone-aware.")

    return (
        value.astimezone(datetime_timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _captured_timestamp(value):
    if value is None:
        value = timezone.now()
    return _timestamp(value)


def _record(source_kind, pk, values):
    model_label = MODEL_LABELS.get(source_kind)
    if model_label is None:
        raise ValidationError(
            f"Unregistered snapshot source_kind: {source_kind}"
        )

    return {
        "source_kind": source_kind,
        "model_label": model_label,
        "pk": _pk(pk),
        "values": values,
    }


def _demand_values(demand):
    return {
        "DEMAND_CODE": demand.demand_code,
        "SUPPLIER_ID": _pk(demand.supplier_id),
        "OUTLET_ID": _pk(demand.outlet_id),
        "CARGO_CATEGORY_ID": _pk(demand.cargo_category_id),
        "QUANTITY_KG": _decimal(demand.quantity_kg),
        "REQUESTED_DATE": _date(demand.requested_date),
        "REQUESTED_START_TIME": _time(
            demand.requested_start_time
        ),
        "REQUESTED_END_TIME": _time(
            demand.requested_end_time
        ),
        "STATUS": demand.status,
    }


def _demand_item_values(demand_item):
    return {
        "DEMAND_ID": _pk(demand_item.demand_id),
        "ITEM_ID": _pk(demand_item.item_id),
        "REQUIRED_WEIGHT_KG": _decimal(
            demand_item.required_weight_kg
        ),
        "UNIT_OF_MEASURE": demand_item.unit_of_measure,
    }


def _supplier_values(supplier):
    return {
        "IS_ACTIVE": supplier.is_active,
    }


def _supplier_item_values(supplier_item):
    return {
        "SUPPLIER_ID": _pk(supplier_item.supplier_id),
        "ITEM_ID": _pk(supplier_item.item_id),
        "OFFER_STATUS": supplier_item.offer_status,
        "UNIT_PRICE_VND_PER_KG": _decimal(
            supplier_item.unit_price_vnd_per_kg
        ),
        "MAX_DAILY_SUPPLY_KG": _decimal(
            supplier_item.max_daily_supply_kg
        ),
        "MINIMUM_ORDER_KG": _decimal(
            supplier_item.minimum_order_kg
        ),
        "LEAD_TIME_HOURS": supplier_item.lead_time_hours,
    }


def _item_values(item):
    return {
        "CARGO_CATEGORY_ID": _pk(item.cargo_category_id),
        "WEIGHT_UNIT": item.weight_unit,
        "IS_ACTIVE": item.is_active,
    }


def _cargo_category_values(category):
    return {
        "CATEGORY_CODE": category.category_code,
        "IS_ACTIVE": category.is_active,
    }


def _outlet_values(outlet):
    return {
        "OUTLET_CODE": outlet.outlet_code,
        "IS_ACTIVE": outlet.is_active,
    }


def _confirmation_values(confirmation, request_status=None):
    validated_commitment_release(confirmation, request_status)
    return {
        "DEMAND_ID": _pk(confirmation.demand_id),
        "SUPPLIER_ID": _pk(confirmation.supplier_id),
        "CONFIRMATION_STATUS": confirmation.confirmation_status,
        "SOURCE_MODE": confirmation.source_mode,
        "READY_DATE": _date(confirmation.ready_date),
        "READY_START_TIME": _time(
            confirmation.ready_start_time
        ),
        "READY_END_TIME": _time(
            confirmation.ready_end_time
        ),
        "PICKUP_ADDRESS": confirmation.pickup_address,
        "RECORDED_AT": _timestamp(confirmation.recorded_at),
        "COMMITMENT_RELEASED_AT": _timestamp(
            confirmation.commitment_released_at
        ),
        "COMMITMENT_RELEASED_BY_ID": _pk(
            confirmation.commitment_released_by_id
        ),
    }


def _request_values(request):
    return {
        "DEMAND_ID": _pk(request.demand_id),
        "SUPPLIER_ID": _pk(request.supplier_id),
        "ATTEMPT_NO": request.attempt_no,
        "REQUEST_STATUS": request.request_status,
        "SUPPLIER_CONFIRMATION_ID": _pk(
            request.supplier_confirmation_id
        ),
        "SENT_AT": _timestamp(request.sent_at),
        "RESPONDED_AT": _timestamp(request.responded_at),
    }


def _promise_values(promise):
    return {
        "SUPPLIER_REQUEST_ID": _pk(
            promise.supplier_request_id
        ),
        "DEMAND_ITEM_ID": _pk(promise.demand_item_id),
        "SUPPLIER_ITEM_ID": _pk(promise.supplier_item_id),
        "PROMISED_WEIGHT_KG": _decimal(
            promise.promised_weight_kg
        ),
        "CONFIRMED_WEIGHT_KG": _decimal(
            promise.confirmed_weight_kg
        ),
        "LINE_STATUS": promise.line_status,
        "UNIT_PRICE_VND_PER_KG_SNAPSHOT": _decimal(
            promise.unit_price_vnd_per_kg_snapshot
        ),
        "LEAD_TIME_HOURS_SNAPSHOT": (
            promise.lead_time_hours_snapshot
        ),
    }


def _related_rows(instance, relation_name):
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


def _add_record(records, source_kind, instance, values):
    if instance is None:
        raise ValidationError(
            f"Missing related object for {source_kind}."
        )

    records.append(
        _record(source_kind, instance.pk, values)
    )


def _add_demand_records(
    records,
    demand,
    *,
    capacity=False,
):
    prefix = "CAPACITY_" if capacity else ""

    _add_record(
        records,
        f"{prefix}DEMAND",
        demand,
        _demand_values(demand),
    )

    _add_record(
        records,
        "SUPPLIER",
        demand.supplier,
        _supplier_values(demand.supplier),
    )

    _add_record(
        records,
        "CARGO_CATEGORY",
        demand.cargo_category,
        _cargo_category_values(demand.cargo_category),
    )

    _add_record(
        records,
        "OUTLET",
        demand.outlet,
        _outlet_values(demand.outlet),
    )

    for demand_item in _related_rows(demand, "items"):
        _add_record(
            records,
            f"{prefix}DEMAND_ITEM",
            demand_item,
            _demand_item_values(demand_item),
        )

        item = demand_item.item
        _add_record(
            records,
            "ITEM",
            item,
            _item_values(item),
        )

        _add_record(
            records,
            "CARGO_CATEGORY",
            item.cargo_category,
            _cargo_category_values(item.cargo_category),
        )


def _add_confirmation_record(
    records,
    confirmation,
    *,
    capacity=False,
    request_status=None,
):
    source_kind = (
        "CAPACITY_SUPPLIER_CONFIRMATION"
        if capacity
        else "SUPPLIER_CONFIRMATION"
    )
    _add_record(
        records,
        source_kind,
        confirmation,
        _confirmation_values(confirmation, request_status),
    )


def _add_request_records(records, request, *, capacity=False):
    request_kind = (
        "CAPACITY_SUPPLIER_REQUEST"
        if capacity
        else "SUPPLIER_REQUEST"
    )
    promise_kind = (
        "CAPACITY_SUPPLIER_ITEM_PROMISE"
        if capacity
        else "SUPPLIER_ITEM_PROMISE"
    )
    supplier_item_kind = (
        "CAPACITY_SUPPLIER_ITEM"
        if capacity
        else "SUPPLIER_ITEM"
    )

    _add_record(
        records,
        request_kind,
        request,
        _request_values(request),
    )

    confirmation = request.supplier_confirmation
    if confirmation is not None:
        _add_confirmation_record(
            records,
            confirmation,
            capacity=capacity,
            request_status=request.request_status,
        )
    elif request.supplier_confirmation_id is not None:
        raise ValidationError(
            "REQUEST_CONFIRMATION_RELATION_INCONSISTENT"
        )

    for promise in _related_rows(request, "item_promises"):
        _add_record(
            records,
            promise_kind,
            promise,
            _promise_values(promise),
        )

        supplier_item = promise.supplier_item
        _add_record(
            records,
            supplier_item_kind,
            supplier_item,
            _supplier_item_values(supplier_item),
        )

        demand_item = promise.demand_item
        _add_record(
            records,
            "CAPACITY_DEMAND_ITEM" if capacity else "DEMAND_ITEM",
            demand_item,
            _demand_item_values(demand_item),
        )

        item = demand_item.item
        _add_record(
            records,
            "ITEM",
            item,
            _item_values(item),
        )

        _add_record(
            records,
            "CARGO_CATEGORY",
            item.cargo_category,
            _cargo_category_values(item.cargo_category),
        )



def _canonicalize_records(records):
    """Deduplicate identical records and sort deterministically."""
    unique = {}

    for record in records:
        key = (
            record["source_kind"],
            record["model_label"],
            record["pk"],
        )

        existing = unique.get(key)
        if existing is not None and existing != record:
            raise ValidationError(
                "SNAPSHOT_RECORD_CONFLICT:"
                f"{record['source_kind']}:{record['pk']}"
            )

        unique[key] = record

    return [
        unique[key]
        for key in sorted(unique)
    ]



def _plan_guard_not_evaluated():
    return {
        "status": "NOT_EVALUATED",
        "source_system": "FULFILLMENT_PLAN",
        "evaluated_at": None,
        "evidence_reference": None,
    }


def build_demand_snapshots(
    orm_data,
    captured_at=None,
    *,
    plan_guard_source=None,
    plan_guard_evidence=None,
):
    """Return {selected_demand_id: schema-1.1 snapshot}; read-only."""
    captured_at_value = _captured_timestamp(captured_at)
    plan_guard_evidence = plan_guard_evidence or {}

    selected_demands = tuple(orm_data.selected_demands)
    capacity_demands = tuple(
        getattr(orm_data, "capacity_demands", ())
    )
    capacity_requests = tuple(orm_data.capacity_requests)

    # Capacity source data must be complete for every date represented
    # by the selected Demand scope.
    if selected_demands and not capacity_demands:
        raise ValidationError(
            "CAPACITY_CONTEXT_DEMANDS_MISSING"
        )

    selected_ids = {demand.pk for demand in selected_demands}
    capacity_ids = {demand.pk for demand in capacity_demands}

    if not selected_ids.issubset(capacity_ids):
        raise ValidationError(
            "CAPACITY_CONTEXT_MISSING_SELECTED_DEMAND"
        )

    snapshots = {}

    for demand in selected_demands:
        records = []

        # Selected Demand and its direct eligibility inputs.
        _add_demand_records(records, demand, capacity=False)
        for item in _related_rows(demand, "items"):
            for option in getattr(item, "f1_selected_sourcing_options", ()):
                _add_record(records, "DEMAND_SOURCING_OPTION", option, {
                    "DEMAND_ITEM_ID": _pk(option.demand_item_id),
                    "SUPPLIER_ITEM_ID": _pk(option.supplier_item_id),
                    "OPTION_TYPE": option.option_type,
                    "EVALUATION_STATUS": option.evaluation_status,
                    "EXCLUSION_REASON_PRESENT": bool(option.exclusion_reason.strip()),
                })

        # Selected Demand confirmations are included independently of
        # request history. Request-linked confirmations are also captured
        # with their Request record.
        for confirmation in _related_rows(
            demand,
            "supplier_confirmations",
        ):
            _add_confirmation_record(
                records,
                confirmation,
                capacity=False,
            )

        # Selected-scope SupplierItem offers are kept separate from
        # Capacity SupplierItems.
        selected_item_ids = {
            item.item_id
            for item in _related_rows(demand, "items")
        }

        for offer in orm_data.supplier_items:
            if (
                offer.supplier_id == demand.supplier_id
                and offer.item_id in selected_item_ids
            ):
                _add_record(
                    records,
                    "SUPPLIER_ITEM",
                    offer,
                    _supplier_item_values(offer),
                )

        # Complete date-scoped Capacity Demand context.
        for capacity_demand in capacity_demands:
            if (
                capacity_demand.requested_date
                == demand.requested_date
            ):
                _add_demand_records(
                    records,
                    capacity_demand,
                    capacity=True,
                )

        # All Requests loaded for the represented dates; no Supplier
        # filter and no Demand-status filter.
        for request in capacity_requests:
            if (
                request.demand.requested_date
                == demand.requested_date
            ):
                _add_request_records(
                    records,
                    request,
                    capacity=True,
                )

        # Preserve the Promise-referenced SupplierItems returned by the
        # ORM loader, even if a particular relation is not reached through
        # a duplicate traversal above.
        for supplier_item in getattr(
            orm_data,
            "capacity_supplier_items",
            (),
        ):
            if supplier_item.pk not in {
                record["pk"]
                for record in records
                if record["source_kind"] == "CAPACITY_SUPPLIER_ITEM"
            }:
                _add_record(
                    records,
                    "CAPACITY_SUPPLIER_ITEM",
                    supplier_item,
                    _supplier_item_values(supplier_item),
                )

        snapshot = {
            "$id": SNAPSHOT_SCHEMA_ID,
            "schema_version": SNAPSHOT_SCHEMA_VERSION,
            "captured_at": captured_at_value,
            "demand_ref": {
                "model_label": "demands.DeliveryDemand",
                "pk": _pk(demand.pk),
            },
            "demand_values": _demand_values(demand),
            "gate_evidence": {
                "plan_guard": plan_guard_evidence.get(demand.pk) or _plan_guard_not_evaluated(),
            },
            "related_records": _canonicalize_records(records),
        }

        validate_demand_snapshot(snapshot)
        snapshots[demand.pk] = snapshot

    return snapshots
