from collections import Counter
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal
from unittest import TestCase

from django.core.exceptions import ValidationError
from jsonschema import Draft202012Validator

from planning.f2_structure import F2_STRUCTURE_SCHEMA, validate_f2_structure
from planning.services.f2_options import Demand, DemandItem, HubPoint, generate_options


class F2StructureTests(TestCase):
    def setUp(self):
        first = Demand(
            id=1, code="DD1", supplier_id=10, outlet_id=11, outlet_code="OUT11",
            cargo_category_id=15, cargo_category_code="DRY_FOOD", requested_date="2026-12-01",
            requested_start_time="09:00:00", requested_end_time="10:00:00",
            required_weight_kg=Decimal("10.125"), items=(DemandItem(20, Decimal("10.125"), Decimal("11.000")),),
            pickup_address="Kho A", pickup_ready_date="2026-12-01",
            pickup_ready_start_time="08:00:00", pickup_ready_end_time="09:00:00", supplier_request_id=30,
            supplier_confirmation_id=40, snapshot_captured_at="2026-11-21T00:00:00Z", snapshot_version="1.1",
        )
        self.demands = [
            first,
            replace(first, id=2, code="DD2", outlet_id=12, outlet_code="OUT12"),
            replace(first, id=3, code="DD3", supplier_id=20, pickup_address="Kho B"),
            replace(first, id=4, code="DD4", pickup_address="Kho C", outlet_id=12, outlet_code="OUT12"),
        ]
        self.candidate = {
            "demand_ids": [1, 2, 3, 4], "requested_date": "2026-12-01",
            "common_start_time": "09:00:00", "common_end_time": "10:00:00", "cargo_category_ids": [15],
        }
        self.hub = HubPoint(8, "HUB8", "Hub 8", "Đường số 8")

    def preview(self, demands=None, **options):
        return generate_options(
            lineage={"run_code": "run-1", "group_code": "group-1"}, candidate=self.candidate,
            demands=self.demands if demands is None else demands, **options,
        )

    def test_direct_and_hub_preserve_exact_demand_and_weight_in_each_phase(self):
        preview = self.preview(hub=self.hub)
        direct, hub = preview["options"]
        self.assertEqual(preview["basis"]["outlet_count"], 2)
        for option in (direct, hub):
            self.assertEqual(option["demand_ids"], self.candidate["demand_ids"])
            self.assertEqual(option["total_required_weight_kg"], "40.500")
            self.assertEqual(option["status"], "DRAFT")
            self.assertFalse(option["ready_for_f3"])

        self.assertEqual(len([stop for stop in direct["stops"] if stop["kind"] == "SUPPLIER"]), 3)
        self.assertFalse(any(stop["kind"] == "HUB" for stop in direct["stops"]))
        self.assertEqual([stop["entity_id"] for stop in hub["stops"] if stop["kind"] == "HUB"], [8])
        for option, phase in ((direct, "DIRECT"), (hub, "INBOUND"), (hub, "OUTBOUND")):
            with self.subTest(phase=phase):
                legs = [leg for leg in option["legs"] if leg["phase"] == phase]
                self.assertEqual(Counter(pk for leg in legs for pk in leg["demand_ids"]), Counter(self.candidate["demand_ids"]))
                self.assertEqual(sum(Decimal(leg["load_kg"]) for leg in legs), Decimal("40.500"))
        self.assertEqual([leg["demand_ids"] for leg in hub["legs"] if leg["phase"] == "OUTBOUND"], [[1, 3], [2, 4]])

    def test_duplicate_request_has_stable_output_and_hub_changes_only_the_hub_option(self):
        original = self.preview(hub=self.hub)
        self.assertEqual(original, self.preview(demands=list(reversed(self.demands)), hub=self.hub))
        changed = self.preview(hub=replace(self.hub, id=9, code="HUB9"))
        self.assertEqual(original["options"][0], changed["options"][0])
        self.assertNotEqual(original["options"][1]["option_key"], changed["options"][1]["option_key"])

    def test_missing_hub_is_explicit_and_does_not_block_direct(self):
        direct, hub = self.preview()["options"]
        self.assertEqual(direct["structural_status"], "COMPLETE")
        self.assertEqual(hub["structural_status"], "INCOMPLETE")
        self.assertEqual(hub["diagnostics"], [{"code": "HUB_SELECTION_REQUIRED"}])
        self.assertEqual(hub["legs"], [])

    def test_duplicate_missing_or_foreign_demand_never_produces_a_complete_option(self):
        for rows in (self.demands + self.demands[:1], self.demands[1:], self.demands + [replace(self.demands[0], id=99)]):
            with self.subTest(ids=[row.id for row in rows]):
                with self.assertRaises(ValueError):
                    self.preview(demands=rows, hub=self.hub)

        preview = self.preview(demands=self.demands[1:], diagnostics=[{"code": "DEMAND_SNAPSHOT_INCOMPLETE", "demand_id": 1}])
        self.assertEqual(preview["basis"]["demand_ids"], [1, 2, 3, 4])
        self.assertIsNone(preview["basis"]["total_required_weight_kg"])
        self.assertTrue(all(option["structural_status"] == "INCOMPLETE" and not option["legs"] for option in preview["options"]))

    def test_versioned_structure_validates_shape_and_replays_weight_and_topology(self):
        Draft202012Validator.check_schema(F2_STRUCTURE_SCHEMA)
        preview = generate_options(
            lineage={
                "run_code": "31fa6411-c12c-45f4-abc9-30bd0abebfe4", "group_code": "group-1",
                "run_status": "COMPLETED", "candidate_status": "CANDIDATE",
                "rule_set_id": 1, "rule_set_code": "REGRESSION", "rule_set_version": 1,
                "configuration_captured_at": "2026-11-21T00:00:00Z", "configuration_fingerprint": "a" * 64,
                "max_group_size": 4, "max_candidates_per_run": 100, "cargo_matrix_source": None,
                "cargo_matrix_sheet": None, "f1_rule_codes": ["RULE-01"],
            },
            candidate=self.candidate, demands=self.demands, hub=self.hub,
        )
        for option in preview["options"]:
            stored = {"schema_version": 1, "lineage": preview["lineage"], "basis": preview["basis"], "option": option}
            validate_f2_structure(stored)
        for path, invalid_value in (
            (("schema_version",), 2),
            (("option", "structural_status"), "INCOMPLETE"),
            (("option", "legs", 0, "demand_ids"), [1, 1]),
            (("option", "legs", 0, "load_kg"), "0.000"),
            (("option", "legs", 0, "to_stop"), "outlet-999"),
            (("option", "option_key"), "c" * 64),
            (("basis", "demands", 0, "requested_date"), "2026-13-01"),
            (("basis", "demands", 0, "snapshot_captured_at"), "2026-13-01T00:00:00Z"),
            (("basis", "demands", 0, "items", 0, "confirmed_weight_kg"), "0.001"),
            (("basis", "total_required_weight_kg"), "81.000"),
        ):
            with self.subTest(path=path):
                invalid = deepcopy(stored)
                entry = invalid
                for key in path[:-1]:
                    entry = entry[key]
                entry[path[-1]] = invalid_value
                with self.assertRaises(ValidationError):
                    validate_f2_structure(invalid)
