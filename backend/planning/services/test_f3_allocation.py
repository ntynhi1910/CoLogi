from collections import Counter
from dataclasses import replace
from datetime import date, time
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from planning.services.f3_allocation import Availability, Offer, allocate


DAY = date(2026, 11, 16)
WINDOW = Availability(1, DAY, time(6), time(20), 4, "AVAILABLE", "PROVIDER_CONFIRMED_IMPORT")
VAN = Offer(1, 1, "V500", "Van", Decimal(500), 4, True, True, time(6), time(20), (WINDOW,))
TRUCK = Offer(2, 2, "T1000", "Truck", Decimal(1000), 4, True, True, None, None, (WINDOW,))
COVERAGE = {1: {"supplier_id": 1, "coverage_status": "ACTIVE", "can_pickup": True}}
MATRIX = {(1, 1): {"is_supported": True, "source": "CONFIG_MATRIX"},
          (2, 1): {"is_supported": True, "source": "CONFIG_MATRIX"}}


def structure(weights, hub_id=None):
    demands = [
        {"id": pk, "code": f"DD{pk}", "cargo_category_id": 1, "supplier_id": 1, "required_weight_kg": str(weight),
         "pickup_ready_date": DAY.isoformat(), "pickup_ready_start_time": "06:30:00"}
        for pk, weight in enumerate(weights, 1)
    ]
    ids = [demand["id"] for demand in demands]
    legs = [
        {"phase": phase, "demand_ids": [pk], "from_stop": "source" if phase != "OUTBOUND" else f"hub-{hub_id}",
         "to_stop": f"hub-{hub_id}" if phase == "INBOUND" else f"outlet-{pk}"}
        for phase in (("INBOUND", "OUTBOUND") if hub_id else ("DIRECT",)) for pk in ids
    ]
    return {
        "basis": {"requested_date": DAY.isoformat(), "common_end_time": "10:00:00", "demand_ids": ids,
                  "total_required_weight_kg": str(sum(weights)), "cargo_category_ids": [1], "demands": demands},
        "option": {"hub": {"id": hub_id} if hub_id else None, "legs": legs},
    }


class F3AllocationTests(TestCase):
    def preview(self, weights, *, offers=(VAN, TRUCK), matrix=MATRIX, coverage=COVERAGE, hub_id=None):
        return allocate(structure(weights, hub_id), provider={"id": 1, "is_active": True}, offers=offers,
                        matrix=matrix, coverage=coverage)

    def assert_blocker(self, output, code):
        self.assertEqual(output["status"], "NOT_ALLOCATED")
        self.assertEqual(output["waves"], [])
        self.assertIn(code, [row["code"] for row in output["diagnostics"]])

    def test_one_vehicle_then_utilization(self):
        result = self.preview([200, 150, 140, 160])
        self.assertEqual(result["status"], "ALLOCATION_VERIFIED")
        self.assertEqual(result["vehicles_required"], 1)
        self.assertEqual(result["utilization_pct"], "65.00")
        self.assertEqual(result["waves"][0]["vehicle"]["vehicle_code"], "T1000")
        self.assertEqual(self.preview([240, 260])["waves"][0]["vehicle"]["vehicle_code"], "V500")

    def test_multiple_vehicles_conserve_whole_demands(self):
        result = self.preview([210, 250, 290, 320])
        self.assertEqual(result["vehicles_required"], 2)
        realized = [item for wave in result["waves"] for item in wave["allocations"]]
        self.assertEqual(Counter(item["demand_id"] for item in realized), Counter([1, 2, 3, 4]))
        self.assertEqual(sum(Decimal(item["weight_kg"]) for item in realized), Decimal(1070))
        self.assertTrue(all(Decimal(wave["allocated_weight_kg"]) <= Decimal(wave["vehicle"]["capacity_kg"])
                            for wave in result["waves"]))

    def test_heavy_and_cargo_cases(self):
        self.assert_blocker(self.preview([1001, 1]), "DEMAND_EXCEEDS_CAPACITY")
        self.assert_blocker(self.preview([201, 1], matrix={}), "COMPATIBILITY_MISSING")
        unsupported = {key: {"is_supported": False, "source": "CONFIG_MATRIX"} for key in MATRIX}
        self.assert_blocker(self.preview([201, 1], matrix=unsupported), "CARGO_UNSUPPORTED")
        self.assert_blocker(self.preview([200, 100], offers=(replace(VAN, active=False),)), "NO_ACTIVE_OFFER")

    def test_pickup_permission(self):
        for coverage in ({}, {1: {**COVERAGE[1], "can_pickup": False}},
                         {1: {**COVERAGE[1], "coverage_status": "INACTIVE"}}):
            with self.subTest(coverage=coverage):
                self.assert_blocker(self.preview([200, 100], coverage=coverage), "SUPPLIER_PICKUP_NOT_COVERED")

    def test_availability_must_cover_original_date_and_time(self):
        for windows, diagnostic in (
            ((), "AVAILABILITY_MISSING"),
            ((replace(WINDOW, service_date=date(2026, 11, 17)),), "AVAILABILITY_MISSING"),
            ((replace(WINDOW, start=time(11)),), "AVAILABILITY_OUTSIDE_WINDOW"),
            ((replace(WINDOW, start=time(7)),), "AVAILABILITY_PARTIAL"),
            ((WINDOW, replace(WINDOW, id=2, start=time(7), end=time(8), count=0, status="UNAVAILABLE")),
             "AVAILABILITY_UNAVAILABLE"),
        ):
            with self.subTest(diagnostic=diagnostic, windows=windows):
                self.assert_blocker(self.preview([200, 100], offers=(replace(VAN, windows=windows),)), diagnostic)

    def test_overlaps_and_phases_cannot_double_count_fleet(self):
        scarce = replace(TRUCK, windows=(replace(WINDOW, count=1), replace(WINDOW, id=2, count=1)))
        self.assert_blocker(self.preview([500, 200], offers=(scarce,), hub_id=1), "FLEET_LIMIT")
        self.assert_blocker(self.preview([700, 700], offers=(scarce,)), "FLEET_LIMIT")
        scarce_offer = replace(TRUCK, count=1)
        self.assert_blocker(self.preview([500, 200], offers=(scarce_offer,), hub_id=1), "FLEET_LIMIT")

    def test_each_hub_uses_its_own_legs_but_same_demand_total(self):
        for hub_id in (1, 2):
            with self.subTest(hub_id=hub_id):
                result = self.preview([500, 150], hub_id=hub_id)
                self.assertEqual(result["status"], "EVIDENCE_INCOMPLETE")
                self.assertEqual(result["vehicles_required"], 2)
                self.assertEqual(result["total_required_weight_kg"], "650")
                self.assertEqual({wave["phase"] for wave in result["waves"]}, {"INBOUND", "OUTBOUND"})
                for wave in result["waves"]:
                    self.assertEqual(wave["allocated_weight_kg"], "650")
                    self.assertEqual([row["demand_id"] for row in wave["allocations"]], [1, 2])
                    self.assertTrue(all(f"hub-{hub_id}" in (row["from_stop"], row["to_stop"]) for row in wave["allocations"]))

    def test_determinism_and_budget(self):
        self.assertEqual(self.preview([650, 250], offers=(VAN, TRUCK)),
                         self.preview([650, 250], offers=(TRUCK, VAN)))
        with patch("planning.services.f3_allocation.SEARCH_BUDGET", 1):
            result = self.preview([111, 211])
        self.assert_blocker(result, "SEARCH_LIMIT_REACHED")
        self.assertNotIn("FLEET_LIMIT", [row["code"] for row in result["diagnostics"]])
