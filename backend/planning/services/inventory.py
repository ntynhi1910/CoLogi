"""Supplier stock and reservation accounting, always in the caller's transaction."""

from collections import defaultdict
from decimal import Decimal
from uuid import uuid4
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Q, Sum
from django.utils import timezone
from rest_framework.exceptions import APIException, NotFound

from accounts.capstone import actor_scenario
from demands.models import SupplierRequest
from masterdata.models import SupplierItem
from planning.models_execution import InventoryTransaction, StockBalance, StockReservation

CAPSTONE_STOCK_PROVENANCE = "SYNTHETIC/CP11_CAPSTONE"
CAPSTONE_OPENING_SOURCE = "MANAGER_APPROVED_OPENING_BALANCE"
CATALOG_OPENING_SOURCE = "SUPPLIER_DECLARED_CATALOG_OPENING"
PLANNING_OPENING_SOURCES = (CAPSTONE_OPENING_SOURCE, CATALOG_OPENING_SOURCE)
INTERNAL_STOCK_REFERENCE = "SYNTHETIC/INTERNAL:"
DECLARED_STOCK_REFERENCE = "SUPPLIER_DECLARED/INVENTORY:"


def unverified_stock_source():
    return (Q(source_reference__in=PLANNING_OPENING_SOURCES) |
            Q(source_reference__startswith=INTERNAL_STOCK_REFERENCE) |
            Q(source_reference__startswith=DECLARED_STOCK_REFERENCE))


class ExecutionBlocked(APIException):
    status_code = 409

    def __init__(self, code):
        super().__init__({"code": code})


def execution_context(actor):
    scenario = actor_scenario(actor)
    if settings.COLOGI_CP11_REHEARSAL:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database()")
            if not cursor.fetchone()[0].startswith("test_cologi_cp11"):
                raise ExecutionBlocked("INVALID_REHEARSAL_DATABASE")
        return scenario, "SYNTHETIC/CP11_REHEARSAL"
    if scenario:
        if scenario == settings.COLOGI_CP11_CAPSTONE_SCENARIO:
            return scenario, CAPSTONE_STOCK_PROVENANCE
        raise ExecutionBlocked("OPERATIONAL_CONTEXT_REQUIRED")
    return "", "OPERATIONAL"


def require_execution_enabled():
    if not settings.COLOGI_CP11_ENABLED:
        raise NotFound()


def lock_request(actor, request_id):
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                       [f"cp11:{actor.pk}:{request_id}"])


@transaction.atomic
def post_stock(*, actor, supplier_id, supplier_item_id, kind, amount, reason, source_reference, request_id,
               catalog_opening=False, reference_kind="COMMERCIAL"):
    scenario, _ = execution_context(actor)
    if (source_reference.casefold() in {source.casefold() for source in PLANNING_OPENING_SOURCES}
            and not (catalog_opening and kind == "OPENING" and source_reference == CATALOG_OPENING_SOURCE)):
        raise ExecutionBlocked("OPENING_SOURCE_RESERVED")
    if source_reference.casefold().startswith((INTERNAL_STOCK_REFERENCE.casefold(), DECLARED_STOCK_REFERENCE.casefold())):
        raise ExecutionBlocked("INTERNAL_STOCK_REFERENCE_RESERVED")
    if reference_kind == "DECLARED":
        if source_reference:
            raise ExecutionBlocked("DECLARED_STOCK_REFERENCE_AUTOMATIC")
        source_reference = DECLARED_STOCK_REFERENCE + str(request_id)
    internal = reference_kind == "INTERNAL"
    if internal:
        source_reference = INTERNAL_STOCK_REFERENCE + source_reference
        if len(source_reference) > 200:
            raise ExecutionBlocked("INTERNAL_STOCK_REFERENCE_TOO_LONG")
    lock_request(actor, request_id)
    # Serialize initialization on the existing masterdata key, including an empty ledger.
    catalog = SupplierItem.objects.select_for_update().filter(pk=supplier_item_id, supplier_id=supplier_id).first()
    if not catalog:
        raise NotFound()
    previous = InventoryTransaction.objects.filter(actor=actor, request_id=request_id).select_related("balance").first()
    if previous:
        if (previous.balance.supplier_item_id, previous.balance.scenario, previous.kind, previous.on_hand_delta_kg,
                previous.reason, previous.source_reference) != (
                    supplier_item_id, scenario, kind, amount, reason, source_reference):
            raise ExecutionBlocked("IDEMPOTENCY_KEY_REUSED")
        return previous, False
    balance = StockBalance.objects.select_for_update().filter(supplier_item=catalog, scenario=scenario).first()
    if internal and not scenario and (
        not balance or not InventoryTransaction.objects.filter(
            balance=balance, kind="OPENING", source_reference__in=PLANNING_OPENING_SOURCES,
        ).exists()
    ):
        raise ExecutionBlocked("INTERNAL_STOCK_REFERENCE_NOT_ALLOWED")
    if kind == "OPENING":
        if balance:
            raise ExecutionBlocked("STOCK_ALREADY_INITIALIZED")
        if amount < 0 or not source_reference:
            raise ExecutionBlocked("OPENING_STOCK_EVIDENCE_REQUIRED")
        balance = StockBalance.objects.create(supplier_item=catalog, scenario=scenario)
    elif not balance:
        raise ExecutionBlocked("OPENING_STOCK_REQUIRED")
    elif (kind == "INBOUND" and amount <= 0) or (kind == "ADJUST" and amount == 0):
        raise ExecutionBlocked("INVALID_STOCK_DELTA")
    return change_stock(balance, actor=actor, kind=kind, on_hand=amount, reason=reason, source=source_reference,
                        request_id=request_id), True


