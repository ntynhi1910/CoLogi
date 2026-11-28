"""Synchronous CP08 F1 execution over persisted snapshots."""

from collections import Counter
from dataclasses import dataclass
import logging
from uuid import uuid4

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import connection, transaction
from django.utils import timezone

from demands.models import DeliveryDemand
from planning.f1.candidate_groups import CandidateLimitExceeded
from planning.f1.orm_reader import load_f1_orm_data
from planning.services.f1_date_gate import F1DateGateError, preflight_f1_dates, validate_f1_dates
from planning.services.f1_selection import F1SelectionError, require_eligible
from planning.services.fulfillment_plan_guard import capture_fulfillment_plan_guard
from planning.models import (
    CollaborationGroup, CollaborationGroupStatus, EligibilityStatus,
    GroupDemand, GroupDemandEligibilityStatus, MatchingStatus,
    PlanGuardStatus, PlanningRun, PlanningRunDemand, PlanningRunSourceMode,
    PlanningRunStatus,
)
from planning.services.run_configuration import load_run_configuration
from planning.services.run_preview import _build_plan_guard_status_map, require_f1_execution_configuration
from planning.services.snapshot_evaluator import evaluate_f1_snapshots
from planning.services.run_scope import validate_run_scope
from planning.services.snapshot_builder import build_demand_snapshots
from planning.json_validators import validate_demand_snapshot


logger = logging.getLogger(__name__)


class RunExecutionError(Exception):
    """Controlled lifecycle diagnostic, not a Demand primary reason code."""

    def __init__(self, code, **details):
        super().__init__(code)
        self.code = code
        self.details = details


class RunFailureRecordingError(RuntimeError):
    """Failure transaction could not be confirmed; recovery must investigate."""


@dataclass(frozen=True)
class CompletedF1Evaluation:
    demand_results: tuple
    candidate_groups: tuple


@dataclass(frozen=True)
class F1DemandResult:
    demand_id: int
    eligibility_status: str
    primary_reason_code: str | None
    plan_guard_status: str
    diagnostics: tuple[dict, ...]


def _set_repeatable_read():
    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")


def _check_scope(actor, demand_ids):
    ids, demands = validate_run_scope(actor, demand_ids)
    if tuple(d.pk for d in demands) != ids:
        raise ValidationError("RUN_SCOPE_DEMAND_SET_INCONSISTENT")
    return ids, demands


def _locked_in_progress_run(run_id):
    run = PlanningRun.objects.select_for_update().get(pk=run_id)
    if run.status != PlanningRunStatus.IN_PROGRESS:
        raise RunExecutionError("RUN_NOT_IN_PROGRESS")
    return run


def _initialize_run(actor, demand_ids, rule_set_id, cost_profile_id, source_mode):
    from accounts.capstone import RUN_REFERENCE_PREFIX, actor_scenario

    # Rejected scope/configuration must not create a Run.
    with transaction.atomic(durable=True):
        snapshot_pin = getattr(settings, "COLOGI_F1_MVCC_CONFIGURATION_PIN", False)
        with connection.cursor() as cursor:
            if snapshot_pin:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            else:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        ids, demands = _check_scope(actor, demand_ids)
        if source_mode not in PlanningRunSourceMode.values:
            raise ValidationError("INVALID_RUN_SOURCE_MODE")
        check_selection = settings.COLOGI_CP11_ENABLED and settings.COLOGI_CP12_ENABLED
        if check_selection:
            list(DeliveryDemand.objects.select_for_update().filter(pk__in=ids).order_by("pk").values_list("pk", flat=True))
            _, demands = _check_scope(actor, ids)
        started_at = timezone.now()
        if check_selection:
            require_eligible(actor, demands, at=started_at)
        else:
            preflight_f1_dates(demands, at=started_at)
        configuration = load_run_configuration(
            rule_set_id=rule_set_id, cost_profile_id=cost_profile_id,
            captured_at=started_at, lock_rule_set=True,
        )
        require_f1_execution_configuration(configuration)
        scenario = actor_scenario(actor)
        run = PlanningRun.objects.create(
            run_code=uuid4(), rule_set_id=rule_set_id,
            cost_profile_id=cost_profile_id, initiated_by=actor,
            started_at=started_at, source_mode=PlanningRunSourceMode.SYNTHETIC if scenario else source_mode,
            scenario_tag=scenario or None, source_reference=RUN_REFERENCE_PREFIX + scenario if scenario else None,
            status=PlanningRunStatus.IN_PROGRESS,
            parameters_snapshot=configuration, failure_diagnostics=[],
        )
    return run, ids


