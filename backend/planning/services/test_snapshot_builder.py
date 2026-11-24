
from datetime import date, datetime, time, timezone
from decimal import Decimal
from types import SimpleNamespace as NS
from unittest import TestCase

from django.core.exceptions import ValidationError

from demands.models import SupplierConfirmation
from planning.services.plan_guard import (
    FAIL,
    NOT_EVALUATED,
    PASS,
    PlanGuardEvidence,
)
from planning.services.snapshot_builder import build_demand_snapshots


CAPTURED_AT = datetime(2026, 11, 17, 10, 0, tzinfo=timezone.utc)


class FakeRelatedManager:
    def __init__(self, records=()):
        self.records = tuple(records)

    def all(self):
        return self.records


class FakePlanGuardSource:
    source_name = "TEST_FULFILLMENT_PLAN"

    def __init__(self, results):
        self.results = results
        self.calls = []

    def capture(self, *, demand_ids, captured_at):
        self.calls.append((demand_ids, captured_at))
        return self.results


def make_demand(demand_id):
    item = NS(
        pk=301,
        item_code="ITEM-001",
        item_name="Test item",
        cargo_category_id=1,
        cargo_category=NS(
            pk=1,
            category_code="TEST",
            is_active=True,
        ),
        weight_unit="KG",
        is_active=True,
    )

    demand_item = NS(
        pk=400 + demand_id,
        demand_id=demand_id,
        item_id=301,
        required_weight_kg=Decimal("10"),
        unit_of_measure="KG",
        item=item,
    )

    return NS(
        pk=demand_id,
        demand_code=f"DD-{demand_id}",
        supplier_id=201,
        outlet_id=100 + demand_id,
        cargo_category_id=1,
        cargo_category=NS(
            pk=1,
            category_code="TEST",
            is_active=True,
        ),
        supplier=NS(
            pk=201,
            is_active=True,
        ),
        outlet=NS(
            pk=100 + demand_id,
            outlet_code=f"OUTLET-{demand_id}",
            is_active=True,
        ),
        quantity_kg=Decimal("10"),
        requested_date=date(2026, 12, 1),
        requested_start_time=time(8, 0),
        requested_end_time=time(12, 0),
        status="SUBMITTED",
        items=FakeRelatedManager([demand_item]),
        supplier_confirmations=FakeRelatedManager(),
    )


def make_orm_data(*demand_ids):
    selected_demands = tuple(
        make_demand(i) for i in demand_ids
    )

    return NS(
        selected_demands=selected_demands,
        capacity_demands=tuple(
            make_demand(i) for i in demand_ids
        ),
        supplier_items=(
            NS(
                pk=501,
                supplier_id=201,
                item_id=301,
                unit_price_vnd_per_kg=Decimal("1000"),
                max_daily_supply_kg=Decimal("100"),
                lead_time_hours=2,
                minimum_order_kg=Decimal("1"),
                offer_status="ACTIVE",
            ),
        ),
        capacity_requests=(),
        capacity_supplier_items=(),
    )


class SnapshotBuilderPlanGuardTests(TestCase):

    def test_unavailable_source_is_not_evaluated(self):
        snapshots = build_demand_snapshots(
            make_orm_data(101),
            captured_at=CAPTURED_AT,
        )

        evidence = snapshots[101]["gate_evidence"]["plan_guard"]

        self.assertEqual(evidence["status"], "NOT_EVALUATED")
        self.assertEqual(
            evidence["source_system"],
            "FULFILLMENT_PLAN",
        )
        self.assertIsNone(evidence["evaluated_at"])
        self.assertIsNone(evidence["evidence_reference"])

        self.assertNotIn(
            "plan_guard",
            snapshots[101]["related_records"],
        )

    def test_unverified_source_is_not_used(self):
        source = FakePlanGuardSource({
            101: PlanGuardEvidence(
                query_complete=True,
                has_finalized_plan=False,
            ),
        })

        snapshots = build_demand_snapshots(
            make_orm_data(101),
            captured_at=CAPTURED_AT,
            plan_guard_source=source,
        )

        evidence = snapshots[101]["gate_evidence"]["plan_guard"]

        self.assertEqual(evidence["status"], "NOT_EVALUATED")
        self.assertIsNone(evidence["evaluated_at"])
        self.assertIsNone(evidence["evidence_reference"])

        # Chưa có hợp đồng nguồn chính thức: không gọi adapter.
        self.assertEqual(source.calls, [])

    def test_release_is_validated_before_serializing_the_allow_list(self):
        data = make_orm_data(101)
        confirmation = SupplierConfirmation(
            pk=701, demand_id=101, supplier_id=201, confirmation_status="PARTIAL",
            ready_date=date(2026, 12, 1), recorded_at=CAPTURED_AT,
            commitment_released_at=CAPTURED_AT, commitment_released_by_id=9,
        )
        data.selected_demands[0].supplier_confirmations = FakeRelatedManager([confirmation])

        with self.assertRaisesRegex(ValidationError, "A release note is required"):
            build_demand_snapshots(data, captured_at=CAPTURED_AT)

        confirmation.commitment_release_note = "Supplier release confirmed"
        snapshot = build_demand_snapshots(data, captured_at=CAPTURED_AT)[101]
        captured = next(
            record["values"] for record in snapshot["related_records"]
            if record["source_kind"] == "SUPPLIER_CONFIRMATION"
        )
        self.assertEqual(captured["COMMITMENT_RELEASED_AT"], "2026-11-17T10:00:00Z")
        self.assertNotIn("COMMITMENT_RELEASE_NOTE", captured)

        confirmation.confirmation_status = "CONFIRMED"
        with self.assertRaisesRegex(ValidationError, "Only a PARTIAL"):
            build_demand_snapshots(data, captured_at=CAPTURED_AT)

    def test_multiple_demands_have_separate_plan_guard_envelopes(self):
        snapshots = build_demand_snapshots(
            make_orm_data(101, 102),
            captured_at=CAPTURED_AT,
        )

        self.assertEqual(set(snapshots), {101, 102})

        for demand_id in (101, 102):
            evidence = snapshots[demand_id]["gate_evidence"]["plan_guard"]

            self.assertEqual(evidence["status"], "NOT_EVALUATED")
            self.assertEqual(
                evidence["source_system"],
                "FULFILLMENT_PLAN",
            )
            self.assertIsNone(evidence["evaluated_at"])
            self.assertIsNone(evidence["evidence_reference"])
