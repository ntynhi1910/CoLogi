"""Read and reconcile published FinalPlan versions without writing CP11 events or inventory."""

from decimal import Decimal

from django.db import connection, transaction
from django.db.models import Q
from rest_framework.exceptions import NotFound, PermissionDenied

from accounts.capstone import actor_scenario
from planning.f3_contract import fingerprint
from planning.models import FinalPlanDemand, ReconciliationRecord
from planning.models_execution import ExecutionEvent
from planning.services.execution import _event_record, _projection, _scope
from planning.services.execution_simulation import approval_for
from planning.services.f5_economics import allocate
from planning.services.inventory import ExecutionBlocked, lock_request
from planning.services.plan_publication import plans_with_publication, publication_state
from planning.services.reconciliation_metrics import ZERO, _sum_known, build_goods, build_waves, kpis
from planning.services.run_results import scoped_f1_runs


Mode = ReconciliationRecord.Mode
Action = ReconciliationRecord.Action
DISPOSITIONS = ("ACCEPT_SHORT", "RETURNED", "DAMAGED", "REFUSED", "SUPPLEMENTAL_DELIVERY", "RESOLVED_WITH_EVIDENCE")
ISSUE_TYPES = ("SHORTAGE", "SURPLUS", "DAMAGED", "WRONG_SKU", "PICKUP_LATE", "DELIVERY_LATE",
               "DELIVERY_IMPOSSIBLE", "QUANTITY_MISMATCH")
QUANTITY_DISPOSITIONS = {"RETURNED": "returned_kg", "DAMAGED": "damaged_kg", "REFUSED": "refused_kg"}
COST_ACTIONS = {Action.COST_SUBMIT, Action.COST_APPROVE, Action.COST_RETURN}


def ensure_storage():
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('logistics_reconciliation_records') IS NOT NULL")
        if not cursor.fetchone()[0]:
            raise NotFound()


def execution_mode(actor, mode):
    if bool(actor_scenario(actor)) != (mode == Mode.CAPSTONE):
        raise NotFound()
    return Mode.SIMULATION if mode == Mode.SIMULATION else Mode.COMMERCIAL


def _record(row):
    return {"id": row.pk, "action": row.action, "target": row.target, "actor": row.actor.full_name,
            "reason": row.reason, "evidence": row.evidence, "at": row.recorded_at, "mode": row.mode}


def _cost(snapshot, records, goods, audience, full):
    if not full or audience not in ("manager", "provider"):
        return None
    source = snapshot["f5"]["result"]
    option = source["option"]
    baseline, planned = Decimal(source["baseline_cost"]), Decimal(option["collaborative_cost"])
    claims = [row for row in records if row.action == Action.COST_SUBMIT]
    claim = claims[-1] if claims else None
    review = next((row for row in reversed(records) if row.action in COST_ACTIONS - {Action.COST_SUBMIT}
                   and claim and row.target == str(claim.pk)), None)
    approved = review and review.action == Action.COST_APPROVE
    evidence = claim.evidence if claim else {}
    actual = sum((Decimal(evidence[field]) for field in ("transport", "hub", "additional")), ZERO) if approved else None
    received = _sum_known(line["received_kg"] for line in goods["lines"])
    manager = audience == "manager"
    allocations = None
    if manager and actual is not None:
        inputs = [{**row, "amount": Decimal(row["amount"]), "weight_kg": Decimal(row["weight_kg"])}
                  for row in source["baseline_inputs"]]
        allocations = allocate(inputs, actual, snapshot["f5"]["configuration"])
    return {"baseline_vnd": baseline if manager else None, "planned_vnd": planned,
            "planned_saving_vnd": baseline - planned if manager else None,
            "planned_components": option.get("components", []) if manager else [],
            "planned_allocations": option.get("allocations", []) if manager else [], "actual_allocations": allocations,
            "actual_vnd": actual, "actual_saving_vnd": baseline - actual if manager and actual is not None else None,
            "variance_vnd": actual - planned if actual is not None else None,
            "received_kg": received, "claim": _record(claim) if claim else None,
            "review": _record(review) if review else None,
            "status": "APPROVED" if approved else "RETURNED" if review else "SUBMITTED" if claim else "UNAVAILABLE"}


def _issue_history(goods, records):
    resolutions = {}
    for issue in goods["issues"]:
        related = [row for row in records if row.target == issue["key"] and row.action not in COST_ACTIONS]
        latest = related[-1] if related else None
        resolved = (latest and latest.action == Action.ISSUE_RESOLVE
                    and latest.evidence.get("issue_fingerprint") == issue["fingerprint"])
        issue["status"] = "RESOLVED" if resolved else "EVIDENCE_REQUESTED" if latest and latest.action == Action.ISSUE_REQUEST else "OPEN"
        issue["history"] = [_record(row) for row in related]
        if resolved and issue["key"].startswith("line:"):
            resolutions[issue["demand_id"], issue["item_id"]] = latest.evidence
    for line in goods["lines"]:
        if resolution := resolutions.get((line["demand_id"], line["id"])):
            field = QUANTITY_DISPOSITIONS.get(resolution["disposition"])
            if field:
                line[field] = Decimal(resolution["quantity_kg"])
            line["unreconciled_kg"] = ZERO