def _capture_scope(run_id, actor, demand_ids):
    """Transaction A: capture the entire scope, or leave no scope records."""
    with transaction.atomic(durable=True):
        _set_repeatable_read()  # before any query, including the Run lock
        run = _locked_in_progress_run(run_id)
        ids, demands = _check_scope(actor, demand_ids)
        if ids != demand_ids:
            raise RunExecutionError("RUN_CAPTURE_SCOPE_CHANGED")
        if PlanningRunDemand.objects.filter(planning_run_id=run.pk).exists():
            raise RunExecutionError("RUN_SCOPE_ALREADY_CAPTURED")
        check_selection = settings.COLOGI_CP11_ENABLED and settings.COLOGI_CP12_ENABLED
        if check_selection:
            list(DeliveryDemand.objects.select_for_update().filter(pk__in=ids).order_by("pk").values_list("pk", flat=True))
        captured_at = timezone.now()
        if check_selection:
            try:
                require_eligible(actor, demands, at=captured_at)
            except F1SelectionError as exc:
                raise RunExecutionError("F1_SELECTION_CHANGED", diagnostics=exc.diagnostics) from exc
        orm_data = load_f1_orm_data(demand_ids)
        if tuple(d.pk for d in orm_data.selected_demands) != demand_ids:
            raise RunExecutionError("RUN_CAPTURE_SCOPE_CHANGED")
        try:
            validate_f1_dates(orm_data.selected_demands, orm_data.capacity_requests, at=run.started_at)
        except F1DateGateError as exc:
            raise RunExecutionError("RUN_CAPTURE_F1_DATE_GATE_FAILED", diagnostics=exc.diagnostics) from exc
        snapshots = build_demand_snapshots(
            orm_data, captured_at=captured_at, plan_guard_evidence=capture_fulfillment_plan_guard(demand_ids),
        )
        if set(snapshots) != set(demand_ids):
            raise RunExecutionError("RUN_CAPTURE_SNAPSHOT_SET_MISMATCH")
        rows = []
        for demand_id in demand_ids:
            snapshot = snapshots[demand_id]
            validate_demand_snapshot(snapshot)
            if (snapshot["schema_version"] != "1.1"
                    or snapshot["demand_ref"]["pk"] != str(demand_id)):
                raise RunExecutionError("RUN_CAPTURE_SNAPSHOT_IDENTITY_INVALID")
            rows.append(PlanningRunDemand(
                planning_run_id=run.pk, demand_id=demand_id,
                demand_snapshot=snapshot,
                eligibility_status=EligibilityStatus.NOT_EVALUATED,
                plan_guard_status=PlanGuardStatus.NOT_EVALUATED,
                matching_status=MatchingStatus.NOT_EVALUATED,
            ))
        PlanningRunDemand.objects.bulk_create(rows)


def _evaluate_for_execution(snapshots, configuration):
    """Execute the validated Python rules against immutable evidence."""
    max_group_size, max_candidates = require_f1_execution_configuration(configuration)
    guard = _build_plan_guard_status_map(snapshots)
    unavailable = sorted(demand_id for demand_id, status in guard.items() if status == PlanGuardStatus.NOT_EVALUATED)
    if unavailable:
        raise RunExecutionError(
            "PLAN_GUARD_NOT_EVALUATED", demand_ids=unavailable,
            conflict_demand_ids=sorted(demand_id for demand_id, status in guard.items() if status == PlanGuardStatus.CONFLICT),
        )
    try:
        evaluation = evaluate_f1_snapshots(
            snapshots,
            cargo_compatibility_rows=configuration["cargo_compatibility_matrix"]["rows"],
            candidate_demand_ids=tuple(demand_id for demand_id, status in guard.items() if status == PlanGuardStatus.PASS),
            max_group_size=max_group_size,
            max_candidates_per_run=max_candidates,
        )
    except CandidateLimitExceeded as exc:
        raise RunExecutionError(
            "CANDIDATE_LIMIT_EXCEEDED", matching_outcome="MATCHING_INCOMPLETE",
        ) from exc
    return CompletedF1Evaluation(
        demand_results=tuple(
            _execution_demand_result(item, guard[item.demand_id])
            for item in evaluation.demand_evaluations
        ),
        candidate_groups=evaluation.candidate_groups,
    )


