import json
from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from planning.services.supplement_import import inspect_supplement


class Command(BaseCommand):
    help = "Validate and import the code-keyed Capstone V7 Supplement."

    def add_arguments(self, parser):
        parser.add_argument("workbook", type=Path)
        parser.add_argument("--report", type=Path, required=True)
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--database-confirm")
        parser.add_argument("--approved-manifest", type=Path)
        parser.add_argument("--actor-id", type=int)

    def handle(self, *args, workbook, report, apply, database_confirm, approved_manifest, actor_id, **options):
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database()")
            database = cursor.fetchone()[0]
        if apply and (database_confirm != database or not actor_id or database == "cologi_cp08_dev_review"):
            raise CommandError("Confirm the target and audit actor. The established UAT database is excluded.")
        if apply and database == "cologi" and (approved_manifest is None or report.resolve() == approved_manifest.resolve()):
            raise CommandError("Apply on cologi requires a separately approved Supplement dry run.")
        try:
            manifest = json.loads(approved_manifest.read_text(encoding="utf-8-sig")) if approved_manifest else None
            if approved_manifest and (not isinstance(manifest, dict) or manifest.get("target") != database
                                      or manifest.get("applied") is not False):
                raise CommandError("The approved manifest must be a dry run for this target.")
            result = inspect_supplement(workbook.read_bytes(), apply=apply, actor_id=actor_id, approved_manifest=manifest)
        except (OSError, ValueError, ValidationError) as exc:
            raise CommandError(str(exc)) from exc
        result["target"] = database
        report.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        self.stdout.write(json.dumps({"target": database, "applied": result["applied"], "actions": result["actions"]}))
        if apply and not result["applied"]:
            raise CommandError("Supplement conflicts blocked all writes.")