def detail(actor, audience, code, mode, *, lock=False, supplier=None, outlet=None):
    plan, projection, provenance = _projection(actor, audience, code, lock=lock, mode=execution_mode(actor, mode))
    approval = approval_for(plan) if mode == Mode.SIMULATION else None
    members = [row for row in projection["demands"] if (supplier is None or row["supplier"]["id"] == supplier)
               and (outlet is None or row["outlet"]["id"] == outlet)]
    if not members:
        raise NotFound()
    member_ids = {row["id"] for row in members}
    full = member_ids == set(plan.snapshot["f2"]["basis"]["demand_ids"])
    scope = {(wave["number"], stop["sequence"], load["demand_id"])
             for wave in projection["waves"] for stop in wave["stops"] for load in stop["loads"]
             if load["demand_id"] in member_ids}
    events = [_event_record(row, approval) for row in ExecutionEvent.objects.filter(
        plan=plan, provenance=provenance, demand_id__in=member_ids,
    ).exclude(action="SIMULATION_AUTHORIZED").order_by("pk")
        if (row.wave, row.stop, row.demand_id) in scope]
    projection["demands"] = members
    projection["waves"] = [{**wave, "stops": [{**stop, "loads": [row for row in stop["loads"] if row["demand_id"] in member_ids]}
                           for stop in wave["stops"] if any(row["demand_id"] in member_ids for row in stop["loads"])]}
                           for wave in projection["waves"]]
    projection["waves"] = [wave for wave in projection["waves"] if wave["stops"]]
    ledger = list(ReconciliationRecord.objects.filter(plan=plan, mode=mode).select_related("actor").order_by("pk"))
    all_records = ledger
    goods = build_goods(projection, plan.snapshot["f2"]["basis"]["demands"], events)
    reports = [row for row in ledger if row.action == Action.ISSUE_REPORT and row.evidence["demand_id"] in member_ids
               and (audience in ("manager", "provider") or row.evidence["audience"] == audience)]
    for row in reports:
        goods["issues"].append({"key": row.target, "demand_id": row.evidence["demand_id"], "item_id": None,
                                "codes": [row.evidence["issue_type"]], "unresolved_kg": None,
                                "fingerprint": fingerprint([row.target, row.evidence])})
    # Surface evidence requests only for the same authorized Demand. A request may concern a stop
    # the party cannot inspect, so never return that stop's quantities or report directly.
    if audience in ("supplier", "purchasing"):
        known = {issue["key"] for issue in goods["issues"]}
        for row in ledger:
            request = row.evidence
            if (row.action == Action.ISSUE_REQUEST and request.get("audience") == audience
                    and request.get("demand_id") in member_ids and row.target not in known):
                goods["issues"].append({"key": row.target, "demand_id": request["demand_id"], "item_id": request.get("item_id"),
                                        "codes": ["EVIDENCE_REQUESTED"], "unresolved_kg": None, "fingerprint": None})
                known.add(row.target)
        ledger = [row for row in ledger if row.action in (Action.ISSUE_REQUEST, Action.ISSUE_REPORT)
                  and row.evidence.get("audience") == audience
                  or row.action == Action.ISSUE_EVIDENCE and row.actor_id == actor.pk
                  or row.action == Action.ISSUE_RESOLVE and row.target in known]
    _issue_history(goods, ledger)
    cost = _cost(plan.snapshot, ledger, goods, audience, full)
    waves = build_waves(projection, plan.snapshot["f4"]["result"]["waves"], events,
                        include_load=full and audience in ("manager", "provider"))
    distances = (cost["claim"]["evidence"].get("distances", {}) if cost and cost["actual_vnd"] is not None else {})
    for wave in waves:
        wave["actual_distance_km"] = distances.get(str(wave["number"]))
    issues = goods["issues"]
    lines = goods["lines"]
    has_exception = any(issue["status"] != "RESOLVED" for issue in issues)
    completed = bool(goods["demands"]) and all(row["completed"] for row in goods["demands"])
    custody_fields = ("shipped_kg", "delivered_kg", "received_kg")
    if projection["hub"]:
        custody_fields += ("hub_received_kg", "hub_dispatched_kg")
    settled = bool(lines) and all(all(line[field] is not None for field in custody_fields)
                                  and line["unreconciled_kg"] == ZERO for line in lines)
    current = publication_state(plan) == "CONFIRMED" and set(plan.snapshot["f2"]["basis"]["demand_ids"]) == set(
        FinalPlanDemand.objects.filter(plan=plan).values_list("demand_id", flat=True))
    started = any(event["action"] != "CANCELLED" for event in events)
    blockers = (["GOODS_PENDING"] if not settled else []) + (["UNRESOLVED_ISSUES"] if has_exception else [])
    if not cost or cost["actual_vnd"] is None:
        blockers.append("COST_PENDING")
    if not current or any(row["action"] == "CANCELLED" for row in events):
        blockers.append("PLAN_INACTIVE")
    closures = [row for row in all_records if row.action == Action.CLOSE]
    event_ids = [event["id"] for event in events]
    if closures and not (full and audience in ("manager", "provider")):
        event_ids = list(ExecutionEvent.objects.filter(plan=plan, provenance=provenance)
                         .exclude(action="SIMULATION_AUTHORIZED").order_by("pk").values_list("pk", flat=True))
    seal = fingerprint([plan.snapshot_hash, event_ids, [row.pk for row in all_records if row.action != Action.CLOSE]])
    closed = current and any(row.target == seal for row in closures)
    status = ("COMPLETED" if closed else "RECONCILED" if not blockers else "EXCEPTION" if has_exception else
              "PENDING_RECONCILIATION" if completed or settled else "IN_PROGRESS" if started else "AWAITING_EXECUTION")
    return plan, {
        "code": str(plan.code), "version": plan.version, "date": projection["service_date"], "mode": mode,
        "execution_provenance": provenance, "source": projection["provenance"], "publication_status": projection["status"],
        "current": current, "started": started, "status": status, "completed_delivery": completed,
        "closure_blockers": blockers if audience == "manager" else None,
        "provider": projection["provider"], "template": "HUB" if projection["hub"] else "DIRECT",
        "hub": projection["hub"], **goods, "waves": waves, "cost": cost, "seal": seal,
        "closure": _record(closures[-1]) if audience == "manager" and closures else None,
    }


