"""Apply the Manager-approved opening inventory in the selected context."""

import json
from collections import Counter, defaultdict
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.models import Prefetch
from django.utils import timezone

from accounts.models import RoleCode, User
from demands.models import SupplierConfirmation, SupplierItemPromise, SupplierRequest
from masterdata.models import SupplierItem
from planning.models_execution import InventoryTransaction, StockBalance, StockReservation
from planning.services.inventory import CAPSTONE_OPENING_SOURCE, change_stock, reserve_commitment_stock

SCENARIO = "v7-supplement-v1"
AMOUNT = Decimal("15000.000")
APPROVAL = "CP11 live deployment approval / Capstone initialization"
OPERATIONAL_APPROVAL = "CP11 final refinement / Manager-approved simulated opening for internal planning"
MANAGER_ID = 1


@transaction.atomic
def bootstrap(database, *, apply=False, operational=False):
    scenario = "" if operational else SCENARIO
    approval = OPERATIONAL_APPROVAL if operational else APPROVAL
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database(), to_regclass('inventory_balances') IS NOT NULL")
        connected, storage = cursor.fetchone()
    if connected != database or not (connected == "cologi" or connected.startswith(
        ("test_cologi_cp11_deploy_", "test_cologi_cp11_refine_")
    )):
        raise CommandError("The verified database does not match the approved deployment target.")
    if apply and not storage:
        raise CommandError("Apply planning/0013 before opening balances.")
    if apply:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [f"cp11:opening:{scenario}"])
            cursor.execute("LOCK TABLE supplier_requests, supplier_confirmations, supplier_item_promises, "
                           "delivery_demands, supplier_items IN SHARE ROW EXCLUSIVE MODE")
    actor = User.objects.filter(pk=MANAGER_ID, is_active=True, capstone_scenario="", user_roles__is_active=True,
                                user_roles__role__code=RoleCode.MANAGER, user_roles__role__is_active=True).first()
    if actor is None:
        raise CommandError("The approved Manager actor is unavailable.")
    mappings = list(SupplierItem.objects.select_related("supplier", "item").order_by("pk"))
    if not mappings or any(row.item.weight_unit != "KG" for row in mappings):
        raise CommandError("Opening batch requires existing Supplier–SKU mappings in KG.")
    balances = {row.supplier_item_id: row for row in StockBalance.objects.filter(scenario=scenario)} if storage else {}
    all_reservations = set(StockReservation.objects.values_list("promise_id", flat=True)) if storage else set()
    baselines = {row.balance.supplier_item_id: row for row in InventoryTransaction.objects.filter(
        balance__scenario=scenario, kind="OPENING", source_reference=CAPSTONE_OPENING_SOURCE,
    ).select_related("balance")} if storage else {}
    for row in mappings:
        if row.pk in balances and row.pk in baselines and baselines[row.pk].on_hand_delta_kg != AMOUNT:
            raise CommandError(f"Opening amount differs for SupplierItem {row.pk}.")
    available = {row.pk: balances[row.pk].on_hand_kg - balances[row.pk].reserved_kg
                 if row.pk in balances else AMOUNT for row in mappings}

    now = timezone.localtime(timezone.now(), ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE))
    requests = SupplierRequest.objects.select_related("demand", "supplier_confirmation", "supplier").prefetch_related(
        Prefetch("item_promises", queryset=SupplierItemPromise.objects.select_related("supplier_item__item", "demand_item")),
    ).filter(demand__requested_date__gte=now.date(), demand__capstone_scenario=scenario).order_by(
        "demand_id", "-attempt_no", "-pk").distinct("demand_id")
    excluded, selected, blocked = [], [], []
    reserve_by_request = []
    for row in requests:
        confirmation, demand = row.supplier_confirmation, row.demand
        if row.request_status != "RESPONDED" or confirmation.confirmation_status not in ("CONFIRMED", "PARTIAL"):
            continue
        lines = [promise for promise in row.item_promises.all() if promise.confirmed_weight_kg > 0]
        if not lines:
            continue
        item = {"demand": demand.demand_code, "request_id": row.pk, "confirmation_id": confirmation.pk,
                "supplier": row.supplier.supplier_code, "scenario": demand.capstone_scenario or "OPERATIONAL",
                "date": demand.requested_date.isoformat(), "source": confirmation.source_mode,
                "kg": format(sum(promise.confirmed_weight_kg for promise in lines), "f")}
        if demand.status == "CANCELLED" or confirmation.commitment_released_at is not None:
            code = "COMMITMENT_ENDED"
        elif (demand.supplier_id != row.supplier_id or confirmation.supplier_id != row.supplier_id
              or confirmation.demand_id != demand.pk):
            code = "COMMITMENT_SCOPE_MISMATCH"
        elif (confirmation.ready_date is None or confirmation.ready_start_time is None
              or confirmation.ready_end_time is None or confirmation.ready_start_time >= confirmation.ready_end_time):
            code = "PICKUP_WINDOW_MISSING"
        elif confirmation.ready_date > demand.requested_date:
            code = "F1_DATE_SEQUENCE_INVALID"
        elif (confirmation.ready_date < now.date()
              or confirmation.ready_date == now.date() and confirmation.ready_end_time <= now.time()
              or demand.requested_date == now.date() and demand.requested_end_time <= now.time()):
            code = "SERVICE_WINDOW_ELAPSED"
        elif any(promise.demand_item.demand_id != demand.pk or promise.supplier_item.supplier_id != row.supplier_id
                 or promise.demand_item.item_id != promise.supplier_item.item_id
                 or promise.demand_item.unit_of_measure != "KG"
                 or promise.supplier_item.item.weight_unit != "KG" for promise in lines):
            code = "SKU_UNIT_OR_SCOPE_MISMATCH"
        elif confirmation.source_mode != (SupplierConfirmation.SourceMode.LIVE_API if operational else
                                          SupplierConfirmation.SourceMode.SYNTHETIC_CAPSTONE):
            code = "COMMITMENT_PROVENANCE_NOT_ELIGIBLE"
        elif (not row.supplier.is_active or any(promise.supplier_item.offer_status != "ACTIVE"
                                                or not promise.supplier_item.item.is_active for promise in lines)):
            code = "INACTIVE_SUPPLY_MAPPING"
        else:
            code = None
        if code:
            excluded.append({**item, "reason": code, "ready_date": str(confirmation.ready_date)})
            continue
        needed = defaultdict(Decimal)
        new_lines = []
        for promise in lines:
            if promise.pk not in all_reservations:
                needed[promise.supplier_item_id] += promise.confirmed_weight_kg
                new_lines.append(promise)
        shortage = {pk: {"required": str(kg), "available": str(available[pk])}
                    for pk, kg in needed.items() if kg > available[pk]}
        if shortage:
            blocked.append({**item, "reason": "INSUFFICIENT_AVAILABLE_STOCK", "supplier_items": shortage})
            continue
        for key, quantity in needed.items():
            available[key] -= quantity
        selected.append({**item, "new_promise_ids": [promise.pk for promise in new_lines],
                         "new_reserved_kg": str(sum(needed.values(), Decimal(0)))})
        if new_lines:
            reserve_by_request.append((row, new_lines))
    if blocked and apply:
        raise CommandError(json.dumps({"reservation_blockers": blocked}, ensure_ascii=True))
    new_mappings = [row for row in mappings if row.pk not in balances]
    if apply:
        for row in new_mappings:
            balance = StockBalance.objects.create(supplier_item=row, scenario=scenario)
            change_stock(balance, actor=actor, kind="OPENING", on_hand=AMOUNT, reason=approval,
                         source=CAPSTONE_OPENING_SOURCE, request_id=uuid5(NAMESPACE_URL, f"cologi/{scenario}/cp11/opening/{row.pk}"))
        for row, promises in reserve_by_request:
            reserve_commitment_stock(request=row, actor=actor, promises=promises, scenario=scenario,
                                     reconciliation_reference=f"{approval}; CP6 request {row.pk}; confirmation {row.supplier_confirmation_id}")
    return {"database": database, "scenario": scenario or "OPERATIONAL", "source_reference": CAPSTONE_OPENING_SOURCE,
            "opening_provenance": "MANAGER_APPROVED_SYNTHETIC", "existing_balances": len(balances),
            "supplier_count": len({row.supplier_id for row in mappings}), "sku_count": len({row.item_id for row in mappings}),
            "mapping_count": len(mappings), "mapping_ids": [row.pk for row in mappings],
            "mapping_supplier_status": dict(Counter("ACTIVE" if row.supplier.is_active else "INACTIVE" for row in mappings)),
            "unit": "KG", "approved_opening_kg": str(AMOUNT * len(mappings)), "new_openings": len(new_mappings),
            "new_opening_kg": str(AMOUNT * len(new_mappings)), "existing_openings": len(baselines),
            "reconciled": selected, "excluded": excluded, "reservation_blockers": blocked}


class Command(BaseCommand):
    help = "Preview the approved opening ledger and currently valid reservations."

    def add_arguments(self, parser):
        parser.add_argument("--target", required=True)
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--operational", action="store_true")

    def handle(self, *args, **options):
        self.stdout.write(json.dumps(bootstrap(options["target"], apply=options["apply"],
                                              operational=options["operational"]), indent=2))
