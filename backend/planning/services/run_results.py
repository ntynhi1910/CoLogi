"""Read the stored F1 outcome for its owner within current Outlet access."""

from django.core.exceptions import ValidationError
from django.db import connection, transaction
from django.db.models import Count, Exists, OuterRef, Prefetch, Q, Subquery
from django.db.models.functions import Coalesce
from accounts.capstone import RUN_REFERENCE_PREFIX, actor_scenario

from planning.models import (
    CollaborationGroup, EligibilityStatus, GroupDemand, MatchingStatus,
    PlanningRun, PlanningRunDemand, PlanningRunStatus,
)
from planning.services.result_presentation import describe_run_configuration, resolve_demand_display_labels
from planning.services.run_scope import get_f1_outlet_ids


def scoped_f1_runs(actor):
    outlet_ids = get_f1_outlet_ids(actor)
    outside_scope = PlanningRunDemand.objects.filter(
        planning_run_id=OuterRef("pk"),
    ).exclude(demand__outlet_id__in=outlet_ids)
    visible = PlanningRun.objects.filter(
        Exists(outlet_ids), ~Exists(outside_scope), initiated_by=actor,
    )
    scenario = actor_scenario(actor)
    if scenario:
        return visible.filter(source_mode="SYNTHETIC", source_reference=RUN_REFERENCE_PREFIX + scenario)
    return visible.exclude(source_mode="SYNTHETIC", source_reference__startswith=RUN_REFERENCE_PREFIX)


MATCHED_STATUSES = (MatchingStatus.INCLUDED, MatchingStatus.MULTIPLE_CANDIDATES)


def summarize_f1_run(run, *, rows=None, candidate_count=None):
    if rows is None:
        counts = {
            key: getattr(run, key)
            for key in ("demand_count", "eligible_count", "excluded_count", "matched_count", "unmatched_count")
        }
        candidate_count = run.candidate_count
    else:
        counts = {
            "demand_count": len(rows),
            "eligible_count": sum(row.eligibility_status == EligibilityStatus.ELIGIBLE for row in rows),
            "excluded_count": sum(row.eligibility_status == EligibilityStatus.EXCLUDED for row in rows),
            "matched_count": sum(row.matching_status in MATCHED_STATUSES for row in rows),
            "unmatched_count": sum(row.matching_status == MatchingStatus.UNMATCHED for row in rows),
        }

    matching_outcome = None
    if run.status == PlanningRunStatus.COMPLETED:
        matching_outcome = "MATCHED" if candidate_count else "NO_CANDIDATE"
    elif run.status == PlanningRunStatus.FAILED and any(
        diagnostic.get("matching_outcome") == "MATCHING_INCOMPLETE"
        for diagnostic in run.failure_diagnostics if isinstance(diagnostic, dict)
    ):
        matching_outcome = "MATCHING_INCOMPLETE"

    return {
        "run_code": run.run_code,
        "status": run.status,
        "source_mode": run.source_mode,
        "started_at": run.started_at,
        "completed_at": run.completed_at,
        "rule_set_id": run.rule_set_id,
        **describe_run_configuration(run.parameters_snapshot),
        "matching_outcome": matching_outcome,
        **counts,
        "evaluated_count": counts["eligible_count"] + counts["excluded_count"],
        "candidate_count": candidate_count if run.status == PlanningRunStatus.COMPLETED else 0,
    }


def list_f1_runs(actor):
    group_counts = CollaborationGroup.objects.filter(run_code=OuterRef("run_code")).order_by().values("run_code")
    group_counts = group_counts.annotate(total=Count("pk")).values("total")
    return scoped_f1_runs(actor).annotate(
        demand_count=Count("run_demands"),
        eligible_count=Count("run_demands", filter=Q(run_demands__eligibility_status=EligibilityStatus.ELIGIBLE)),
        excluded_count=Count("run_demands", filter=Q(run_demands__eligibility_status=EligibilityStatus.EXCLUDED)),
        matched_count=Count("run_demands", filter=Q(run_demands__matching_status__in=MATCHED_STATUSES)),
        unmatched_count=Count("run_demands", filter=Q(run_demands__matching_status=MatchingStatus.UNMATCHED)),
        candidate_count=Coalesce(Subquery(group_counts), 0),
    ).order_by("-started_at", "-pk")


@transaction.atomic
def get_f1_run_detail(*, actor, run_code):
    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    run = scoped_f1_runs(actor).get(run_code=run_code)
    rows = list(run.run_demands.order_by("demand_id"))

    candidates = []
    if run.status == PlanningRunStatus.COMPLETED:
        allowed_demand_ids = {row.demand_id for row in rows}
        groups = CollaborationGroup.objects.filter(run_code=run.run_code).order_by("id").prefetch_related(
            Prefetch("group_demands", queryset=GroupDemand.objects.order_by("demand_id")),
        )
        for group in groups:
            memberships = tuple(group.group_demands.all())
            if any(member.demand_id not in allowed_demand_ids for member in memberships):
                raise ValidationError("F1 candidate membership is inconsistent with the Run scope.")
            candidates.append({
                "group_code": group.group_code,
                "status": group.status,
                "memberships": memberships,
                "matching_reason": group.matching_reason,
            })
    return {
        **summarize_f1_run(run, rows=rows, candidate_count=len(candidates)),
        "failure_diagnostics": run.failure_diagnostics,
        "demand_results": rows,
        "display_labels": resolve_demand_display_labels(
            {row.demand_id: row.demand_snapshot for row in rows}, get_f1_outlet_ids(actor),
        ),
        "candidate_groups": candidates,
    }
