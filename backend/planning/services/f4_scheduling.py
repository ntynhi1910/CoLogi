"""Deterministic, same-service-day scheduling on the allocations of one saved F3 revision."""

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo


PASS, HARD, SOFT, UNKNOWN = "PASS", "HARD_CONFLICT", "SOFT_CONFLICT", "NOT_EVALUATED"
_SCHEDULE_PREFERENCE = {HARD: 0, UNKNOWN: 1, SOFT: 2, PASS: 3}
RULES = {
    "RULE-16": {"expression": "planned within receiving window", "rule_type": "B"},
    "RULE-17": {"expression": "interval overlap check", "rule_type": "B/W"},
    "RULE-18": {"expression": "no unresolved hard conflict", "rule_type": "B"},
    "RULE-19": {"expression": "human selects alternate slot", "rule_type": "B"},
}


def aggregate(statuses):
    for status in (HARD, SOFT, UNKNOWN):
        if status in statuses:
            return status
    return PASS if statuses else UNKNOWN


def issue(code, **details):
    return {"code": code, **details}


def _overlap(a, b, c, d):
    return a < d and c < b


def _minutes(delta):
    return round(delta.total_seconds() / 60, 6)


@dataclass
class Visit:
    key: str
    role: str
    stop: dict
    members: list[dict]

    @property
    def window(self):
        if self.role == "SUPPLIER_PICKUP":
            first, last = "pickup_ready_start_time", "pickup_ready_end_time"
        elif self.role == "OUTLET_DELIVERY":
            first, last = "requested_start_time", "requested_end_time"
        else:
            return None
        return max(time.fromisoformat(row[first]) for row in self.members), min(
            time.fromisoformat(row[last]) for row in self.members
        )


def wave_visits(f2, wave):
    """One visit per pickup/outlet in a wave, with the same Demand mapping as the frozen allocation."""
    demand_by_id = {row["id"]: row for row in f2["basis"]["demands"]}
    stop_by_key = {row["key"]: row for row in f2["option"]["stops"]}
    visits = []
    for field, role in (
        ("from_stop", "HUB_DISPATCH" if wave["phase"] == "OUTBOUND" else "SUPPLIER_PICKUP"),
        ("to_stop", "HUB_RECEIVE" if wave["phase"] == "INBOUND" else "OUTLET_DELIVERY"),
    ):
        by_stop = defaultdict(list)
        for allocation in wave["allocations"]:
            by_stop[allocation[field]].append(demand_by_id[allocation["demand_id"]])
        stops = [Visit(key, role, stop_by_key[key], sorted(rows, key=lambda row: row["id"])) for key, rows in by_stop.items()]
        visits.extend(sorted(stops, key=lambda visit: (visit.window[1] if visit.window else time.max, visit.stop["entity_id"])))
    return visits


def _stop_result(visit, sequence):
    window = visit.window
    return {
        "sequence": sequence, "stop": visit.stop["key"], "role": visit.role,
        "entity_id": visit.stop["entity_id"], "code": visit.stop["code"],
        "demand_ids": [row["id"] for row in visit.members],
        "demand_codes": [row["code"] for row in visit.members],
        "weight_kg": str(sum(Decimal(row["required_weight_kg"]) for row in visit.members)),
        "status": UNKNOWN, "conflict_type": None, "arrival": None, "service_start": None, "service_end": None,
        "departure": None, "wait_minutes": None, "travel_from_previous": None, "evidence": {}, "diagnostics": [],
        "alternate_slots": [],
        "requested_window": {"start_time": window[0], "end_time": window[1]} if window else None,
        "receiving_windows": [],
    }


