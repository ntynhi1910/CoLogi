"""Manager decisions and immutable FinalPlan publication."""

from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
from django.db.models import Count, Q
from django.db.models.functions import TruncDate
from django.utils import timezone

from accounts.capstone import actor_scenario, run_scenario
from accounts.models import AuditLog
from demands.models import DeliveryDemand, SupplierRequest
from masterdata.models import TransportProvider
from planning.f1.adapter import build_confirmation_result, latest_request_by_demand
from planning.f1.supplier_confirmation import ConfirmationGateStatus
from planning.f3_contract import fingerprint
from planning.models import (
    CarrierOutcome, CollaborationGroupStatus, DecisionOutcome, EconomicEvaluation, FinalPlan, FinalPlanDemand,
    FulfillmentPlan, FulfillmentPlanStatus, GroupDemandEligibilityStatus, PlanDecision, PlanningRunStatus,
)
from planning.services.f2_preview import CandidateInvalid, CandidateUnavailable, find_f2_candidate
from planning.services.f3_preview import capture_f3_in_snapshot
from planning.services.f4_evidence import F4EvidenceInvalid, F4ScenarioUnavailable, read_approved_document, select_scenario
from planning.services.f4_preview import F4MigrationRequired, _configuration, _read_saved, visible_f3_sources
from planning.services.f5_preview import F5AnchorBlocked, _ready, _validate, capture_f5
from planning.services.run_results import scoped_f1_runs

MIGRATION = "0012_cp09_cp10_delivery"


class DeliveryConflict(Exception):
    pass


class DeliveryStorageUnavailable(Exception):
    pass


def require_storage():
    if not MigrationRecorder(connection).migration_qs.filter(app="planning", name=MIGRATION).exists():
        raise DeliveryStorageUnavailable


def begin_snapshot(*, writable=False):
    with connection.cursor() as cursor:
        if writable and settings.COLOGI_CP11_ENABLED:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        else:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ" if writable else
                           "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")


def audit(actor, action, entity_type, record, new_values):
    AuditLog.objects.create(
        actor_user=actor, action=action, entity_type=entity_type,
        entity_id=str(record.pk), new_values=new_values,
    )


def _economic_rows(run, group, actor, outlets):
    visible, sources = visible_f3_sources(group, actor, outlets)
    context = "CAPSTONE" if run_scenario(run) else "OPERATIONAL"
    rows = EconomicEvaluation.objects.filter(
        sealed=True, calculated_by=actor, plan_id__in=visible,
        f4_evaluation__f3_evaluation_id__in=[source.pk for source in sources],
        snapshot__lineage__evaluation_context=context,
    ).select_related("plan", "f4_evaluation__f3_evaluation").order_by("-calculated_at", "-pk")
    return rows, visible


def _plan_summary(row):
    snap = row.snapshot
    f4 = row.f4_evaluation.f4_structure
    f3 = row.f4_evaluation.f3_evaluation.f3_structure
    return {
        "evaluation_code": str(row.evaluation_code), "calculated_at": row.calculated_at,
        "plan": snap["result"]["option"]["plan"], "lineage": snap["lineage"],
        "baseline_cost": row.baseline_cost, "collaborative_cost": row.collaborative_cost,
        "cost_saving": row.cost_saving, "saving_rate_pct": row.saving_rate_pct,
        "recommended": snap["result"]["option"]["rank"] == 1,
        "currency": snap["configuration"]["currency_code"], "service_date": snap["result"]["service_date"],
        "timeline": f4["result"]["waves"], "warnings": {
            "f3": f3["result"]["diagnostics"],
            "f4": f4["result"]["diagnostics"], "f5": snap["result"]["option"]["diagnostics"],
        },
        "provenance": _provenance(row),
        "evidence_details": {
            "records": {
                "F3": f3["inputs"]["cp7"].get("source_records", []),
                "F4": f4["inputs"]["time_evidence"].get("source_records", []),
                "F5": snap["price_inputs"].get("source_records", []),
            },
            "fingerprints": {
                "F2": snap["lineage"]["f2_fingerprint"],
                "F3": snap["lineage"]["f3_input_fingerprint"],
                "F4": snap["lineage"]["f4_input_fingerprint"],
                "F5": row.input_fingerprint,
                "F5 · Cấu hình": row.configuration_fingerprint,
                "F5 · So sánh": snap["comparison"]["fingerprint"],
            },
        },
    }


