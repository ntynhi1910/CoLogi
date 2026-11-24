"""Read projections for F3. Saved evidence and its fingerprints remain unchanged."""

from collections import Counter
from decimal import Decimal

from planning.services.f3_allocation import _utilization
from transportation.services import BUSINESS_TZ


def describe_evaluation(result, parameters):
    waves = result["waves"]
    by_offer = {wave["vehicle"]["offer_id"]: wave["vehicle"] for wave in waves}
    counts = Counter(wave["vehicle"]["offer_id"] for wave in waves)
    sources = [
        {**offer, "vehicles_required": counts[offer_id]}
        for offer_id, offer in by_offer.items()
    ]
    assigned = sum(Decimal(wave["vehicle"]["capacity_kg"]) for wave in waves)
    allocated = sum(Decimal(wave["allocated_weight_kg"]) for wave in waves)
    fleet = None
    utilization_matches = False
    if waves:
        utilization_matches = result["utilization_pct"] == _utilization(allocated, assigned) and all(
            wave["utilization_pct"] == _utilization(
                Decimal(wave["allocated_weight_kg"]), Decimal(wave["vehicle"]["capacity_kg"]),
            )
            for wave in waves
        )
        fleet = {
            "sources": sources,
            "available_count": sum(row["available_vehicle_count"] for row in sources),
            "available_capacity_kg": str(sum(Decimal(row["capacity_kg"]) * row["available_vehicle_count"] for row in sources)),
            "assigned_capacity_kg": str(assigned),
            "remaining_assigned_capacity_kg": str(assigned - allocated),
        }
    checks = {item["check"]: item["status"] for item in result["hard_constraints"]}
    if not waves:
        checks["RULE-15"] = "NOT_EVALUATED"
    else:
        checks["RULE-15"] = "VERIFIED" if utilization_matches else "FAIL"
    unavailable_rules = {
        code for item in result["diagnostics"]
        if item["code"] in ("F3_RULE_CONFIGURATION_MISSING", "F3_RULE_CONFIGURATION_UNSUPPORTED")
        for code in item.get("values", [])
    }
    invalid_parameters = {
        key for item in result["diagnostics"] if item["code"] == "F3_PARAMETER_INVALID"
        for key in item.get("values", [])
    }
    return {
        "fleet": fleet,
        "rule_checks": [
            {"check": code, "status": "UNVERIFIED" if code in unavailable_rules else checks[code]}
            for code in ("RULE-13", "RULE-14", "RULE-15")
        ],
        "parameters": [
            {
                "key": key, "configured": key in parameters, "invalid": key in invalid_parameters,
                "value": parameters[key][0] if key in parameters else contract_value,
            }
            for key, contract_value in (
                ("TIMEZONE", str(BUSINESS_TZ)),
                ("WEIGHT_UNIT", "KG"),
                ("UTILIZATION_WARNING_PCT", None),
            )
        ],
    }