class Scheduler:
    def __init__(self, f2, cp7, evidence, timezone, parameters):
        self.f2 = f2
        self.day = date.fromisoformat(f2["basis"]["requested_date"])
        self.zone = ZoneInfo(timezone)
        self.offers = {row["id"]: row for row in cp7["offers"]}
        self.travel = {(row["from_stop"], row["to_stop"]): row for row in evidence["travel"]}
        self.services = {(row["stop"], row["role"]): row for row in evidence["services"]}
        self.hubs = defaultdict(list)
        for row in evidence["hub_windows"]:
            self.hubs[row["stop"]].append(row)
        self.calendars = {row["outlet_id"]: row for row in evidence["receiving"]}
        self.parameters = parameters
        self.reservations = defaultdict(list)
        self.inbound_completed = {}

    def _stamp(self, value):
        if isinstance(value, str):
            value = time.fromisoformat(value)
        return datetime.combine(self.day, value, tzinfo=self.zone)

    def _interval(self, record, start="start_time", end="end_time"):
        return self._stamp(record[start]), self._stamp(record[end])

    def describe_wave(self, wave):
        visits = wave_visits(self.f2, wave)
        result = {
            "wave_no": wave["wave_no"], "phase": wave["phase"], "vehicle": wave["vehicle"],
            "demand_ids": sorted(row["demand_id"] for row in wave["allocations"]),
            "weight_kg": wave["allocated_weight_kg"], "status": UNKNOWN, "receiving_status": UNKNOWN,
            "start": None, "end": None, "stops": [_stop_result(visit, n) for n, visit in enumerate(visits, 1)],
            "diagnostics": [], "fleet_evidence": [],
        }
        frozen = self.offers[wave["vehicle"]["offer_id"]]
        offer = {**frozen, "windows": [row for row in frozen["windows"] if row["service_date"] == self.day.isoformat()]}
        result["operating_hours"] = {"start_time": offer["operating_start"], "end_time": offer["operating_end"]}
        if not offer["operating_start"] or not offer["operating_end"]:
            result["diagnostics"].append(issue("OPERATING_HOURS_REQUIRED", offer_id=offer["id"]))
        if not offer["windows"]:
            result["diagnostics"].append(issue("VEHICLE_AVAILABILITY_REQUIRED", offer_id=offer["id"]))
        for index, (visit, stop) in enumerate(zip(visits, result["stops"], strict=True)):
            service = self.services.get((visit.key, visit.role))
            if service is None:
                stop["diagnostics"].append(issue("SERVICE_DURATION_REQUIRED", stop=visit.key, role=visit.role))
            else:
                stop["evidence"]["service"] = service
            if visit.role == "SUPPLIER_PICKUP":
                stop["evidence"]["supplier_confirmations"] = [
                    {key: row[key] for key in ("id", "supplier_confirmation_id", "pickup_ready_date",
                                               "pickup_ready_start_time", "pickup_ready_end_time")}
                    for row in visit.members
                ]
                if any(row["pickup_ready_date"] != self.day.isoformat() for row in visit.members):
                    stop["diagnostics"].append(issue("PICKUP_DATE_MISMATCH", stop=visit.key))
            if visit.role == "OUTLET_DELIVERY":
                stop["evidence"]["requested_windows"] = [
                    {key: row[key] for key in ("id", "requested_start_time", "requested_end_time")}
                    for row in visit.members
                ]
                calendar = self.calendars.get(visit.stop["entity_id"])
                if not calendar or not calendar["windows"]:
                    stop["diagnostics"].append(issue("RECEIVING_WINDOWS_REQUIRED", stop=visit.key, outlet_id=visit.stop["entity_id"]))
                if not calendar or calendar["slots"] is None:
                    stop["diagnostics"].append(issue("RECEIVING_SLOTS_REQUIRED", stop=visit.key, outlet_id=visit.stop["entity_id"]))
                if calendar:
                    stop["evidence"]["receiving_calendar"] = calendar
                    stop["receiving_windows"] = calendar["windows"]
            if visit.role.startswith("HUB_"):
                if not self.hubs[visit.key]:
                    stop["diagnostics"].append(issue("HUB_HOURS_REQUIRED", stop=visit.key))
                else:
                    stop["evidence"]["hub_windows"] = self.hubs[visit.key]
            if index:
                previous = visits[index - 1].key
                leg = self.travel.get((previous, visit.key))
                if leg is None:
                    stop["diagnostics"].append(issue("TRAVEL_EVIDENCE_REQUIRED", from_stop=previous, to_stop=visit.key))
                else:
                    stop["travel_from_previous"] = leg
        return visits, result, offer

    def _select_service(self, visit, arrival, duration):
        if visit.role == "SUPPLIER_PICKUP":
            site = self.services.get((visit.key, visit.role), {}).get("site_hours")
            windows = [{
                "start_time": max(visit.window[0], time.fromisoformat(site["start_time"])) if site else visit.window[0],
                "end_time": min(visit.window[1], time.fromisoformat(site["end_time"])) if site else visit.window[1],
            }]
        elif visit.role == "OUTLET_DELIVERY":
            windows = self.calendars[visit.stop["entity_id"]]["windows"]
        else:
            windows = self.hubs[visit.key]
        hard_blocks, soft_blocks = [], []
        if visit.role == "OUTLET_DELIVERY":
            for slot in self.calendars[visit.stop["entity_id"]]["slots"]:
                # An open AVAILABLE slot is not a reservation. Cancelled/rejected slots do not block.
                if slot["status"] == "CONFIRMED" or slot["slot_type"] == "BLOCKED" and slot["status"] == "OPEN":
                    hard_blocks.append(slot)
                elif slot["status"] == "RESERVED":
                    soft_blocks.append(slot)
        blocked = []
        for window in sorted(windows, key=self._interval):
            left, right = self._interval(window)
            if visit.role == "OUTLET_DELIVERY":
                left = max(left, self._stamp(visit.window[0]))
                right = min(right, self._stamp(visit.window[1]))
            start = max(left, arrival)
            for slot in sorted(hard_blocks, key=self._interval):
                slot_start, slot_end = self._interval(slot)
                if start + duration <= right and _overlap(start, start + duration, slot_start, slot_end):
                    blocked.append({"slot": slot, "attempt_start": start, "attempt_end": start + duration})
                    start = slot_end
            end = start + duration
            if end <= right:
                overlaps = [slot for slot in soft_blocks if _overlap(start, end, *self._interval(slot))]
                diagnostics = [issue("RECEIVING_RESERVED", slot=slot) for slot in overlaps]
                diagnostics.extend(issue("RECEIVING_BLOCK_AVOIDED", **interval) for interval in blocked)
                return start, end, SOFT if overlaps else PASS, diagnostics, window
        code = {
            "SUPPLIER_PICKUP": "PICKUP_WINDOW_CONFLICT",
            "OUTLET_DELIVERY": "RECEIVING_BLOCKED" if blocked else "DELIVERY_WINDOW_CONFLICT",
            "HUB_RECEIVE": "HUB_WINDOW_CONFLICT", "HUB_DISPATCH": "HUB_WINDOW_CONFLICT",
        }[visit.role]
        return None, None, HARD, [issue(code, blocked=blocked, arrival=arrival)], None

    def _suggest_alternate(self, visit, arrival, service_duration):
        minutes = self.parameters.get("SERVICE_DURATION_MINUTES", {})
        policy = self.parameters.get("ALTERNATE_SLOT_SEARCH")
        value = minutes.get("value")
        if (
            minutes.get("data_type") != "INTEGER" or type(value) is not int or not 1 <= value <= 1440
            or policy != {"value": "AFTER_ORIGINAL", "data_type": "STRING"}
        ):
            return []
        duration = timedelta(minutes=value)
        if service_duration > duration:
            return []
        requested_start, requested_end = map(self._stamp, visit.window)
        earliest = max(arrival, requested_start)
        calendar = self.calendars[visit.stop["entity_id"]]
        periods = [
            self._interval(slot) for slot in calendar["slots"]
            if slot["status"] in ("CONFIRMED", "RESERVED")
            or slot["slot_type"] == "BLOCKED" and slot["status"] == "OPEN"
        ]
        for preserve_request in (True, False):
            for window in sorted(calendar["windows"], key=self._interval):
                left, right = self._interval(window)
                start = max(left, earliest)
                latest_end = min(right, requested_end) if preserve_request else right
                for blocked_start, blocked_end in sorted(periods):
                    if _overlap(start, start + duration, blocked_start, blocked_end):
                        start = blocked_end
                if start + duration <= latest_end:
                    return [{
                        "start": start, "end": start + duration, "duration_minutes": value,
                        "status": "PROPOSED", "within_requested_window": preserve_request,
                        "requires_demand_window_change": not preserve_request,
                        "receiving_window": window,
                    }]
        return []

    def _fleet(self, offer, start, end):
        if start < self._stamp(offer["operating_start"]) or end > self._stamp(offer["operating_end"]):
            return HARD, issue("VEHICLE_OPERATING_HOURS_CONFLICT", offer_id=offer["id"], start=start, end=end), []
        windows = [(self._interval(window, "start", "end"), window) for window in offer["windows"]]
        reserved = self.reservations[offer["id"]]
        points = {start, end}
        for a, b in [*(period for period, _ in windows), *reserved]:
            if start < a < end:
                points.add(a)
            if start < b < end:
                points.add(b)
        ordered = sorted(points)
        applied = {}
        for a, b in zip(ordered, ordered[1:]):
            rows = [row for (left, right), row in windows if left <= a and b <= right]
            if not rows:
                return UNKNOWN, issue("VEHICLE_PERIOD_UNVERIFIED", offer_id=offer["id"], start=a, end=b), []
            applied.update({row["id"]: row for row in rows})
            capacity = min(offer["count"], *(row["count"] if row["status"] == "AVAILABLE" else 0 for row in rows))
            used = sum(left <= a and b <= right for left, right in reserved)
            if used >= capacity:
                return HARD, issue("VEHICLE_FLEET_CONFLICT", offer_id=offer["id"], start=a, end=b,
                                   available=capacity, already_allocated=used, window_ids=[row["id"] for row in rows]), []
        return PASS, None, list(applied.values())

    def _attempt(self, visits, wave, offer, first_arrival):
        arrival = first_arrival
        stops = []
        for visit, blank in zip(visits, wave["stops"], strict=True):
            stop = {**blank, "evidence": dict(blank["evidence"])}
            stops.append(stop)
            if arrival is None:
                stop["diagnostics"] = [issue("PREVIOUS_STOP_UNAVAILABLE", stop=visit.key)]
                continue
            if stop["travel_from_previous"]:
                arrival += timedelta(minutes=stop["travel_from_previous"]["minutes"])
            duration = timedelta(minutes=stop["evidence"]["service"]["minutes"])
            start, end, state, diagnostics, window = self._select_service(visit, arrival, duration)
            if state == HARD:
                # Losing this stop in one tested sequence does not prove infeasibility.
                impossible = self._select_service(visit, self._stamp(time.min), duration)[2] == HARD
                diagnostics = [{**row, "independent_of_sequence": impossible} for row in diagnostics]
            if window:
                stop["evidence"]["used_window"] = window
            stop.update(arrival=arrival, service_start=start, service_end=end, departure=end, status=state, diagnostics=diagnostics,
                        wait_minutes=_minutes(start - arrival) if start else None)
            if visit.role == "OUTLET_DELIVERY":
                stop["conflict_type"] = "NONE" if state == PASS else state
                if state == HARD and any(row["code"] == "RECEIVING_BLOCKED" for row in diagnostics):
                    stop["alternate_slots"] = self._suggest_alternate(visit, arrival, duration)
            arrival = end
        states = [stop["status"] for stop in stops]
        receiving = aggregate([
            stop["status"] for stop in stops if stop["role"] == "OUTLET_DELIVERY"
        ])
        result = {**wave, "stops": stops, "status": aggregate(states),
                  "receiving_status": "NONE" if receiving == PASS else receiving}
        if arrival is None:
            return result
        state, diagnostic, evidence = self._fleet(offer, first_arrival, arrival)
        result.update(start=first_arrival, end=arrival, status=aggregate([result["status"], state]),
                      diagnostics=[diagnostic] if diagnostic else [], fleet_evidence=evidence)
        return result

    def schedule_wave(self, visits, wave, offer):
        if wave["diagnostics"] or any(stop["diagnostics"] for stop in wave["stops"]):
            return wave
        base = self._stamp(offer["operating_start"])
        if wave["phase"] == "OUTBOUND":
            absent = sorted(set(wave["demand_ids"]) - self.inbound_completed.keys())
            if absent:
                wave["diagnostics"].append(issue("HUB_INBOUND_NOT_READY", demand_ids=absent))
                return wave
            release = {pk: self.inbound_completed[pk] for pk in wave["demand_ids"]}
            base = max(base, *release.values())
            wave["stops"][0]["evidence"]["inbound_released_at"] = release
        if visits[0].window:
            base = max(base, self._stamp(visits[0].window[0]))
        openings = {base, *(self._stamp(row["start"]) for row in offer["windows"]),
                    *(self._stamp(row["end"]) for row in offer["windows"]),
                    *(end for _, end in self.reservations[offer["id"]])}
        best = None
        for instant in sorted(point for point in openings if base <= point < self._stamp(offer["operating_end"])):
            attempt = self._attempt(visits, wave, offer, instant)
            if best is None or _SCHEDULE_PREFERENCE[attempt["status"]] > _SCHEDULE_PREFERENCE[best["status"]]:
                best = attempt
            if attempt["status"] == PASS:
                best = attempt
                break
        if best is None:
            return {**wave, "status": HARD, "diagnostics": [issue(
                "VEHICLE_OPERATING_HOURS_CONFLICT", offer_id=offer["id"], earliest=base, operating_end=self._stamp(offer["operating_end"]),
            )]}
        if best["status"] in (PASS, SOFT):
            self.reservations[offer["id"]].append((best["start"], best["end"]))
            if best["phase"] == "INBOUND":
                self.inbound_completed.update({pk: best["end"] for pk in best["demand_ids"]})
        return best