def _provenance(row):
    f4 = row.f4_evaluation.f4_structure["inputs"]
    f3 = row.f4_evaluation.f3_evaluation.f3_structure["inputs"]["cp7"]
    price = row.snapshot["price_inputs"]
    context = f4["evaluation_context"]
    internal = [source["internal_planning"] for source in (f3, f4["time_evidence"], price)
                if source.get("internal_planning")]
    return {
        "classification": ("CAPSTONE" if context == "CAPSTONE" else "UAT" if context == "UAT"
                           else "INTERNAL_ASSUMPTIONS" if internal else "OPERATIONAL_EVIDENCE"),
        "internal_sources": internal,
        "time_source": f4["time_evidence"]["source_mode"], "price_source": price["source_mode"],
        "provider_independently_verified": False,
    }


def decision_payload(row):
    final = getattr(row, "final_plan", None)
    return {
        "id": row.pk, "request_id": str(row.request_id), "outcome": row.outcome,
        "reason": row.reason, "recorded_at": row.recorded_at, "actor_id": row.actor_id,
        "actor_name": row.actor.full_name,
        "evaluation_code": str(row.evaluation.evaluation_code),
        "final_plan_code": str(final.code) if final else None,
        "run_code": str(row.group.run_code), "group_code": row.group.group_code,
    }


def final_plan_summary(plan, *, current):
    sent = getattr(plan, "handover", None)
    reply = getattr(sent, "reply", None)
    return {
        "code": str(plan.code), "version": plan.version, "current": current,
        "supersedes_code": str(plan.supersedes.code) if plan.supersedes_id else None,
        "approved_at": plan.decision.recorded_at, "reason": plan.decision.reason,
        "run_code": str(plan.decision.group.run_code), "group_code": plan.decision.group.group_code,
        "provider_code": plan.snapshot["f3"]["result"]["provider"]["provider_code"],
        "service_date": plan.snapshot["f2"]["basis"]["requested_date"],
        "provenance": plan.snapshot["provenance"],
        "handover": ({
            "sent_at": sent.sent_at, "sent_by": sent.actor_id,
            "response": ({"outcome": reply.outcome, "reason": reply.reason, "actor_id": reply.actor_id,
                          "responded_at": reply.responded_at} if reply else None),
        } if sent else None),
    }


def is_current(plan):
    return not FinalPlan.objects.filter(supersedes_id=plan.pk).exists()


