
import json
import re
from datetime import datetime, date, time
from decimal import Decimal, InvalidOperation
from django.core.exceptions import ValidationError
_MODEL_LABELS = {
    "DEMAND": "demands.DeliveryDemand",
    "DEMAND_ITEM": "demands.DemandItem",
    "DEMAND_SOURCING_OPTION": "demands.DemandSourcingOption",
    "SUPPLIER": "masterdata.Supplier",
    "SUPPLIER_ITEM": "masterdata.SupplierItem",
    "SUPPLIER_REQUEST": "demands.SupplierRequest",
    "SUPPLIER_CONFIRMATION": "demands.SupplierConfirmation",
    "SUPPLIER_ITEM_PROMISE": "demands.SupplierItemPromise",
    "ITEM": "masterdata.Item",
    "CARGO_CATEGORY": "masterdata.CargoCategory",
    "OUTLET": "masterdata.Outlet",
    "CAPACITY_DEMAND": "demands.DeliveryDemand",
    "CAPACITY_DEMAND_ITEM": "demands.DemandItem",
    "CAPACITY_SUPPLIER_REQUEST": "demands.SupplierRequest",
    "CAPACITY_SUPPLIER_CONFIRMATION": "demands.SupplierConfirmation",
    "CAPACITY_SUPPLIER_ITEM_PROMISE": "demands.SupplierItemPromise",
    "CAPACITY_SUPPLIER_ITEM": "masterdata.SupplierItem",
}

_DEMAND_FIELDS = {
    "DEMAND_CODE",
    "SUPPLIER_ID",
    "OUTLET_ID",
    "CARGO_CATEGORY_ID",
    "QUANTITY_KG",
    "REQUESTED_DATE",
    "REQUESTED_START_TIME",
    "REQUESTED_END_TIME",
    "STATUS",
}

_FIELD_ALLOWLISTS = {
    "DEMAND": _DEMAND_FIELDS,
    "CAPACITY_DEMAND": _DEMAND_FIELDS,

    "DEMAND_ITEM": {
        "DEMAND_ID",
        "ITEM_ID",
        "REQUIRED_WEIGHT_KG",
        "UNIT_OF_MEASURE",
    },
    "DEMAND_SOURCING_OPTION": {
        "DEMAND_ITEM_ID", "SUPPLIER_ITEM_ID", "OPTION_TYPE",
        "EVALUATION_STATUS", "EXCLUSION_REASON_PRESENT",
    },
    "CAPACITY_DEMAND_ITEM": {
        "DEMAND_ID",
        "ITEM_ID",
        "REQUIRED_WEIGHT_KG",
        "UNIT_OF_MEASURE",
    },

    "SUPPLIER": {
        "IS_ACTIVE",
    },

    "SUPPLIER_ITEM": {
        "SUPPLIER_ID",
        "ITEM_ID",
        "OFFER_STATUS",
        "UNIT_PRICE_VND_PER_KG",
        "MAX_DAILY_SUPPLY_KG",
        "MINIMUM_ORDER_KG",
        "LEAD_TIME_HOURS",
    },
    "CAPACITY_SUPPLIER_ITEM": {
        "SUPPLIER_ID",
        "ITEM_ID",
        "OFFER_STATUS",
        "UNIT_PRICE_VND_PER_KG",
        "MAX_DAILY_SUPPLY_KG",
        "MINIMUM_ORDER_KG",
        "LEAD_TIME_HOURS",
    },

    "ITEM": {
        "CARGO_CATEGORY_ID",
        "WEIGHT_UNIT",
        "IS_ACTIVE",
    },

    "CARGO_CATEGORY": {
        "CATEGORY_CODE",
        "IS_ACTIVE",
    },

    "OUTLET": {
        "OUTLET_CODE",
        "IS_ACTIVE",
    },

    "SUPPLIER_REQUEST": {
        "DEMAND_ID",
        "SUPPLIER_ID",
        "ATTEMPT_NO",
        "REQUEST_STATUS",
        "SUPPLIER_CONFIRMATION_ID",
        "SENT_AT",
        "RESPONDED_AT",
    },
    "CAPACITY_SUPPLIER_REQUEST": {
        "DEMAND_ID",
        "SUPPLIER_ID",
        "ATTEMPT_NO",
        "REQUEST_STATUS",
        "SUPPLIER_CONFIRMATION_ID",
        "SENT_AT",
        "RESPONDED_AT",
    },

    "SUPPLIER_CONFIRMATION": {
        "DEMAND_ID",
        "SUPPLIER_ID",
        "CONFIRMATION_STATUS",
        "SOURCE_MODE",
        "READY_DATE",
        "READY_START_TIME",
        "READY_END_TIME",
        "PICKUP_ADDRESS",
        "RECORDED_AT",
        "COMMITMENT_RELEASED_AT",
        "COMMITMENT_RELEASED_BY_ID",
    },
    "CAPACITY_SUPPLIER_CONFIRMATION": {
        "DEMAND_ID",
        "SUPPLIER_ID",
        "CONFIRMATION_STATUS",
        "SOURCE_MODE",
        "READY_DATE",
        "READY_START_TIME",
        "READY_END_TIME",
        "PICKUP_ADDRESS",
        "RECORDED_AT",
        "COMMITMENT_RELEASED_AT",
        "COMMITMENT_RELEASED_BY_ID",
    },

    "SUPPLIER_ITEM_PROMISE": {
        "SUPPLIER_REQUEST_ID",
        "DEMAND_ITEM_ID",
        "SUPPLIER_ITEM_ID",
        "PROMISED_WEIGHT_KG",
        "CONFIRMED_WEIGHT_KG",
        "LINE_STATUS",
        "UNIT_PRICE_VND_PER_KG_SNAPSHOT",
        "LEAD_TIME_HOURS_SNAPSHOT",
    },
    "CAPACITY_SUPPLIER_ITEM_PROMISE": {
        "SUPPLIER_REQUEST_ID",
        "DEMAND_ITEM_ID",
        "SUPPLIER_ITEM_ID",
        "PROMISED_WEIGHT_KG",
        "CONFIRMED_WEIGHT_KG",
        "LINE_STATUS",
        "UNIT_PRICE_VND_PER_KG_SNAPSHOT",
        "LEAD_TIME_HOURS_SNAPSHOT",
    },
}

