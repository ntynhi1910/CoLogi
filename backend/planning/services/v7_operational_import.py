"""V7 import of receiving inputs and reference profiles; unrelated sheets are never written."""

from datetime import date, datetime, time
from decimal import Decimal
from hashlib import sha256
from io import BytesIO

from django.core.exceptions import ValidationError
from django.db import connection, transaction
from openpyxl import load_workbook
from django.utils import timezone

from accounts.models import AuditLog
from masterdata.models import Outlet
from planning.models import CostProfile, ReceivingSlot, ReceivingSource, ReceivingWindow


IMPORT_SHEETS = ("15_Receiving_Windows", "16_Receiving_Slots", "14_Cost_Profiles")


def source_rows(workbook, sheet):
    rows = workbook[sheet].iter_rows(min_row=4, values_only=True)
    headings = next(rows)
    return [(index, {key: value for key, value in zip(headings, row) if isinstance(key, str)})
            for index, row in enumerate(rows, 5) if row and row[0] is not None]


def _date(value):
    return value.date() if isinstance(value, datetime) else date.fromisoformat(str(value))


def _time(value):
    return value if isinstance(value, time) else time.fromisoformat(str(value))


def _record(model, key, attributes):
    existing = model.objects.filter(**key).first()
    if existing is not None:
        same = all(getattr(existing, field) == value for field, value in attributes.items()
                   if field not in ("source_reference", "source"))
        return ("SKIP" if same else "CONFLICT"), existing
    candidate = model(**key, **attributes)
    candidate.full_clean()
    return "INSERT", candidate


def _windows(values, outlet, provenance):
    weekday = values["day_of_week"]
    if type(weekday) is not int or weekday not in range(7):
        raise ValueError("Expected a Monday-zero weekday from 0 to 6")
    return _record(ReceivingWindow, {
        "outlet": outlet, "day_of_week": weekday, "start_time": _time(values["start_time"]),
        "end_time": _time(values["end_time"]), "source_mode": ReceivingSource.SYNTHETIC_V7,
    }, {"is_active": values["is_active"], **provenance})


def _slots(values, outlet, provenance):
    return _record(ReceivingSlot, {
        "outlet": outlet, "slot_date": _date(values["slot_date"]), "start_time": _time(values["start_time"]),
        "end_time": _time(values["end_time"]), "slot_type": values["slot_type"],
        "source_mode": ReceivingSource.SYNTHETIC_V7,
    }, {"status": values["status"], "reason": values["reason"], **provenance})


def _profiles(values):
    return _record(CostProfile, {"profile_code": values["profile_code"]}, {
        "profile_name": values["profile_name"], "currency_code": values["currency_code"],
        "fixed_transport_cost": Decimal(str(values["fixed_transport_cost"])),
        "cost_per_km": Decimal(str(values["cost_per_km"])) if values["cost_per_km"] is not None else None,
        "additional_handling_cost": Decimal(str(values["additional_handling_cost"])),
        "is_active": False,
    })


def _entry(digest, sheet, line, values, outlet_codes, outlets):
    reference = f"V7:{digest}:{sheet}!{line}"
    if sheet == "14_Cost_Profiles":
        action, row = _profiles(values)
        key = values["profile_code"]
        expired = False
    else:
        code = outlet_codes[values["outlet_id"]]
        mapper = _windows if sheet == "15_Receiving_Windows" else _slots
        action, row = mapper(values, outlets[code], {"source": "SYNTHETIC_V7", "source_reference": reference})
        when = row.day_of_week if sheet == "15_Receiving_Windows" else f"{row.slot_date}|{row.slot_type}"
        key = f"{code}|{when}|{row.start_time}|{row.end_time}"
        expired = sheet == "16_Receiving_Slots" and row.slot_date < timezone.localdate()
    attributes = {
        name: str(value) if isinstance(value, (date, time, Decimal)) else value
        for name, value in values.items() if name not in ("id", "outlet_id")
    }
    if sheet != "14_Cost_Profiles":
        attributes["outlet_code"] = code
    else:
        attributes["is_active"] = row.is_active if action == "SKIP" else False
    return {
        "sheet": sheet, "row": line, "key": key, "table": row._meta.db_table, "action": action,
        "source_reference": reference, "expired": expired, "source_provenance": "SYNTHETIC_V7",
        "proposed_values": attributes, "imported_active": row.is_active if sheet != "16_Receiving_Slots" else None,
    }, row


@transaction.atomic
def inspect_import(workbook_bytes, *, apply=False, approved_manifest=None):
    digest = sha256(workbook_bytes).hexdigest()
    workbook = load_workbook(BytesIO(workbook_bytes), read_only=True, data_only=True)
    try:
        if apply:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(%s)", [12041204])
        outlets = {outlet.outlet_code: outlet for outlet in Outlet.objects.all()}
        outlet_codes = {value["id"]: value["outlet_code"] for _, value in source_rows(workbook, "05_Outlets")}
        entries, insertions, seen = [], [], set()
        for sheet in IMPORT_SHEETS:
            for line, values in source_rows(workbook, sheet):
                try:
                    result, row = _entry(digest, sheet, line, values, outlet_codes, outlets)
                except (KeyError, TypeError, ValueError, ValidationError) as exc:
                    entries.append({"sheet": sheet, "row": line, "action": "CONFLICT", "reason": str(exc)})
                    continue
                key = (sheet, result["key"])
                if key in seen:
                    result.update(action="CONFLICT", reason="Duplicate workbook business key")
                if result["action"] == "INSERT":
                    insertions.append((result, row))
                elif result["action"] == "CONFLICT":
                    result["reason"] = "An existing row has different values."
                entries.append(result)
                seen.add(key)
        has_conflict = any(row["action"] == "CONFLICT" for row in entries)
        if approved_manifest is not None:
            authorized = {(row["sheet"], row["row"]): row for row in approved_manifest.get("records", [])}
            same_content = all(
                (original := authorized.get((row["sheet"], row["row"]))) is not None
                and all(row.get(key) == original.get(key) for key in (
                    "key", "table", "source_provenance", "source_reference", "proposed_values",
                ))
                and (row["action"] == "SKIP" or row["action"] == original["action"] == "INSERT")
                for row in entries
            )
            if (approved_manifest.get("file_sha256") != digest or len(authorized) != len(entries)
                    or not same_content):
                raise ValidationError("The current import differs from the approved manifest.")
        if apply and not has_conflict:
            for result, row in insertions:
                row.save(force_insert=True)
                result["record_id"] = row.pk
                AuditLog.objects.create(
                    action="V7_INPUT_IMPORTED", entity_type=row._meta.db_table, entity_id=str(row.pk),
                    new_values=result,
                )
        return {"file_sha256": digest, "sheets_in_workbook": len(workbook.sheetnames),
                "applied": apply and not has_conflict, "records": entries}
    finally:
        workbook.close()