def _sealed_scope(run, group, row, *, lock_demands):
    f2 = row.plan.f2_structure
    basis = f2["basis"]
    ids = basis["demand_ids"]
    member_ids = list(group.group_demands.filter(
        eligibility_status=GroupDemandEligibilityStatus.INCLUDED,
    ).order_by("demand_id").values_list("demand_id", flat=True))
    if ids != member_ids or run.status != PlanningRunStatus.COMPLETED or group.status != CollaborationGroupStatus.CANDIDATE:
        raise DeliveryConflict("CANDIDATE_CHANGED")
    sources = list(run.run_demands.filter(demand_id__in=ids).order_by("demand_id"))
    if [source.demand_id for source in sources] != ids or any(
        source.eligibility_status != "ELIGIBLE" or source.plan_guard_status != "PASS" for source in sources
    ):
        raise DeliveryConflict("F1_HARD_GATE")
    query = DeliveryDemand.objects.filter(pk__in=ids).order_by("pk").prefetch_related("items")
    if lock_demands:
        query = query.select_for_update()
    current = list(query)
    latest = latest_request_by_demand(SupplierRequest.objects.filter(demand_id__in=ids).select_related(
        "supplier_confirmation",
    ).prefetch_related("item_promises__demand_item", "item_promises__supplier_item"))
    if [item.pk for item in current] != ids:
        raise DeliveryConflict("DEMAND_CHANGED")
    for demand, sealed in zip(current, basis["demands"], strict=True):
        request = latest.get(demand.pk)
        if not request or request.pk != sealed["supplier_request_id"]:
            raise DeliveryConflict("SUPPLIER_REQUEST_CHANGED")
        confirmation = request.supplier_confirmation
        if (
            demand.status != "SUBMITTED" or demand.supplier_id != sealed["supplier_id"]
            or demand.outlet_id != sealed["outlet_id"] or demand.cargo_category_id != sealed["cargo_category_id"]
            or demand.requested_date != date.fromisoformat(sealed["requested_date"])
            or demand.requested_start_time != time.fromisoformat(sealed["requested_start_time"])
            or demand.requested_end_time != time.fromisoformat(sealed["requested_end_time"])
            or demand.quantity_kg != Decimal(sealed["required_weight_kg"])
            or confirmation.pk != sealed["supplier_confirmation_id"]
            or confirmation.commitment_released_at is not None or confirmation.ready_date is None
            or confirmation.ready_date != date.fromisoformat(sealed["pickup_ready_date"])
            or confirmation.ready_start_time != time.fromisoformat(sealed["pickup_ready_start_time"])
            or confirmation.ready_end_time != time.fromisoformat(sealed["pickup_ready_end_time"])
            or (confirmation.pickup_address or "").strip() != sealed["pickup_address"]
        ):
            raise DeliveryConflict("DEMAND_OR_PICKUP_CHANGED")
        result = build_confirmation_result(demand, request)
        weights = dict(result.confirmed_weight_by_demand_item)
        if result.status != ConfirmationGateStatus.ELIGIBLE or {
            item.item_id: (item.required_weight_kg, weights.get(item.pk)) for item in demand.items.all()
        } != {
            item["item_id"]: (Decimal(item["required_weight_kg"]), Decimal(item["confirmed_weight_kg"]))
            for item in sealed["items"]
        }:
            raise DeliveryConflict("SUPPLIER_CONFIRMATION_CHANGED")
    return sources


