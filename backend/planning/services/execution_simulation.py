"""Version-scoped simulation using existing append-only execution and stock ledgers."""

from collections import defaultdict
from datetime import datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from planning.models_execution import ExecutionEvent, InventoryTransaction, StockBalance
from planning.services.inventory import ExecutionBlocked, change_stock, pickup_reservations, unverified_stock_source

SIMULATION = "SIMULATION"
COMMERCIAL_EXECUTION = "COMMERCIAL_EXECUTION"
APPROVAL_ACTION = "SIMULATION_AUTHORIZED"


def approval_for(plan):
    return ExecutionEvent.objects.filter(plan=plan, provenance=SIMULATION, action=APPROVAL_ACTION).first()


def simulated_time(approval, recorded_at):
    return datetime.fromisoformat(approval.reason) + (recorded_at - approval.occurred_at)


def validate_fleet_snapshot(plan):
    """Apply the sealed F4 fleet limit inside this plan's simulation only."""
    f4 = plan.snapshot["f4"]
    zone = ZoneInfo(f4["configuration"]["timezone"])
    intervals = defaultdict(list)
    for wave in f4["result"]["waves"]:
        vehicle = wave["vehicle"]
        start = datetime.fromisoformat(wave["stops"][0]["arrival"]).astimezone(zone)
        end = datetime.fromisoformat(wave["stops"][-1]["departure"]).astimezone(zone)
        if start >= end or start.date() != end.date():
            raise ExecutionBlocked("FLEET_WINDOW_INVALID")
        captured = [
            window["count"] for window in vehicle["windows"]
            if window["status"] == "AVAILABLE" and window["service_date"] == start.date().isoformat()
            and time.fromisoformat(window["start_time"]) <= start.time()
            and time.fromisoformat(window["end_time"]) >= end.time()
        ]
        if not captured:
            raise ExecutionBlocked("SIMULATION_FLEET_SNAPSHOT_REQUIRED")
        offer = vehicle["offer_id"]
        capacity = min(*captured, int(vehicle["available_vehicle_count"]))
        intervals[offer].append((start, end, capacity))
    if not intervals:
        raise ExecutionBlocked("SIMULATION_FLEET_SNAPSHOT_REQUIRED")
    for waves in intervals.values():
        for instant in {left for left, _, _ in waves}:
            limits = [capacity for start, end, capacity in waves if start <= instant < end]
            if len(limits) > min(limits):
                raise ExecutionBlocked("FLEET_CAPACITY_RESERVED")


def validate_pickup(plan, demand_id, supplier_id, quantities):
    reservations = list(pickup_reservations(demand_id, supplier_id).filter(balance__scenario="")
                        .select_related("promise__demand_item", "balance").order_by("balance_id"))
    by_item = {str(row.promise.demand_item.item_id): row for row in reservations}
    if not by_item or any(item not in by_item or by_item[item].held_kg < weight
                          for item, weight in quantities.items() if weight > 0):
        raise ExecutionBlocked("PICKUP_RESERVATION_MISSING_OR_INSUFFICIENT")
    scenario = f"cp11-sim:{plan.pk}"
    # Every version has its own balance. A rehearsal never consumes the live CP6 hold.
    openings = {row.balance_id: row for row in InventoryTransaction.objects.filter(
        unverified_stock_source(), balance_id__in=[row.balance_id for row in reservations], kind="OPENING")}
    shadows = {row.supplier_item_id: row for row in StockBalance.objects.select_for_update().filter(
        supplier_item_id__in=[row.balance.supplier_item_id for row in reservations], scenario=scenario).order_by("pk")}
    result = []
    for item, weight in quantities.items():
        if weight <= 0:
            continue
        reservation = by_item[item]
        catalog = reservation.balance.supplier_item_id
        opening = openings.get(reservation.balance_id)
        if opening is None:
            raise ExecutionBlocked("SIMULATION_OPENING_REQUIRED")
        shadow = shadows.get(catalog)
        if weight > (shadow.on_hand_kg if shadow else opening.on_hand_delta_kg):
            raise ExecutionBlocked("INSUFFICIENT_AVAILABLE_STOCK")
        result.append((catalog, opening, shadow, weight))
    return result


def settle_simulation_pickup(event, supplier_id, quantities):
    for catalog, opening, balance, weight in validate_pickup(event.plan, event.demand_id, supplier_id, quantities):
        source = f"SIMULATION / FinalPlan {event.plan_id} / Opening ledger {opening.pk}"
        if balance is None:
            balance = StockBalance.objects.create(supplier_item_id=catalog, scenario=f"cp11-sim:{event.plan_id}")
            change_stock(balance, actor=event.actor, kind="OPENING", on_hand=opening.on_hand_delta_kg,
                         reason="Simulation copy of the approved opening", source=source, event=event)
        change_stock(balance, actor=event.actor, kind="PICKUP", on_hand=-weight,
                     reason="Simulated pickup agreed by Supplier and Carrier", source=source, event=event)
