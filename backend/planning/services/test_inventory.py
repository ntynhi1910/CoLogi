from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from django.db import connection, connections
from django.test import override_settings
import pytest
from rest_framework.test import APIClient

from accounts.models import ExternalUserAccess, Role, RoleCode, User, UserRole
from demands.models import SupplierRequest
from demands.services import submit_demand
from demands.tests import DemandServiceTestBase
from planning.models_execution import InventoryTransaction, StockBalance, StockReservation
from planning.services.inventory import (CAPSTONE_OPENING_SOURCE, ExecutionBlocked, change_stock, post_stock,
                                        require_pickup_stock)
from masterdata.models import CargoCategory, Item, Supplier, SupplierItem


@override_settings(COLOGI_CP11_ENABLED=True)
class InventoryIntegrationTests(DemandServiceTestBase):
    def setUp(self):
        super().setUp()
        self.supplier.address = "Pickup address"
        self.supplier.save(update_fields=["address"])
        self.actor = self.User.objects.create_user(email="inventory-supplier@example.test", full_name="Test Supplier")
        UserRole.objects.create(user=self.actor, role=Role.objects.create(code=RoleCode.SUPPLIER, name="Supplier"))
        ExternalUserAccess.objects.create(user=self.actor, actor_type="SUPPLIER", supplier=self.supplier)
        self.client = APIClient()
        self.client.force_authenticate(user=self.actor)
        self.offer = self.create_offer(capacity="100.000")
        self.demand = self.create_demand(demand_code="DD-CP11-INVENTORY")
        self.request = submit_demand(demand_id=self.demand.pk, submitted_by=self.user)
        self.promise = self.request.item_promises.get()

    def opening(self, amount, key=None):
        return self.client.post("/api/planning/inventory/", {
            "supplier_item_id": self.promise.supplier_item_id, "kind": "OPENING", "amount": amount,
            "request_id": str(key or uuid4()), "reason": "Isolated test stock count", "source_reference": "TEST-COUNT",
        }, format="json")

    def confirm(self, amount="10.000"):
        return self.client.post(f"/api/supply-requests/{self.request.pk}/confirm", {
            "ready_date": "2026-11-16", "ready_start_time": "08:00", "ready_end_time": "10:00",
            "items": [{"promise_id": self.promise.pk, "confirmed_weight_kg": amount}],
        }, format="json")

    def test_opening_document_and_confirmation_reserve_without_consuming(self):
        key = uuid4()
        self.assertEqual(self.opening("20.000", key).status_code, 201)
        self.assertEqual(self.opening("20.000", key).status_code, 200)
        self.assertEqual(self.opening("21.000", key).status_code, 409)
        response = self.confirm()
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self.confirm().status_code, 409)
        balance = StockBalance.objects.get()
        self.assertEqual((balance.on_hand_kg, balance.reserved_kg), (Decimal(20), Decimal(10)))
        self.assertEqual(StockReservation.objects.count(), 1)
        self.assertEqual(list(InventoryTransaction.objects.order_by("pk").values_list("kind", flat=True)),
                         ["OPENING", "RESERVE"])

    def test_missing_or_short_stock_keeps_cp6_waiting_and_rolls_back(self):
        self.assertEqual(self.confirm().data["code"], "OPENING_STOCK_REQUIRED")
        self.assertEqual(self.opening("4").status_code, 201)
        response = self.confirm()
        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data["code"], "INSUFFICIENT_AVAILABLE_STOCK")
        self.request.refresh_from_db()
        self.promise.refresh_from_db()
        self.assertEqual(self.request.request_status, SupplierRequest.RequestStatus.WAITING)
        self.assertEqual(self.promise.confirmed_weight_kg, 0)
        self.assertEqual(StockReservation.objects.count(), 0)

    def test_purchasing_cannot_read_or_open_supplier_inventory(self):
        self.client.force_authenticate(user=self.user)
        self.assertEqual(self.client.get("/api/planning/inventory/").status_code, 403)
        self.assertEqual(self.opening("20").status_code, 403)

    def test_operational_planning_opening_cannot_fund_commercial_pickup(self):
        balance = StockBalance.objects.create(supplier_item=self.offer)
        change_stock(balance, actor=self.actor, kind="OPENING", on_hand=Decimal(15000),
                     source=CAPSTONE_OPENING_SOURCE, reason="Test manager approval")
        self.assertEqual(self.confirm().status_code, 200)
        reservations = StockReservation.objects.filter(balance=balance)
        quantities = {str(self.item.pk): Decimal(10)}
        with self.assertRaises(ExecutionBlocked) as error:
            require_pickup_stock(reservations, quantities)
        self.assertEqual(str(error.exception.detail["code"]), "COMMERCIAL_STOCK_EVIDENCE_REQUIRED")
        internal = self.client.post("/api/planning/inventory/", {
            "supplier_item_id": self.offer.pk, "kind": "INBOUND", "amount": "10",
            "request_id": str(uuid4()), "reason": "Nhập hàng bổ sung", "source_reference": "NB-01",
            "reference_kind": "INTERNAL",
        }, format="json")
        self.assertEqual(internal.status_code, 201, internal.data)
        self.assertEqual(InventoryTransaction.objects.get(pk=internal.data["transaction_id"]).source_reference,
                         "SYNTHETIC/INTERNAL:NB-01")
        with self.assertRaises(ExecutionBlocked):
            require_pickup_stock(reservations, quantities)
        post_stock(actor=self.actor, supplier_id=self.supplier.pk, supplier_item_id=self.offer.pk,
                   kind="INBOUND", amount=Decimal(10), reason="Supplier receipt", source_reference="TEST-RECEIPT",
                   request_id=uuid4())
        require_pickup_stock(reservations, quantities)
        stock = self.client.get("/api/planning/inventory/").data["balances"][0]
        self.assertEqual(stock["opening_provenance"], "MANAGER_APPROVED_SYNTHETIC")
        self.assertEqual(stock["reserved_kg"], Decimal(10))

    def test_stock_adjustment_guard_and_history_filters(self):
        from zoneinfo import ZoneInfo
        from django.utils import timezone

        self.assertEqual(self.opening("20").status_code, 201)
        self.assertEqual(self.confirm().status_code, 200)
        data = {"supplier_item_id": self.offer.pk, "kind": "ADJUST", "amount": "-11",
                "request_id": str(uuid4()), "reason": "Chênh lệch kiểm kê", "source_reference": "KK-01"}
        endpoint = "/api/planning/inventory/"
        blocked = self.client.post(endpoint, data, format="json")
        self.assertEqual(blocked.data["code"], "INSUFFICIENT_AVAILABLE_STOCK")
        denied = self.client.post(endpoint, {**data, "amount": "-5", "reference_kind": "INTERNAL"}, format="json")
        self.assertEqual(denied.data["code"], "INTERNAL_STOCK_REFERENCE_NOT_ALLOWED")
        accepted = self.client.post(endpoint, {**data, "amount": "-5"}, format="json")
        self.assertEqual(accepted.status_code, 201, accepted.data)
        day = timezone.localdate(timezone=ZoneInfo("Asia/Ho_Chi_Minh")).isoformat()
        response = self.client.get(endpoint, {"kind": "ADJUST", "day": day, "supplier_item": self.offer.pk})
        self.assertEqual(len(response.data["history"]), 1)
        self.assertEqual(response.data["history"][0]["on_hand_delta_kg"], Decimal("-5"))

    def test_declared_stock_records_auto_reference_and_excludes_it_from_commercial_pickup(self):
        from planning.services.inventory import DECLARED_STOCK_REFERENCE

        self.assertEqual(self.opening("5").status_code, 201)
        endpoint = "/api/planning/inventory/"
        request_id = str(uuid4())
        payload = {"supplier_item_id": self.offer.pk, "request_id": request_id, "kind": "INBOUND",
                   "amount": "12", "reason": "Nhập hàng bổ sung", "note": "Thuộc lô nội bộ",
                   "reference_kind": "DECLARED"}
        self.assertEqual(self.client.post(endpoint, {**payload, "reference_kind": "COMMERCIAL"}, format="json").status_code, 400)
        movement = self.client.post(endpoint, payload, format="json")
        self.assertEqual(movement.status_code, 201, movement.data)
        self.assertEqual(self.client.post(endpoint, payload, format="json").status_code, 200)
        entry = InventoryTransaction.objects.get(pk=movement.data["transaction_id"])
        self.assertEqual(entry.source_reference, DECLARED_STOCK_REFERENCE + request_id)
        self.assertEqual(entry.reason, "Nhập hàng bổ sung\nGhi chú · Thuộc lô nội bộ")
        self.assertEqual(self.confirm().status_code, 200)
        reservations = StockReservation.objects.filter(balance=entry.balance)
        require_pickup_stock(reservations, {str(self.item.pk): Decimal(5)})
        with self.assertRaises(ExecutionBlocked) as blocked:
            require_pickup_stock(reservations, {str(self.item.pk): Decimal(10)})
        self.assertEqual(blocked.exception.detail["code"], "COMMERCIAL_STOCK_EVIDENCE_REQUIRED")

    @override_settings(COLOGI_CAPSTONE_SCENARIOS=frozenset({"v7-supplement-v1"}),
                       COLOGI_CP11_CAPSTONE_SCENARIO="v7-supplement-v1")
    def test_capstone_stock_never_supplies_operational_confirmation(self):
        StockBalance.objects.create(supplier_item_id=self.promise.supplier_item_id, scenario="v7-supplement-v1",
                                    on_hand_kg=Decimal(15000))
        self.assertIsNone(self.client.get("/api/planning/inventory/").data["balances"][0]["on_hand_kg"])
        self.assertEqual(self.confirm().data["code"], "OPENING_STOCK_REQUIRED")
        self.actor.capstone_scenario = "v7-supplement-v1"
        self.actor.save(update_fields=["capstone_scenario"])
        scoped = self.client.get("/api/planning/inventory/")
        self.assertEqual(scoped.data["provenance"], "SYNTHETIC/CP11_CAPSTONE")
        self.assertEqual(scoped.data["balances"][0]["on_hand_kg"], Decimal(15000))
        response = self.client.post("/api/planning/inventory/", {
            "supplier_item_id": self.promise.supplier_item_id, "kind": "INBOUND", "amount": "1",
            "request_id": str(uuid4()), "reason": "test", "source_reference": CAPSTONE_OPENING_SOURCE.lower(),
        }, format="json")
        self.assertEqual(response.data["code"], "OPENING_SOURCE_RESERVED")


