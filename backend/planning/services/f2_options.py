"""Deterministic F2 transport structure, independent of ORM and later DSS stages."""

from collections import defaultdict
from dataclasses import asdict, dataclass
from decimal import Decimal
from hashlib import sha256
import json


CONTRACT_VERSION = "1.0"


@dataclass(frozen=True)
class HubPoint:
    id: int
    code: str
    name: str
    address: str


@dataclass(frozen=True)
class DemandItem:
    item_id: int
    required_weight_kg: Decimal
    confirmed_weight_kg: Decimal | None


@dataclass(frozen=True)
class Demand:
    id: int
    code: str
    supplier_id: int
    outlet_id: int
    outlet_code: str
    cargo_category_id: int
    cargo_category_code: str
    requested_date: str
    requested_start_time: str | None
    requested_end_time: str | None
    required_weight_kg: Decimal
    items: tuple[DemandItem, ...]
    pickup_address: str | None
    pickup_ready_date: str | None
    pickup_ready_start_time: str | None
    pickup_ready_end_time: str | None
    supplier_request_id: int | None
    supplier_confirmation_id: int | None
    snapshot_captured_at: str
    snapshot_version: str


def _kg(value):
    return format(value, "f") if value is not None else None


def _demand_payload(demand):
    data = asdict(demand)
    data["required_weight_kg"] = _kg(demand.required_weight_kg)
    data["items"] = list(data["items"])
    for item in data["items"]:
        item["required_weight_kg"] = _kg(item["required_weight_kg"])
        item["confirmed_weight_kg"] = _kg(item["confirmed_weight_kg"])
    return data


def _stop(key, kind, rows, *, entity_id, code, address=None):
    return {
        "key": key, "kind": kind, "entity_id": entity_id, "code": code, "address": address,
        "demand_ids": [row.id for row in rows],
        "load_kg": _kg(sum(row.required_weight_kg for row in rows)) if rows else None,
    }


def _leg(phase, start, end, rows):
    return {
        "phase": phase, "from_stop": start, "to_stop": end,
        "demand_ids": [row.id for row in rows],
        "load_kg": _kg(sum(row.required_weight_kg for row in rows)),
    }


def _structure(demands):
    by_pickup, by_outlet = defaultdict(list), defaultdict(list)
    for demand in demands:
        by_pickup[(demand.supplier_id, demand.pickup_address or "")].append(demand)
        by_outlet[demand.outlet_id].append(demand)
    pickups = [
        _stop(f"pickup-{index}", "SUPPLIER", by_pickup[supplier, address],
              entity_id=supplier, code=None, address=address or None)
        for index, (supplier, address) in enumerate(sorted(by_pickup), 1)
    ]
    deliveries = [
        _stop(f"outlet-{outlet}", "OUTLET", by_outlet[outlet],
              entity_id=outlet, code=by_outlet[outlet][0].outlet_code)
        for outlet in sorted(by_outlet)
    ]
    return pickups, deliveries


def _option(template, lineage, basis, *, stops, legs, diagnostics, hub=None):
    result = {
        "template_type": template,
        "status": "DRAFT",
        "structural_status": "INCOMPLETE" if diagnostics else "COMPLETE",
        "ready_for_f3": False,
        "hub": asdict(hub) if hub else None,
        "stops": stops,
        "legs": legs,
        "diagnostics": diagnostics,
        "demand_ids": basis["demand_ids"],
        "total_required_weight_kg": basis["total_required_weight_kg"],
    }
    canonical = json.dumps(
        [CONTRACT_VERSION, lineage, basis, result], sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    return {**result, "option_key": sha256(canonical.encode()).hexdigest()}


def generate_options(*, lineage, candidate, demands, diagnostics=(), hub=None, hub_diagnostic=None):
    """Emit both drafts, each tied to exactly the provided Candidate membership."""
    demands = sorted(demands, key=lambda row: row.id)
    members = [row.id for row in demands]
    expected = candidate["demand_ids"]
    if len(expected) < 2 or len(expected) != len(set(expected)) or len(members) != len(set(members)):
        raise ValueError("Invalid or duplicate F2 Demand assignment.")
    if not set(members).issubset(expected) or (members != expected and not diagnostics):
        raise ValueError("Incomplete F2 Demand assignment.")

    basis = {
        **candidate,
        "outlet_count": len({row.outlet_id for row in demands}) if members == expected else None,
        "total_required_weight_kg": _kg(sum(row.required_weight_kg for row in demands)) if members == expected else None,
        "demands": [_demand_payload(row) for row in demands],
    }
    pickups, deliveries = _structure(demands)
    rows_by_id = {row.id: row for row in demands}
    direct_legs = []
    hub_legs = []
    if not diagnostics:
        for stop in pickups:
            by_outlet = defaultdict(list)
            for demand_id in stop["demand_ids"]:
                row = rows_by_id[demand_id]
                by_outlet[row.outlet_id].append(row)
            for outlet, rows in sorted(by_outlet.items()):
                direct_legs.append(_leg("DIRECT", stop["key"], f"outlet-{outlet}", rows))
        if hub and hub_diagnostic is None:
            hub_legs = [
                _leg("INBOUND", stop["key"], f"hub-{hub.id}", [rows_by_id[pk] for pk in stop["demand_ids"]])
                for stop in pickups
            ] + [
                _leg("OUTBOUND", f"hub-{hub.id}", stop["key"], [rows_by_id[pk] for pk in stop["demand_ids"]])
                for stop in deliveries
            ]

    hub_stops = [_stop(f"hub-{hub.id}", "HUB", demands, entity_id=hub.id, code=hub.code, address=hub.address)] if hub else []
    hub_issue = hub_diagnostic or ({"code": "HUB_SELECTION_REQUIRED"} if not hub else None)
    issues = list(diagnostics)
    return {
        "contract_version": CONTRACT_VERSION,
        "lineage": lineage,
        "basis": basis,
        "options": [
            _option("DIRECT_CONSOLIDATED", lineage, basis, stops=pickups + deliveries,
                    legs=direct_legs, diagnostics=issues),
            _option("HUB_BASED", lineage, basis, stops=pickups + hub_stops + deliveries,
                    legs=hub_legs, diagnostics=issues + ([hub_issue] if hub_issue else []), hub=hub),
        ],
    }
