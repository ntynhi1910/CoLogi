"""Audited V7 availability for planning. The imported rows remain historical."""

from hashlib import sha256
import json

from accounts.models import AuditLog
from transportation.models import ProviderAvailability


V7_FLEET_SOURCE = "V7_INTERNAL_PLANNING"
V7_FLEET_VERSION = "V7-FLEET"
V7_WORKBOOK_SHA256 = "fa10e68aa1e39ab6ac4a6fc53d6b0711c76cb8481f035455b254e4193ca4b799"
V7_ROWS_SHA256 = "c6777ad603773b8deea6f58eaa0c9307624815e1272f4f2e872b686d71c57a91"
BATCH_KEY = "TP001_CP7_140_AVAILABILITY_20261116"


def v7_planning_availability():
    batch = AuditLog.objects.filter(
        action="PROVIDER_AVAILABILITY_MIGRATED", entity_type="PROVIDER_AVAILABILITY_BATCH", entity_id=BATCH_KEY,
    ).first()
    if not batch or AuditLog.objects.filter(action="PROVIDER_AVAILABILITY_MIGRATION_REVERSED", entity_id=BATCH_KEY,
                                          pk__gt=batch.pk).exists():
        return None, {}
    old, new = batch.old_values or {}, batch.new_values or {}
    if new.get("workbook") != "CoLogi_Dataset_v7.xlsx" or new.get("sheets") != ["48_Provider_Availability"]:
        return None, {}
    origins = {entry["id"]: entry["source_mode"] for entry in old.get("original_sources", ())}
    ids = new.get("availability_ids", ())
    if len(ids) != 140 or set(ids) != origins.keys():
        return None, {}
    slots = ProviderAvailability.objects.filter(
        pk__in=ids, provider_vehicle_offer__provider__provider_code="TP001", source_mode="PROVIDER_CONFIRMED_IMPORT",
    ).order_by("pk")
    rows = [[slot.pk, slot.provider_vehicle_offer_id, slot.service_date.isoformat(), slot.available_vehicle_count,
             slot.start_time.isoformat(), slot.end_time.isoformat(), slot.availability_status, origins[slot.pk]]
            for slot in slots]
    normalized = json.dumps(rows, separators=(",", ":")).encode()
    if sha256(normalized).hexdigest() != V7_ROWS_SHA256:
        return None, {}
    start, end = min(row[2] for row in rows), max(row[2] for row in rows)
    source = {"approval_id": batch.pk, "version": V7_FLEET_VERSION, "provenance": "SYNTHETIC_V7",
              "file_sha256": V7_WORKBOOK_SHA256, "valid_from": start, "valid_to": end, "first_fleet_date": start,
              "provider_independently_verified": False}
    return source, {row[0]: (slot, row[-1]) for slot, row in zip(slots, rows, strict=True)}
