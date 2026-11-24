from datetime import timedelta
from unittest.mock import patch

from django.test import override_settings
from rest_framework.test import APITestCase

from accounts.models import AuditLog, Role, RoleCode, User, UserOutletAccess, UserRole
from masterdata.models import CargoCategory, Hub, Item, Outlet, Supplier
from masterdata.outlet_workspace import today
from planning.models import ReceivingSlot, ReceivingSource, ReceivingWindow
from planning.services.database_evidence import timing_evidence


class OutletWorkspaceTests(APITestCase):
    endpoint = "/api/masterdata/outlet-workspace/"

    @classmethod
    def setUpTestData(cls):
        roles = {role: Role.objects.create(code=role, name=role.label) for role in RoleCode}
        cls.manager = User.objects.create_user(email="scope-manager@example.test", full_name="Manager")
        cls.staff = User.objects.create_user(email="scope-buyer@example.test", full_name="Buyer")
        cls.other = User.objects.create_user(email="scope-other@example.test", full_name="Other Buyer")
        cls.supplier_actor = User.objects.create_user(email="scope-supplier@example.test", full_name="Supplier")
        for actor, role in ((cls.manager, RoleCode.MANAGER), (cls.staff, RoleCode.PURCHASING_STAFF),
                            (cls.other, RoleCode.PURCHASING_STAFF), (cls.supplier_actor, RoleCode.SUPPLIER)):
            UserRole.objects.create(user=actor, role=roles[role])
        cls.outlet = Outlet.objects.create(outlet_code="OUT-TEST", outlet_name="Primary", address="10 Test Street")
        cls.unrelated = Outlet.objects.create(outlet_code="OUT-PRIVATE", outlet_name="Outside", address="8 Test Street")
        UserOutletAccess.objects.create(user=cls.manager, outlet=cls.outlet)
        UserOutletAccess.objects.create(user=cls.staff, outlet=cls.outlet, assigned_by=cls.manager)
        UserOutletAccess.objects.create(user=cls.other, outlet=cls.unrelated, assigned_by=cls.manager)
        cls.supplier = Supplier.objects.create(supplier_code="S-TEST", supplier_name="Direct Source")
        cls.hub = Hub.objects.create(hub_code="H-TEST", hub_name="Test Hub", address="Hub address")
        cargo = CargoCategory.objects.create(category_code="OUTLET-CARGO", category_name="Cargo")
        cls.item = Item.objects.create(item_code="OUTLET-ITEM", item_name="Item", cargo_category=cargo, weight_unit="kg")

    def setUp(self):
        self.client.force_authenticate(self.staff)
        self.day = today() + timedelta(days=1)

    def path(self, outlet=None):
        return self.endpoint + str(outlet or self.outlet.pk) + "/"

    @staticmethod
    def data():
        return {"outlet_name": "Regional Branch", "address": "22 Warehouse Road",
                "contact_name": "Shift Desk", "phone": "+84 903 123 456"}

    def demand(self, outlet_id):
        return self.client.post("/api/demands/", {
            "supplier_id": self.supplier.pk, "outlet_id": outlet_id, "requested_date": self.day.isoformat(),
            "requested_start_time": "08:00", "requested_end_time": "12:00",
            "items": [{"item_id": self.item.pk, "required_weight_kg": "25.000"}],
        }, format="json")

    def state(self, is_active, path=None):
        return self.client.post((path or self.path()) + "state/", {
            "is_active": is_active, "confirm": True, "reason": "Staff requested an operational change",
        }, format="json")

    def test_scoped_read_and_no_write_by_default(self):
        response = self.client.get(self.endpoint)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["summary"], {"total": 1, "active": 1, "inactive": 0})
        self.assertFalse(response.data["writes_enabled"])
        self.assertEqual(self.client.get(self.path(self.unrelated.pk)).status_code, 404)
        self.assertEqual(self.client.post(self.endpoint, self.data(), format="json").status_code, 403)
        self.client.force_authenticate(self.manager)
        self.assertEqual(self.client.get(self.endpoint).status_code, 403)
        self.client.force_authenticate(self.supplier_actor)
        self.assertEqual(self.client.get(self.endpoint).status_code, 403)

    @override_settings(COLOGI_OUTLET_WORKSPACE_WRITES=True)
    def test_create_unique_scope_update_and_cp04(self):
        with patch("masterdata.outlet_workspace._new_code", side_effect=[self.outlet.outlet_code, "OUT-UNIQUETEST"]):
            outcome = self.client.post(self.endpoint, self.data(), format="json")
        self.assertEqual(outcome.status_code, 201, outcome.data)
        outlet_id = outcome.data["id"]
        self.assertEqual(outcome.data["outlet_code"], "OUT-UNIQUETEST")
        self.assertEqual(set(UserOutletAccess.objects.filter(outlet_id=outlet_id).values_list("user_id", flat=True)),
                         {self.staff.pk, self.manager.pk})
        outlets = self.client.get("/api/masterdata/outlets/").data
        self.assertIn(outlet_id, {row["id"] for row in outlets})
        detail = self.path(outlet_id)
        res = self.client.patch(detail, {"address": "Updated Street 7"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["address"], "Updated Street 7")
        self.assertEqual(self.client.patch(detail, {"owner": self.other.pk}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(self.path(self.unrelated.pk), {"address": "Attempt"}, format="json").status_code, 404)
        self.assertEqual(self.client.get(detail).data["history"][0]["before"]["address"], self.data()["address"])
        draft = self.demand(outlet_id)
        self.assertEqual(draft.status_code, 201, draft.data)
        blocked = self.state(False, detail)
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(int(blocked.data["blockers"]["open_demands"]), 1)

    @override_settings(COLOGI_OUTLET_WORKSPACE_WRITES=True)
    def test_missing_manager_delegation_blocks_existing_or_new(self):
        UserOutletAccess.objects.filter(user=self.manager, outlet=self.outlet).update(is_active=False)
        self.assertFalse(self.client.get(self.endpoint).data["can_create"])
        self.assertEqual(self.client.post(self.endpoint, self.data(), format="json").status_code, 403)
        self.assertEqual(self.client.patch(self.path(), {"address": "Attempt"}, format="json").status_code, 403)
        self.assertEqual(self.state(False).status_code, 403)

    @override_settings(COLOGI_OUTLET_WORKSPACE_WRITES=True)
    def test_deactivate_preserves_assignments_and_reactivate(self):
        self.assertEqual(self.state(False).status_code, 200)
        self.assertTrue(Outlet.objects.filter(pk=self.outlet.pk, is_active=False).exists())
        self.assertEqual(self.client.get(self.endpoint).data["summary"]["inactive"], 1)
        self.assertEqual(self.demand(self.outlet.pk).status_code, 403)
        self.assertFalse(self.outlet.delivery_demands.exists())
        self.assertTrue(UserOutletAccess.objects.filter(outlet=self.outlet, user=self.staff, is_active=True).exists())
        self.assertEqual(self.state(True).status_code, 200)
        self.assertEqual(self.client.delete(self.path()).status_code, 405)
        self.assertEqual(AuditLog.objects.filter(entity_type="OUTLET_WORKSPACE", entity_id=str(self.outlet.pk)).count(), 2)

    @override_settings(COLOGI_OUTLET_WORKSPACE_WRITES=True)
    def test_calendar_uses_operational_sources_and_rejects_overlap(self):
        window = {"day_of_week": self.day.weekday(), "start_time": "08:00", "end_time": "12:00", "is_active": True}
        creation = self.client.post(self.path() + "windows/", window, format="json")
        self.assertEqual(creation.status_code, 201, creation.data)
        self.assertEqual(self.client.post(self.path() + "windows/", {**window, "start_time": "11:30"}, format="json").status_code, 409)
        self.assertIsNotNone(ReceivingWindow.objects.get(pk=creation.data["id"], source_mode=ReceivingSource.OPERATIONAL))
        slot = {"slot_date": self.day.isoformat(), "start_time": "09:00", "end_time": "10:00",
                "slot_type": "BLOCKED", "status": "OPEN", "reason": "Inbound count"}
        created = self.client.post(self.path() + "slots/", slot, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(self.client.post(self.path() + "slots/", {**slot, "reason": ""}, format="json").status_code, 400)
        self.assertEqual(self.client.post(self.path() + "slots/", {**slot, "slot_date": (today() - timedelta(days=1)).isoformat()},
                                         format="json").status_code, 400)
        version = self.client.patch(self.path() + f"slots/{created.data['id']}/", {**slot, "reason": "Inventory count"}, format="json")
        self.assertEqual(version.status_code, 200)
        self.assertEqual(ReceivingSlot.objects.get(pk=created.data["id"]).reason, "Inventory count")
        result = timing_evidence({
            "basis": {"requested_date": self.day.isoformat(), "demands": [{"outlet_id": self.outlet.pk}]},
            "option": {"stops": [{"kind": "OUTLET", "entity_id": self.outlet.pk, "key": "stop"}]},
        })["receiving"][0]
        self.assertEqual(result["windows"][0]["record_id"], creation.data["id"])
        self.assertEqual(result["observed_slots"][0]["record_id"], created.data["id"])
        self.assertFalse(result["slot_calendar_confirmed"])
        readiness = self.client.get(self.path() + "?date=" + self.day.isoformat()).data["planning"]
        checks = {row["code"]: row["status"] for row in readiness["checks"]}
        self.assertFalse(readiness["ready"])
        self.assertEqual(checks["RECEIVING_WINDOWS"], "READY")
        self.assertEqual(checks["RECEIVING_SLOTS"], "MISSING")
        for check in ("BASELINE_COST", "TRAVEL_TIME", "HUB_COVERAGE", "SERVICE_DURATION"):
            self.assertEqual(checks[check], "MISSING")