_MODEL_LABEL_RE = re.compile(
    r"^[a-z][a-z0-9_]*\.[A-Z][A-Za-z0-9_]*$"
)
_PK_RE = re.compile(r"^[1-9][0-9]*$")
_ID_FIELDS = {
    "SUPPLIER_ID",
    "OUTLET_ID",
    "CARGO_CATEGORY_ID",
    "DEMAND_ID",
    "ITEM_ID",
    "SUPPLIER_CONFIRMATION_ID",
    "COMMITMENT_RELEASED_BY_ID",
    "SUPPLIER_REQUEST_ID",
    "DEMAND_ITEM_ID",
    "SUPPLIER_ITEM_ID",
}

_DECIMAL_FIELDS = {
    "QUANTITY_KG",
    "REQUIRED_WEIGHT_KG",
    "UNIT_PRICE_VND_PER_KG",
    "MAX_DAILY_SUPPLY_KG",
    "MINIMUM_ORDER_KG",
    "PROMISED_WEIGHT_KG",
    "CONFIRMED_WEIGHT_KG",
    "UNIT_PRICE_VND_PER_KG_SNAPSHOT",
}

_BOOLEAN_FIELDS = {"IS_ACTIVE", "EXCLUSION_REASON_PRESENT"}

_INTEGER_FIELDS = {
    "ATTEMPT_NO",
    "LEAD_TIME_HOURS",
    "LEAD_TIME_HOURS_SNAPSHOT",

}

_DATE_FIELDS = {
    "REQUESTED_DATE",
    "READY_DATE",
}

_TIME_FIELDS = {
    "REQUESTED_START_TIME",
    "REQUESTED_END_TIME",
    "READY_START_TIME",
    "READY_END_TIME",
}

_TIMESTAMP_FIELDS = {
    "SENT_AT",
    "RESPONDED_AT",
    "RECORDED_AT",
    "COMMITMENT_RELEASED_AT",
}

_STRING_FIELDS = {
    "DEMAND_CODE",
    "STATUS",
    "UNIT_OF_MEASURE",
    "OFFER_STATUS",
    "OPTION_TYPE",
    "EVALUATION_STATUS",
    "WEIGHT_UNIT",
    "CATEGORY_CODE",
    "OUTLET_CODE",
    "REQUEST_STATUS",
    "CONFIRMATION_STATUS",
    "SOURCE_MODE",
    "PICKUP_ADDRESS",
    "LINE_STATUS",
}