def validated_snapshot(*, actor, run, group, row, visible, lock_demands):
    f4 = row.f4_evaluation
    f3 = f4.f3_evaluation
    plan = row.plan
    if row.plan_id not in visible or f3.plan_id != row.plan_id or not _ready(f4):
        raise DeliveryConflict("F3_F4_HARD_GATE")
    _validate(f4)
    if FulfillmentPlan.objects.filter(group=group, template_type=plan.template_type, hub_id=plan.hub_id,
                                      f2_structure__isnull=False, pk__gt=plan.pk).exists():
        raise DeliveryConflict("F2_REVISION_SUPERSEDED")
    if date.fromisoformat(plan.f2_structure["basis"]["requested_date"]) < timezone.localdate(
        timezone=ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE),
    ):
        raise DeliveryConflict("SERVICE_DATE_PAST")
    pickup_at = f4.f4_structure["result"]["metrics"]["first_pickup_at"]
    if not pickup_at or not timezone.is_aware(pickup := datetime.fromisoformat(pickup_at)) or pickup <= timezone.now():
        raise DeliveryConflict("SCHEDULE_ALREADY_STARTED")
    sources = _sealed_scope(run, group, row, lock_demands=lock_demands)
    captured = capture_f3_in_snapshot(actor=actor, run_code=run.run_code, group_code=group.group_code,
                                      plan_codes=[plan.plan_code])[0].document
    if (
        not captured or captured["result"]["gate_status"] != "ELIGIBLE"
        or (fingerprint(captured["inputs"]), fingerprint(captured["configuration"]))
        != (f3.input_fingerprint, f3.configuration_fingerprint)
    ):
        raise DeliveryConflict("F3_SOURCE_CHANGED")
    scenario = row.snapshot["scenario"]
    approved, _, _ = select_scenario(read_approved_document(), run_code=run.run_code,
                                     group_code=group.group_code, requested=scenario)
    current_f4 = _read_saved(plan, visible[plan.pk][1], f3, _configuration(run), approved).preview
    if (current_f4["status"] != "PASS" or not current_f4["complete"]
            or (current_f4.get("input_fingerprint"), current_f4.get("configuration_fingerprint"))
            != (f4.input_fingerprint, f4.configuration_fingerprint)):
        raise DeliveryConflict("F4_SOURCE_CHANGED")
    cost, _, _, _ = capture_f5(actor=actor, run_code=run.run_code, group_code=group.group_code,
                                evaluation_code=f4.evaluation_code, scenario=scenario)
    current = next((option for option in cost["options"] if option["lineage"]
                    and option["lineage"]["f4_evaluation_code"] == str(f4.evaluation_code)), None)
    saved = row.snapshot["result"]["option"]
    if (
        not current or current["status"] != "EVALUATED"
        or (current["input_fingerprint"], cost["configuration_fingerprint"])
        != (row.input_fingerprint, row.configuration_fingerprint)
        or cost["fingerprint"] != row.snapshot["comparison"]["fingerprint"]
        or fingerprint(current) != fingerprint(saved)
        or Decimal(current["collaborative_cost"]) != row.collaborative_cost
        or Decimal(cost["baseline_cost"]) != row.baseline_cost
    ):
        raise DeliveryConflict("F5_SOURCE_CHANGED")
    return {
        "schema_version": 1,
        "f1": {"run_code": str(run.run_code), "group_code": group.group_code,
               "configuration": run.parameters_snapshot,
               "demands": [source.demand_snapshot for source in sources]},
        "f2": plan.f2_structure, "f3": f3.f3_structure, "f4": f4.f4_structure, "f5": row.snapshot,
        "provenance": _provenance(row),
    }


def _group_summary(run, row, final, last_decision):
    group = row.plan.group
    basis = row.plan.f2_structure["basis"]
    return {
        "run_code": str(run.run_code), "run_number": run.pk, "run_started_at": run.started_at,
        "group_code": group.group_code, "group_number": group.pk,
        "service_date": basis["requested_date"], "demand_count": len(basis["demand_ids"]),
        "total_weight_kg": basis["total_required_weight_kg"],
        "publication": final_plan_summary(final, current=True) if final else None,
        "last_outcome": last_decision.outcome if last_decision else None,
    }


def _overlapping_plans(*, actor, ids, runs):
    claims = list(FinalPlanDemand.objects.filter(demand_id__in=ids).select_related(
        "demand", "plan__decision__group", "plan__handover__reply", "plan__supersedes",
    ).order_by("plan_id", "demand_id"))
    scope_key = fingerprint(ids)
    count = len({claim.plan_id for claim in claims})
    allowed_runs = set(runs.filter(run_code__in=[
        item.plan.decision.group.run_code for item in claims if item.plan.decision.actor_id == actor.pk
    ]).values_list("run_code", flat=True))
    conflicts = {}
    for claim in claims:
        plan = claim.plan
        if count == 1 and plan.scope_key == scope_key and plan.decision.actor_id == actor.pk and plan.scenario == actor_scenario(actor):
            continue
        can_open = (plan.decision.actor_id == actor.pk and plan.scenario == actor_scenario(actor)
                    and plan.decision.group.run_code in allowed_runs)
        entry = conflicts.setdefault(plan.pk, {
            "plan_id": plan.pk, "code": str(plan.code) if can_open else None,
            "version": plan.version, "active": True, "demands": [],
        })
        entry["demands"].append({"id": claim.demand_id, "code": claim.demand.demand_code})
    return list(conflicts.values())