def evaluate_schedule(f2, f3, evidence, configuration):
    scheduler = Scheduler(f2, f3["inputs"]["cp7"], evidence, configuration["timezone"], configuration.get("parameters", {}))
    global_issues = configuration["diagnostics"]
    waves = sorted(f3["result"]["waves"], key=lambda wave: (
        {"DIRECT": 0, "INBOUND": 1, "OUTBOUND": 2}[wave["phase"]], wave["wave_no"],
    ))
    output = []
    for wave in waves:
        visits, described, offer = scheduler.describe_wave(wave)
        output.append(described if global_issues else scheduler.schedule_wave(visits, described, offer))
    stops = [stop for wave in output for stop in wave["stops"]]
    receiving = [stop for stop in stops if stop["role"] == "OUTLET_DELIVERY"]
    states = [wave["status"] for wave in output]
    state = aggregate(states)
    diagnostics = list(global_issues)
    proven = any(row.get("independent_of_sequence") for stop in stops for row in stop["diagnostics"])
    if state == HARD and not proven:
        state = UNKNOWN
        diagnostics.append(issue("F4_SEQUENCE_NOT_EXHAUSTIVE"))
    complete = bool(output) and all(s in (PASS, SOFT) for s in states)
    pickups = [stop["service_start"] for stop in stops if stop["role"] == "SUPPLIER_PICKUP" and stop["service_start"]]
    counts = Counter(stop["status"] for stop in receiving)
    metrics = {
        "first_pickup_at": min(pickups) if pickups else None,
        "completed_at": max(wave["end"] for wave in output) if complete else None,
        "travel_minutes": sum(stop["travel_from_previous"]["minutes"] for stop in stops if stop["travel_from_previous"]) if complete else None,
        "distance_km": str(sum(Decimal(stop["travel_from_previous"]["distance_km"]) for stop in stops
                               if stop["travel_from_previous"])) if complete else None,
        "wait_minutes": round(sum(stop["wait_minutes"] for stop in stops), 6) if complete else None,
        "hub_handling_minutes": sum(stop["evidence"]["service"]["minutes"] for stop in stops
                                    if stop["role"].startswith("HUB_")) if complete else None,
        "delivery_stop_count": len(receiving), "on_time_stops": counts[PASS],
        "conflict_stops": counts[HARD] + counts[SOFT], "not_evaluated_stops": counts[UNKNOWN],
    }
    return {"status": state, "complete": complete, "metrics": metrics, "waves": output, "diagnostics": diagnostics}
