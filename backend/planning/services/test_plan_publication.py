from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

from django.test import SimpleTestCase
from django.utils import timezone

from planning.f3_contract import fingerprint
from planning.services.final_delivery import DeliveryConflict
from planning.services.plan_publication import _metrics, publication_detail, publication_events, publication_state


class PublicationProjectionTests(SimpleTestCase):
    def setUp(self):
        self.demands = [
            {"id": 1, "code": "D1", "supplier_id": 10, "outlet_id": 20, "outlet_code": "O1",
             "required_weight_kg": "50", "items": [{"item_id": 101, "required_weight_kg": "20"},
                                                    {"item_id": 102, "required_weight_kg": "30"}]},
            {"id": 2, "code": "D2", "supplier_id": 11, "outlet_id": 21, "outlet_code": "O2",
             "required_weight_kg": "60", "items": [{"item_id": 201, "required_weight_kg": "60"}]},
        ]
        self.labels = ({}, {}, {pk: {"id": pk, "code": f"SKU-{pk}", "name": f"Item {pk}"} for pk in (101, 102, 201)})
        self.frozen = {
            "f1": {"demands": [{"related_records": [
                {"model_label": "demands.DemandItem", "values": {
                    "DEMAND_ID": str(demand["id"]), "ITEM_ID": str(item["item_id"]), "UNIT_OF_MEASURE": "KG"}}
                for item in demand["items"]
            ]} for demand in self.demands]},
            "f2": {"basis": {"requested_date": "2026-12-03", "demands": self.demands}, "option": {
                "hub": {"id": 3, "code": "HUB001", "name": "Hub 1"},
                "stops": [{"key": name, "address": f"Address {name}"} for name in ("s1", "s2", "hub", "o1", "o2")],
            }},
            "f3": {"result": {"waves": [
                {"wave_no": 1, "allocations": self.allocations(("s1", "s2"), ("hub", "hub"))},
                {"wave_no": 2, "allocations": self.allocations(("hub", "hub"), ("o1", "o2"))},
            ]}},
            "f4": {"configuration": {"timezone": "Asia/Ho_Chi_Minh"}, "result": {"waves": [
                self.wave(1, "INBOUND", [self.stop("s1", "SUPPLIER_PICKUP", [1], 1),
                                         self.stop("s2", "SUPPLIER_PICKUP", [2], 2),
                                         self.stop("hub", "HUB_RECEIVE", [1, 2], 3)]),
                self.wave(2, "OUTBOUND", [self.stop("hub", "HUB_DISPATCH", [1, 2], 1),
                                          self.stop("o1", "OUTLET_DELIVERY", [1], 2),
                                          self.stop("o2", "OUTLET_DELIVERY", [2], 3)]),
            ]}},
            "provenance": {"classification": "INTERNAL_ASSUMPTIONS", "provider_independently_verified": False,
                           "time_source": "INTERNAL", "price_source": "INTERNAL"},
        }
        self.plan = SimpleNamespace(
            code=uuid4(), version=1, snapshot=self.frozen, snapshot_hash=fingerprint(self.frozen),
            decision=SimpleNamespace(outcome="APPROVE"),
            provider=SimpleNamespace(pk=1, provider_code="TP001", provider_name="Provider 1"),
            handover=SimpleNamespace(sent_at=timezone.now()),
        )

    def allocations(self, starts, ends):
        return [{"demand_id": row["id"], "from_stop": start, "to_stop": end, "weight_kg": row["required_weight_kg"]}
                for row, start, end in zip(self.demands, starts, ends, strict=True)]

    def wave(self, number, phase, stops):
        return {"wave_no": number, "phase": phase, "stops": stops, "weight_kg": "110",
                "vehicle": {"vehicle_code": "VEH", "vehicle_name": "Delivery truck"}}

    def stop(self, key, role, ids, sequence):
        return {"stop": key, "role": role, "demand_ids": ids, "sequence": sequence, "code": key,
                "arrival": None, "service_start": "2026-12-03T08:00:00+07:00",
                "service_end": "2026-12-03T08:20:00+07:00", "departure": None, "wait_minutes": 15}

    def test_scoped_hub_load_preserves_sku_partition_and_weights(self):
        payload = publication_detail(self.plan, self.demands[:1], "supplier", labels=self.labels)
        self.assertEqual(payload["status"], "AWAITING_TRANSPORT")
        self.assertEqual(payload["waves"][0]["weight_kg"], None)
        pickup, hub = payload["waves"][0]["stops"]
        self.assertEqual((pickup["sequence"], hub["sequence"]), (1, 3))
        self.assertEqual(pickup["wait_minutes"], 15)
        self.assertEqual(hub["weight_kg"], "50")
        self.assertEqual([row["code"] for row in hub["loads"][0]["items"]], ["SKU-101", "SKU-102"])
        self.assertEqual([row["unit"] for row in pickup["loads"][0]["items"]], ["KG", "KG"])
        self.assertNotIn("SKU-201", str(payload))
        self.assertNotIn("Address s2", str(payload))
        self.assertFalse(payload["provenance"]["provider_independently_verified"])
        purchase = publication_detail(self.plan, self.demands[1:], "purchasing", labels=self.labels)
        self.assertEqual(purchase["waves"][0]["phase"], "OUTBOUND")
        self.assertEqual(purchase["waves"][0]["stops"][0]["weight_kg"], "60")
        self.assertNotIn("SKU-101", str(purchase))
        provider = publication_detail(self.plan, self.demands, "provider", labels=self.labels)
        self.assertEqual(provider["waves"][1]["weight_kg"], "110")
        self.assertEqual(len(provider["waves"][1]["stops"][0]["loads"]), 2)

    def test_sealed_values_and_partial_quantity(self):
        self.plan.snapshot["f3"]["result"]["waves"][0]["allocations"][0]["weight_kg"] = "25"
        with self.assertRaisesMessage(DeliveryConflict, "FINAL_PLAN_INVALID"):
            publication_detail(self.plan, self.demands, "provider", labels=self.labels)
        self.plan.snapshot_hash = fingerprint(self.plan.snapshot)
        load = publication_detail(self.plan, self.demands, "provider", labels=self.labels)["waves"][0]["stops"][0]["loads"][0]
        self.assertEqual(load["weight_kg"], "25")
        self.assertIsNone(load["items"])

    def test_notifications_follow_events_and_preserve_original_seal(self):
        saved = deepcopy(self.plan.snapshot)
        self.plan.handover.reply = SimpleNamespace(outcome="DECLINE", responded_at=timezone.now())
        self.assertEqual(publication_state(self.plan), "DECLINED")
        self.plan.successor = SimpleNamespace(decision=SimpleNamespace(recorded_at=timezone.now()))
        self.assertEqual(publication_state(self.plan), "SUPERSEDED")
        events = publication_events(self.plan)
        self.assertEqual([event["kind"] for event in events], ["PUBLISHED", "DECLINED", "SUPERSEDED"])
        self.assertEqual(len({event["id"] for event in events}), 3)
        self.assertEqual(events, publication_events(self.plan))
        self.assertEqual(self.plan.snapshot, saved)
        del self.plan.handover
        self.assertEqual(publication_events(self.plan), [])

    def test_dashboard_counts_effective_versions_and_only_upcoming_weight(self):
        plans = [
            {"status": "CONFIRMED", "service_date": "2099-01-01", "demands": [{"id": 1, "weight_kg": "1.250"}, {"id": 2, "weight_kg": "2.500"}]},
            {"status": "AWAITING_TRANSPORT", "service_date": "2099-01-02", "demands": [{"id": 3, "weight_kg": "4.125"}]},
            {"status": "CONFIRMED", "service_date": "2000-01-01", "demands": [{"id": 4, "weight_kg": "500"}]},
            {"status": "SUPERSEDED", "service_date": "2099-01-01", "demands": [{"id": 1, "weight_kg": "600"}]},
            {"status": "DECLINED", "service_date": "2099-01-01", "demands": [{"id": 6, "weight_kg": "700"}]},
        ]
        self.assertEqual(_metrics(plans), {"upcoming": 2, "upcoming_weight_kg": "7.875", "awaiting": 1,
                                          "confirmed": 2, "active_demand_count": 4})
