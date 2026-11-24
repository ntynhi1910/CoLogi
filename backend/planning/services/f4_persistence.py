"""Append-only F4 results tied to the exact preview and eligible saved F3 evaluation."""

from django.db import connection, transaction
from accounts.capstone import enabled

from planning.f4_contract import VERSION
from planning.models import F4Evaluation, _require_read_committed
from planning.services.f2_preview import CandidateUnavailable, find_f2_candidate
from planning.services.f3_hub_coverage import uat_hub_coverage_enabled
from planning.services.f4_preview import (
    F4MigrationRequired, F4NotReady, _begin_read, can_evaluate, capture_for_save, f4_storage_available, visible_f3_sources,
)
from planning.services.f4_scheduling import PASS


class F4PreviewChanged(Exception):
    pass


def _summary(row):
    document = row.f4_structure
    context = document["inputs"]["evaluation_context"]
    internal = (document["inputs"]["time_evidence"].get("internal_planning")
                or row.f3_evaluation.f3_structure["inputs"]["cp7"].get("internal_planning"))
    return {
        "evaluation_code": str(row.evaluation_code), "evaluated_at": row.evaluated_at,
        "f3_evaluation_code": str(row.f3_evaluation.evaluation_code), "contract_version": row.contract_version,
        "plan": row.f3_evaluation.f3_structure["result"]["plan"],
        "input_fingerprint": row.input_fingerprint, "configuration_fingerprint": row.configuration_fingerprint,
        "status": document["result"]["status"], "evaluation_context": context,
        "source_mode": document["inputs"]["time_evidence"]["source_mode"],
        **({"internal_planning": internal} if internal else {}),
        "scenario_id": document["inputs"]["time_evidence"].get("scenario_id"),
        "configuration_version": document["configuration"]["version"],
        "ready_for_f5": (
            document["result"]["status"] == PASS and document["result"]["complete"]
            and (context != "UAT" or uat_hub_coverage_enabled(connection))
            and (context != "CAPSTONE" or enabled(document["inputs"]["time_evidence"].get("capstone_scenario")))
            and can_evaluate(row.f3_evaluation.plan, row.f3_evaluation)
        ),
    }


def _detail(row):
    document, summary = row.f4_structure, _summary(row)
    inputs = document["inputs"]
    return {
        **summary, "configuration": document["configuration"], "lineage": inputs["lineage"],
        "result": {
            **document["result"], **summary,
            "service_date": inputs["f2"]["basis"]["requested_date"],
            "demand_weight_kg": inputs["f2"]["basis"]["total_required_weight_kg"],
            "f1_common_window": {
                "start_time": inputs["f2"]["basis"]["common_start_time"],
                "end_time": inputs["f2"]["basis"]["common_end_time"], "scope": "F1_GROUP_ELIGIBILITY",
            },
            "f3_uses_synthetic": bool(inputs["f3"]["result"].get("hub_coverage", {}).get("uses_synthetic")),
        },
    }


@transaction.atomic
def _save_captures(*, actor, run_code, group_code, captures):
    _require_read_committed(connection.alias)
    _, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code, lock=True)
    visible, sources = visible_f3_sources(group, actor, outlets)
    by_pk = {source.pk: source for source in sources}
    rows, created_count = [], 0
    for capture in captures:
        source = by_pk.get(capture.evaluation.pk)
        if source is None:
            raise CandidateUnavailable
        if not can_evaluate(visible[source.plan_id][0], source):
            raise F4NotReady
        preview = capture.preview
        row, created = F4Evaluation.objects.get_or_create(
            f3_evaluation=source, contract_version=VERSION,
            input_fingerprint=preview["input_fingerprint"],
            configuration_fingerprint=preview["configuration_fingerprint"],
            defaults={"f4_structure": capture.document, "evaluated_by": actor},
        )
        created_count += int(created)
        rows.append(_summary(row))
    return {"evaluations": rows, "created_count": created_count}


def save_f4(*, actor, run_code, group_code, evaluations, scenario=None):
    captures = capture_for_save(
        actor=actor, run_code=run_code, group_code=group_code,
        requests=evaluations, scenario=scenario,
    )
    for capture, request in zip(captures, evaluations, strict=True):
        if any(capture.preview[key] != request[key] for key in ("input_fingerprint", "configuration_fingerprint")):
            raise F4PreviewChanged
    return _save_captures(actor=actor, run_code=run_code, group_code=group_code, captures=captures)


@transaction.atomic
def read_f4_history(*, actor, run_code, group_code, evaluation_code=None):
    _begin_read()
    _, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f4_storage_available():
        raise F4MigrationRequired
    _, sources = visible_f3_sources(group, actor, outlets)
    rows = F4Evaluation.objects.filter(
        f3_evaluation_id__in=[source.pk for source in sources], evaluated_by=actor,
    ).select_related("f3_evaluation__plan").order_by("-evaluated_at", "-pk")
    if evaluation_code is None:
        return {"evaluations": [_summary(row) for row in rows]}
    row = rows.filter(evaluation_code=evaluation_code).first()
    if row is None:
        raise CandidateUnavailable
    return _detail(row)