def overview(actor, audience, mode, *, filters):
    scope = _scope(actor, audience)
    if not scope:
        return [], kpis([])
    rows = plans_with_publication().filter(scenario=actor_scenario(actor), handover__isnull=False)
    if audience == "manager":
        rows = rows.filter(decision__actor=actor, decision__group__run_code__in=scoped_f1_runs(actor).values("run_code"))
    elif audience == "provider":
        rows = rows.filter(provider_id__in=scope)
    else:
        key = "supplier_id" if audience == "supplier" else "outlet_id"
        ownership = Q()
        for pk in scope:
            ownership |= Q(snapshot__f2__basis__demands__contains=[{key: pk}])
        rows = rows.filter(ownership)
    if filters.get("plan"):
        rows = rows.filter(code=filters["plan"])
    plans = []
    for row in rows.order_by("-pk"):
        day = row.snapshot["f2"]["basis"]["requested_date"]
        hub = row.snapshot["f2"]["option"].get("hub")
        if (filters.get("from_date") and filters["from_date"].isoformat() > day
                or filters.get("to_date") and filters["to_date"].isoformat() < day
                or filters.get("template") not in (None, "HUB" if hub else "DIRECT")):
            continue
        try:
            _, projection = detail(actor, audience, row.code, mode, supplier=filters.get("supplier"), outlet=filters.get("outlet"))
        except NotFound:
            continue
        if not filters.get("status") or projection["status"] == filters["status"]:
            plans.append(projection)
    return plans, kpis([row for row in plans if row["current"]])


