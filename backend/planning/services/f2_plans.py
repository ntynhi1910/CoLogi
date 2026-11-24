"""Save and replay immutable F2 draft revisions."""

from uuid import NAMESPACE_URL, uuid5

from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
from accounts.capstone import run_scenario

from planning.f2_structure import SCHEMA_VERSION
from planning.models import FulfillmentPlan, _require_read_committed
from planning.services.demand_provenance import (
    OPERATIONAL_SOURCE_REQUIRED, operational_demands_required, requires_operational_provenance,
)
from planning.services.f2_preview import CandidateInvalid, CandidateUnavailable, build_f2_options, find_f2_candidate
from planning.services.plan_persistence import create_draft_plan


class F2MigrationRequired(Exception):
    pass


def f2_storage_available():
    with connection.cursor() as cursor:
        fields = connection.introspection.get_table_description(cursor, FulfillmentPlan._meta.db_table)
    return any(field.name == "f2_structure" for field in fields)


def f2_multi_hub_available():
    return connection.features.supports_nulls_distinct_unique_constraints and MigrationRecorder(connection).migration_qs.filter(
        app="planning", name="0005_f2_option_identity",
    ).exists()


def _saved_plans(group, actor):
    return (
        group.plans.filter(created_by=actor, f2_structure__isnull=False)
        .select_related("supersedes_plan").order_by("pk")
    )


def _visible_plan(plan, outlet_ids):
    return all(demand["outlet_id"] in outlet_ids for demand in plan.f2_structure["basis"]["demands"])


def _summaries(plans, outlet_ids):
    revisions = {}
    for plan in plans:
        revision = 1 if plan.supersedes_plan_id is None else revisions[plan.supersedes_plan_id] + 1
        revisions[plan.pk] = revision
        if _visible_plan(plan, outlet_ids):
            yield plan, {
                "plan_code": plan.plan_code,
                "supersedes_plan_code": plan.supersedes_plan.plan_code if plan.supersedes_plan_id else None,
                "revision": revision,
                "status": plan.status,
                "template_type": plan.template_type,
                "hub_id": plan.hub_id,
                "hub": plan.f2_structure["option"]["hub"],
                "option_key": plan.f2_structure["option"]["option_key"],
                "created_at": plan.created_at,
            }


def plan_summaries(group, actor, outlet_ids):
    return [summary for _, summary in _summaries(_saved_plans(group, actor), outlet_ids)]


def _plan_detail(plan, plans, outlet_ids):
    for candidate, summary in _summaries(plans, outlet_ids):
        if candidate.pk == plan.pk:
            return {**summary, "f2_structure": candidate.f2_structure}
    raise CandidateUnavailable


@transaction.atomic
def read_f2_plan(*, actor, run_code, group_code, plan_code):
    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    _, group, outlet_ids = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f2_storage_available():
        raise F2MigrationRequired
    plans = list(_saved_plans(group, actor))
    plan = next((row for row in plans if row.plan_code == plan_code), None)
    if not plan:
        raise CandidateUnavailable
    return _plan_detail(plan, plans, outlet_ids)


@transaction.atomic
def save_f2_plan(*, actor, run_code, group_code, template_type, option_key, hub_id=None, supersedes_plan_code=None):
    _require_read_committed(connection.alias)
    run, group, outlet_ids = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code, lock=True)
    if not f2_storage_available() or not f2_multi_hub_available():
        raise F2MigrationRequired
    if requires_operational_provenance("") and operational_demands_required(
        run_scenario(run), group.group_demands.values_list("demand_id", flat=True),
    ):
        raise CandidateInvalid(OPERATIONAL_SOURCE_REQUIRED)

    # Keep the full history for detail and revision numbering; legacy predecessors can be from a different Hub.
    plans = list(_saved_plans(group, actor))
    identity_plans = [plan for plan in plans if plan.template_type == template_type and plan.hub_id == hub_id]
    latest = identity_plans[-1] if identity_plans else None
    code = uuid5(NAMESPACE_URL, f"cologi/f2/{run_code}/{group_code}/{template_type}/{hub_id}/{supersedes_plan_code}/{option_key}").hex
    duplicate = next((row for row in identity_plans if row.plan_code == code), None)
    if duplicate:
        return _plan_detail(duplicate, plans, outlet_ids), False

    if supersedes_plan_code and not any(plan.plan_code == supersedes_plan_code for plan in identity_plans):
        raise CandidateInvalid("F2_REVISION_CONFLICT")
    unchanged = latest is not None and latest.f2_structure["option"]["option_key"] == option_key
    latest_code = latest.plan_code if latest else None
    if supersedes_plan_code != latest_code and not unchanged:
        raise CandidateInvalid("F2_REVISION_CONFLICT")

    preview = build_f2_options(run=run, group=group, outlet_ids=outlet_ids, hub_id=hub_id, lock_hub=True)
    option = next(row for row in preview["options"] if row["template_type"] == template_type)
    if option["structural_status"] != "COMPLETE":
        raise CandidateInvalid(option["diagnostics"][0]["code"])
    if option["option_key"] != option_key:
        raise CandidateInvalid("F2_PREVIEW_STALE")
    if unchanged:
        return _plan_detail(latest, plans, outlet_ids), False

    plan = create_draft_plan(
        group=group, actor=actor, template_type=template_type, hub_id=hub_id,
        supersedes=latest, plan_code=code,
        f2_structure={"schema_version": SCHEMA_VERSION, "lineage": preview["lineage"], "basis": preview["basis"], "option": option},
    )
    return _plan_detail(plan, [*plans, plan], outlet_ids), True
