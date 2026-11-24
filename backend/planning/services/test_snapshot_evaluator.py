from copy import deepcopy
from datetime import date
from decimal import Decimal
from unittest import TestCase
from django.core.exceptions import ValidationError

from planning.f1.eligibility import (
    EligibilityBlocker,
    EligibilityStatus,
)
from planning.f1.supplier_confirmation import ConfirmationGateStatus
from planning.services.snapshot_evaluator import evaluate_f1_snapshots

from planning.services.snapshot_reader import (
    read_demand_snapshot,
    read_run_snapshots,
)
class SnapshotEvaluatorTests(TestCase):
    DELIVERY_DATE = "2026-12-01"

    def make_request(
        self,
        *,
        request_id=601,
        demand_id=1,
        supplier_id=201,
        attempt_no=1,
        demand_item_id=401,
        item_id=301,
        supplier_item_id=None,
        confirmed_weight="10",
        promised_weight="10",
        request_status="RESPONDED",
        confirmation_status="CONFIRMED",
        commitment_released=False,
        line_status="CONFIRMED",
        supplier_item_supplier_id=None,
        supplier_item_item_id=None,
    ):
        if supplier_item_id is None:
            supplier_item_id = 500 + supplier_id
        return {
            "id": request_id,
            "demand_id": demand_id,
            "requested_date": self.DELIVERY_DATE,
            "demand_status": "SUBMITTED",
            "supplier_id": supplier_id,
            "attempt_no": attempt_no,
            "request_status": request_status,
            "confirmation": {
                "id": request_id + 1000,
                "demand_id": demand_id,
                "supplier_id": supplier_id,
                "confirmation_status": confirmation_status,
                "commitment_released": commitment_released,
            },
            "promises": [
                {
                    "id": request_id + 2000,
                    "supplier_request_id": request_id,
                    "demand_item_id": demand_item_id,
                    "demand_item_demand_id": demand_id,
                    "supplier_item_id": supplier_item_id,
                    "item_id": item_id,
                    "promised_weight_kg": promised_weight,
                    "confirmed_weight_kg": confirmed_weight,
                    "line_status": line_status,
                    "supplier_item_supplier_id": (
                        supplier_item_supplier_id
                        if supplier_item_supplier_id is not None
                        else supplier_id
                    ),
                    "supplier_item_item_id": (
                        supplier_item_item_id
                        if supplier_item_item_id is not None
                        else item_id
                    ),
                }
            ],
        }

    def make_demand(
        self,
        demand_id=1,
        outlet_id=101,
        quantity="10",
        start_time="09:00:00",
        end_time="11:00:00",
        max_daily_supply="100",
        request_list=None,
    ):
        request_list = request_list or []
        item_id = 301
        demand_item_id = 400 + demand_id
        supplier_id = 201
        requested_date = "2026-12-01"

        records = {}

        def add(kind, pk, values):
            labels = {
                "DEMAND": "demands.DeliveryDemand",
                "DEMAND_ITEM": "demands.DemandItem",
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
            record = {
                "source_kind": kind,
                "model_label": labels[kind],
                "pk": str(pk),
                "values": values,
            }
            key = (kind, str(pk))
            if key in records and records[key] != record:
                raise AssertionError(f"Conflicting test fixture record: {key}")
            records[key] = record

        def demand_values(code, supplier, outlet, qty, status="SUBMITTED"):
            return {
                "DEMAND_CODE": code,
                "SUPPLIER_ID": str(supplier),
                "OUTLET_ID": str(outlet),
                "CARGO_CATEGORY_ID": "1",
                "QUANTITY_KG": str(qty),
                "REQUESTED_DATE": requested_date,
                "REQUESTED_START_TIME": start_time,
                "REQUESTED_END_TIME": end_time,
                "STATUS": status,
            }

        # Selected Demand and its eligibility context.
        selected_values = demand_values(
            f"DM-{demand_id:04d}",
            supplier_id,
            outlet_id,
            quantity,
        )

        add("DEMAND", demand_id, selected_values)
        add("SUPPLIER", supplier_id, {"IS_ACTIVE": True})
        add(
            "CARGO_CATEGORY",
            1,
            {"CATEGORY_CODE": "TEST", "IS_ACTIVE": True},
        )
        add(
            "OUTLET",
            outlet_id,
            {"OUTLET_CODE": f"OUT-{outlet_id}", "IS_ACTIVE": True},
        )

        add(
            "DEMAND_ITEM",
            demand_item_id,
            {
                "DEMAND_ID": str(demand_id),
                "ITEM_ID": str(item_id),
                "REQUIRED_WEIGHT_KG": str(quantity),
                "UNIT_OF_MEASURE": "KG",
            },
        )
        add(
            "ITEM",
            item_id,
            {
                "CARGO_CATEGORY_ID": "1",
                "WEIGHT_UNIT": "KG",
                "IS_ACTIVE": True,
            },
        )

        supplier_item_values = {
            "SUPPLIER_ID": str(supplier_id),
            "ITEM_ID": str(item_id),
            "OFFER_STATUS": "ACTIVE",
            "UNIT_PRICE_VND_PER_KG": "1000",
            "MAX_DAILY_SUPPLY_KG": None if max_daily_supply is None else str(max_daily_supply),
            "MINIMUM_ORDER_KG": "1",
            "LEAD_TIME_HOURS": 2,
        }
        add("SUPPLIER_ITEM", 501, supplier_item_values)

        # The selected Demand is also part of the date-scoped Capacity context.
        add("CAPACITY_DEMAND", demand_id, selected_values)
        add(
            "CAPACITY_DEMAND_ITEM",
            demand_item_id,
            {
                "DEMAND_ID": str(demand_id),
                "ITEM_ID": str(item_id),
                "REQUIRED_WEIGHT_KG": str(quantity),
                "UNIT_OF_MEASURE": "KG",
            },
        )

        # Flatten the complete date-scoped Request / Confirmation / Promise data.
        for request in request_list:
            request_id = request["id"]
            request_demand_id = request["demand_id"]
            request_supplier_id = request["supplier_id"]
            confirmation = request["confirmation"]
            confirmation_id = confirmation["id"]

            request_promises = request["promises"]

            # Create the Capacity Demand referenced by this Request.
            if request_demand_id != demand_id:
                first_promise_weight = (
                    request_promises[0]["promised_weight_kg"]
                    if request_promises
                    else "10"
                )
                add(
                    "CAPACITY_DEMAND",
                    request_demand_id,
                    demand_values(
                        f"DM-{request_demand_id:04d}",
                        request_supplier_id,
                        100 + request_demand_id,
                        first_promise_weight,
                        request.get("demand_status", "SUBMITTED"),
                    ),
                )

            add(
                "CAPACITY_SUPPLIER_REQUEST",
                request_id,
                {
                    "DEMAND_ID": str(request_demand_id),
                    "SUPPLIER_ID": str(request_supplier_id),
                    "ATTEMPT_NO": request["attempt_no"],
                    "REQUEST_STATUS": request["request_status"],
                    "SUPPLIER_CONFIRMATION_ID": str(confirmation_id),
                    "SENT_AT": None,
                    "RESPONDED_AT": None,
                },
            )

            add(
                "CAPACITY_SUPPLIER_CONFIRMATION",
                confirmation_id,
                {
                    "DEMAND_ID": str(confirmation["demand_id"]),
                    "SUPPLIER_ID": str(confirmation["supplier_id"]),
                    "CONFIRMATION_STATUS": confirmation["confirmation_status"],
                    "SOURCE_MODE": "MANUAL",
                    "READY_DATE": requested_date,
                    "READY_START_TIME": start_time,
                    "READY_END_TIME": end_time,
                    "PICKUP_ADDRESS": "Test pickup address",
                    "RECORDED_AT": "2026-11-17T08:00:00Z",
                    "COMMITMENT_RELEASED_AT": (
                        "2026-11-17T08:00:00Z"
                        if confirmation["commitment_released"]
                        else None
                    ),
                    "COMMITMENT_RELEASED_BY_ID": None,
                },
            )

            for promise in request_promises:
                promise_demand_item_id = promise["demand_item_id"]
                promise_demand_id = promise["demand_item_demand_id"]
                promise_item_id = promise["item_id"]
                promise_supplier_item_id = promise["supplier_item_id"]

                required_weight = promise["promised_weight_kg"]

                add(
                    "CAPACITY_DEMAND_ITEM",
                    promise_demand_item_id,
                    {
                        "DEMAND_ID": str(promise_demand_id),
                        "ITEM_ID": str(promise_item_id),
                        "REQUIRED_WEIGHT_KG": str(required_weight),
                        "UNIT_OF_MEASURE": "KG",
                    },
                )

                capacity_supplier_item_values = {
                    "SUPPLIER_ID": str(
                        promise["supplier_item_supplier_id"]
                    ),
                    "ITEM_ID": str(
                        promise["supplier_item_item_id"]
                    ),
                    "OFFER_STATUS": "ACTIVE",
                    "UNIT_PRICE_VND_PER_KG": "1000",
                    "MAX_DAILY_SUPPLY_KG": None if max_daily_supply is None else str(max_daily_supply),
                    "MINIMUM_ORDER_KG": "1",
                    "LEAD_TIME_HOURS": 2,
                }
                add(
                    "CAPACITY_SUPPLIER_ITEM",
                    promise_supplier_item_id,
                    capacity_supplier_item_values,
                )

                add(
                    "CAPACITY_SUPPLIER_ITEM_PROMISE",
                    promise["id"],
                    {
                        "SUPPLIER_REQUEST_ID": str(request_id),
                        "DEMAND_ITEM_ID": str(promise_demand_item_id),
                        "SUPPLIER_ITEM_ID": str(promise_supplier_item_id),
                        "PROMISED_WEIGHT_KG": str(
                            promise["promised_weight_kg"]
                        ),
                        "CONFIRMED_WEIGHT_KG": str(
                            promise["confirmed_weight_kg"]
                        ),
                        "LINE_STATUS": promise["line_status"],
                        "UNIT_PRICE_VND_PER_KG_SNAPSHOT": "1000",
                        "LEAD_TIME_HOURS_SNAPSHOT": 2,
                    },
                )

        return {
            "$id": "cologi://cp08/planning-run-demand-snapshot/1.1",
            "schema_version": "1.1",
            "captured_at": "2026-11-17T01:00:00Z",
            "demand_ref": {
                "model_label": "demands.DeliveryDemand",
                "pk": str(demand_id),
            },
            "demand_values": selected_values,
            "gate_evidence": {
                "plan_guard": {
                    "status": "NOT_EVALUATED",
                    "source_system": "FULFILLMENT_PLAN",
                    "evaluated_at": None,
                    "evidence_reference": None,
                },
            },
            "related_records": [
                records[key]
                for key in sorted(records)
            ],
        }

    @staticmethod
    def valid_cargo_compatibility_rows():
        from planning.f1.cargo_compatibility import (
            dataset_v7_cargo_compatibility_rows,
        )

        return dataset_v7_cargo_compatibility_rows()

    def evaluate(self, *demands):
        return evaluate_f1_snapshots(
            demands,
            cargo_compatibility_rows=self.valid_cargo_compatibility_rows(),
        )

    def test_valid_snapshot_is_eligible(self):
        request = self.make_request()
        demand = self.make_demand(request_list=[request])

        result = self.evaluate(demand)

        self.assertEqual(len(result.demand_evaluations), 1)
        evaluation = result.demand_evaluations[0]

        self.assertEqual(evaluation.demand_id, 1)
        self.assertEqual(
            evaluation.eligibility.eligibility_status,
            EligibilityStatus.ELIGIBLE,
        )
        self.assertEqual(result.candidate_groups, ())

    def test_missing_request_is_not_responded(self):
        snapshot = self.make_demand(
            demand_id=1,
            request_list=[],
        )

        result = evaluate_f1_snapshots(
            [snapshot],
            cargo_compatibility_rows=self.valid_cargo_compatibility_rows(),
        )
        eligibility = result.demand_evaluations[0].eligibility

        self.assertEqual(
            eligibility.eligibility_status,
            EligibilityStatus.EXCLUDED,
        )
        self.assertIn(
            EligibilityBlocker.SUPPLIER_CONFIRMATION_FAILED,
            eligibility.blockers,
        )


    def test_latest_request_supersedes_older_request_globally(self):
        older_request = self.make_request(
            request_id=601,
            demand_id=1,
            supplier_id=201,
            attempt_no=1,
        )
        newer_request = self.make_request(
            request_id=602,
            demand_id=1,
            supplier_id=202,
            attempt_no=2,
        )

        snapshot = self.make_demand(
            demand_id=1,
            request_list=[older_request, newer_request],
        )   

        result = evaluate_f1_snapshots(
            [snapshot],
            cargo_compatibility_rows=self.valid_cargo_compatibility_rows(),
        )
        eligibility = result.demand_evaluations[0].eligibility

        self.assertEqual(
            eligibility.eligibility_status,
            EligibilityStatus.EXCLUDED,
        )
        self.assertIn(
            EligibilityBlocker.SUPPLIER_CONFIRMATION_FAILED,
            eligibility.blockers,
        )

    def test_out_of_scope_demand_commitment_consumes_capacity(self):
        selected_request = self.make_request(
            request_id=601,
            demand_id=1,
            demand_item_id=401,
            supplier_item_id=501,
            confirmed_weight="10",
        )
        outside_request = self.make_request(
            request_id=602,
            demand_id=2,
            demand_item_id=402,
            supplier_item_id=501,
            confirmed_weight="20",
            promised_weight="20",
        )

        selected_demand = self.make_demand(
            demand_id=1,
            request_list=[selected_request, outside_request],
            max_daily_supply="25",
        )

        result = self.evaluate(selected_demand)
        eligibility = result.demand_evaluations[0].eligibility

        self.assertEqual(
            eligibility.eligibility_status,
            EligibilityStatus.EXCLUDED,
        )

    def test_outside_cancelled_partial_survives_waiting_retry_and_blocks_bucket(self):
        selected = self.make_request(supplier_item_id=501)
        historical = self.make_request(
            request_id=602, demand_id=2, demand_item_id=402,
            supplier_item_id=501, confirmed_weight="5",
            confirmation_status="PARTIAL", line_status="PARTIAL",
        )
        retry = self.make_request(
            request_id=603, demand_id=2, demand_item_id=402, attempt_no=2,
            supplier_item_id=501, request_status="WAITING",
            confirmation_status="PENDING", line_status="PENDING", confirmed_weight="0",
        )
        for request in (historical, retry):
            request["demand_status"] = "CANCELLED"
        demand = self.make_demand(request_list=[selected, historical, retry], max_daily_supply="14")

        result = self.evaluate(demand)
        self.assertEqual([row.demand_id for row in result.demand_evaluations], [1])
        self.assertEqual(result.demand_evaluations[0].eligibility.blockers, (EligibilityBlocker.CAPACITY_EXCEEDED,))
        self.assertEqual(result.candidate_groups, ())

    def test_null_cap_blocks_demand_with_fulfilled_promise(self):
        demand = self.make_demand(
            request_list=[self.make_request(supplier_item_id=501)], max_daily_supply=None,
        )
        result = self.evaluate(demand)
        self.assertEqual(result.demand_evaluations[0].eligibility.blockers, (EligibilityBlocker.CAPACITY_UNVERIFIED,))
        self.assertIsNone(result.demand_evaluations[0].eligibility.primary_reason_code)

    def test_selected_sourcing_option_is_optional_and_validated_when_present(self):
        snapshot = self.make_demand(request_list=[self.make_request(supplier_item_id=501)])
        self.assertEqual(self.evaluate(snapshot).demand_evaluations[0].eligibility.eligibility_status, EligibilityStatus.ELIGIBLE)
        option = {
            "source_kind": "DEMAND_SOURCING_OPTION", "model_label": "demands.DemandSourcingOption", "pk": "701",
            "values": {
                "DEMAND_ITEM_ID": "401", "SUPPLIER_ITEM_ID": "501",
                "OPTION_TYPE": "SELECTED_EXISTING", "EVALUATION_STATUS": "INELIGIBLE", "EXCLUSION_REASON_PRESENT": False,
            },
        }
        snapshot["related_records"].append(option)
        snapshot["related_records"].sort(key=lambda record: (record["source_kind"], record["model_label"], record["pk"]))
        self.assertEqual(self.evaluate(snapshot).demand_evaluations[0].eligibility.primary_reason_code, "INVALID_SOURCE_ITEM")
        option["values"]["EXCLUSION_REASON_PRESENT"] = True
        self.assertEqual(self.evaluate(snapshot).demand_evaluations[0].eligibility.eligibility_status, EligibilityStatus.ELIGIBLE)

    def test_header_mismatch_leaves_quantity_diagnostic_and_uses_fulfillment_reason(self):
        request = self.make_request(
            supplier_item_id=501, confirmation_status="CONFIRMED",
            line_status="PARTIAL", confirmed_weight="5",
        )
        eligibility = self.evaluate(self.make_demand(request_list=[request])).demand_evaluations[0].eligibility
        self.assertEqual(eligibility.primary_reason_code, "PROMISE_INSUFFICIENT")
        self.assertEqual(set(eligibility.diagnostics), {"PROMISE_LINE_NOT_CONFIRMED", "CONFIRMATION_STATUS_INCONSISTENT"})

    def test_partial_line_does_not_fulfill_demand_with_verified_capacity(self):
        request = self.make_request(
            supplier_item_id=501, confirmation_status="PARTIAL",
            line_status="PARTIAL", confirmed_weight="5",
        )
        result = self.evaluate(self.make_demand(request_list=[request], max_daily_supply="5"))
        self.assertEqual(result.demand_evaluations[0].eligibility.blockers, (EligibilityBlocker.SUPPLIER_CONFIRMATION_FAILED,))

    def test_missing_promise_for_an_active_capacity_demand_is_rejected(self):
        snapshot = self.make_demand(request_list=[self.make_request()])
        items = snapshot["related_records"]
        omitted_promise_item = deepcopy(next(
            item for item in items if item["source_kind"] == "CAPACITY_DEMAND_ITEM"
        ))
        omitted_promise_item["pk"] = "499"
        omitted_promise_item["values"]["ITEM_ID"] = "399"
        items.append(omitted_promise_item)
        items.sort(key=lambda item: (item["source_kind"], item["model_label"], item["pk"]))
        with self.assertRaisesRegex(ValidationError, "incomplete DemandItem Promise coverage"):
            self.evaluate(snapshot)

    def test_released_partial_outside_run_does_not_consume_capacity(self):
        selected = self.make_request(supplier_item_id=501)
        outside = self.make_request(
            request_id=602, demand_id=2, demand_item_id=402,
            supplier_item_id=501, confirmation_status="PARTIAL",
            line_status="PARTIAL", confirmed_weight="5", commitment_released=True,
        )
        demand = self.make_demand(request_list=[selected, outside], max_daily_supply="10")

        result = self.evaluate(demand)

        self.assertEqual(
            result.demand_evaluations[0].eligibility.eligibility_status,
            EligibilityStatus.ELIGIBLE,
        )

    def test_invalid_promise_supplier_link_rejects_capacity_context(self):
        request = self.make_request(
            supplier_item_supplier_id=999,
        )
        demand = self.make_demand(request_list=[request])

        with self.assertRaisesRegex(ValidationError, "invalid DemandItem"):
            self.evaluate(demand)

    def test_two_eligible_demands_generate_candidate_group(self):
        request_1 = self.make_request(
            request_id=601,
            demand_id=1,
            demand_item_id=401,
            supplier_item_id=501,
        )
        request_2 = self.make_request(
            request_id=602,
            demand_id=2,
            demand_item_id=402,
            supplier_item_id=501,
        )

        all_requests = [request_1, request_2]

        demand_1 = self.make_demand(
            demand_id=1,
            outlet_id=101,
            request_list=all_requests,
        )
        demand_2 = self.make_demand(
            demand_id=2,
            outlet_id=102,
            request_list=all_requests,
        )

        result = self.evaluate(demand_1, demand_2)

        self.assertEqual(
            [
                item.eligibility.eligibility_status
                for item in result.demand_evaluations
            ],
            [
                EligibilityStatus.ELIGIBLE,
                EligibilityStatus.ELIGIBLE,
            ],
        )
        self.assertEqual(len(result.candidate_groups), 1)
        self.assertEqual(
            result.candidate_groups[0].demand_ids,
            (1, 2),
        )
    def test_request_without_confirmation_is_readable(self):
        request = self.make_request()
        snapshot = self.make_demand(request_list=[request])

        # Mô phỏng Request chưa có SupplierConfirmation.
        capacity_request = next(
            record
            for record in snapshot["related_records"]
            if record["source_kind"] == "CAPACITY_SUPPLIER_REQUEST"
        )
        confirmation_id = capacity_request["values"][
            "SUPPLIER_CONFIRMATION_ID"
        ]
        capacity_request["values"]["SUPPLIER_CONFIRMATION_ID"] = None

        snapshot["related_records"] = [
            record
            for record in snapshot["related_records"]
            if not (
                record["source_kind"] == "CAPACITY_SUPPLIER_CONFIRMATION"
                and record["pk"] == confirmation_id
            )
        ]

        result = read_demand_snapshot(snapshot)

        capacity_requests = result.related_records["capacity_requests"]
        self.assertEqual(len(capacity_requests), 1)
        self.assertIsNone(capacity_requests[0]["confirmation"])

    def test_run_rejects_duplicate_demand_snapshots(self):
        snapshot = self.make_demand(demand_id=1)

        with self.assertRaises(ValidationError):
            read_run_snapshots([snapshot, deepcopy(snapshot)])

    def test_run_rejects_conflicting_shared_records(self):
        snapshot_1 = self.make_demand(demand_id=1)
        snapshot_2 = self.make_demand(demand_id=2)

        supplier_record = next(
            record
            for record in snapshot_2["related_records"]
            if record["source_kind"] == "SUPPLIER"
        )
        supplier_record["values"]["IS_ACTIVE"] = False

        with self.assertRaises(ValidationError):
            read_run_snapshots([snapshot_1, snapshot_2])


    def test_schema_v1_0_flat_snapshot_is_supported(self):
        snapshot = self.make_demand()

        snapshot["$id"] = (
            "cologi://cp08/planning-run-demand-snapshot/1.0"
        )
        snapshot["schema_version"] = "1.0"
        snapshot.pop("gate_evidence")

        result = read_demand_snapshot(snapshot)

        self.assertEqual(result.demand_id, 1)
        self.assertEqual(result.demand_code, "DM-0001")
        self.assertIn(
            "demand_items",
            result.related_records,
        )

    def test_schema_v1_0_rejects_gate_evidence(self):
        snapshot = self.make_demand()

        snapshot["$id"] = (
            "cologi://cp08/planning-run-demand-snapshot/1.0"
        )
        snapshot["schema_version"] = "1.0"

        with self.assertRaises(ValidationError):
            read_demand_snapshot(snapshot)