@transaction.atomic
def write(actor, audience, code, mode, *, action, reason, request_id, data):
    lock_request(actor, request_id)
    plan, result = detail(actor, audience, code, mode, lock=True)
    target = data.pop("target", "")
    previous = ReconciliationRecord.objects.filter(actor=actor, request_id=request_id).select_related("actor").first()
    payload_hash = fingerprint([str(code), mode, action, target, reason, data])
    if previous:
        if previous.evidence.get("request_fingerprint") != payload_hash:
            raise ExecutionBlocked("IDEMPOTENCY_KEY_REUSED")
        return _record(previous), False
    if not result["current"] or mode == Mode.SIMULATION and not approval_for(plan):
        raise ExecutionBlocked("PLAN_INACTIVE")
    if result["status"] == "COMPLETED":
        raise ExecutionBlocked("PLAN_ALREADY_CLOSED")
    if action == Action.COST_SUBMIT:
        if audience != "provider":
            raise PermissionDenied()
        if result["cost"]["status"] == "APPROVED" or not result["started"]:
            raise ExecutionBlocked("COST_SUBMISSION_UNAVAILABLE")
        waves = {str(wave["number"]) for wave in result["waves"]}
        if not data.get("distances", {}).keys() <= waves:
            raise ExecutionBlocked("INVALID_WAVE")
        if result["template"] == "DIRECT" and Decimal(data["hub"]):
            raise ExecutionBlocked("DIRECT_HAS_NO_HUB_FEE")
        unit = Decimal(plan.snapshot["f5"]["configuration"]["rounding_unit_vnd"])
        if any(Decimal(data[key]) % unit for key in ("transport", "hub", "additional")):
            raise ExecutionBlocked("COST_CURRENCY_UNIT_INVALID")
    elif action in (Action.COST_APPROVE, Action.COST_RETURN):
        if audience != "manager":
            raise PermissionDenied()
        cost = result["cost"]
        if cost["status"] != "SUBMITTED" or str(cost["claim"]["id"]) != target:
            raise ExecutionBlocked("COST_CLAIM_CHANGED")
    elif action == Action.CLOSE:
        if audience != "manager":
            raise PermissionDenied()
        if result["closure_blockers"]:
            raise ExecutionBlocked(result["closure_blockers"][0])
        if data["seal"] != result["seal"]:
            raise ExecutionBlocked("RECONCILIATION_CHANGED")
        target = result["seal"]
    elif action == Action.ISSUE_REPORT:
        if not result["started"] or data["demand_id"] not in {demand["id"] for demand in result["demands"]}:
            raise NotFound()
        target = f"report:{request_id}"
        data["audience"] = audience
    else:
        issue = next((row for row in result["issues"] if row["key"] == target), None)
        if issue is None:
            raise NotFound()
        if action == Action.ISSUE_EVIDENCE:
            if audience == "manager":
                raise PermissionDenied()
        else:
            if audience != "manager":
                raise PermissionDenied()
            if issue["status"] == "RESOLVED" or issue["fingerprint"] != data["issue_fingerprint"]:
                raise ExecutionBlocked("RECONCILIATION_CHANGED")
            if action == Action.ISSUE_RESOLVE:
                quantity = Decimal(data["quantity_kg"]) if "quantity_kg" in data else None
                pending = issue["unresolved_kg"]
                if pending is not None and (quantity != pending or data["disposition"] == "RESOLVED_WITH_EVIDENCE"):
                    raise ExecutionBlocked("ISSUE_QUANTITY_MUST_MATCH")
                if pending is None and (quantity is not None or data["disposition"] != "RESOLVED_WITH_EVIDENCE"):
                    raise ExecutionBlocked("ISSUE_HAS_NO_SKU_QUANTITY")
                if data["disposition"] == "ACCEPT_SHORT" and set(issue["codes"]) != {"SHORTAGE"}:
                    raise ExecutionBlocked("ISSUE_DISPOSITION_INVALID")
                if data["disposition"] == "SUPPLEMENTAL_DELIVERY":
                    _verify_supplement(actor, plan, mode, issue, result, data, quantity)
                elif "supplemental_plan" in data or "supplemental_demand" in data:
                    raise ExecutionBlocked("ISSUE_DISPOSITION_INVALID")
            data.update(demand_id=issue["demand_id"], item_id=issue["item_id"])
    row = ReconciliationRecord.objects.create(plan=plan, actor=actor, mode=mode, action=action, reason=reason,
                                              target=target, request_id=request_id,
                                              evidence={**data, "request_fingerprint": payload_hash})
    return _record(row), True


def _verify_supplement(actor, plan, mode, issue, result, data, quantity):
    code = data.get("supplemental_plan")
    demand = data.get("supplemental_demand")
    if not code or not demand or code == str(plan.code) or not quantity or "SHORTAGE" not in issue["codes"]:
        raise ExecutionBlocked("SUPPLEMENTAL_RECEIPT_REQUIRED")
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                       [f"cp12:supplement:{mode}:{code}:{demand}:{issue['item_id']}"])
    if ReconciliationRecord.objects.filter(mode=mode, action=Action.ISSUE_RESOLVE,
            evidence__supplemental_plan=code, evidence__supplemental_demand=demand, evidence__item_id=issue["item_id"]).exists():
        raise ExecutionBlocked("SUPPLEMENTAL_RECEIPT_ALREADY_USED")
    _, supplement = detail(actor, "manager", code, mode)
    line = next(row for row in result["lines"] if (row["demand_id"], row["id"]) == (issue["demand_id"], issue["item_id"]))
    if not supplement["current"] or not any(
        row["demand_id"] == demand and row["id"] == issue["item_id"] and row["supplier"] == line["supplier"]
        and row["outlet"] == line["outlet"] and row["received_kg"] == quantity for row in supplement["lines"]
    ):
        raise ExecutionBlocked("SUPPLEMENTAL_RECEIPT_REQUIRED")
