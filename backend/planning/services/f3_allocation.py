"""Deterministic F3 preview. Each wave needs a distinct vehicle for the plan envelope."""

from collections import Counter
from dataclasses import dataclass
from datetime import date, time
from decimal import Decimal

from planning.services.f3_hub_coverage import hub_scope_diagnostics


# Technical search budget, independent of business configuration.
SEARCH_BUDGET = 50_000
F4_PENDING = ["TRAVEL_TIME", "PICKUP_SEQUENCE", "HUB_HANDLING_IF_APPLICABLE", "RECEIVING_SCHEDULE"]


@dataclass(frozen=True)
class Availability:
    id: int
    service_date: date
    start: time
    end: time
    count: int
    status: str
    source: str

    def evidence(self):
        return {
            "id": self.id, "service_date": self.service_date.isoformat(), "start_time": self.start.isoformat(),
            "end_time": self.end.isoformat(), "count": self.count, "status": self.status, "source": self.source,
        }


@dataclass(frozen=True)
class Offer:
    id: int
    vehicle_type_id: int
    code: str
    name: str
    capacity: Decimal
    count: int
    active: bool
    vehicle_active: bool
    operating_start: time | None
    operating_end: time | None
    windows: tuple[Availability, ...]


@dataclass(frozen=True)
class Load:
    phase: str
    demand_id: int
    weight: Decimal
    category: int
    supplier: int
    from_stop: str
    to_stop: str


@dataclass
class Wave:
    offer: Offer
    phase: str
    loads: list[Load]
    weight: Decimal


def _offer_availability(offer, day, start, end):
    windows = [row for row in offer.windows if row.service_date == day]
    intersecting = [row for row in windows if row.start < end and row.end > start]
    covered = any(row.start <= start and row.end >= end for row in intersecting)
    if not offer.active or not offer.vehicle_active or offer.capacity <= 0 or offer.count <= 0:
        code, count = "OFFER_UNUSABLE", 0
    elif offer.operating_start is not None and not (offer.operating_start <= start and end <= offer.operating_end):
        code, count = "OFFER_OUTSIDE_OPERATING_HOURS", 0
    elif any(row.status != "AVAILABLE" or row.count <= 0 for row in intersecting):
        code, count = "AVAILABILITY_UNAVAILABLE", 0
    elif not windows:
        code, count = "AVAILABILITY_MISSING", 0
    elif not intersecting:
        code, count = "AVAILABILITY_OUTSIDE_WINDOW", 0
    elif not covered:
        code, count = "AVAILABILITY_PARTIAL", 0
    else:
        # Windows describe the same offer fleet. Never add counts across overlapping rows.
        code, count = "VERIFIED", min(offer.count, *(row.count for row in intersecting))
    return {
        "offer_id": offer.id, "vehicle_type_id": offer.vehicle_type_id, "vehicle_code": offer.code,
        "vehicle_name": offer.name, "capacity_kg": str(offer.capacity), "offer_vehicle_count": offer.count,
        "available_vehicle_count": count, "status": code, "windows": [row.evidence() for row in windows],
    }


def _search(loads, options, fleet):
    waves, used = [], Counter()
    best, score, explored = None, None, 0
    limited = False

    def visit(index, capacity):
        nonlocal best, score, explored, limited
        if explored >= SEARCH_BUDGET:
            limited = True
            return
        explored += 1
        if score is not None and len(waves) > score[0]:
            return
        if index == len(loads):
            candidate = (len(waves), capacity)
            if score is None or candidate < score:
                score = candidate
                best = [Wave(wave.offer, wave.phase, list(wave.loads), wave.weight) for wave in waves]
            return
        load = loads[index]
        eligible = options[load]
        equivalent = set()
        for wave in waves:
            key = (wave.offer.id, wave.weight)
            if wave.phase != load.phase or wave.offer not in eligible or key in equivalent:
                continue
            equivalent.add(key)
            if wave.weight + load.weight <= wave.offer.capacity:
                wave.loads.append(load)
                wave.weight += load.weight
                visit(index + 1, capacity)
                wave.weight -= load.weight
                wave.loads.pop()
        if score is not None and len(waves) >= score[0]:
            return
        for offer in eligible:
            if used[offer.id] < fleet[offer.id]:
                waves.append(Wave(offer, load.phase, [load], load.weight))
                used[offer.id] += 1
                visit(index + 1, capacity + offer.capacity)
                used[offer.id] -= 1
                waves.pop()
            if limited:
                break

    visit(0, Decimal(0))
    return best, limited


def _load_offer_issues(load, offers, fleet, matrix, availability):
    active = [offer for offer in offers if offer.active and offer.vehicle_active and offer.capacity > 0 and offer.count > 0]
    fitting = [offer for offer in active if offer.capacity >= load.weight]
    compatible = [offer for offer in fitting if matrix.get((offer.vehicle_type_id, load.category), {}).get("is_supported") is True]
    eligible = [offer for offer in compatible if fleet[offer.id] > 0]
    if eligible:
        return eligible, []
    if not active:
        codes = ["NO_ACTIVE_OFFER"]
    elif not fitting:
        codes = ["DEMAND_EXCEEDS_CAPACITY"]
    elif not compatible:
        codes = ["COMPATIBILITY_MISSING" if any(
            (offer.vehicle_type_id, load.category) not in matrix for offer in fitting
        ) else "CARGO_UNSUPPORTED"]
    else:
        codes = sorted({availability[offer.id]["status"] for offer in compatible})
    return [], codes


def _utilization(weight, capacity):
    return str((100 * weight / capacity).quantize(Decimal("0.01")))


