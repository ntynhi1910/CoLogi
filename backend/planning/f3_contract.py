"""Canonical F3 fingerprints and independent allocation checks."""

from collections import Counter
from datetime import date, time
from decimal import Decimal
from hashlib import sha256
import json

from django.core.exceptions import ValidationError

from planning.services.f3_allocation import Availability, Offer, _offer_availability, _utilization
from planning.services.f3_hub_coverage import hub_scope_diagnostics, resolve_hub_coverage
from transportation.v7_planning import V7_FLEET_SOURCE, V7_FLEET_VERSION, V7_WORKBOOK_SHA256


LEGACY_VERSION = 1
HUB_COVERAGE_VERSION = 2
MANAGER_ACCEPTED_AVAILABILITY = "MANAGER_ACCEPTED_FOR_OPERATIONAL_TESTING"


def evaluation_contract_version(hub_id):
    return HUB_COVERAGE_VERSION if hub_id else LEGACY_VERSION


# Dataset V7, sheet 12_Business_Rules, active rule set.
RULES = {
    "RULE-13": {"expression": "wave_load <= vehicle_capacity", "rule_type": "B"},
    "RULE-14": {"expression": "split or change vehicle", "rule_type": "B"},
    "RULE-15": {"expression": "utilization = load / capacity", "rule_type": "C"},
}


def _encode(value):
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"Unsupported F3 evidence value: {type(value).__name__}")


def canonical(value):
    return json.dumps(value, default=_encode, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value):
    return sha256(canonical(value).encode("utf-8")).hexdigest()


def rule_issues(active):
    missing = sorted(RULES.keys() - active.keys())
    unsupported = sorted(code for code, value in active.items() if RULES.get(code) != value)
    issues = []
    if missing:
        issues.append({"code": "F3_RULE_CONFIGURATION_MISSING", "values": missing})
    if unsupported:
        issues.append({"code": "F3_RULE_CONFIGURATION_UNSUPPORTED", "values": unsupported})
    return issues


_UNCERTAIN = {
    "AVAILABILITY_MISSING", "AVAILABILITY_PARTIAL", "COMPATIBILITY_MISSING", "SEARCH_LIMIT_REACHED",
    "PICKUP_PERIOD_UNVERIFIED", "F3_RULE_CONFIGURATION_MISSING", "F3_RULE_CONFIGURATION_UNSUPPORTED",
    "F3_PARAMETER_INVALID", "HUB_SERVICE_SCOPE_UNVERIFIED",
}
_HARD_DIAGNOSTICS = {
    "PROVIDER_UNAVAILABLE", "NO_ACTIVE_OFFER", "AVAILABILITY_UNAVAILABLE", "AVAILABILITY_OUTSIDE_WINDOW",
    "OFFER_OUTSIDE_OPERATING_HOURS", "DEMAND_EXCEEDS_CAPACITY", "CARGO_UNSUPPORTED", "FLEET_LIMIT",
    "SUPPLIER_PICKUP_NOT_COVERED",
}


def gate_result(result, cp7):
    diagnostics = result["diagnostics"]
    codes = {row["code"] for row in diagnostics}
    missing_scope = any(
        row["code"] == "SUPPLIER_PICKUP_NOT_COVERED" and row["demand_id"] in cp7["missing_pickup_demand_ids"]
        for row in diagnostics
    )
    hard = _HARD_DIAGNOSTICS & codes
    if missing_scope and not any(
        row["code"] == "SUPPLIER_PICKUP_NOT_COVERED" and row["demand_id"] not in cp7["missing_pickup_demand_ids"]
        for row in diagnostics
    ):
        hard -= {"SUPPLIER_PICKUP_NOT_COVERED"}
    if result["waves"] and result["status"] == "ALLOCATION_VERIFIED" and not hard and not (
        codes & (_UNCERTAIN - {"SEARCH_LIMIT_REACHED"})
    ):
        return "ELIGIBLE"
    if not result["waves"] and hard:
        return "NOT_ELIGIBLE"
    return "UNVERIFIED"


