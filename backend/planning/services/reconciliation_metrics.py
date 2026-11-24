"""CP12 comparisons from immutable execution events and captured F2–F5 inputs."""

from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from planning.f3_contract import fingerprint


ZERO = Decimal(0)
MEASURES = {
    "SUPPLIER_HANDOVER": "supplier_handover", "CARRIER_PICKUP": "carrier_pickup",
    "PICKUP_COMPLETE": "shipped", "HUB_RECEIVE": "hub_received", "HUB_DISPATCH": "hub_dispatched",
    "DELIVER": "delivered", "RECEIVE": "received",
}
PICKUP = {"PICKUP_COMPLETE", "HUB_DISPATCH"}
UNLOAD = {"HUB_RECEIVE", "DELIVER"}


def _sum_known(values):
    known = [value for value in values if value is not None]
    return sum(known, ZERO) if known else None


def percent(numerator, denominator):
    return (100 * Decimal(numerator) / denominator).quantize(Decimal(".01")) if numerator is not None and denominator else None


def _event_time(event):
    return event.get("simulation_at") or event["occurred_at"]


def _stop_time(event, window, zone):
    if not event or not window or not all(window.get(key) for key in ("start_time", "end_time")):
        return None, None
    captured = _event_time(event)
    instant = datetime.fromisoformat(captured) if isinstance(captured, str) else captured
    start, end = (datetime.fromisoformat(window["date"] + "T" + window[key]).replace(tzinfo=zone)
                  for key in ("start_time", "end_time"))
    delay = Decimal(str(max(0, (instant - end).total_seconds()))) / 60
    return start <= instant <= end, delay.quantize(Decimal(".01"))


def _weights(rows, action, item):
    return _sum_known(Decimal(row["quantities"][str(item)]) for row in rows
                      if row["action"] == action and str(item) in row["quantities"])


def _issue(key, demand, item, codes, quantity, evidence):
    return {"key": key, "demand_id": demand, "item_id": item, "codes": codes, "unresolved_kg": quantity,
            "fingerprint": fingerprint([key, codes, quantity, evidence])}


def build_goods(projection, basis, events):
    members = {row["id"]: row for row in basis}
    by_demand = defaultdict(list)
    for event in events:
        by_demand[event["demand_id"]].append(event)
    lines, demands, issues = [], [], []
    zone = ZoneInfo(projection["timezone"])
    for demand in projection["demands"]:
        pk = demand["id"]
        planned = members[pk]
        latest = {(row["action"], row["wave"], row["stop"]): row for row in by_demand[pk] if row["action"] in MEASURES}
        current = list(latest.values())
        shipment = next((row for row in reversed(current) if row["action"] == "PICKUP_COMPLETE"), None)
        receipt = next((row for row in reversed(current) if row["action"] == "RECEIVE"), None)
        pickup_time, _ = _stop_time(shipment, {
            "date": planned.get("pickup_ready_date") or projection["service_date"],
            "start_time": planned.get("pickup_ready_start_time"), "end_time": planned.get("pickup_ready_end_time"),
        }, zone)
        delivery_time, delay = _stop_time(receipt, {
            "date": planned.get("requested_date") or projection["service_date"],
            "start_time": planned.get("requested_start_time"), "end_time": planned.get("requested_end_time"),
        }, zone)
        demand_lines = []
        for item in demand["items"]:
            weight = Decimal(item["weight_kg"])
            actual = {label: _weights(current, action, item["id"]) for action, label in MEASURES.items()}
            received = actual["received"]
            supplier, carrier = actual["supplier_handover"], actual["carrier_pickup"]
            shipped, arrived, dispatched, delivered = (actual[key] for key in (
                "shipped", "hub_received", "hub_dispatched", "delivered"))
            if received is not None:
                short = max(ZERO, weight - received)
            else:
                short = max(ZERO, weight - shipped) if shipped is not None else None
            custody_pairs = ((shipped, arrived), (arrived, dispatched), (dispatched, delivered)) if projection["hub"] else (
                (shipped, delivered),)
            differences = [abs(left - right) for left, right in (*custody_pairs, (delivered, received))
                           if left is not None and right is not None]
            gap = max(differences) if differences else None
            mismatch = abs(supplier - carrier) if supplier is not None and carrier is not None else None
            excess = max(ZERO, received - weight) if received is not None else None
            codes = [code for code, value in (("SHORTAGE", short), ("SURPLUS", excess), ("CUSTODY_MISMATCH", gap),
                                              ("PICKUP_QUANTITY_MISMATCH", mismatch)) if value]
            unresolved = max((value for value in (short, excess, gap, mismatch) if value is not None), default=None)
            line = {**item, "demand_id": pk, "demand_code": demand["code"], "supplier": demand["supplier"],
                    "outlet": demand["outlet"], "planned_kg": weight, **{key + "_kg": value for key, value in actual.items()},
                    "shortage_kg": short, "excess_kg": excess, "custody_gap_kg": gap,
                    "unreconciled_kg": unresolved, "damaged_kg": None, "refused_kg": None, "returned_kg": None}
            demand_lines.append(line)
            if codes:
                issues.append(_issue(f"line:{pk}:{item['id']}", pk, item["id"], codes, unresolved,
                                     [actual, weight]))
        lines.extend(demand_lines)
        acceptance = _sum_known(line["received_kg"] for line in demand_lines)
        complete = bool(demand_lines) and all(line["received_kg"] == line["planned_kg"] for line in demand_lines)
        demands.append({**{key: demand[key] for key in ("id", "code", "supplier", "outlet")},
                        "planned_kg": Decimal(demand["weight_kg"]), "received_kg": acceptance,
                        "pickup_at": _event_time(shipment) if shipment else None,
                        "received_at": _event_time(receipt) if receipt else None,
                        "pickup_on_time": pickup_time, "delivery_on_time": delivery_time, "delivery_delay_min": delay,
                        "completed": complete, "otif": delivery_time and complete if delivery_time is not None else None})
        for event in by_demand[pk]:
            code = event["exception_code"]
            if code and code not in {"PICKUP_QUANTITY_MISMATCH", "SHORT_PICKUP", "RECEIPT_DISCREPANCY"}:
                issues.append(_issue(f"event:{event['id']}", pk, None, [code], None, [event["id"], code]))
    return {"lines": lines, "demands": demands, "issues": issues}