def allocate(structure, *, provider, offers, matrix, coverage, configuration_issues=(),
             warning_pct=None, hub_coverage=None):
    basis, option = structure["basis"], structure["option"]
    day = date.fromisoformat(basis["requested_date"])
    demands = {demand["id"]: demand for demand in basis["demands"]}
    start = min(time.fromisoformat(demand["pickup_ready_start_time"]) for demand in demands.values())
    end = time.fromisoformat(basis["common_end_time"])
    loads = []
    for leg in option["legs"]:
        for pk in leg["demand_ids"]:
            demand = demands[pk]
            loads.append(Load(
                leg["phase"], pk, Decimal(demand["required_weight_kg"]), demand["cargo_category_id"],
                demand["supplier_id"], leg["from_stop"], leg["to_stop"],
            ))
    loads.sort(key=lambda value: (-value.weight, value.phase, value.demand_id))
    offers = sorted(offers, key=lambda offer: (offer.capacity, offer.id))
    diagnostics = list(configuration_issues)
    if option["hub"] and hub_coverage is None:
        diagnostics.append({"code": "HUB_SERVICE_SCOPE_UNVERIFIED", "hub_id": option["hub"]["id"]})
    elif hub_coverage is not None:
        diagnostics.extend(hub_scope_diagnostics(hub_coverage))
    pending = [code for code in F4_PENDING if code != "HUB_HANDLING_IF_APPLICABLE" or option["hub"]]
    result = {
        "status": "NOT_ALLOCATED", "demand_ids": basis["demand_ids"],
        "total_required_weight_kg": basis["total_required_weight_kg"],
        "provider": provider, "vehicles_required": None, "utilization_pct": None,
        "offers": [], "waves": [], "diagnostics": diagnostics, "f4_pending": pending,
        "availability_envelope": {"date": day.isoformat(), "start_time": start.isoformat(), "end_time": end.isoformat()},
        "search": "NOT_RUN",
    }
    if any(demand["pickup_ready_date"] != basis["requested_date"]
           or time.fromisoformat(demand["pickup_ready_start_time"]) >= end for demand in demands.values()):
        diagnostics.append({"code": "PICKUP_PERIOD_UNVERIFIED"})
        return result
    if not provider or not provider["is_active"]:
        diagnostics.append({"code": "PROVIDER_UNAVAILABLE"})
        return result

    availability = {offer.id: _offer_availability(offer, day, start, end) for offer in offers}
    for offer in offers:
        availability[offer.id]["cargo_compatibility"] = [
            {"cargo_category_id": category, **matrix.get(
                (offer.vehicle_type_id, category), {"is_supported": None, "source": None},
            )}
            for category in basis["cargo_category_ids"]
        ]
    result["offers"] = list(availability.values())
    fleet = {pk: value["available_vehicle_count"] for pk, value in availability.items()}
    options = {}
    for load in loads:
        authorization = coverage.get(load.supplier)
        qualified, codes = _load_offer_issues(load, offers, fleet, matrix, availability)
        if load.phase != "OUTBOUND" and not (
            authorization and authorization["coverage_status"] == "ACTIVE" and authorization["can_pickup"]
        ):
            qualified = []
            codes.append("SUPPLIER_PICKUP_NOT_COVERED")
        options[load] = qualified
        diagnostics.extend({"code": code, "phase": load.phase, "demand_id": load.demand_id} for code in codes)
    if any(not choices for choices in options.values()):
        return result

    waves, limited = _search(loads, options, fleet)
    result["search"] = "BOUNDED" if limited else "EXHAUSTIVE_WITHIN_ENVELOPE"
    if limited:
        diagnostics.append({"code": "SEARCH_LIMIT_REACHED"})
    if waves is None:
        if not limited:
            diagnostics.append({"code": "FLEET_LIMIT"})
        return result

    result["waves"] = [
        {
            "wave_no": index, "phase": wave.phase, "vehicle": availability[wave.offer.id],
            "allocated_weight_kg": str(wave.weight), "utilization_pct": _utilization(wave.weight, wave.offer.capacity),
            "cargo_compatibility": [{"cargo_category_id": category, **matrix[wave.offer.vehicle_type_id, category]}
                                    for category in sorted({load.category for load in wave.loads})],
            "supplier_coverage": [coverage[supplier] for supplier in sorted({load.supplier for load in wave.loads})]
                                 if wave.phase != "OUTBOUND" else [],
            "allocations": [
                {"demand_id": load.demand_id, "demand_code": demands[load.demand_id]["code"], "weight_kg": str(load.weight),
                 "from_stop": load.from_stop, "to_stop": load.to_stop}
                for load in sorted(wave.loads, key=lambda item: item.demand_id)
            ],
        }
        for index, wave in enumerate(sorted(waves, key=lambda w: (
            ("DIRECT", "INBOUND", "OUTBOUND").index(w.phase), min(item.demand_id for item in w.loads),
        )), 1)
    ]
    result["vehicles_required"] = len(waves)
    result["utilization_pct"] = _utilization(sum(w.weight for w in waves), sum(w.offer.capacity for w in waves))
    hub_unverified = option["hub"] and (hub_coverage is None or hub_coverage["status"] != "VERIFIED")
    result["status"] = "EVIDENCE_INCOMPLETE" if configuration_issues or hub_unverified else "ALLOCATION_VERIFIED"
    if warning_pct is not None:
        diagnostics.extend({"code": "LOW_UTILIZATION", "wave_no": wave["wave_no"]}
                           for wave in result["waves"] if Decimal(wave["utilization_pct"]) < warning_pct)
    return result