def hard_checks(result, cp7, hub):
    codes = {row["code"] for row in result["diagnostics"]}
    dimensions = {
        "RULE-13": {"DEMAND_EXCEEDS_CAPACITY"},
        "RULE-14": {"DEMAND_EXCEEDS_CAPACITY"},
        "VEHICLE_CARGO": {"CARGO_UNSUPPORTED", "COMPATIBILITY_MISSING"},
        "SUPPLIER_PICKUP": {"SUPPLIER_PICKUP_NOT_COVERED"},
        "PROVIDER_OFFER": {"PROVIDER_UNAVAILABLE", "NO_ACTIVE_OFFER"},
        "FLEET_AVAILABILITY": {"FLEET_LIMIT", "PICKUP_PERIOD_UNVERIFIED", "SEARCH_LIMIT_REACHED",
                               "OFFER_OUTSIDE_OPERATING_HOURS", "AVAILABILITY_OUTSIDE_WINDOW",
                               "AVAILABILITY_MISSING", "AVAILABILITY_PARTIAL", "AVAILABILITY_UNAVAILABLE"},
    }
    checks = []
    for key, relevant in dimensions.items():
        problems = codes & relevant
        if problems:
            status = "UNVERIFIED" if problems <= _UNCERTAIN or (
                key == "SUPPLIER_PICKUP" and all(
                    row["demand_id"] in cp7["missing_pickup_demand_ids"] for row in result["diagnostics"]
                    if row["code"] == "SUPPLIER_PICKUP_NOT_COVERED"
                )
            ) else "FAIL"
        else:
            status = "VERIFIED" if result["waves"] else "NOT_EVALUATED"
        checks.append({"check": key, "status": status})
    checks.extend((
        {"check": "HUB_SCOPE", "status": result.get("hub_coverage", {}).get("status", "UNVERIFIED")
         if hub else "NOT_APPLICABLE"},
        {"check": "RULE_CONFIGURATION", "status": "UNVERIFIED" if any(code.startswith("F3_") for code in codes) else "VERIFIED"},
    ))
    return checks


def _offer(row):
    return Offer(
        **{key: row[key] for key in ("id", "vehicle_type_id", "code", "name", "count", "active", "vehicle_active")},
        capacity=Decimal(row["capacity"]),
        operating_start=time.fromisoformat(row["operating_start"]) if row["operating_start"] else None,
        operating_end=time.fromisoformat(row["operating_end"]) if row["operating_end"] else None,
        windows=tuple(Availability(
            slot["id"], date.fromisoformat(slot["service_date"]), time.fromisoformat(slot["start"]),
            time.fromisoformat(slot["end"]), slot["count"], slot["status"], slot["source"],
        ) for slot in row["windows"]),
    )


def validate_output(f2, result, cp7):
    """Check capacity, whole Demand/phase allocations, utilization and frozen evidence."""
    basis, option = f2["basis"], f2["option"]
    demands = {row["id"]: row for row in basis["demands"]}
    expected = {
        (leg["phase"], pk): (leg["from_stop"], leg["to_stop"], Decimal(demands[pk]["required_weight_kg"]))
        for leg in option["legs"] for pk in leg["demand_ids"]
    }
    waves = result["waves"]
    if result["demand_ids"] != basis["demand_ids"] or result["total_required_weight_kg"] != basis["total_required_weight_kg"]:
        raise ValidationError("F3 must preserve the F2 Demand membership and required weight.")
    if not waves:
        if result["status"] != "NOT_ALLOCATED" or result["vehicles_required"] is not None or result["utilization_pct"] is not None:
            raise ValidationError("F3 without waves cannot report utilization or verified allocation.")
        return

    provider = cp7["provider"]
    if result["vehicles_required"] != len(waves) or not provider or not provider["is_active"] or provider["provider_code"] != "TP001":
        raise ValidationError("F3 fleet count or provider evidence is inconsistent.")
    if result["status"] not in ("ALLOCATION_VERIFIED", "EVIDENCE_INCOMPLETE"):
        raise ValidationError("F3 wave status is inconsistent.")
    date_key = date.fromisoformat(basis["requested_date"])
    start = min(time.fromisoformat(row["pickup_ready_start_time"]) for row in demands.values())
    end = time.fromisoformat(basis["common_end_time"])
    if (result["availability_envelope"] != {
        "date": date_key.isoformat(), "start_time": start.isoformat(), "end_time": end.isoformat(),
    } or start >= end or any(
        row["pickup_ready_date"] != basis["requested_date"] or time.fromisoformat(row["pickup_ready_start_time"]) >= end
        for row in demands.values()
    )):
        raise ValidationError("F3 availability must cover the source snapshot period.")
    offers = {row["id"]: _offer(row) for row in cp7["offers"]}
    matrix = {(row["vehicle_type_id"], row["cargo_category_id"]): row for row in cp7["compatibility"]}
    coverage = {row["supplier_id"]: row for row in cp7["supplier_coverage"]}
    seen, used = set(), Counter()
    total_load = total_capacity = Decimal(0)
    for index, wave in enumerate(waves, 1):
        if wave["wave_no"] != index or not wave["allocations"]:
            raise ValidationError("F3 requires numbered, nonempty waves.")
        offer = offers[wave["vehicle"]["offer_id"]]
        evidence = _offer_availability(offer, date_key, start, end)
        used[offer.id] += 1
        if any(wave["vehicle"].get(key) != value for key, value in evidence.items()) or used[offer.id] > evidence["available_vehicle_count"]:
            raise ValidationError("F3 allocation exceeds the frozen vehicle availability.")
        load = Decimal(0)
        for item in wave["allocations"]:
            pk = item["demand_id"]
            member = (wave["phase"], pk)
            allocation = (item["from_stop"], item["to_stop"], Decimal(item["weight_kg"]))
            if member in seen or expected.get(member) != allocation or item["demand_code"] != demands[pk]["code"]:
                raise ValidationError("RULE-14 requires whole Demand allocations, once per F2 phase and leg.")
            demand = demands[pk]
            compatibility = matrix.get((offer.vehicle_type_id, demand["cargo_category_id"]), {})
            if compatibility.get("is_supported") is not True:
                raise ValidationError("F3 lacks frozen vehicle/cargo compatibility for this allocation.")
            pickup = coverage.get(demand["supplier_id"], {})
            if member[0] != "OUTBOUND" and (pickup.get("coverage_status") != "ACTIVE" or not pickup.get("can_pickup")):
                raise ValidationError("F3 lacks frozen Supplier pickup permission for this allocation.")
            seen.add(member)
            load += allocation[2]
        if load > offer.capacity or load != Decimal(wave["allocated_weight_kg"]):
            raise ValidationError("RULE-13 requires the exact wave load within vehicle capacity.")
        if wave["utilization_pct"] != _utilization(load, offer.capacity):
            raise ValidationError("RULE-15 requires utilization calculated from the wave load and capacity.")
        total_load += load
        total_capacity += offer.capacity
    if seen != expected.keys():
        raise ValidationError("RULE-14 requires complete F2 Demand coverage in every phase.")
    if result["utilization_pct"] != _utilization(total_load, total_capacity):
        raise ValidationError("RULE-15 requires utilization calculated from total wave loads and capacities.")