_CAPACITY_REQUIRED_FIELDS = {
    "CAPACITY_DEMAND": _DEMAND_FIELDS,
    "CAPACITY_DEMAND_ITEM": {
        "DEMAND_ID", "ITEM_ID", "REQUIRED_WEIGHT_KG", "UNIT_OF_MEASURE",
    },
    "CAPACITY_SUPPLIER_ITEM": {
        "SUPPLIER_ID", "ITEM_ID", "MAX_DAILY_SUPPLY_KG",
    },
    "CAPACITY_SUPPLIER_REQUEST": {
        "DEMAND_ID", "SUPPLIER_ID", "ATTEMPT_NO",
        "REQUEST_STATUS", "SUPPLIER_CONFIRMATION_ID",
    },
    "CAPACITY_SUPPLIER_CONFIRMATION": {
        "DEMAND_ID", "SUPPLIER_ID",
        "CONFIRMATION_STATUS", "COMMITMENT_RELEASED_AT",
    },
    "CAPACITY_SUPPLIER_ITEM_PROMISE": {
        "SUPPLIER_REQUEST_ID", "DEMAND_ITEM_ID", "SUPPLIER_ITEM_ID",
        "PROMISED_WEIGHT_KG", "CONFIRMED_WEIGHT_KG", "LINE_STATUS",
    },
}


def _validate_decimal_string(value, field):
    if not isinstance(value, str):
        raise ValidationError(
            f"{field} must be serialized as a decimal string."
        )

    try:
        parsed = Decimal(value)
    except (InvalidOperation, ValueError):
        raise ValidationError(f"{field} is not a valid decimal string.")

    if not parsed.is_finite():
        raise ValidationError(f"{field} must be finite.")

    # Reject whitespace, exponent notation and non-canonical leading zeros.
    if value.strip() != value or "e" in value.lower():
        raise ValidationError(f"{field} is not a canonical decimal string.")

    import re
    if not re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?", value):
        raise ValidationError(f"{field} is not a canonical decimal string.")


def _validate_date_string(value, field):
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be an ISO date string.")

    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError(f"{field} must be YYYY-MM-DD.") from exc

    if parsed.isoformat() != value:
        raise ValidationError(f"{field} must be canonical YYYY-MM-DD.")


def _validate_time_string(value, field):
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be an ISO time string.")

    try:
        parsed = time.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError(f"{field} has an invalid time.") from exc

    if parsed.tzinfo is not None or parsed.isoformat() != value:
        raise ValidationError(
            f"{field} must be a local time HH:MM:SS[.ffffff]."
        )


def _validate_value_types(values, context):
    for field, value in values.items():
        field_context = f"{context}.{field}"

        # SQL NULL is represented as JSON null. Type validation applies
        # only when the source field is non-null.
        if value is None:
            continue

        if field in _ID_FIELDS:
            _validate_pk(value, field_context)

        elif field in _DECIMAL_FIELDS:
            _validate_decimal_string(value, field_context)

        elif field in _BOOLEAN_FIELDS:
            if not isinstance(value, bool):
                raise ValidationError(
                    f"{field_context} must be a boolean."
                )

        elif field in _INTEGER_FIELDS:
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
                or value < 0
            ):
                raise ValidationError(
                    f"{field_context} must be a non-negative integer."
                )

        elif field in _DATE_FIELDS:
            _validate_date_string(value, field_context)

        elif field in _TIME_FIELDS:
            _validate_time_string(value, field_context)

        elif field in _TIMESTAMP_FIELDS:
            _validate_timestamp(value, require_utc_z=True)

        elif field in _STRING_FIELDS:
            _validate_string(value, field_context)
MAX_DEMAND_SNAPSHOT_BYTES = 256 * 1024
MAX_FAILURE_DIAGNOSTICS_BYTES = 16 * 1024

SNAPSHOT_SCHEMA_V1_ID = (
    "cologi://cp08/planning-run-demand-snapshot/1.0"
)
SNAPSHOT_SCHEMA_V1_1_ID = (
    "cologi://cp08/planning-run-demand-snapshot/1.1"
)