def change_stock(balance, *, actor, kind, on_hand=Decimal(0), reserved=Decimal(0), reason, source="",
                 reservation=None, event=None, request_id=None):
    next_on_hand = balance.on_hand_kg + on_hand
    next_reserved = balance.reserved_kg + reserved
    if not 0 <= next_reserved <= next_on_hand:
        raise ExecutionBlocked("INSUFFICIENT_AVAILABLE_STOCK")
    if next_on_hand > Decimal("99999999999.999"):
        raise ExecutionBlocked("STOCK_LIMIT_EXCEEDED")
    balance.on_hand_kg, balance.reserved_kg = next_on_hand, next_reserved
    balance.save(update_fields=["on_hand_kg", "reserved_kg", "updated_at"])
    return InventoryTransaction.objects.create(
        balance=balance, actor=actor, kind=kind, on_hand_delta_kg=on_hand, reserved_delta_kg=reserved,
        reason=reason, source_reference=source, reservation=reservation, event=event, request_id=request_id,
    )


def open_catalog_stock(*, actor, catalog, amount):
    return post_stock(actor=actor, supplier_id=catalog.supplier_id, supplier_item_id=catalog.pk,
                      kind="OPENING", amount=amount, reason="Supplier declared opening when adding a SKU",
                      source_reference=CATALOG_OPENING_SOURCE, request_id=uuid4(), catalog_opening=True)


def require_pickup_stock(reservations, quantities):
    """Exclude supplier declarations and simulation movements from commercial stock backing."""
    by_item = defaultdict(list)
    for row in reservations.select_related("promise__demand_item"):
        by_item[str(row.promise.demand_item.item_id)].append(row.balance_id)
    balances = StockBalance.objects.select_for_update().filter(
        pk__in={balance for ids in by_item.values() for balance in ids}, scenario="",
    ).order_by("pk")
    for balance in balances:
        planned = sum((weight for item, weight in quantities.items() if balance.pk in by_item[item]), Decimal(0))
        if planned <= 0:
            continue
        ledger = InventoryTransaction.objects.filter(balance=balance)
        unverified = unverified_stock_source()
        if not ledger.filter(unverified).exists():
            continue
        stock_entries = ("OPENING", "INBOUND")
        if not ledger.filter(unverified, kind="OPENING").exists():
            stock_entries += ("ADJUST",)
        documented = ledger.filter(kind__in=stock_entries, on_hand_delta_kg__gt=0).exclude(
            source_reference="").exclude(unverified).aggregate(
            total=Sum("on_hand_delta_kg", default=Decimal(0)))["total"]
        depleted = ledger.filter(on_hand_delta_kg__lt=0).aggregate(
            total=Sum("on_hand_delta_kg", default=Decimal(0)))["total"]
        if planned > documented + depleted:
            raise ExecutionBlocked("COMMERCIAL_STOCK_EVIDENCE_REQUIRED")


def reserve_confirmation(*, request, actor, promises, reconciliation_reference=""):
    scenario, _ = execution_context(actor)
    return reserve_commitment_stock(request=request, actor=actor, promises=promises, scenario=scenario,
                                    reconciliation_reference=reconciliation_reference)