def build_waves(projection, planned_waves, events, include_load):
    planned_by_wave = {row["wave_no"]: row for row in planned_waves}
    groups = defaultdict(list)
    for event in events:
        groups[event["wave"]].append(event)
    result = []
    for wave in projection["waves"]:
        planned = planned_by_wave[wave["number"]]
        capacity = planned["vehicle"].get("capacity_kg")
        balance = peak = ZERO
        measured = False
        milestones = defaultdict(list)
        for event in groups[wave["number"]]:
            action = event["action"]
            milestones[event["stop"]].append({key: event[key] for key in ("action", "demand_id", "occurred_at")} |
                                             {"time": _event_time(event)})
            if action in PICKUP | UNLOAD:
                quantity = sum(map(Decimal, event["quantities"].values()), ZERO)
                balance += quantity if action in PICKUP else -quantity
                peak = max(peak, balance)
                measured = True
        distance = [Decimal(stop["travel_from_previous"]["distance_km"])
                    for stop in planned["stops"] if (stop.get("travel_from_previous") or {}).get("distance_km") is not None]
        result.append({
            "number": wave["number"], "phase": wave["phase"], "vehicle": wave["vehicle"],
            "capacity_kg": Decimal(capacity) if include_load and capacity is not None else None,
            "planned_load_kg": Decimal(planned["weight_kg"]) if include_load else None,
            "peak_actual_load_kg": peak if include_load and measured else None,
            "planned_distance_km": _sum_known(distance) if include_load and len(distance) == len(planned["stops"]) - 1 else None,
            "stops": [{key: stop[key] for key in ("sequence", "role", "code", "start", "end")} |
                      {"demand_ids": [load["demand_id"] for load in stop["loads"]],
                       "actual": milestones[stop["sequence"]]} for stop in wave["stops"]],
        })
    return result


def kpis(plans):
    demands = [demand for plan in plans for demand in plan["demands"]]
    lines = [line for plan in plans for line in plan["lines"]]
    waves = [wave for plan in plans for wave in plan["waves"] if wave["peak_actual_load_kg"] is not None and wave["capacity_kg"]]
    costs = [plan["cost"] for plan in plans if plan["cost"] is not None]
    actual = [cost for cost in costs if cost["actual_vnd"] is not None]
    issues = {(plan["code"], issue["demand_id"]) for plan in plans for issue in plan["issues"]}
    received = [line for line in lines if line["received_kg"] is not None]
    delays = [demand["delivery_delay_min"] for demand in demands if demand["delivery_delay_min"] is not None]
    active = any(plan["started"] for plan in plans)
    def rate(field):
        known = [row[field] for row in demands if row[field] is not None]
        return percent(sum(known), len(known))
    return {
        "final_plans": len(plans), "demands": len({row["id"] for row in demands}),
        "shipped_kg": _sum_known(line["shipped_kg"] for line in lines),
        "received_kg": _sum_known(line["received_kg"] for line in lines),
        "completion_pct": percent(sum(row["completed"] for row in demands), len(demands)) if active else None,
        "on_time_pickup_pct": rate("pickup_on_time"), "on_time_delivery_pct": rate("delivery_on_time"), "otif_pct": rate("otif"),
        "fill_pct": percent(_sum_known(min(row["received_kg"], row["planned_kg"]) for row in received),
                            sum((row["planned_kg"] for row in received), ZERO)),
        "load_factor_pct": percent(_sum_known(wave["peak_actual_load_kg"] for wave in waves),
                                   sum((wave["capacity_kg"] for wave in waves), ZERO)),
        "planned_saving_pct": percent(_sum_known(cost["planned_saving_vnd"] for cost in costs),
                                      sum((cost["baseline_vnd"] for cost in costs if cost["baseline_vnd"] is not None), ZERO)),
        "actual_saving_pct": percent(_sum_known(cost["actual_saving_vnd"] for cost in actual),
                                     sum((cost["baseline_vnd"] for cost in actual if cost["baseline_vnd"] is not None), ZERO)),
        "actual_cost_per_kg": (sum((cost["actual_vnd"] for cost in actual), ZERO) /
                               sum((cost["received_kg"] for cost in actual), ZERO)).quantize(Decimal(".01"))
                              if actual and all(cost["received_kg"] for cost in actual) else None,
        "exception_pct": percent(len(issues), len(demands)) if active else None,
        "average_delivery_delay_min": (sum(delays, ZERO) / len(delays)).quantize(Decimal(".01")) if delays else None,
    }
