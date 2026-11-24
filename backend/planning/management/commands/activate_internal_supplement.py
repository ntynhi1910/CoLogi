import json
import re
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from accounts.capstone import PROVENANCE
from accounts.models import AuditLog, User
from planning.models import CostProfile, OperationalEvidence
from planning.services.internal_supplement import ACTION, SCENARIO, VERSION, WORKBOOK_SHA256


class Command(BaseCommand):
    help = "Audit or approve the exact Supplement import for internal planning."

    def add_arguments(self, parser):
        parser.add_argument("--report", required=True, type=Path)
        parser.add_argument("--database-confirm", required=True)
        parser.add_argument("--approval-reference", required=True)
        parser.add_argument("--actor-id", required=True, type=int)
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--approved-manifest", type=Path)

    @transaction.atomic
    def handle(self, *args, **opts):
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database(), host(inet_server_addr())")
            database, host = cursor.fetchone()
            if database != opts["database_confirm"] or host != "127.0.0.1" or (
                database != "cologi" and not re.fullmatch(r"cologi_cp08_group126_[0-9]{8}_[0-9]{6}", database)
            ):
                raise CommandError("Unapproved database target.")
            if opts["apply"]:
                cursor.execute("SELECT pg_advisory_xact_lock(%s)", [1206001])
        actor = User.objects.filter(pk=opts["actor_id"], is_active=True, capstone_scenario="",
                                    user_roles__role__code="MANAGER", user_roles__role__is_active=True,
                                    user_roles__is_active=True).first()
        if not actor:
            raise CommandError("An active operational Manager is required.")
        imported = AuditLog.objects.filter(action="V7_SUPPLEMENT_IMPORTED", entity_id=SCENARIO).first()
        if not imported or imported.new_values.get("file_sha256") != WORKBOOK_SHA256:
            raise CommandError("The approved import audit is missing.")
        ids = sorted({row["id"] for row in imported.new_values["records"]})
        rows = list(OperationalEvidence.objects.filter(
            pk__in=ids, scenario=SCENARIO, provenance=PROVENANCE, approval="APPROVED",
        ).order_by("pk"))
        if len(ids) != 2124 or len(rows) != len(ids) or any(
            not row.source_reference.startswith("V7S:" + WORKBOOK_SHA256[:16] + ":") for row in rows
        ):
            raise CommandError("The imported evidence differs from the approved workbook.")
        policy = next(row for row in rows if row.kind == "POLICY")
        profile = CostProfile.objects.get(pk=policy.scope["profile_id"], profile_code="CP_GOLDEN", is_active=False)
        data = {
            "version": VERSION, "file_sha256": WORKBOOK_SHA256, "record_ids": ids,
            "profile_id": profile.pk, "import_audit_id": imported.pk,
            "valid_from": min(row.valid_from for row in rows).isoformat(),
            "valid_to": max(row.valid_to for row in rows).isoformat(),
            "first_fleet_date": min(row.valid_from for row in rows if row.kind == "AVAILABILITY").isoformat(),
            "approval_reference": opts["approval_reference"],
        }
        if opts["apply"] and database == "cologi":
            approved = opts["approved_manifest"]
            if not approved or approved.resolve() == opts["report"].resolve():
                raise CommandError("Apply requires a separate reviewed dry-run report.")
            if json.loads(approved.read_text(encoding="utf-8")) != self._report(database, data):
                raise CommandError("The approval differs from the current cologi dry run.")
        report = self._report(database, data)
        if opts["apply"]:
            previous = AuditLog.objects.filter(action=ACTION, entity_id=SCENARIO).order_by("-pk").first()
            if previous and previous.new_values != data:
                raise CommandError("Another internal approval already exists for this version.")
            report["action"] = "SKIP" if previous else "INSERT"
            if previous is None:
                previous = AuditLog.objects.create(actor_user=actor, action=ACTION,
                    entity_type="operational_evidence", entity_id=SCENARIO, new_values=data)
            report["approval_id"] = previous.pk
        opts["report"].write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        self.stdout.write(json.dumps({key: value for key, value in report.items() if key != "data"}))

    @staticmethod
    def _report(database, data):
        return {"target": database, "action": "DRY_RUN", "records_reused": len(data["record_ids"]), "data": data}