def _execution_demand_result(item, plan_guard_status):
    eligibility = item.eligibility
    diagnostics = [
        {
            "stage": "CAPACITY" if blocker.value.startswith("CAPACITY_") else "ELIGIBILITY",
            "code": blocker.value, "severity": "BLOCKER", "message": eligibility.detail,
        }
        for blocker in eligibility.blockers
    ]
    blocker_codes = {blocker.value for blocker in eligibility.blockers}
    diagnostics.extend(
        {"stage": "ELIGIBILITY", "code": code, "severity": "BLOCKER", "message": eligibility.detail}
        for code in eligibility.reason_codes if code not in blocker_codes
    )
    diagnostics.extend(
        {"stage": "ELIGIBILITY", "code": code, "severity": "WARNING", "message": eligibility.detail}
        for code in eligibility.diagnostics
    )
    diagnostics.extend(
        {"stage": "CAPACITY", "code": result.status.value, "severity": "INFO", "item_id": result.item_id}
        for result in item.capacity_results
    )
    if plan_guard_status == PlanGuardStatus.CONFLICT:
        diagnostics.append({
            "stage": "PLAN_GUARD", "code": "DEMAND_IN_FINALIZED_PLAN",
            "severity": "BLOCKER", "message": "Demand is allocated to a finalized Plan.",
        })
    return F1DemandResult(
        demand_id=item.demand_id,
        eligibility_status=eligibility.eligibility_status.value,
        primary_reason_code=eligibility.primary_reason_code,
        plan_guard_status=plan_guard_status,
        diagnostics=tuple(diagnostics),
    )


def _persist_completed_results(run, rows, result):
    """Write Transaction B results; caller owns the atomic transaction.

    Entry requires a completed evaluation, not RunPreview. Defensive checks
    precede all writes. No snapshot or pinned configuration is modified.
    """
    if not isinstance(result, CompletedF1Evaluation):
        raise RunExecutionError("F1_COMPLETED_EVALUATION_REQUIRED")
    if not connection.in_atomic_block or run.status != PlanningRunStatus.IN_PROGRESS:
        raise RunExecutionError("RUN_RESULT_REQUIRES_ACTIVE_TRANSACTION")
    limit_size, limit_count = require_f1_execution_configuration(run.parameters_snapshot)
    row_by_id = {row.demand_id: row for row in rows}
    outcome_by_id = {outcome.demand_id: outcome for outcome in result.demand_results}
    if (not rows or len(row_by_id) != len(rows)
            or len(outcome_by_id) != len(result.demand_results)
            or set(row_by_id) != set(outcome_by_id)):
        raise RunExecutionError("RUN_RESULT_SCOPE_MISMATCH")
    for outcome in outcome_by_id.values():
        if outcome.eligibility_status not in (EligibilityStatus.ELIGIBLE, EligibilityStatus.EXCLUDED):
            raise RunExecutionError("RUN_RESULT_ELIGIBILITY_NOT_EVALUATED")
        if outcome.plan_guard_status not in (PlanGuardStatus.PASS, PlanGuardStatus.CONFLICT):
            raise RunExecutionError("PLAN_GUARD_NOT_EVALUATED")
        if outcome.eligibility_status == EligibilityStatus.EXCLUDED and not outcome.diagnostics:
            raise RunExecutionError("RUN_RESULT_EXCLUSION_DIAGNOSTICS_REQUIRED")
        if outcome.eligibility_status == EligibilityStatus.ELIGIBLE and outcome.primary_reason_code is not None:
            raise RunExecutionError("RUN_RESULT_UNEXPECTED_PRIMARY_REASON")

    if len(result.candidate_groups) > limit_count:
        raise RunExecutionError("CANDIDATE_LIMIT_EXCEEDED", matching_outcome="MATCHING_INCOMPLETE")
    membership = Counter()
    seen = set()
    for group in result.candidate_groups:
        ids = tuple(group.demand_ids)
        if (len(ids) < 2
                or (limit_size is not None and len(ids) > limit_size)
                or ids != tuple(sorted(set(ids)))
                or ids in seen or not set(ids).issubset(row_by_id)):
            raise RunExecutionError("RUN_RESULT_CANDIDATE_INVALID")
        for demand_id in ids:
            outcome = outcome_by_id[demand_id]
            if (outcome.eligibility_status != EligibilityStatus.ELIGIBLE
                    or outcome.plan_guard_status != PlanGuardStatus.PASS):
                raise RunExecutionError("RUN_RESULT_CANDIDATE_GATE_BLOCKED")
        seen.add(ids)
        membership.update(ids)

    if CollaborationGroup.objects.filter(run_code=run.run_code).exists():
        raise RunExecutionError("RUN_RESULT_ALREADY_EXISTS")
    for group in result.candidate_groups:
        metadata = {
            "demand_ids": list(group.demand_ids),
            "requested_date": group.requested_date.isoformat(),
            "cargo_category_ids": list(group.cargo_category_ids),
            "common_start_time": group.common_start_time.isoformat(),
            "common_end_time": group.common_end_time.isoformat(),
        }
        persisted = CollaborationGroup.objects.create(
            group_code=uuid4().hex, run_code=run.run_code,
            status=CollaborationGroupStatus.CANDIDATE,
            matching_reason=metadata, created_by_id=run.initiated_by_id,
        )
        GroupDemand.objects.bulk_create([
            GroupDemand(group_id=persisted.pk, demand_id=demand_id,
                        eligibility_status=GroupDemandEligibilityStatus.INCLUDED)
            for demand_id in group.demand_ids
        ])

    for demand_id, row in row_by_id.items():
        outcome = outcome_by_id[demand_id]
        row.eligibility_status = outcome.eligibility_status
        row.primary_reason_code = outcome.primary_reason_code
        row.plan_guard_status = outcome.plan_guard_status
        row.diagnostics = list(outcome.diagnostics)
        if outcome.eligibility_status != EligibilityStatus.ELIGIBLE or outcome.plan_guard_status != PlanGuardStatus.PASS:
            row.matching_status = MatchingStatus.NOT_EVALUATED
        elif membership[demand_id] == 0:
            row.matching_status = MatchingStatus.UNMATCHED
        elif membership[demand_id] == 1:
            row.matching_status = MatchingStatus.INCLUDED
        else:
            row.matching_status = MatchingStatus.MULTIPLE_CANDIDATES
        row.updated_at = timezone.now()
    PlanningRunDemand.objects.bulk_update(rows, [
        "eligibility_status", "primary_reason_code", "plan_guard_status",
        "diagnostics", "matching_status", "updated_at",
    ])
    run.status = PlanningRunStatus.COMPLETED
    run.completed_at = timezone.now()
    run.save(update_fields=["status", "completed_at"])


