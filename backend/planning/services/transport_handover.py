"""Version-bound CP10 handover and replies in the provider portal."""

from django.conf import settings
from django.db import transaction

from accounts.capstone import actor_scenario
from masterdata.models import Item, Supplier
from planning.f3_contract import fingerprint
from planning.models import (
    CarrierOutcome, DecisionOutcome, FinalPlan, FinalPlanDemand, TransportHandover, TransportHandoverResponse,
)
from planning.services.f2_preview import CandidateUnavailable, find_f2_candidate
from planning.services.final_delivery import (
    DeliveryConflict, _economic_rows, audit, begin_snapshot, final_plan_summary, is_current, require_storage,
    validated_snapshot,
)
from planning.services.plan_publication import manager_recipients, plans_with_publication, publication_detail, publication_events
from planning.services.run_results import scoped_f1_runs


def _final_rows():
    return plans_with_publication().select_related("decision__evaluation", "supersedes__handover__reply")


def _manager_plan(actor, code, *, lock=False):
    row = _final_rows().filter(code=code, decision__actor=actor, scenario=actor_scenario(actor)).first()
    if row is None:
        raise CandidateUnavailable
    group = row.decision.group
    run, group, outlets = find_f2_candidate(actor=actor, run_code=group.run_code, group_code=group.group_code, lock=lock)
    return row, run, group, outlets


def _provider_rows(actor, provider_id):
    return _final_rows().filter(
        provider_id=provider_id, provider__provider_code="TP001", provider__is_active=True,
        scenario=actor_scenario(actor), handover__isnull=False, decision__outcome=DecisionOutcome.APPROVE,
    )


def _check_seal(row):
    if row.decision.outcome != DecisionOutcome.APPROVE or fingerprint(row.snapshot) != row.snapshot_hash:
        raise DeliveryConflict("FINAL_PLAN_INVALID")


def _lock_current(row):
    ids = row.snapshot["f2"]["basis"]["demand_ids"]
    claims = list(FinalPlanDemand.objects.select_for_update().filter(
        demand_id__in=ids,
    ).order_by("demand_id").values_list("demand_id", "plan_id"))
    if claims != [(pk, row.pk) for pk in ids] or not is_current(row):
        raise DeliveryConflict("FINAL_PLAN_SUPERSEDED")


def _delivery_payload(row, *, manager):
    _check_seal(row)
    result = {**final_plan_summary(row, current=is_current(row)), "snapshot_hash": row.snapshot_hash}
    f2, f3, f4, f5 = (row.snapshot[key] for key in ("f2", "f3", "f4", "f5"))
    demands = f2["basis"]["demands"]
    if manager:
        labels = dict(Item.objects.filter(pk__in={item["item_id"] for demand in demands for item in demand["items"]})
                      .values_list("pk", "item_code"))
        suppliers = dict(Supplier.objects.filter(pk__in={demand["supplier_id"] for demand in demands})
                         .values_list("pk", "supplier_code"))
        demands = [{**demand, "supplier_code": suppliers.get(demand["supplier_id"]),
                    "items": [{**item, "item_code": labels.get(item["item_id"])} for item in demand["items"]]}
                   for demand in demands]
    return {
        **result,
        **({"snapshot": row.snapshot, "approved_by": row.decision.actor.full_name} if manager else {}),
        **({"publication": manager_recipients(row)} if manager else {"publication": publication_detail(row, demands, "provider")}),
        "delivery": {
            "demands": demands, "total_weight_kg": f2["basis"]["total_required_weight_kg"],
            "stops": f2["option"]["stops"], "legs": f2["option"]["legs"],
            "allocation": f3["result"]["waves"], "timeline": f4["result"]["waves"],
            "cost": f5["result"]["option"]["collaborative_cost"], "currency": f5["configuration"]["currency_code"],
        },
    }


@transaction.atomic
def read_manager_plan(*, actor, code):
    begin_snapshot()
    require_storage()
    return _delivery_payload(_manager_plan(actor, code)[0], manager=True)