@pytest.mark.django_db(transaction=True)
def test_parallel_inventory_adjustments_cannot_overdraw():
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database()")
        assert cursor.fetchone()[0].startswith("test_cologi_cp11_")
    actor = User.objects.create_user(email="race-supplier@example.test", full_name="Isolated race")
    supplier = Supplier.objects.create(supplier_code="CP11-RACE", supplier_name="Isolated supplier")
    category = CargoCategory.objects.create(category_code="CP11-RACE", category_name="Isolated category")
    item = Item.objects.create(item_code="CP11-RACE", item_name="Isolated item", cargo_category=category)
    catalog = SupplierItem.objects.create(supplier=supplier, item=item, unit_price_vnd_per_kg=Decimal(1))
    params = dict(actor=actor, supplier_id=supplier.pk, supplier_item_id=catalog.pk, reason="Isolated concurrency",
                  source_reference="CP11-TEST")
    post_stock(**params, kind="OPENING", amount=Decimal(10), request_id=uuid4())
    start = Barrier(2)

    def try_adjust():
        try:
            start.wait(timeout=8)
            post_stock(**params, kind="ADJUST", amount=Decimal(-7), request_id=uuid4())
            return "APPLIED"
        except ExecutionBlocked as error:
            return str(error.detail["code"])
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as workers:
        outcomes = list(workers.map(lambda _: try_adjust(), range(2)))
    assert sorted(outcomes) == ["APPLIED", "INSUFFICIENT_AVAILABLE_STOCK"]
    assert StockBalance.objects.get().on_hand_kg == Decimal(3)
    assert InventoryTransaction.objects.filter(kind="ADJUST").count() == 1
