"""Versioned JSON Schema and cross-field validation for stored F2 drafts."""

from datetime import datetime, time
from decimal import Decimal

from django.core.exceptions import ValidationError
from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError as JsonSchemaValidationError

from planning.services.f2_options import Demand, DemandItem, HubPoint, generate_options


SCHEMA_VERSION = 1
TEMPLATES = ("DIRECT_CONSOLIDATED", "HUB_BASED")
ID = {"type": "integer", "minimum": 1}
TEXT = {"type": "string", "pattern": r"\S"}
BY_DATE = {"type": "string", "format": "date"}
BY_TIME = {"type": "string", "pattern": r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?$"}
STAMP = {
    "type": "string", "format": "date-time",
    "pattern": r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
}
KG = {"type": "string", "pattern": r"^[0-9]+(?:\.[0-9]{1,3})?$"}
HASH = {"type": "string", "pattern": r"^[0-9a-f]{64}$"}


def _object(**properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def _array(items, minimum=1, *, unique=False):
    return {"type": "array", "items": items, "minItems": minimum, "uniqueItems": unique}


def _optional(schema):
    return {"anyOf": [schema, {"type": "null"}]}


IDS = _array(ID, unique=True)
ITEM = _object(item_id=ID, required_weight_kg=KG, confirmed_weight_kg=KG)
DEMAND = _object(
    id=ID, code=TEXT, supplier_id=ID, outlet_id=ID, outlet_code=TEXT,
    cargo_category_id=ID, cargo_category_code=TEXT, requested_date=BY_DATE,
    requested_start_time=BY_TIME, requested_end_time=BY_TIME, required_weight_kg=KG,
    items=_array(ITEM), pickup_address=TEXT, pickup_ready_date=BY_DATE,
    pickup_ready_start_time=BY_TIME, pickup_ready_end_time=BY_TIME,
    supplier_request_id=ID, supplier_confirmation_id=ID, snapshot_captured_at=STAMP,
    snapshot_version=TEXT,
)
HUB = _object(id=ID, code=TEXT, name=TEXT, address=TEXT)
STOP = _object(
    key=TEXT, kind={"enum": ["SUPPLIER", "HUB", "OUTLET"]}, entity_id=ID,
    code=_optional(TEXT), address=_optional(TEXT), demand_ids=IDS, load_kg=KG,
)
LEG = _object(
    phase={"enum": ["DIRECT", "INBOUND", "OUTBOUND"]}, from_stop=TEXT, to_stop=TEXT,
    demand_ids=IDS, load_kg=KG,
)
F2_STRUCTURE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    **_object(
        schema_version={"const": SCHEMA_VERSION},
        lineage=_object(
            run_code={"type": "string", "format": "uuid"}, group_code=TEXT,
            run_status={"const": "COMPLETED"}, candidate_status={"const": "CANDIDATE"},
            rule_set_id=ID, rule_set_code=TEXT, rule_set_version=ID, configuration_captured_at=STAMP,
            configuration_fingerprint=HASH, max_group_size=_optional(ID), max_candidates_per_run=ID,
            cargo_matrix_source=_optional(TEXT), cargo_matrix_sheet=_optional(TEXT),
            f1_rule_codes=_array(TEXT, unique=True),
        ),
        basis=_object(
            demand_ids=_array(ID, 2, unique=True), requested_date=BY_DATE,
            common_start_time=BY_TIME, common_end_time=BY_TIME, cargo_category_ids=IDS,
            outlet_count={"type": "integer", "minimum": 2}, total_required_weight_kg=KG,
            demands=_array(DEMAND, 2),
        ),
        option=_object(
            option_key=HASH, template_type={"enum": list(TEMPLATES)}, status={"const": "DRAFT"},
            structural_status={"const": "COMPLETE"}, ready_for_f3={"const": False},
            demand_ids=_array(ID, 2, unique=True), total_required_weight_kg=KG,
            hub=_optional(HUB), stops=_array(STOP, 3), legs=_array(LEG, 2), diagnostics={"const": []},
        ),
    ),
}
_FORMATS = FormatChecker()


@_FORMATS.checks("date-time", raises=ValueError)
def _is_zoned_timestamp(value):
    return not isinstance(value, str) or datetime.fromisoformat(value).utcoffset() is not None


_VALIDATOR = Draft202012Validator(F2_STRUCTURE_SCHEMA, format_checker=_FORMATS)


def _validate_item_weights(demand):
    items = demand["items"]
    required = [Decimal(item["required_weight_kg"]) for item in items]
    if (
        len({item["item_id"] for item in items}) != len(items)
        or sum(required) != Decimal(demand["required_weight_kg"])
        or any(weight <= 0 or Decimal(item["confirmed_weight_kg"]) < weight for item, weight in zip(items, required, strict=True))
    ):
        raise ValidationError("F2 Demand weights or confirmed item allocations are inconsistent.")


def validate_f2_structure(data):
    try:
        _VALIDATOR.validate(data)
    except JsonSchemaValidationError as exc:
        path = ".".join(map(str, exc.absolute_path)) or "root"
        raise ValidationError("Invalid F2 structure at %(path)s.", params={"path": path}) from exc

    basis, option = data["basis"], data["option"]
    start = time.fromisoformat(basis["common_start_time"])
    end = time.fromisoformat(basis["common_end_time"])
    demands = []
    starts, ends = [], []
    for demand in basis["demands"]:
        _validate_item_weights(demand)
        starts.append(time.fromisoformat(demand["requested_start_time"]))
        ends.append(time.fromisoformat(demand["requested_end_time"]))
        if demand["requested_date"] != basis["requested_date"] or (
            time.fromisoformat(demand["pickup_ready_start_time"]) >= time.fromisoformat(demand["pickup_ready_end_time"])
        ):
            raise ValidationError("F2 Demand date or pickup window is inconsistent.")
        demands.append(Demand(**{
            **demand,
            "required_weight_kg": Decimal(demand["required_weight_kg"]),
            "items": tuple(DemandItem(i["item_id"], Decimal(i["required_weight_kg"]), Decimal(i["confirmed_weight_kg"])) for i in demand["items"]),
        }))
    if (
        start != max(starts) or end != min(ends) or start > end
        or sorted({demand.cargo_category_id for demand in demands}) != basis["cargo_category_ids"]
    ):
        raise ValidationError("F2 common window or cargo categories are inconsistent.")

    candidate = {key: basis[key] for key in (
        "demand_ids", "requested_date", "common_start_time", "common_end_time", "cargo_category_ids",
    )}
    try:
        replay = generate_options(
            lineage=data["lineage"], candidate=candidate, demands=demands,
            hub=HubPoint(**option["hub"]) if option["hub"] else None,
        )
    except ValueError as exc:
        raise ValidationError("F2 Candidate Demand membership is inconsistent.") from exc
    expected = next(row for row in replay["options"] if row["template_type"] == option["template_type"])
    if replay["basis"] != basis or expected != option:
        raise ValidationError("F2 topology, membership, weight or fingerprint differs from the captured evidence.")