PLAN_GUARD_STATUSES = {
    "PASS",
    "CONFLICT",
    "NOT_EVALUATED",
}

_TOP_LEVEL_V1 = {
    "$id",
    "schema_version",
    "captured_at",
    "demand_ref",
    "demand_values",
    "related_records",
}

_TOP_LEVEL_V1_1 = _TOP_LEVEL_V1 | {"gate_evidence"}

_RELATED_RECORD_KEYS = {
    "source_kind",
    "model_label",
    "pk",
    "values",
}




def validate_json_object(value):
    if not isinstance(value, dict):
        raise ValidationError("Value must be a JSON object.")


def validate_diagnostics_array(value):
    if not isinstance(value, list):
        raise ValidationError("Diagnostics must be a JSON array.")


def _validate_string(value, field, *, max_length=1024):
    if (
        not isinstance(value, str)
        or not value
        or len(value) > max_length
        or value.strip() != value
    ):
        raise ValidationError(f"Invalid snapshot {field}.")


def _validate_timestamp(value, *, require_utc_z=False):
    _validate_string(value, "timestamp")

    if require_utc_z and not value.endswith("Z"):
        raise ValidationError(
            "Timestamp must use UTC RFC3339 Z."
        )

    try:
        parsed = datetime.fromisoformat(
            value[:-1] + "+00:00"
            if value.endswith("Z")
            else value
        )
    except ValueError as exc:
        raise ValidationError(
            "Timestamp must be RFC3339."
        ) from exc

    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValidationError(
            "Timestamp must include timezone information."
        )

    if require_utc_z and parsed.utcoffset().total_seconds() != 0:
        raise ValidationError(
            "Timestamp must represent UTC."
        )


def _validate_pk(value, field):
    if (
        not isinstance(value, str)
        or not _PK_RE.fullmatch(value)
    ):
        raise ValidationError(
            f"{field} must be a canonical positive integer string."
        )


def _validate_demand_ref(value):
    if not isinstance(value, dict):
        raise ValidationError("demand_ref must be an object.")

    if set(value) != {"model_label", "pk"}:
        raise ValidationError("Invalid demand_ref properties.")

    if value["model_label"] != "demands.DeliveryDemand":
        raise ValidationError("Invalid demand_ref model_label.")

    _validate_pk(value["pk"], "demand_ref.pk")



def _validate_field_map(
    value,
    allowed_fields,
    context,
    *,
    required_fields=None,
):
    if not isinstance(value, dict):
        raise ValidationError(f"{context} must be an object.")

    actual = set(value)

    unknown = actual - allowed_fields
    if unknown:
        raise ValidationError(
            f"{context} contains unsupported fields: {sorted(unknown)}"
        )

    required = (
        allowed_fields
        if required_fields is None
        else required_fields
    )
    missing = required - actual

    if missing:
        raise ValidationError(
            f"{context} is missing required fields: {sorted(missing)}"
        )

    _validate_value_types(value, context)

def _validate_demand_values(value):
    _validate_field_map(
        value,
        _DEMAND_FIELDS,
        "demand_values",
    )

def _validate_related_records(value, *, allow_sourcing_options=False):
    if not isinstance(value, list):
        raise ValidationError("related_records must be an array.")

    previous_key = None
    seen = set()

    for index, record in enumerate(value):
        context = f"related_records[{index}]"

        if not isinstance(record, dict):
            raise ValidationError(f"{context} must be an object.")

        if set(record) != _RELATED_RECORD_KEYS:
            raise ValidationError(
                f"{context} has invalid properties."
            )

        source_kind = record["source_kind"]
        model_label = record["model_label"]
        pk = record["pk"]
        values = record["values"]

        if source_kind not in _MODEL_LABELS:
            raise ValidationError(
                f"{context} has unsupported source_kind."
            )
        if source_kind == "DEMAND_SOURCING_OPTION" and not allow_sourcing_options:
            raise ValidationError("Sourcing option evidence is supported on schema 1.1 only.")

        if model_label != _MODEL_LABELS[source_kind]:
            raise ValidationError(
                f"{context} model_label does not match source_kind."
            )

        _validate_pk(pk, f"{context}.pk")

        allowed_fields = _FIELD_ALLOWLISTS[source_kind]
        required_fields = _CAPACITY_REQUIRED_FIELDS.get(source_kind)
        if source_kind == "DEMAND_SOURCING_OPTION":
            required_fields = allowed_fields

        _validate_field_map(
            values,
            allowed_fields,
            f"{context}.values",
            required_fields=required_fields,
        )
        if source_kind == "DEMAND_SOURCING_OPTION" and any(value is None for value in values.values()):
            raise ValidationError(f"{context}.values must contain non-null evidence.")

        current_key = (source_kind, model_label, pk)

        if current_key in seen:
            raise ValidationError(
                f"{context} duplicates a snapshot record."
            )

        if previous_key is not None and current_key < previous_key:
            raise ValidationError(
                "related_records are not deterministically ordered."
            )

        seen.add(current_key)
        previous_key = current_key