def _approval_preview(*, actor, run, group, row, visible):
    try:
        snapshot = validated_snapshot(actor=actor, run=run, group=group, row=row, visible=visible, lock_demands=False)
        ids = snapshot["f2"]["basis"]["demand_ids"]
        current = list(FinalPlan.objects.filter(active_demands__demand_id__in=ids).select_related("decision").distinct())
        if len(current) > 1 or any(
            p.scope_key != fingerprint(ids) or p.decision.actor_id != actor.pk or p.scenario != actor_scenario(actor)
            for p in current
        ):
            raise DeliveryConflict("DEMAND_ALREADY_FINALIZED")
        previous = current[0] if current else None
        if previous and previous.decision.evaluation_id == row.pk:
            raise DeliveryConflict("EVALUATION_ALREADY_APPROVED")
        if FulfillmentPlan.objects.filter(status=FulfillmentPlanStatus.FINALIZED,
                                          waves__allocations__demand_id__in=ids).exists():
            raise DeliveryConflict("DEMAND_ALREADY_FINALIZED")
        if not TransportProvider.objects.filter(pk=snapshot["f3"]["result"]["provider"]["id"], is_active=True).exists():
            raise DeliveryConflict("CARRIER_UNAVAILABLE")
        return {"allowed": True, "code": None, "version": previous.version + 1 if previous else 1,
                "replaces": str(previous.code) if previous else None}
    except (DeliveryConflict, F5AnchorBlocked) as exc:
        code = str(exc)
    except (CandidateInvalid, ValidationError, F4EvidenceInvalid):
        code = "DELIVERY_SOURCE_INVALID"
    except (CandidateUnavailable, F4ScenarioUnavailable, F4MigrationRequired):
        code = "DELIVERY_SOURCE_UNAVAILABLE"
    return {"allowed": False, "code": code, "version": None, "replaces": None}


@transaction.atomic
def workbench(*, actor, run_code, group_code):
    begin_snapshot()
    require_storage()
    run, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    rows, visible = _economic_rows(run, group, actor, outlets)
    decisions = list(group.decisions.filter(actor=actor).select_related(
        "actor", "evaluation", "group", "final_plan__supersedes", "final_plan__handover__reply", "final_plan__successor",
    ).order_by("-pk"))
    publications = {}
    history = []
    for decision in decisions:
        final = getattr(decision, "final_plan", None)
        summary = final_plan_summary(final, current=is_current(final)) if final else None
        if summary:
            publications.setdefault(decision.evaluation_id, summary)
        history.append({**decision_payload(decision), "final": summary})
    options = []
    group_summary = None
    active = None
    latest = set()
    for row in rows:
        identity = (row.plan.template_type, row.plan.hub_id)
        if identity not in latest:
            options.append({**_plan_summary(row),
                            "approval": _approval_preview(actor=actor, run=run, group=group, row=row, visible=visible),
                            "publication": publications.get(row.pk)})
            latest.add(identity)
            if len(options) == 1:
                demand_ids = row.plan.f2_structure["basis"]["demand_ids"]
                active = FinalPlan.objects.filter(
                    scope_key=fingerprint(demand_ids), decision__actor=actor, scenario=actor_scenario(actor),
                    successor__isnull=True,
                ).select_related("decision__group", "supersedes", "handover__reply").first()
                group_summary = _group_summary(run, row, active, decisions[0] if decisions else None)
                group_summary["conflicts"] = _overlapping_plans(actor=actor, ids=demand_ids, runs=scoped_f1_runs(actor))
    return {"options": options, "active_plan_code": str(active.code) if active else None,
            "group": group_summary, "decisions": history}