def validate_saved_document(f2, document, input_fingerprint, configuration_fingerprint, *,
                            contract_version=LEGACY_VERSION):
    try:
        if not isinstance(document, dict) or document.keys() != {"inputs", "configuration", "result"}:
            raise ValidationError("Invalid F3 evaluation document.")
        inputs, config, result = document["inputs"], document["configuration"], document["result"]
        cp7 = inputs["cp7"]
        if "manager_acceptance" in cp7 or any(
            slot.get("source") == MANAGER_ACCEPTED_AVAILABILITY
            for offer in cp7.get("offers", ()) for slot in offer.get("windows", ())
        ):
            raise ValidationError("Manager acceptance Preview cannot be persisted as an F3 evaluation.")
        used_v7 = {slot["id"] for wave in result.get("waves", ()) for slot in wave["vehicle"]["windows"]
                   if slot["source"] == V7_FLEET_SOURCE}
        if used_v7:
            marker = cp7.get("internal_planning") or {}
            refs = {row["id"] for row in cp7.get("source_records", ()) if row.get("source") == V7_FLEET_SOURCE
                    and row.get("workbook_sha256") == V7_WORKBOOK_SHA256
                    and row.get("provider_independently_verified") is False}
            if (cp7.get("capstone_scenario") or marker.get("version") != V7_FLEET_VERSION
                    or marker.get("provider_independently_verified") is not False or refs != used_v7):
                raise ValidationError("Planning-only V7 windows must retain their workbook provenance.")
        if any(f2["lineage"][key] != config["rule_set"][key] for key in (
            "rule_set_id", "rule_set_code", "rule_set_version", "configuration_fingerprint",
        )):
            raise ValidationError("F3 evaluation must retain the saved F2 RuleSet lineage.")
        if (inputs["f2_fingerprint"] != fingerprint(f2) or fingerprint(inputs) != input_fingerprint
            or fingerprint(config) != configuration_fingerprint):
            raise ValidationError("F3 evaluation fingerprints do not match the pinned evidence.")
        if result["gate_status"] != gate_result(result, cp7):
            raise ValidationError("F3 gate status does not match the captured diagnostics.")
        option_has_hub = f2["option"]["hub"] is not None
        hub_verified = False
        if contract_version == HUB_COVERAGE_VERSION and option_has_hub:
            coverage = resolve_hub_coverage(f2, cp7["provider"], cp7["hub_coverage"])
            expected = hub_scope_diagnostics(coverage)
            diagnostics = [row for row in result["diagnostics"] if row["code"] == "HUB_SERVICE_SCOPE_UNVERIFIED"]
            if result["hub_coverage"] != coverage or diagnostics != expected:
                raise ValidationError("F3 Hub status and diagnostics must match the frozen route evidence.")
            hub_verified = coverage["status"] == "VERIFIED"
        elif contract_version != LEGACY_VERSION:
            raise ValidationError("Unsupported F3 contract version for this plan.")
        elif option_has_hub and not any(row["code"] == "HUB_SERVICE_SCOPE_UNVERIFIED" for row in result["diagnostics"]):
            raise ValidationError("Legacy F3 cannot certify Hub coverage.")
        if (rule_issues(config["rules"]) or (option_has_hub and not hub_verified)) and result["gate_status"] == "ELIGIBLE":
            raise ValidationError("F3 cannot pass with missing configuration or Hub evidence.")
        if result["hard_constraints"] != hard_checks(result, cp7, option_has_hub):
            raise ValidationError("F3 hard constraint statuses do not match the frozen evidence.")
        validate_output(f2, result, cp7)
    except (KeyError, TypeError, ValueError, ArithmeticError) as exc:
        raise ValidationError("Invalid F3 evaluation evidence.") from exc
