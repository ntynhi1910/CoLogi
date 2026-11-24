from collections import Counter
import json
from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from planning.services.v7_operational_import import inspect_import


class Command(BaseCommand):
    help = "Dry-run or rehearse a conflict-safe V7 receiving/reference import."

    def add_arguments(self, parser):
        parser.add_argument("workbook", type=Path)
        parser.add_argument("--report", type=Path)
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--database-confirm")
        parser.add_argument("--approved-manifest", type=Path)

    def handle(self, *args, workbook, apply, report, database_confirm, approved_manifest, **options):
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database()")
            database = cursor.fetchone()[0]
        if apply and (database_confirm != database or database == "cologi_cp08_dev_review"):
            raise CommandError("Confirm the target database. The established UAT target is excluded.")
        if apply and database == "cologi" and (approved_manifest is None or report == approved_manifest):
            raise CommandError("Apply on cologi requires a separate, approved dry-run manifest.")
        try:
            manifest = json.loads(approved_manifest.read_text(encoding="utf-8-sig")) if approved_manifest else None
            if manifest is not None and (manifest.get("database") != database or manifest.get("applied") is not False):
                raise CommandError("Use a dry-run manifest from the same target database.")
            result = inspect_import(workbook.read_bytes(), apply=apply, approved_manifest=manifest)
        except (OSError, ValueError, ValidationError) as exc:
            raise CommandError(str(exc)) from exc
        result["database"] = database
        result["actions"] = dict(Counter(row["action"] for row in result["records"]))
        if report:
            report.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        self.stdout.write(json.dumps({"database": database, "applied": result["applied"], "actions": result["actions"]}))
        if apply and not result["applied"]:
            raise CommandError("Import conflicts prevented all writes.")
