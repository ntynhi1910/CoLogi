"""Append synthetic planning evidence for one future day in a local release install."""

import argparse
import os
import sys
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

import django

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
django.setup()

from django.db import connection, transaction
from django.utils import timezone
from accounts.models import AuditLog, User
from planning.models import OperationalEvidence
from planning.services.operational_evidence import manager_may_manage, publish

SCENARIO = "v7-supplement-v1"
PROVENANCE = "SYNTHETIC/CAPSTONE"


@transaction.atomic
def prepare(day, template, manager, *, apply):
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database(), current_user")
        database, role = cursor.fetchone()
        isolated = database.startswith("test_cologi_cp13_install_")
        container = (database, role, connection.settings_dict["HOST"]) == ("cologi", "cologi_installer", "db")
        if os.environ.get("COLOGI_RELEASE_INSTALL") != "1" or not (isolated or container):
            raise SystemExit("Use the isolated release installation.")
        if apply:
            cursor.execute("SELECT pg_advisory_xact_lock(%s)", [130001])
    if day <= timezone.localdate(timezone=ZoneInfo("Asia/Ho_Chi_Minh")) or day <= template:
        raise SystemExit("The target must be a future date later than the template date.")
    actor = User.objects.get(email__iexact=manager, is_active=True, capstone_scenario="")
    if not manager_may_manage(actor, set()):
        raise SystemExit("Select an operational Manager with access to the full dataset scope.")
    rows = OperationalEvidence.objects.filter(scenario=SCENARIO, provenance=PROVENANCE).exclude(approval="REFERENCE")
    basis = rows.filter(valid_from__lte=template, valid_to__gte=template).order_by("kind", "business_key", "-version")
    by_key = {}
    for row in basis:
        by_key.setdefault((row.kind, row.business_key), row)
    if not {"AVAILABILITY", "CALENDAR", "TRAVEL", "POLICY"} <= {row.kind for row in by_key.values() if row.approval == "APPROVED"}:
        raise SystemExit("Template day is missing active fleet, calendar, travel or cost policy evidence.")
    staged = []
    for row in by_key.values():
        reference = f"CP13_SYNTHETIC_DAY:{row.pk}:{template.isoformat()}"
        overlap = rows.filter(kind=row.kind, business_key=row.business_key, valid_from__lte=day, valid_to__gte=day)
        if overlap.exists():
            if overlap.count() != 1 or not overlap.filter(valid_from=day, valid_to=day, source_reference=reference,
                                                          approval=row.approval, data=row.data).exists():
                raise SystemExit("Target overlaps an existing revision. Choose a different date.")
            continue
        staged.append((row, reference))
    if apply and staged:
        for row, reference in staged:
            publish(actor=actor, kind=row.kind, scope=row.scope, data=row.data, valid_from=day, valid_to=day,
                    approval=row.approval, provenance=PROVENANCE, scenario=SCENARIO, source_reference=reference)
        AuditLog.objects.create(actor_user=actor, action="CP13_CAPSTONE_DAY_PREPARED", entity_type="operational_evidence",
                                entity_id=SCENARIO, new_values={"day": str(day), "template": str(template),
                                                               "count": len(staged), "provenance": PROVENANCE})
    print(f"{PROVENANCE} {day}: {len(staged)} revisions {'published' if apply else 'eligible to publish'}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, type=date.fromisoformat)
    parser.add_argument("--template", required=True, type=date.fromisoformat)
    parser.add_argument("--manager-email", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    prepare(args.date, args.template, args.manager_email, apply=args.apply)
