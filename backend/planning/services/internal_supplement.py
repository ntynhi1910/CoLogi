"""Audit-backed authority to use specific imported Supplement revisions internally."""

from django.conf import settings
from accounts.capstone import PROVENANCE
from accounts.models import AuditLog


ACTION = "V7_SUPPLEMENT_INTERNAL_APPROVAL"
SCENARIO = "v7-supplement-v1"
VERSION = "V7-SUPPLEMENT-v1"
WORKBOOK_SHA256 = "5ce02e1a580ca0cb8d1df8340730d80b3f2666a3ff6bd73135eea938a3bbc196"
SOURCE_MODE = "INTERNAL_PLANNING"


def approval_for_day(day=None):
    if not settings.COLOGI_INTERNAL_SUPPLEMENT:
        return None
    row = AuditLog.objects.filter(action=ACTION, entity_id=SCENARIO).order_by("-id").first()
    if row is None:
        return None
    data = row.new_values or {}
    if data.get("file_sha256") != WORKBOOK_SHA256 or not data.get("record_ids"):
        return None
    if day is not None and not data["valid_from"] <= str(day) <= data["valid_to"]:
        return None
    return {
        "approval_id": row.pk, "version": VERSION, "provenance": PROVENANCE,
        "file_sha256": WORKBOOK_SHA256, "valid_from": data["valid_from"], "valid_to": data["valid_to"],
        "first_fleet_date": data["first_fleet_date"], "profile_id": data["profile_id"],
        "record_ids": data["record_ids"],
    }


def display_approval(approval):
    return {key: value for key, value in approval.items() if key not in ("record_ids", "profile_id")}