def _queue_row(*, actor, run, group, row, final, decision, scoped_runs):
    summary = _group_summary(run, row, final, decision)
    conflicts = _overlapping_plans(actor=actor, ids=row.plan.f2_structure["basis"]["demand_ids"], runs=scoped_runs)
    options, eligible = [], []
    if not conflicts:
        try:
            run, group, outlets = find_f2_candidate(actor=actor, run_code=run.run_code, group_code=group.group_code)
            rows, visible = _economic_rows(run, group, actor, outlets)
            seen = set()
            for option in rows:
                key = (option.plan.template_type, option.plan.hub_id)
                if key in seen:
                    continue
                seen.add(key)
                approval = _approval_preview(actor=actor, run=run, group=group, row=option, visible=visible)
                options.append((option, approval))
        except (CandidateInvalid, CandidateUnavailable):
            pass
        eligible = sorted(
            (option for option, approval in options if approval["allowed"]), key=lambda option: option.collaborative_cost,
        )
    reason = next((approval["code"] for _, approval in options if approval["code"]), None)
    best = eligible[0] if eligible else None
    return {
        **summary, "queue_status": "CONFLICT" if conflicts else "APPROVED" if final else "WAITING" if best else "UNAVAILABLE",
        "conflicts": conflicts, "can_replace": bool(best and final),
        "risk_code": "DEMAND_ALREADY_FINALIZED" if conflicts else reason if not best and not final else None,
        "estimate": ({"cost": best.collaborative_cost, "saving": best.cost_saving,
                      "currency": best.snapshot["configuration"]["currency_code"]} if best else None),
    }


@transaction.atomic
def review_index(*, actor, outcome=None, code=None, date_from=None, date_to=None,
                 actor_id=None, version=None, search=None, page=1, history_only=False):
    begin_snapshot()
    require_storage()
    scoped_runs = scoped_f1_runs(actor)
    runs = scoped_runs.values("run_code")
    candidates = [] if history_only else list(EconomicEvaluation.objects.filter(
        calculated_by=actor, sealed=True, plan__group__run_code__in=runs,
    ).select_related("plan__group").order_by(
        "-plan__group_id", "-calculated_at", "-pk",
    ).distinct("plan__group_id")[:100])
    group_ids = [row.plan.group_id for row in candidates]
    run_by_code = scoped_runs.in_bulk({row.plan.group.run_code for row in candidates}, field_name="run_code")
    last_by_group = {item.group_id: item for item in PlanDecision.objects.filter(
        actor=actor, group_id__in=group_ids,
    ).order_by("group_id", "-pk").distinct("group_id")}
    current_by_group = {item.decision.group_id: item for item in FinalPlan.objects.filter(
        decision__actor=actor, decision__group_id__in=group_ids, successor__isnull=True,
    ).select_related("decision__group", "handover__reply", "supersedes")}
    history = PlanDecision.objects.filter(actor=actor, group__run_code__in=runs).select_related(
        "actor", "evaluation", "group", "final_plan__supersedes", "final_plan__handover__reply",
    )
    if actor_id:
        history = history.filter(actor_id=actor_id)
    if version:
        history = history.filter(final_plan__version=version)
    if search:
        matching = (Q(reason__icontains=search) | Q(actor__full_name__icontains=search)
                    | Q(group__group_code__icontains=search) | Q(group__run_code__icontains=search))
        if search.isascii() and search.isdecimal() and len(search) <= 10:
            matching |= Q(group_id=int(search)) | Q(group__run_code__in=scoped_runs.filter(pk=int(search)).values("run_code"))
        history = history.filter(matching)
    if code:
        history = history.filter(final_plan__code=code)
    if date_from or date_to:
        history = history.annotate(business_date=TruncDate(
            "recorded_at", tzinfo=ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE),
        ))
        if date_from:
            history = history.filter(business_date__gte=date_from)
        if date_to:
            history = history.filter(business_date__lte=date_to)
    history_counts = {row["outcome"]: row["count"] for row in history.order_by().values("outcome").annotate(count=Count("pk"))}
    if outcome:
        history = history.filter(outcome=outcome)
        history_counts = {outcome: history_counts.get(outcome, 0)}
    decisions = []
    size = 20 if history_only else 100
    start = (page - 1) * size
    scoped_run_labels = {str(run.run_code): run.pk for run in scoped_runs.filter(
        run_code__in=history.values("group__run_code"),
    ).only("run_code")}
    for decision in history.order_by("-pk")[start:start + size]:
        final = getattr(decision, "final_plan", None)
        decisions.append({**decision_payload(decision),
                          "group_number": decision.group_id, "run_number": scoped_run_labels[str(decision.group.run_code)],
                          "final": final_plan_summary(final, current=is_current(final)) if final else None})
    declines = FinalPlan.objects.filter(
        decision__actor=actor, decision__group__run_code__in=runs,
        successor__isnull=True, handover__reply__outcome=CarrierOutcome.DECLINE,
    ).select_related("decision__group", "handover__reply", "supersedes").order_by("-pk")[:100]
    return {"candidates": [
        _queue_row(actor=actor, run=run_by_code[row.plan.group.run_code], group=row.plan.group, row=row,
                   final=current_by_group.get(row.plan.group_id), decision=last_by_group.get(row.plan.group_id),
                   scoped_runs=scoped_runs)
        for row in candidates
    ], "decisions": decisions, "carrier_declines": [final_plan_summary(row, current=True) for row in declines],
        "history_counts": history_counts, "page_size": size, "total": sum(history_counts.values())}


