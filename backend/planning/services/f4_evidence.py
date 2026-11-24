"""Read-only F4 source adapters. Only a deployment-owned, approved document can supply timing estimates."""

from datetime import date, time
import json
from pathlib import Path

from django.conf import settings
from django.db import connection
from jsonschema import Draft202012Validator, FormatChecker

from planning.f2_structure import BY_DATE, BY_TIME, ID, TEXT
from planning.f4_contract import SYNTHETIC
from planning.models import ReceivingSlot, ReceivingWindow
from planning.services.f3_hub_coverage import uat_hub_coverage_enabled


class F4EvidenceInvalid(Exception):
    pass


class F4ScenarioUnavailable(Exception):
    pass


def _object(**fields):
    return {"type": "object", "properties": fields, "required": list(fields), "additionalProperties": False}


def _array(record):
    return {"type": "array", "items": record}


_REFERENCE = {"source": TEXT, "reference": TEXT}
_INTERVAL = {"start_time": BY_TIME, "end_time": BY_TIME, **_REFERENCE}
_WINDOW = _object(**_INTERVAL)
_SLOT = _object(
    slot_type={"enum": ["BLOCKED", "AVAILABLE"]},
    status={"enum": ["OPEN", "RESERVED", "CONFIRMED", "REJECTED", "CANCELLED"]}, **_INTERVAL,
)
_TRAVEL = _object(
    from_stop=TEXT, to_stop=TEXT, minutes={"type": "integer", "minimum": 0, "maximum": 1440},
    distance_km={"type": "string", "pattern": r"^[0-9]+(?:\.[0-9]+)?$"}, **_REFERENCE,
)
_SERVICE = _object(
    stop=TEXT, role={"enum": ["SUPPLIER_PICKUP", "OUTLET_DELIVERY", "HUB_RECEIVE", "HUB_DISPATCH"]},
    minutes={"type": "integer", "minimum": 1, "maximum": 1440}, **_REFERENCE,
)
_SCOPE = _object(
    f3_evaluation_code={"type": "string", "format": "uuid"}, provider_id=ID, service_date=BY_DATE, timezone=TEXT,
    travel=_array(_TRAVEL), services=_array(_SERVICE), hub_windows=_array(_object(stop=TEXT, **_INTERVAL)),
    receiving=_array(_object(outlet_id=ID, windows=_array(_WINDOW), slots=_array(_SLOT), **_REFERENCE)),
)
_SCOPE["properties"].update(
    source_mode={"enum": ["OPERATIONAL", SYNTHETIC]},
    f4_configuration=_object(
        version=TEXT,
        rules={
            "type": "object",
            "additionalProperties": _object(expression=TEXT, rule_type=TEXT),
        },
        parameters={
            "type": "object",
            "propertyNames": {"enum": ["TIMEZONE", "SERVICE_DURATION_MINUTES", "ALTERNATE_SLOT_SEARCH"]},
            "additionalProperties": _object(value={}, data_type=TEXT),
        },
    ),
)
_DOCUMENT = Draft202012Validator(
    _object(schema_version={"const": 1}, approval_reference=TEXT, evaluations=_array(_SCOPE)),
    format_checker=FormatChecker(),
)
_SLUG = {"type": "string", "pattern": r"^[a-z0-9]+(?:-[a-z0-9]+)*$", "maxLength": 50}
_SCENARIO_SCOPE = {**_SCOPE, "properties": {**_SCOPE["properties"], "approval_reference": TEXT}}
_REGISTRY = Draft202012Validator(
    _object(
        schema_version={"const": 2}, approval_reference=TEXT, run_code={"type": "string", "format": "uuid"},
        group_code=TEXT, default_scenario=_SLUG,
        scopes={"type": "object", "minProperties": 1, "propertyNames": _SLUG, "additionalProperties": _SCENARIO_SCOPE},
        scenarios={"type": "object", "minProperties": 1, "propertyNames": _SLUG, "additionalProperties": _object(
            label=TEXT, cases={"type": "array", "minItems": 1, "uniqueItems": True, "items": _SLUG},
        )},
    ),
    format_checker=FormatChecker(),
)


def _unique(rows, *keys):
    return len({tuple(row[key] for key in keys) for row in rows}) == len(rows)


def read_approved_document():
    path = getattr(settings, "F4_TIME_EVIDENCE_FILE", None)
    if not path:
        return None
    try:
        with Path(path).open(encoding="utf-8") as source:
            data = json.load(source)
    except (OSError, ValueError) as exc:
        raise F4EvidenceInvalid from exc
    registry = isinstance(data, dict) and data.get("schema_version") == 2
    if registry:
        if not _REGISTRY.is_valid(data) or data["default_scenario"] not in data["scenarios"]:
            raise F4EvidenceInvalid
        scopes = data["scopes"]
        for scenario in data["scenarios"].values():
            cases = scenario["cases"]
            if any(case not in scopes for case in cases) or not _unique(
                [scopes[case] for case in cases], "f3_evaluation_code",
            ):
                raise F4EvidenceInvalid
    else:
        if not _DOCUMENT.is_valid(data) or not _unique(data["evaluations"], "f3_evaluation_code"):
            raise F4EvidenceInvalid
        scopes = dict(enumerate(data["evaluations"]))
    for scope in scopes.values():
        if not (
            _unique(scope["travel"], "from_stop", "to_stop") and _unique(scope["services"], "stop", "role")
            and _unique(scope["receiving"], "outlet_id")
        ):
            raise F4EvidenceInvalid
        for interval in [
            *scope["hub_windows"],
            *(record for row in scope["receiving"] for record in (*row["windows"], *row["slots"])),
        ]:
            if time.fromisoformat(interval["start_time"]) >= time.fromisoformat(interval["end_time"]):
                raise F4EvidenceInvalid
        provenance = [
            *scope["services"], *scope["travel"], *scope["hub_windows"],
            *(record for row in scope["receiving"] for record in [row, *row["windows"], *row["slots"]]),
        ]
        if registry and (
            scope.get("source_mode") != SYNTHETIC or not scope.get("f4_configuration")
            or any(row["source"] != SYNTHETIC for row in provenance)
        ):
            raise F4EvidenceInvalid
        if scope.get("source_mode") != SYNTHETIC and any("SYNTHETIC" in row["source"].upper() for row in provenance):
            raise F4EvidenceInvalid
    return data


