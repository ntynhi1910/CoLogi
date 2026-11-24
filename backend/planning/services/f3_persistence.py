"""Persist captured F3 evidence atomically and replay the immutable result."""

from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
from accounts.capstone import enabled

from planning.f3_contract import evaluation_contract_version, fingerprint
from planning.models import F3Evaluation, _require_read_committed
from planning.services.f2_plans import F2MigrationRequired, _saved_plans, _summaries, f2_storage_available
from planning.services.f2_preview import CandidateInvalid, CandidateUnavailable, find_f2_candidate
from planning.services.f3_hub_coverage import uat_hub_coverage_enabled
from planning.services.f3_preview import capture_f3


class F3MigrationRequired(Exception):
    pass


def f3_storage_available():
    return MigrationRecorder(connection).migration_qs.filter(app="planning", name="0006_f3_evaluation").exists()


def _visible_plans(group, actor, outlet_ids):
    if not f2_storage_available():
        raise F2MigrationRequired
    return {plan.plan_code: plan for plan, _ in _summaries(_saved_plans(group, actor), outlet_ids)}


def evaluation_summary(evaluation):
    result = evaluation.f3_structure["result"]
    uses_synthetic = result.get("hub_coverage", {}).get("uses_synthetic", False)
    scenario = evaluation.f3_structure["inputs"]["cp7"].get("capstone_scenario")
    internal = evaluation.f3_structure["inputs"]["cp7"].get("internal_planning")
    return {
        "evaluation_code": str(evaluation.evaluation_code), "plan": result["plan"],
        "contract_version": evaluation.contract_version, "input_fingerprint": evaluation.input_fingerprint,
        "configuration_fingerprint": evaluation.configuration_fingerprint,
        "evaluated_by_id": evaluation.evaluated_by_id, "evaluated_at": evaluation.evaluated_at,
        "gate_status": result["gate_status"],
        "ready_for_f4": result["gate_status"] == "ELIGIBLE" and (
            enabled(scenario) if scenario else bool(internal) or not uses_synthetic or uat_hub_coverage_enabled(connection)
        ),
        **({"internal_planning": internal} if internal else {}),
        **({"evaluation_context": "CAPSTONE", "scenario": scenario} if scenario else {}),
    }


@transaction.atomic
def _persist_captures(*, actor, run_code, group_code, plan_codes, captures):
    _require_read_committed(connection.alias)
    _, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code, lock=True)
    by_code = _visible_plans(group, actor, outlets)
    rows, created_count = [], 0
    for code, capture in zip(plan_codes, captures, strict=True):
        plan = by_code.get(code)
        if not plan or plan.pk != capture.plan_id:
            raise CandidateUnavailable
        document = capture.document
        if document is None or fingerprint(plan.f2_structure) != document["inputs"]["f2_fingerprint"]:
            raise CandidateInvalid("F3_INVALID_SAVED_F2")
        evaluation, created = F3Evaluation.objects.get_or_create(
            plan=plan, contract_version=evaluation_contract_version(plan.hub_id),
            input_fingerprint=fingerprint(document["inputs"]),
            configuration_fingerprint=fingerprint(document["configuration"]),
            defaults={"f3_structure": document, "evaluated_by": actor},
        )
        created_count += int(created)
        rows.append(evaluation_summary(evaluation))
    return {"evaluations": rows, "created_count": created_count}


def save_f3(*, actor, run_code, group_code, plan_codes):
    # Capture takes a read-only snapshot. Writes recheck current scope and the exact F2 revision.
    captures = capture_f3(actor=actor, run_code=run_code, group_code=group_code, plan_codes=plan_codes)
    if not f3_storage_available():
        raise F3MigrationRequired
    return _persist_captures(actor=actor, run_code=run_code, group_code=group_code,
                             plan_codes=plan_codes, captures=captures)


@transaction.atomic
def read_f3_history(*, actor, run_code, group_code, plan_code=None, evaluation_code=None):
    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    _, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f3_storage_available():
        raise F3MigrationRequired
    plans = _visible_plans(group, actor, outlets)
    if plan_code and plan_code not in plans:
        raise CandidateUnavailable
    ids = [plans[plan_code].pk] if plan_code else [plan.pk for plan in plans.values()]
    evaluations = F3Evaluation.objects.filter(plan_id__in=ids, evaluated_by=actor).order_by("-evaluated_at", "-pk")
    if evaluation_code:
        evaluation = evaluations.filter(evaluation_code=evaluation_code).first()
        if not evaluation:
            raise CandidateUnavailable
        return {**evaluation_summary(evaluation), "f3_structure": evaluation.f3_structure}
    return {"evaluations": [evaluation_summary(row) for row in evaluations]}