@transaction.atomic
def decision_timeline(*, actor, decision_id):
    begin_snapshot()
    require_storage()
    scoped_runs = scoped_f1_runs(actor)
    row = PlanDecision.objects.filter(pk=decision_id, actor=actor, group__run_code__in=scoped_runs.values("run_code")).select_related(
        "actor", "group", "evaluation__plan", "final_plan__supersedes", "final_plan__handover__actor",
        "final_plan__handover__reply__actor",
    ).first()
    if row is None:
        raise CandidateUnavailable
    run = scoped_runs.get(run_code=row.group.run_code)
    evaluation = row.evaluation
    plan = evaluation.plan
    final = getattr(row, "final_plan", None)
    events = [
        {"stage": "F2", "at": plan.created_at, "actor": run.initiated_by.full_name,
         "details": {"code": plan.plan_code, "version": evaluation.snapshot["result"]["option"]["plan"]["revision"]}},
        {"stage": "F5", "at": evaluation.calculated_at, "actor": row.actor.full_name,
         "details": {"code": evaluation.evaluation_code, "cost": evaluation.collaborative_cost,
                     "source": _provenance(evaluation), "fingerprint": evaluation.input_fingerprint}},
        {"stage": row.outcome, "at": row.recorded_at, "actor": row.actor.full_name,
         "details": {"reason": row.reason}},
    ]
    versions = []
    if final:
        events.append({"stage": "FINAL", "at": getattr(final, "created_at", row.recorded_at), "actor": row.actor.full_name,
                       "details": {"code": final.code, "version": final.version, "fingerprint": final.snapshot_hash}})
        handover = getattr(final, "handover", None)
        if handover:
            events.append({"stage": "HANDOVER", "at": handover.sent_at, "actor": handover.actor.full_name,
                           "details": {"provider": final.provider.provider_code, "version": final.version}})
            reply = getattr(handover, "reply", None)
            if reply:
                events.append({"stage": reply.outcome, "at": reply.responded_at, "actor": reply.actor.full_name,
                               "details": {"reason": reply.reason, "version": final.version}})
        versions = [
            {"code": item.code, "version": item.version, "cost": item.decision.evaluation.collaborative_cost,
             "currency": item.decision.evaluation.snapshot["configuration"]["currency_code"],
             "waves": len(item.snapshot["f4"]["result"]["waves"]), "reason": item.decision.reason,
             "current": not hasattr(item, "successor")}
            for item in FinalPlan.objects.filter(scope_key=final.scope_key, decision__actor=actor, scenario=final.scenario,
                                                decision__group__run_code__in=scoped_runs.values("run_code"))
            .select_related("decision__evaluation", "successor").order_by("version")
        ]
    return {"run_number": run.pk, "group_number": row.group_id, "events": events, "versions": versions}