def _evaluate_and_persist(run_id, scope_ids):
    """Transaction B: evaluate persisted snapshots and commit all results."""
    with transaction.atomic(durable=True):
        run = _locked_in_progress_run(run_id)
        rows = list(PlanningRunDemand.objects.select_for_update().filter(
            planning_run_id=run.pk,
        ).order_by("demand_id"))
        if tuple(row.demand_id for row in rows) != scope_ids:
            raise RunExecutionError("RUN_RESULT_SCOPE_MISMATCH")
        snapshots = []
        capture_times = set()
        for row in rows:
            snapshot = row.demand_snapshot
            demand_ref = snapshot.get("demand_ref") if isinstance(snapshot, dict) else None
            if not isinstance(demand_ref, dict) or demand_ref.get("pk") != str(row.demand_id):
                raise RunExecutionError("RUN_RESULT_SCOPE_MISMATCH")
            captured_at = snapshot.get("captured_at")
            if not isinstance(captured_at, str):
                raise RunExecutionError("RUN_RESULT_SCOPE_MISMATCH")
            capture_times.add(captured_at)
            snapshots.append(snapshot)
        if len(capture_times) != 1:
            raise RunExecutionError("RUN_RESULT_SCOPE_MISMATCH")
        result = _evaluate_for_execution(
            tuple(snapshots), run.parameters_snapshot,
        )
        _persist_completed_results(run, rows, result)
    return run


def _record_failure(run_id, stage, exc):
    diagnostic = {"stage": stage, "code": f"RUN_{stage}_FAILED"}
    if isinstance(exc, RunExecutionError):
        diagnostic.update(code=exc.code, **exc.details)
    # Never include arbitrary exception text, SQL, credentials or source data.
    with transaction.atomic(durable=True):
        run = PlanningRun.objects.select_for_update().get(pk=run_id)
        if run.status in (PlanningRunStatus.COMPLETED, PlanningRunStatus.FAILED):
            return run  # terminal state is never overwritten
        if run.status != PlanningRunStatus.IN_PROGRESS:
            raise RunExecutionError("RUN_NOT_IN_PROGRESS")
        run.status = PlanningRunStatus.FAILED
        run.completed_at = timezone.now()
        run.failure_diagnostics = [diagnostic]
        run.save(update_fields=["status", "completed_at", "failure_diagnostics"])
    return run


def execute_f1_run_for_actor(*, actor, demand_ids, rule_set_id,
                             cost_profile_id=None, source_mode=PlanningRunSourceMode.MANUAL):
    """Internal synchronous lifecycle; not callable via the preview endpoint.

    Do not invoke before the schema migration is separately approved/applied.
    Invalid scope/configuration raises before initialization. A/B failures
    preserve the committed Run and report its confirmed terminal status.
    """
    if connection.vendor != "postgresql" or connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("F1_EXECUTION_REQUIRES_POSTGRESQL_AUTOCOMMIT")
    run, ids = _initialize_run(actor, demand_ids, rule_set_id, cost_profile_id, source_mode)
    stage = "CAPTURE"
    try:
        _capture_scope(run.pk, actor, ids)
        stage = "RESULT"
        return _evaluate_and_persist(run.pk, ids)
    except Exception as exc:
        logger.warning("CP08 Run %s failed at %s (%s)", run.run_code, stage, type(exc).__name__)
        try:
            return _record_failure(run.pk, stage, exc)
        except Exception as recording_error:
            # The actual state is uncertain. No automatic stale-run recovery.
            raise RunFailureRecordingError(f"CP08 Run {run.run_code}: failure state not confirmed") from recording_error
