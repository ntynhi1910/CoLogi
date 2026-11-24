"""Exact server-pinned authority for the read-only Manager acceptance Preview."""

from dataclasses import replace
from datetime import date, time
from hashlib import sha256
import json

from django.conf import settings
from django.db import connection

from planning.f3_contract import MANAGER_ACCEPTED_AVAILABILITY, fingerprint
from planning.services.f3_allocation import Availability


MANIFEST_PATH = "artifacts/cp08-tp001-v7-revalidation/manager-data-acceptance-v1.json"
MANIFEST_SHA256 = "2f8bae8ec77f49950fdc664521e562490a6f584420fc2532c73683821cc042a4"


class AcceptanceEvidenceMismatch(Exception):
    """The approved evidence or exact lineage no longer matches."""


def manifest_for_request(actor, run_code, group_code, plan_code=None):
    if (not getattr(settings, "COLOGI_MANAGER_ACCEPTANCE_PREVIEW", False)
            or not actor.is_authenticated or not actor.is_active or actor.capstone_scenario):
        return None
    try:
        raw = (settings.BASE_DIR.parent / MANIFEST_PATH).read_bytes()
    except OSError:
        return None
    if sha256(raw).hexdigest() != MANIFEST_SHA256:
        return None
    manifest = json.loads(raw)
    scope = manifest["scope"]
    if (connection.settings_dict["NAME"] != scope["database"]
            or actor.pk != scope["manager_actor_id"]
            or str(run_code) != scope["run_uuid"] or group_code != scope["candidate_code"]
            or plan_code not in (None, scope["plan_code"])):
        return None
    return manifest


def verify_scope(manifest, run, group, plan, revision):
    scope = manifest["scope"]
    f2 = plan.f2_structure
    basis = f2["basis"]
    if (
        (run.pk, group.pk, plan.pk) != (scope["run_id"], scope["candidate_id"], scope["plan_id"])
        or str(run.run_code) != scope["run_uuid"] or group.group_code != scope["candidate_code"]
        or group.status != "CANDIDATE"
        or run.rule_set_id != scope["rule_set_id"] or run.initiated_by_id != scope["manager_actor_id"]
        or plan.group_id != group.pk or plan.created_by_id != scope["manager_actor_id"]
        or plan.plan_code != scope["plan_code"] or plan.template_type != scope["template"] or plan.hub_id is not None
        or revision != 1 or fingerprint(f2) != scope["f2_fingerprint"]
        or basis["requested_date"] != scope["requested_service_date"]
        or basis["demand_ids"] != scope["demand_ids"] or basis["total_required_weight_kg"] != scope["weight_kg"]
    ):
        raise AcceptanceEvidenceMismatch


def verify_pinned_rows(manifest, cursor):
    scope = manifest["scope"]
    source = manifest["sources"]["v7_availability"]
    ids = [row["legacy_id"] for row in source["rows"]]
    # Attested byte recipe, in the same repeatable-read transaction as the allocation.
    cursor.execute("SELECT current_database()")
    if cursor.fetchone()[0] != scope["database"] or ids != list(range(99, 105)):
        raise AcceptanceEvidenceMismatch
    cursor.execute("SELECT to_jsonb(a)::text FROM audit_logs a WHERE id = %s AND action = %s",
                   [source["audit_log_id"], source["audit_action"]])
    audit = cursor.fetchone()
    cursor.execute(
        "SELECT string_agg(to_jsonb(p)::text, E'\\n' ORDER BY id) FROM provider_availability p WHERE id = ANY(%s)",
        [ids],
    )
    rows = cursor.fetchone()[0]
    if (not audit or sha256(audit[0].encode()).hexdigest() != source["audit_row_sha256"]
            or not rows or sha256(rows.encode()).hexdigest() != source["legacy_rows_sha256"]):
        raise AcceptanceEvidenceMismatch


def overlay_legacy_windows(manifest, fleet, audited_ids, has_dated_authority):
    provider, offers, matrix, coverage = fleet
    scope = manifest["scope"]
    source = manifest["sources"]["v7_availability"]
    if not provider or not provider["is_active"] or (
        provider["id"], provider["provider_code"]
    ) != (scope["provider_id"], scope["provider_code"]):
        raise AcceptanceEvidenceMismatch
    mapped = {offer.id: offer for offer in offers}
    for row in source["rows"]:
        offer = mapped.get(row["offer_id"])
        if row["legacy_id"] not in audited_ids or not offer or offer.code != row["vehicle_type"]:
            raise AcceptanceEvidenceMismatch
    admitted = []
    updated = []
    by_offer = {row["offer_id"]: row for row in source["rows"]}
    for offer in offers:
        row = by_offer.get(offer.id)
        if row and not offer.windows and not has_dated_authority(offer.id):
            offer = replace(offer, windows=(Availability(
                row["legacy_id"], date.fromisoformat(source["effective_date"]),
                time.fromisoformat(source["window"]["start"]), time.fromisoformat(source["window"]["end"]),
                row["vehicle_count"], source["availability_status"], MANAGER_ACCEPTED_AVAILABILITY,
            ),))
            admitted.append({
                **row, "workbook_sha256": source["sha256"], "sheet": source["sheet"],
                "original_provenance": source["original_provenance"],
                "stored_source_mode": source["stored_source_mode"], "audit_log_id": source["audit_log_id"],
            })
        updated.append(offer)
    return (provider, updated, matrix, coverage), admitted