@transaction.atomic
def record_decision(*, actor, run_code, group_code, evaluation_code, request_id, outcome, reason, replaces=None):
    begin_snapshot(writable=True)
    require_storage()
    run, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code, lock=True)
    existing = PlanDecision.objects.filter(actor=actor, request_id=request_id).select_related("evaluation").first()
    if existing:
        final = getattr(existing, "final_plan", None)
        previous_code = final.supersedes.code if final and final.supersedes_id else None
        if (existing.group_id, existing.evaluation.evaluation_code, existing.outcome, existing.reason, previous_code) != (
            group.pk, evaluation_code, outcome, reason, replaces,
        ):
            raise DeliveryConflict("IDEMPOTENCY_KEY_REUSED")
        return decision_payload(existing), False
    rows, visible = _economic_rows(run, group, actor, outlets)
    row = rows.filter(evaluation_code=evaluation_code).first()
    if row is None:
        raise CandidateUnavailable
    if not reason.strip() or outcome not in DecisionOutcome.values:
        raise ValidationError("Decision requires a supported action and a reason.")
    if replaces and outcome != DecisionOutcome.APPROVE:
        raise DeliveryConflict("ONLY_APPROVAL_CAN_REPLACE")
    snapshot, key, current, provider = None, None, None, None
    if outcome == DecisionOutcome.APPROVE:
        snapshot = validated_snapshot(actor=actor, run=run, group=group, row=row, visible=visible, lock_demands=True)
        ids = snapshot["f2"]["basis"]["demand_ids"]
        key = fingerprint(ids)
        claims = FinalPlanDemand.objects.filter(demand_id__in=ids).select_related("plan__decision")
        plans = {claim.plan_id: claim.plan for claim in claims}
        if len(plans) > 1:
            raise DeliveryConflict("DEMAND_ALREADY_FINALIZED")
        current = next(iter(plans.values()), None)
        if current and (current.scope_key != key or current.decision.actor_id != actor.pk
                        or current.scenario != actor_scenario(actor)):
            raise DeliveryConflict("DEMAND_ALREADY_FINALIZED")
        if current and current.decision.evaluation_id == row.pk:
            raise DeliveryConflict("EVALUATION_ALREADY_APPROVED")
        if replaces != (current.code if current else None):
            raise DeliveryConflict("FINAL_PLAN_VERSION_CHANGED")
        if current and settings.COLOGI_CP11_ENABLED:
            from planning.services.fleet_hold import guard_replacement

            current = FinalPlan.objects.select_for_update().get(pk=current.pk)
            guard_replacement(current)
        if FulfillmentPlan.objects.filter(status=FulfillmentPlanStatus.FINALIZED,
                                           waves__allocations__demand_id__in=ids).exists():
            raise DeliveryConflict("DEMAND_ALREADY_FINALIZED")
        provider_id = snapshot["f3"]["result"]["provider"]["id"]
        provider = TransportProvider.objects.filter(pk=provider_id, is_active=True).first()
        if not provider:
            raise DeliveryConflict("CARRIER_UNAVAILABLE")
    decision = PlanDecision.objects.create(group=group, evaluation=row, actor=actor, request_id=request_id,
                                           outcome=outcome, reason=reason)
    if snapshot:
        final = FinalPlan.objects.create(
            decision=decision, provider=provider, scope_key=key, version=current.version + 1 if current else 1,
            supersedes=current, scenario=actor_scenario(actor), snapshot=snapshot, snapshot_hash=fingerprint(snapshot),
        )
        if current:
            changed = FinalPlanDemand.objects.filter(demand_id__in=ids, plan=current).update(plan=final)
            if changed != len(ids):
                raise DeliveryConflict("FINAL_PLAN_VERSION_CHANGED")
        else:
            FinalPlanDemand.objects.bulk_create([FinalPlanDemand(demand_id=pk, plan=final) for pk in ids])
    audit(actor, f"PLAN_DECISION_{outcome}", "PLAN_DECISION", decision, {
        "evaluation_code": str(evaluation_code), "reason": reason,
        "final_plan_code": str(final.code) if snapshot else None,
        "version": final.version if snapshot else None, "snapshot_hash": final.snapshot_hash if snapshot else None,
    })
    return decision_payload(decision), True

