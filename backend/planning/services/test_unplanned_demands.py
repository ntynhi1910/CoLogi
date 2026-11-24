from datetime import datetime, time, timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import AuditLog, ExternalUserAccess, Role, RoleCode, UserOutletAccess, UserRole
from demands.services import select_supplier_for_submitted_demand, submit_demand
from demands.tests import DemandServiceTestBase
from planning.models_execution import InventoryTransaction, StockBalance, StockReservation
from planning.services.f1_selection import selection_diagnostics
from planning.services.inventory import change_stock
from planning.services.unplanned_demands import ACTION, SUPPLIER_MESSAGE, _all_options_failed
from suppliers.services import respond_to_supplier_request


@override_settings(COLOGI_CP11_ENABLED=True)
class UnplannedDemandTests(DemandServiceTestBase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.today = timezone.localdate(timezone=ZoneInfo("Asia/Ho_Chi_Minh"))
        self.supplier.address = "Da Nang"
        self.supplier.save(update_fields=["address"])
        self.manager = self.new_actor("manager", RoleCode.MANAGER)
        self.provider = self.new_actor("supplier", RoleCode.SUPPLIER)
        self.other_supplier = self.new_actor("other-supplier", RoleCode.SUPPLIER)
        UserOutletAccess.objects.create(user=self.manager, outlet=self.outlet)
        UserRole.objects.create(user=self.user, role=Role.objects.create(code=RoleCode.PURCHASING_STAFF, name="Purchasing"))
        UserOutletAccess.objects.create(user=self.user, outlet=self.outlet)
        ExternalUserAccess.objects.create(user=self.provider, actor_type="SUPPLIER", supplier=self.supplier)
        offer = self.create_offer()
        self.balance = StockBalance.objects.create(supplier_item=offer)
        change_stock(self.balance, actor=self.provider, kind="OPENING", on_hand=Decimal(25), reason="Verified test opening")
        self.demand = self.create_demand(requested_date=self.today - timedelta(days=1))
        self.current = submit_demand(demand_id=self.demand.pk, submitted_by=self.user)

    def new_actor(self, name, code):
        actor = self.User.objects.create_user(email=f"{name}@cp12.example.test", full_name=name)
        role, _ = Role.objects.get_or_create(code=code, defaults={"name": name})
        UserRole.objects.create(user=actor, role=role)
        return actor

    def confirm(self, supplier_request, day):
        return respond_to_supplier_request(request_id=supplier_request.pk, supplier_id=self.supplier.pk,
            actor=self.provider, response_data={"ready_date": day, "ready_start_time": self.demand.requested_start_time,
            "ready_end_time": self.demand.requested_end_time,
            "items": [{"promise_id": supplier_request.item_promises.get().pk, "confirmed_weight_kg": Decimal(10)}]})

    def close(self, actor, confirmed=True):
        self.client.force_authenticate(actor)
        return self.client.post(f"/api/planning/f1/demands/{self.demand.pk}/close-unplanned/",
                                {"confirm_finished": confirmed, "reason": "Isolated policy verification",
                                 "supplier_request_id": self.current.pk}, format="json")

    def test_expired_full_release_preserves_on_hand_and_other_demands_and_allows_resubmit(self):
        self.confirm(self.current, self.demand.requested_date)
        other = self.create_demand(demand_code="CP12-UNRELATED", requested_date=self.today + timedelta(days=1))
        other_request = submit_demand(demand_id=other.pk, submitted_by=self.user)
        self.confirm(other_request, other.requested_date)
        self.assertEqual(self.close(self.manager, confirmed=False).status_code, 400)
        self.assertEqual(self.close(self.user).status_code, 403)
        response = self.close(self.manager)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(self.close(self.manager).status_code, 200)
        self.demand.refresh_from_db()
        self.current.refresh_from_db()
        self.balance.refresh_from_db()
        self.assertEqual(self.demand.status, "SUBMITTED")
        self.assertEqual(self.current.request_status, "CANCELLED")
        self.assertEqual(self.current.supplier_confirmation.confirmation_status, "CONFIRMED")
        self.assertEqual(self.current.supplier_confirmation.confirmed_weight_kg, 10)
        self.assertEqual((self.balance.on_hand_kg, self.balance.reserved_kg), (25, 10))
        entry = InventoryTransaction.objects.get(kind="RELEASE")
        self.assertEqual((entry.on_hand_delta_kg, entry.reserved_delta_kg), (0, -10))
        self.assertEqual(StockReservation.objects.get(promise__supplier_request=other_request).remaining_kg, 10)
        self.assertEqual(AuditLog.objects.filter(action=ACTION).count(), 1)
        self.client.force_authenticate(self.provider)
        notices = self.client.get("/api/planning/publication/supplier/unplanned/").data
        self.assertEqual([row["message"] for row in notices], [SUPPLIER_MESSAGE])
        self.assertEqual(self.client.get("/api/planning/publication/purchasing/unplanned/").status_code, 403)
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get("/api/planning/publication/purchasing/unplanned/").data[0]["demand_id"], self.demand.pk)
        self.client.force_authenticate(self.other_supplier)
        self.assertEqual(self.client.get("/api/planning/publication/supplier/unplanned/").status_code, 404)
        selection = select_supplier_for_submitted_demand(demand_id=self.demand.pk, selected_by=self.user,
                                                         selected_supplier_id=self.supplier.pk)
        self.assertEqual(selection.selection_reason, "RETRY_AFTER_CANCELLED")
        retry = submit_demand(demand_id=self.demand.pk, submitted_by=self.user)
        self.assertEqual((retry.attempt_no, retry.request_status), (2, "WAITING"))
        self.assertEqual(self.close(self.manager).status_code, 200)
        retry.refresh_from_db()
        self.assertEqual(retry.request_status, "WAITING")
        self.assertEqual(StockReservation.objects.filter(promise__supplier_request=retry).count(), 0)

    def test_guards_preserve_waiting_attempt_when_final_plan_or_custody_exists(self):
        for code in ("F1_EFFECTIVE_FINAL_PLAN", "F1_EXECUTION_OBLIGATION"):
            with patch("planning.services.unplanned_demands.plan_blockers", return_value={self.demand.pk: code}):
                result = self.close(self.manager)
                self.assertEqual((result.status_code, result.data["code"]), (409, "UNPLANNED_LIVE_PLAN"))
        self.current.refresh_from_db()
        self.assertEqual(self.current.request_status, "WAITING")
        self.assertFalse(AuditLog.objects.filter(action=ACTION).exists())

    def test_a_feasible_alternative_blocks_planning_failure(self):
        module = "planning.services.unplanned_demands."
        plan = SimpleNamespace(group_id=3, hub_id=None, pk=7)
        f3 = SimpleNamespace(pk=9, plan_id=7, f3_structure={"result": {"gate_status": "ELIGIBLE"}})
        f4 = SimpleNamespace(f3_evaluation_id=9, f4_structure={"result": {"status": "PASS"}})
        with (patch(module + "Hub.objects") as hubs, patch(module + "FulfillmentPlan.objects") as plans,
              patch(module + "EconomicEvaluation.objects") as costs, patch(module + "F3Evaluation.objects") as vehicles,
              patch(module + "F4Evaluation.objects") as timing):
            hubs.filter.return_value.values_list.return_value = []
            plans.filter.return_value.order_by.return_value = [plan]
            costs.filter.return_value.exists.return_value = False
            vehicles.filter.return_value.order_by.return_value = [f3]
            timing.filter.return_value.order_by.return_value = [f4]
            self.assertFalse(_all_options_failed([3]))
            f4.f4_structure["result"]["status"] = "HARD_CONFLICT"
            self.assertTrue(_all_options_failed([3]))

    def test_future_demand_without_finished_run_is_not_cancelled(self):
        self.demand.requested_date = self.today + timedelta(days=1)
        self.demand.save(update_fields=["requested_date"])
        result = self.close(self.manager)
        self.assertEqual((result.status_code, result.data["code"]), (409, "UNPLANNED_RUN_NOT_FINAL"))

    def test_f1_selector_hides_expired_and_includes_current_confirmed_demand(self):
        future = self.create_demand(demand_code="CP12-ELIGIBLE", requested_date=self.today + timedelta(days=1))
        attempt = submit_demand(demand_id=future.pk, submitted_by=self.user)
        self.confirm(attempt, future.requested_date)
        self.demand.refresh_from_db()
        future.refresh_from_db()
        self.assertEqual({row["demand_id"] for row in selection_diagnostics(self.manager, [self.demand, future], at=timezone.now())},
                         {self.demand.pk})
        self.client.force_authenticate(self.manager)
        selection = self.client.get("/api/planning/f1/selectable-demands/")
        self.assertEqual([row["id"] for row in selection.data["demands"]], [future.pk])
        self.assertEqual(selection.data["counts"]["past_due"], 1)

    def test_f1_picker_and_overdue_kpi_roll_at_same_day_deadline(self):
        today = self.create_demand(demand_code="CP12-TODAY", requested_date=self.today)
        attempt = submit_demand(demand_id=today.pk, submitted_by=self.user)
        self.confirm(attempt, self.today)
        self.client.force_authenticate(self.manager)
        zone = ZoneInfo("Asia/Ho_Chi_Minh")
        url = "/api/planning/f1/selectable-demands/"
        with patch("planning.views.timezone.now", return_value=datetime.combine(self.today, time(9), tzinfo=zone)):
            before = self.client.get(url).data
        with patch("planning.views.timezone.now", return_value=datetime.combine(self.today, time(10), tzinfo=zone)):
            after = self.client.get(url).data
        self.assertEqual([row["id"] for row in before["demands"]], [today.pk])
        self.assertEqual(before["next_expiry_at"], datetime.combine(self.today, time(10), tzinfo=zone))
        self.assertEqual(after["demands"], [])
        self.assertEqual(after["counts"]["past_due"], before["counts"]["past_due"] + 1)