def select_scenario(document, *, run_code, group_code, requested):
    registry = document is not None and document["schema_version"] == 2
    available = registry and uat_hub_coverage_enabled(connection) and (
        document["run_code"], document["group_code"]
    ) == (str(run_code), group_code)
    if not available:
        if requested is not None:
            raise F4ScenarioUnavailable
        return (None if registry else document), [], None
    code = document["default_scenario"] if requested is None else requested
    scenario = document["scenarios"].get(code)
    if not scenario:
        raise F4ScenarioUnavailable
    return {
        "approval_reference": document["approval_reference"],
        "scenario_registry": True,
        "evaluations": [{**document["scopes"][case], "scenario_id": case} for case in scenario["cases"]],
    }, [{"code": key, "label": row["label"]} for key, row in document["scenarios"].items()], code


def _period(row):
    return {
        "start_time": row.start_time.isoformat(), "end_time": row.end_time.isoformat(),
        "source": row.source, "reference": row.source_reference, "source_mode": row.source_mode,
    }


def read_receiving_calendars(day, outlets, scope):
    synthetic = scope is not None and scope.get("source_mode") == SYNTHETIC
    planned = {row["outlet_id"]: row for row in scope["receiving"]} if scope else {}
    mode = SYNTHETIC if synthetic else "OPERATIONAL"
    windows, slots = {pk: [] for pk in outlets}, {pk: [] for pk in outlets}
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('public.receiving_windows'), to_regclass('public.receiving_slots')")
        has_windows, has_slots = cursor.fetchone()
    if has_windows:
        for row in ReceivingWindow.objects.filter(
            outlet_id__in=outlets, day_of_week=day.weekday(), is_active=True, source_mode=mode,
        ).order_by("outlet_id", "start_time", "end_time", "pk"):
            windows[row.outlet_id].append(_period(row))
    if has_slots and not synthetic:
        for row in ReceivingSlot.objects.filter(outlet_id__in=outlets, slot_date=day, source_mode=mode).order_by("pk"):
            slots[row.outlet_id].append({
                **_period(row), "slot_type": row.slot_type, "status": row.status, "reason": row.reason,
            })
    calendars = []
    for pk in outlets:
        declaration = planned.get(pk)
        if scope and "scenario_id" in scope:
            # Each approved case declares the exact V7 recurring windows it uses.
            # A missing or changed row cannot silently fall back to a proposed window.
            keys = ("start_time", "end_time", "reference")
            expected = {tuple(row[key] for key in keys) for row in declaration["windows"]} if declaration else set()
            actual = {tuple(row[key] for key in keys) for row in windows[pk]}
            selected_windows = windows[pk] if actual == expected else []
        else:
            selected_windows = windows[pk] or (declaration["windows"] if declaration else [])
        declared_slots = declaration["slots"] if declaration else None
        if declared_slots is not None and not synthetic:
            # An explicit dated declaration is required, even when the database has no blocked rows.
            # Include known operational slots omitted from the declaration.
            fields = ("start_time", "end_time", "slot_type", "status")
            known = {tuple(row[key] for key in fields) for row in declared_slots}
            declared_slots = declared_slots + [row for row in slots[pk] if tuple(row[key] for key in fields) not in known]
        calendars.append({
            "outlet_id": pk, "windows": selected_windows, "slots": declared_slots, "observed_slots": slots[pk],
            "source": declaration["source"] if declaration else "CoLogi receiving calendar",
            "reference": declaration["reference"] if declaration else day.isoformat(),
            "slot_calendar_confirmed": declaration is not None,
        })
    return calendars


def approved_scope(document, *, evaluation_code, provider_id, timezone, day):
    if not document:
        return None
    scope = next((row for row in document["evaluations"] if row["f3_evaluation_code"] == evaluation_code), None)
    if not scope or (scope.get("source_mode") == SYNTHETIC and not uat_hub_coverage_enabled(connection)):
        return None
    if (scope["provider_id"], scope["service_date"], scope["timezone"]) != (provider_id, day, timezone):
        raise F4EvidenceInvalid
    return scope


def capture_time_evidence(document, scope, *, day, outlets):
    return {
        "approval_reference": scope.get("approval_reference", document["approval_reference"]) if scope else None,
        "scenario_id": scope.get("scenario_id") if scope else None,
        "source_mode": scope.get("source_mode", "OPERATIONAL") if scope else "UNAVAILABLE",
        "travel": scope["travel"] if scope else [],
        "services": scope["services"] if scope else [],
        "hub_windows": scope["hub_windows"] if scope else [],
        "receiving": read_receiving_calendars(date.fromisoformat(day), outlets, scope),
    }
