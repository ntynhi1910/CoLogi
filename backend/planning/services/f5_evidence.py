"""The deployment may supply approved quotes; preview clients supply no prices."""

import json
from pathlib import Path

from django.conf import settings
from jsonschema import Draft202012Validator, FormatChecker

from planning.f4_contract import SYNTHETIC
from planning.services.f5_economics import DISTANCE_BASIS, RULES, PriceInvalid


def record(required, optional=None):
    return {
        "type": "object", "required": list(required),
        "properties": {**required, **(optional or {})}, "additionalProperties": False,
    }


def rows(items):
    return {"type": "array", "items": items}


TEXT = {"type": "string", "minLength": 1, "maxLength": 180}
DAY = {"type": "string", "format": "date"}
UUID = {"type": "string", "format": "uuid"}
ID = {"type": "integer", "minimum": 1}
HASH = {"type": "string", "pattern": r"^[0-9a-f]{64}$"}
NUMBER = {"type": "string", "pattern": r"^[0-9]{1,14}(\.[0-9]{1,6})?$"}
MONEY = {"type": "string", "pattern": r"^[0-9]{1,12}(\.[0-9]{1,2})?$"}
BASIS = {"enum": sorted(DISTANCE_BASIS)}
CHARGES = ["TRANSPORT_BASE", "DISTANCE", "WAIT", "STOP_HANDLING", "HUB_HANDLING", "SURCHARGE"]
COMPONENT = record({
    "pricing_basis": {"enum": ["FIXED", "PER_KM", "PER_KG", "PER_ORDER", "BUNDLED", "OTHER"]},
    "rate_vnd": MONEY, "covers": {
        "type": "array", "items": {"enum": CHARGES}, "minItems": 1, "uniqueItems": True,
    },
}, {"measure": {"enum": ["WAIT", "STOP_HANDLING"]}})
QUOTE = {
    "source_reference": TEXT, "source_type": {"enum": ["APPROVED_UAT_QUOTE", "APPROVED_OPERATIONAL_QUOTE"]},
    "valid_from": DAY, "valid_to": DAY, "complete": {"const": True},
    "components": {**rows(COMPONENT), "minItems": 1},
}
WAVE = record({**QUOTE, "wave_no": ID, "offer_id": ID}, {
    "depot": record({"to_pickup_km": NUMBER, "return_km": NUMBER, "source_reference": TEXT}),
})
HUB = record({**QUOTE, "hub_id": ID})
DEMAND = record({**QUOTE, "demand_id": ID, "outlet_id": ID, "weight_kg": NUMBER}, {
    "independent_distance": record({"distance_km": NUMBER, "scope": BASIS, "source_reference": TEXT}),
    "wait_minutes": NUMBER, "handling_minutes": NUMBER,
})
OPTION = record({
    "f4_evaluation_code": UUID, "input_fingerprint": HASH, "configuration_fingerprint": HASH,
    "waves": rows(WAVE),
}, {"hub": HUB})
CONFIG = record({
    "version": TEXT, "rules": {"const": RULES}, "currency_code": {"const": "VND"},
    "rounding_unit_vnd": {"type": "integer", "minimum": 1, "maximum": 1_000_000},
    "rounding_mode": {"const": "HALF_UP"}, "allocation_residual": {"const": "LARGEST_REMAINDER_OUTLET_ID"},
    "allocation_method": {"enum": ["WEIGHT", "ORDER_COUNT"]}, "distance_basis": BASIS, "service_basis": TEXT,
})
SCHEMA = Draft202012Validator(record({
    "schema_version": {"const": 1}, "approval_reference": TEXT, "source_mode": {"enum": ["OPERATIONAL", SYNTHETIC]},
    "run_code": UUID, "group_code": TEXT, "scenario": {"type": ["string", "null"]},
    "service_date": DAY, "demand_basis_fingerprint": HASH, "configuration": CONFIG,
    "baseline": rows(DEMAND), "options": rows(OPTION),
}), format_checker=FormatChecker())


def read_prices(*, run_code, group_code, scenario, uat):
    path = getattr(settings, "F5_PRICE_EVIDENCE_FILE", None)
    if not path:
        return None
    try:
        with Path(path).open(encoding="utf-8") as raw:
            evidence = json.load(raw)
    except (OSError, ValueError) as exc:
        raise PriceInvalid("PRICE_EVIDENCE_INVALID") from exc
    if not SCHEMA.is_valid(evidence):
        raise PriceInvalid("PRICE_EVIDENCE_INVALID")
    if evidence["source_mode"] != (SYNTHETIC if uat else "OPERATIONAL"):
        return None
    if (evidence["run_code"], evidence["group_code"], evidence["scenario"]) != (str(run_code), group_code, scenario):
        return None
    expected_type = "APPROVED_UAT_QUOTE" if uat else "APPROVED_OPERATIONAL_QUOTE"
    quotes = [*evidence["baseline"]]
    for option in evidence["options"]:
        quotes.extend(option["waves"])
        if option.get("hub"):
            quotes.append(option["hub"])
    if any(row["source_type"] != expected_type for row in quotes):
        raise PriceInvalid("PRICE_SOURCE_CONTEXT_MISMATCH")
    if len({row["f4_evaluation_code"] for row in evidence["options"]}) != len(evidence["options"]):
        raise PriceInvalid("PRICE_EVIDENCE_INVALID")
    return evidence