@transaction.atomic
def read_manager_plans(*, actor):
    begin_snapshot()
    require_storage()
    runs = scoped_f1_runs(actor)
    rows = list(_final_rows().filter(
        decision__actor=actor, scenario=actor_scenario(actor),
        decision__group__run_code__in=runs.values("run_code"),
    ).select_related("decision__actor", "successor").order_by("-pk")[:100])
    run_numbers = dict(runs.filter(run_code__in=[row.decision.group.run_code for row in rows]).values_list("run_code", "pk"))
    return {"plans": [{
        **final_plan_summary(row, current=not hasattr(row, "successor")),
        "run_number": run_numbers[row.decision.group.run_code], "group_number": row.decision.group_id,
        "actor_name": row.decision.actor.full_name,
        "wave_count": len(row.snapshot["f4"]["result"]["waves"]),
        "demand_count": len(row.snapshot["f2"]["basis"]["demand_ids"]),
        "weight": row.snapshot["f2"]["basis"]["total_required_weight_kg"],
        "cost": row.decision.evaluation.collaborative_cost,
        "currency": row.snapshot["f5"]["configuration"]["currency_code"],
    } for row in rows]}


@transaction.atomic
def read_provider_plans(*, actor, provider_id, code=None):
    begin_snapshot()
    require_storage()
    rows = _provider_rows(actor, provider_id)
    if code:
        row = rows.filter(code=code).first()
        if not row:
            raise CandidateUnavailable
        return _delivery_payload(row, manager=False)
    rows = list(rows.order_by("-pk")[:100])
    return {"plans": [final_plan_summary(row, current=not hasattr(row, "successor")) for row in rows],
            "events": sorted([event for row in rows for event in publication_events(row)],
                             key=lambda event: event["at"], reverse=True)}


@transaction.atomic
def send_plan(*, actor, code):
    begin_snapshot(writable=True)
    require_storage()
    row, run, group, outlets = _manager_plan(actor, code, lock=True)
    _check_seal(row)
    if (row.snapshot["f3"]["result"]["provider"]["provider_code"] != "TP001"
            or row.provider.provider_code != "TP001" or not row.provider.is_active):
        raise DeliveryConflict("CARRIER_NOT_TP001")
    # Acquire Demand locks before claim locks, matching the publication order.
    rows, visible = _economic_rows(run, group, actor, outlets)
    source = rows.filter(pk=row.decision.evaluation_id).first()
    existing = getattr(row, "handover", None)
    if existing:
        _lock_current(row)
        return _delivery_payload(row, manager=True), False
    if source is None:
        raise DeliveryConflict("FINAL_PLAN_SOURCE_CHANGED")
    captured = validated_snapshot(actor=actor, run=run, group=group, row=source, visible=visible, lock_demands=True)
    _lock_current(row)
    if fingerprint(captured) != row.snapshot_hash:
        raise DeliveryConflict("FINAL_PLAN_SOURCE_CHANGED")
    if settings.COLOGI_CP11_ENABLED and row.snapshot["provenance"]["classification"] == "OPERATIONAL_EVIDENCE":
        from planning.services.fleet_hold import reserve_fleet

        reserve_fleet(row)
    sent = TransportHandover.objects.create(plan=row, actor=actor)
    audit(actor, "TRANSPORT_PLAN_SENT", "TRANSPORT_HANDOVER", sent, {
        "code": str(row.code), "version": row.version, "provider_id": row.provider_id,
        "snapshot_hash": row.snapshot_hash, "provenance": row.snapshot["provenance"]["classification"],
    })
    row.handover = sent
    return _delivery_payload(row, manager=True), True


@transaction.atomic
def respond_to_plan(*, actor, provider_id, code, outcome, reason):
    begin_snapshot(writable=True)
    require_storage()
    row = _provider_rows(actor, provider_id).filter(code=code).first()
    if row is None:
        raise CandidateUnavailable
    _check_seal(row)
    _lock_current(row)
    reply = getattr(row.handover, "reply", None)
    if reply:
        if (reply.actor_id, reply.outcome, reply.reason) == (actor.pk, outcome, reason):
            return _delivery_payload(row, manager=False), False
        raise DeliveryConflict("HANDOVER_ALREADY_ANSWERED")
    if outcome not in CarrierOutcome.values or not reason.strip():
        raise DeliveryConflict("INVALID_HANDOVER_RESPONSE")
    reply = TransportHandoverResponse.objects.create(
        handover=row.handover, actor=actor, outcome=outcome, reason=reason,
    )
    if settings.COLOGI_CP11_ENABLED and outcome == CarrierOutcome.DECLINE:
        from planning.services.fleet_hold import release_fleet

        release_fleet(row)
    audit(actor, f"TRANSPORT_PLAN_{outcome}", "TRANSPORT_HANDOVER", row.handover, {
        "code": str(row.code), "version": row.version, "provider_id": provider_id,
        "reason": reason, "snapshot_hash": row.snapshot_hash,
        "provenance": row.snapshot["provenance"]["classification"],
    })
    row.handover.reply = reply
    return _delivery_payload(row, manager=False), True