def reserve_commitment_stock(*, request, actor, promises, scenario, reconciliation_reference=""):
    positive = [promise for promise in promises if promise.confirmed_weight_kg > 0]
    if not positive:
        return
    catalog_ids = {promise.supplier_item_id for promise in positive}
    balances = {row.supplier_item_id: row for row in StockBalance.objects.select_for_update().filter(
        supplier_item_id__in=catalog_ids, supplier_item__supplier_id=request.supplier_id, scenario=scenario,
    ).order_by("pk")}
    if catalog_ids != balances.keys():
        raise ExecutionBlocked("OPENING_STOCK_REQUIRED")
    for promise in positive:
        if StockReservation.objects.filter(promise=promise).exists():
            continue
        weight = promise.confirmed_weight_kg
        balance = balances[promise.supplier_item_id]
        reservation = StockReservation.objects.create(promise=promise, balance=balance, held_kg=weight, remaining_kg=weight)
        change_stock(balance, actor=actor, kind="RESERVE", reserved=weight, reservation=reservation,
                     reason="Supplier commitment", source=reconciliation_reference)


@transaction.atomic
def reconcile_commitment(*, actor, supplier_id, request_id, source_reference):
    from demands.models import DeliveryDemand, DemandStatus, SupplierConfirmation, SupplierItemPromise

    scenario, _ = execution_context(actor)
    row = SupplierRequest.objects.filter(pk=request_id, supplier_id=supplier_id, demand__capstone_scenario=scenario).first()
    if not row:
        raise NotFound()
    demand = DeliveryDemand.objects.select_for_update().get(pk=row.demand_id)
    business_day = timezone.localdate(timezone=ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE))
    if demand.requested_date < business_day:
        raise ExecutionBlocked("PAST_COMMITMENT_REQUIRES_RECONCILIATION_POLICY")
    latest = SupplierRequest.objects.select_for_update().filter(demand=demand).order_by("-attempt_no", "-pk").first()
    if latest.pk != row.pk or latest.request_status != SupplierRequest.RequestStatus.RESPONDED or demand.status == DemandStatus.CANCELLED:
        raise ExecutionBlocked("COMMITMENT_NOT_CURRENT")
    confirmation = SupplierConfirmation.objects.select_for_update().get(pk=row.supplier_confirmation_id)
    if (confirmation.confirmation_status not in ("CONFIRMED", "PARTIAL")
            or confirmation.commitment_released_at is not None):
        raise ExecutionBlocked("COMMITMENT_NOT_ACTIVE")
    promises = list(SupplierItemPromise.objects.select_for_update().filter(supplier_request=row).order_by("pk"))
    reserve_confirmation(request=row, actor=actor, promises=promises, reconciliation_reference=source_reference)


def release_ended_commitments(*, demand, actor, request=None, scenario=None, reason="Supplier commitment released"):
    rows = StockReservation.objects.select_for_update().filter(
        promise__supplier_request__demand=demand, remaining_kg__gt=0,
        promise__supplier_request__supplier_confirmation__commitment_released_at__isnull=False,
    ).order_by("balance_id", "pk")
    if request is not None:
        rows = rows.filter(promise__supplier_request=request)
    if scenario is not None:
        rows = rows.filter(balance__scenario=scenario)
    for row in rows:
        balance = StockBalance.objects.select_for_update().get(pk=row.balance_id)
        change_stock(balance, actor=actor, kind="RELEASE", reserved=-row.remaining_kg, reservation=row,
                     reason=reason, source=f"CP12_SUPPLY_CANCELLATION:{request.pk}" if request else "")
        row.remaining_kg = Decimal(0)
        row.save(update_fields=["remaining_kg"])


def pickup_reservations(demand_id, supplier_id):
    active = SupplierRequest.objects.filter(demand_id=demand_id).order_by("-attempt_no", "-pk").first()
    if (not active or active.supplier_id != supplier_id or active.supplier_confirmation.commitment_released_at
            or active.supplier_confirmation.confirmation_status not in ("CONFIRMED", "PARTIAL")):
        raise ExecutionBlocked("COMMITMENT_NOT_ACTIVE")
    return StockReservation.objects.filter(promise__supplier_request=active)


def settle_pickup(*, event, supplier_id, quantities):
    rows = list(pickup_reservations(event.demand_id, supplier_id).select_for_update(of=("self",))
                .select_related("promise__demand_item").order_by("balance_id", "pk"))
    by_item = defaultdict(list)
    for row in rows:
        by_item[str(row.promise.demand_item.item_id)].append(row)
    for item, weight in quantities.items():
        if weight <= 0:
            continue
        matches = by_item[item]
        if len(matches) != 1 or matches[0].remaining_kg < weight:
            raise ExecutionBlocked("PICKUP_RESERVATION_MISSING_OR_INSUFFICIENT")
        row = matches[0]
        balance = StockBalance.objects.select_for_update().get(pk=row.balance_id)
        change_stock(balance, actor=event.actor, kind="PICKUP", on_hand=-weight, reserved=-weight,
                     reservation=row, event=event, reason="Supplier and carrier confirmed pickup")
        row.remaining_kg -= weight
        row.save(update_fields=["remaining_kg"])