def _validate_v1(snapshot):
    if set(snapshot) != _TOP_LEVEL_V1:
        raise ValidationError(
            "Schema 1.0 has missing or unsupported top-level properties."
        )

    if snapshot["$id"] != SNAPSHOT_SCHEMA_V1_ID:
        raise ValidationError("Invalid Schema 1.0 $id.")

    _validate_timestamp(snapshot["captured_at"])
    _validate_demand_ref(snapshot["demand_ref"])
    _validate_demand_values(snapshot["demand_values"])
    _validate_related_records(snapshot["related_records"])


def _validate_plan_guard(plan_guard):
    if not isinstance(plan_guard, dict):
        raise ValidationError("plan_guard must be an object.")

    required = {
        "status",
        "source_system",
        "evaluated_at",
        "evidence_reference",
    }

    if set(plan_guard) != required:
        raise ValidationError(
            "plan_guard has missing or unsupported properties."
        )

    status = plan_guard["status"]

    if not isinstance(status, str) or status not in PLAN_GUARD_STATUSES:
        raise ValidationError("Invalid canonical Plan Guard status.")

    if plan_guard["source_system"] != "FULFILLMENT_PLAN":
        raise ValidationError("Invalid Plan Guard source_system.")

    evaluated_at = plan_guard["evaluated_at"]
    evidence_reference = plan_guard["evidence_reference"]

    if status == "NOT_EVALUATED":
        if evaluated_at is not None or evidence_reference is not None:
            raise ValidationError(
                "NOT_EVALUATED requires null evaluated_at and evidence_reference."
            )
        return

    if evaluated_at is None or evidence_reference is None:
        raise ValidationError(
            "PASS and CONFLICT require external evidence timestamp and reference."
        )

    _validate_timestamp(evaluated_at, require_utc_z=True)
    _validate_string(
        evidence_reference,
        "plan_guard.evidence_reference",
    )


def _validate_v1_1(snapshot):
    if set(snapshot) != _TOP_LEVEL_V1_1:
        raise ValidationError(
            "Schema 1.1 has missing or unsupported top-level properties."
        )

    if snapshot["$id"] != SNAPSHOT_SCHEMA_V1_1_ID:
        raise ValidationError("Invalid Schema 1.1 $id.")

    _validate_timestamp(
        snapshot["captured_at"],
        require_utc_z=True,
    )
    _validate_demand_ref(snapshot["demand_ref"])
    _validate_demand_values(snapshot["demand_values"])
    _validate_related_records(snapshot["related_records"], allow_sourcing_options=True)

    gate_evidence = snapshot["gate_evidence"]

    if not isinstance(gate_evidence, dict):
        raise ValidationError("gate_evidence must be an object.")

    if set(gate_evidence) != {"plan_guard"}:
        raise ValidationError("Invalid gate_evidence properties.")

    _validate_plan_guard(gate_evidence["plan_guard"])


def validate_demand_snapshot(value):
    if not isinstance(value, dict):
        raise ValidationError("Demand snapshot must be a JSON object.")

    version = value.get("schema_version")

    if version == "1.0":
        _validate_v1(value)
    elif version == "1.1":
        _validate_v1_1(value)
    else:
        raise ValidationError(
            "Unsupported demand snapshot schema version."
        )

    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValidationError(
            "Demand snapshot must contain valid JSON data."
        ) from exc

    if len(encoded) > MAX_DEMAND_SNAPSHOT_BYTES:
        raise ValidationError(
            "Demand snapshot exceeds the 256 KiB limit."
        )
