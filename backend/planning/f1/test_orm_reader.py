
import os
from datetime import date
from types import SimpleNamespace as NS
import pytest

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

import django
from django.apps import apps

if not apps.ready:
    django.setup()

import planning.f1.orm_reader as reader


class FakeQuerySet:
    def __init__(self, rows=()):
        self.rows = tuple(rows)
        self.calls = []

    def select_related(self, *fields):
        self.calls.append(("select_related", fields))
        return self

    def prefetch_related(self, *fields):
        self.calls.append(("prefetch_related", fields))
        return self

    def order_by(self, *fields):
        self.calls.append(("order_by", fields))
        return self

    def __iter__(self):
        return iter(self.rows)


class FakeManager:
    def __init__(self, querysets=()):
        self.querysets = list(querysets)
        self.filters = []

    def filter(self, **kwargs):
        self.filters.append(kwargs)
        if not self.querysets:
            raise AssertionError("Unexpected manager.filter() call")
        return self.querysets.pop(0)


def make_demand(pk, supplier_id, item_ids, requested_date, status="SUBMITTED"):
    items = [NS(item_id=item_id) for item_id in item_ids]
    return NS(
        pk=pk,
        supplier_id=supplier_id,
        requested_date=requested_date,
        status=status,
        items=NS(all=lambda: items),
    )


def make_request(pk, supplier_id, promises=()):
    return NS(
        pk=pk,
        supplier_id=supplier_id,
        item_promises=NS(all=lambda: tuple(promises)),
    )


def test_empty_demand_ids_performs_no_queries(monkeypatch):
    delivery_manager = FakeManager()
    request_manager = FakeManager()
    supplier_item_manager = FakeManager()

    monkeypatch.setattr(reader, "DeliveryDemand", NS(objects=delivery_manager))
    monkeypatch.setattr(reader, "SupplierRequest", NS(objects=request_manager))
    monkeypatch.setattr(reader, "SupplierItem", NS(objects=supplier_item_manager))

    result = reader.load_f1_orm_data([])

    assert result.selected_demands == ()
    assert result.supplier_items == ()
    assert result.capacity_requests == ()
    assert result.capacity_demands == ()
    assert result.capacity_supplier_items == ()
    assert delivery_manager.filters == []
    assert request_manager.filters == []
    assert supplier_item_manager.filters == []


def test_no_selected_demands_stops_after_initial_select(monkeypatch):
    selected_qs = FakeQuerySet()
    delivery_manager = FakeManager([selected_qs])
    request_manager = FakeManager()
    supplier_item_manager = FakeManager()

    monkeypatch.setattr(reader, "DeliveryDemand", NS(objects=delivery_manager))
    monkeypatch.setattr(reader, "SupplierRequest", NS(objects=request_manager))
    monkeypatch.setattr(reader, "SupplierItem", NS(objects=supplier_item_manager))

    result = reader.load_f1_orm_data([5, 2, 5])

    assert result.selected_demands == ()
    assert result.supplier_items == ()
    assert result.capacity_requests == ()
    assert result.capacity_demands == ()
    assert result.capacity_supplier_items == ()
    assert delivery_manager.filters == [{"pk__in": (2, 5)}]
    assert request_manager.filters == []
    assert supplier_item_manager.filters == []
    prefetch = next(fields for operation, fields in selected_qs.calls if operation == "prefetch_related")
    assert prefetch[:2] == ("items__item", "supplier_confirmations")
    assert prefetch[2].prefetch_through == "items__sourcing_options"
    assert prefetch[2].to_attr == "f1_selected_sourcing_options"
    assert ("order_by", ("pk",)) in selected_qs.calls


@pytest.mark.parametrize("scenario", ["", "v7-supplement-v1"])
def test_reader_loads_full_capacity_context_without_status_filter(monkeypatch, scenario):
    day = date(2026, 11, 20)

    selected_1 = make_demand(1, 10, [101, 102], day)
    selected_2 = make_demand(2, 20, [103], day)

    # Demand 3 is outside the selected scope and CANCELLED.
    # It must remain in Capacity Context.
    outside_cancelled = make_demand(
        3, 30, [104], day, status="CANCELLED"
    )
    outside_draft = make_demand(
        4, 40, [105], day, status="DRAFT"
    )
    for demand in (selected_1, selected_2, outside_cancelled, outside_draft):
        demand.capstone_scenario = scenario

    selected_qs = FakeQuerySet([selected_1, selected_2])
    capacity_demands_qs = FakeQuerySet([
        selected_1,
        selected_2,
        outside_cancelled,
        outside_draft,
    ])
    delivery_manager = FakeManager([
        selected_qs,
        capacity_demands_qs,
    ])

    capacity_supplier_item_1 = NS(
        pk=901, supplier_id=30, item_id=104
    )
    capacity_supplier_item_2 = NS(
        pk=902, supplier_id=40, item_id=105
    )

    promise_1 = NS(
        supplier_item_id=901,
        supplier_item=capacity_supplier_item_1,
    )
    promise_2 = NS(
        supplier_item_id=902,
        supplier_item=capacity_supplier_item_2,
    )

    request_rows = [
        make_request(501, 10),
        make_request(502, 20),
        make_request(503, 30, [promise_1]),
        make_request(504, 40, [promise_2]),
    ]
    request_qs = FakeQuerySet(request_rows)
    request_manager = FakeManager([request_qs])

    offer_rows = [
        NS(pk=801, supplier_id=10, item_id=101),
        NS(pk=802, supplier_id=20, item_id=103),
    ]
    offer_qs = FakeQuerySet(offer_rows)
    supplier_item_manager = FakeManager([offer_qs])

    monkeypatch.setattr(reader, "DeliveryDemand", NS(objects=delivery_manager))
    monkeypatch.setattr(reader, "SupplierRequest", NS(objects=request_manager))
    monkeypatch.setattr(reader, "SupplierItem", NS(objects=supplier_item_manager))

    result = reader.load_f1_orm_data([2, 1, 2])

    assert result.selected_demands == (selected_1, selected_2)
    assert result.capacity_demands == (
        selected_1,
        selected_2,
        outside_cancelled,
        outside_draft,
    )
    assert result.capacity_requests == tuple(request_rows)
    assert result.supplier_items == tuple(offer_rows)
    assert result.capacity_supplier_items == (
        capacity_supplier_item_1,
        capacity_supplier_item_2,
    )

    assert delivery_manager.filters == [
        {"pk__in": (1, 2)},
        {"requested_date__in": {day}, "capstone_scenario": scenario},
    ]

    # Capacity request history includes every Supplier for all matching
    # Demand dates, including Demand outside the selected PlanningRun.
    assert request_manager.filters == [
        {"demand_id__in": (1, 2, 3, 4)},
    ]

    assert (
        "select_related",
        (
            "demand",
            "supplier",
            "supplier_confirmation",
            "supplier_confirmation__demand",
            "supplier_confirmation__supplier",
        ),
    ) in request_qs.calls

    assert (
        "prefetch_related",
        (
            "item_promises__demand_item",
            "item_promises__supplier_item",
        ),
    ) in request_qs.calls

    assert (
        "order_by",
        ("demand_id", "attempt_no", "pk"),
    ) in request_qs.calls

    assert supplier_item_manager.filters == [
        {
            "supplier_id__in": {10, 20},
            "item_id__in": {101, 102, 103},
        },
    ]

    assert (
        "select_related",
        ("supplier", "item"),
    ) in offer_qs.calls

    assert (
        "order_by",
        ("supplier_id", "item_id"),
    ) in offer_qs.calls
