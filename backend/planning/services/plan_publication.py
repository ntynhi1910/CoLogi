"""Role-scoped publication of an existing, sealed CP10 FinalPlan."""

from collections import defaultdict
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from accounts.capstone import actor_scenario
from accounts.models import AuditLog, ExternalUserAccess, RoleCode, UserOutletAccess
from accounts.permissions import get_active_user_outlet_accesses
from masterdata.models import Item, Outlet, Supplier
from planning.f3_contract import fingerprint
from planning.models import CarrierOutcome, DecisionOutcome, FinalPlan, FinalPlanDemand, GroupDemand, PlanDecision
from planning.services.f2_preview import CandidateUnavailable
from planning.services.final_delivery import DeliveryConflict, begin_snapshot, require_storage


def plans_with_publication():
    return FinalPlan.objects.select_related("decision__group", "provider", "handover__reply", "successor__decision")


def publication_state(plan):
    sent = getattr(plan, "handover", None)
    reply = getattr(sent, "reply", None)
    if hasattr(plan, "successor"):
        return "SUPERSEDED"
    if not sent:
        return "APPROVED"
    if not reply:
        return "AWAITING_TRANSPORT"
    return "CONFIRMED" if reply.outcome == CarrierOutcome.CONFIRM else "DECLINED"


def publication_events(plan):
    sent = getattr(plan, "handover", None)
    if not sent:
        return []
    events = [("PUBLISHED", sent.sent_at)]
    reply = getattr(sent, "reply", None)
    if reply:
        events.append(("CONFIRMED" if reply.outcome == CarrierOutcome.CONFIRM else "DECLINED", reply.responded_at))
    successor = getattr(plan, "successor", None)
    if successor:
        events.append(("SUPERSEDED", successor.decision.recorded_at))
    return [{"id": f"{plan.code}:{kind}", "kind": kind, "at": at, "code": str(plan.code), "version": plan.version}
            for kind, at in events]


def _entity(row, code_field, name_field):
    return {"id": row.pk, "code": getattr(row, code_field), "name": getattr(row, name_field)}


def _labels(demands):
    supplier = {row.pk: _entity(row, "supplier_code", "supplier_name")
                for row in Supplier.objects.filter(pk__in={row["supplier_id"] for row in demands})}
    outlet = {row.pk: _entity(row, "outlet_code", "outlet_name")
              for row in Outlet.objects.filter(pk__in={row["outlet_id"] for row in demands})}
    items = {row.pk: _entity(row, "item_code", "item_name")
             for row in Item.objects.filter(pk__in={item["item_id"] for row in demands for item in row["items"]})}
    return supplier, outlet, items


def _units(snapshot):
    return {
        (str(record["values"]["DEMAND_ID"]), str(record["values"]["ITEM_ID"])): record["values"].get("UNIT_OF_MEASURE")
        for demand in snapshot["f1"]["demands"] for record in demand.get("related_records", ())
        if record["model_label"].lower() == "demands.demanditem"
    }


def publication_detail(plan, demands, audience, *, labels=None):
    if (plan.decision.outcome != DecisionOutcome.APPROVE or fingerprint(plan.snapshot) != plan.snapshot_hash):
        raise DeliveryConflict("FINAL_PLAN_INVALID")
    snapshot = plan.snapshot
    f2, f3, f4 = (snapshot[key] for key in ("f2", "f3", "f4"))
    suppliers, outlets, items = labels or _labels(demands)
    units = _units(snapshot)
    members = {}
    for row in demands:
        members[row["id"]] = {
            "id": row["id"], "code": row["code"],
            "supplier": suppliers.get(row["supplier_id"], {"id": row["supplier_id"], "code": None, "name": None}),
            "outlet": outlets.get(row["outlet_id"], {"id": row["outlet_id"], "code": row["outlet_code"], "name": None}),
            "weight_kg": row["required_weight_kg"],
            "items": [{
                **items.get(item["item_id"], {"id": item["item_id"], "code": None, "name": None}),
                "unit": units.get((str(row["id"]), str(item["item_id"]))), "weight_kg": item["required_weight_kg"],
            } for item in row["items"]],
        }
    hours = {
        "supplier": {"SUPPLIER_PICKUP": "from_stop", "HUB_RECEIVE": "to_stop"},
        "purchasing": {"HUB_DISPATCH": "from_stop", "OUTLET_DELIVERY": "to_stop"},
        "provider": {"SUPPLIER_PICKUP": "from_stop", "HUB_RECEIVE": "to_stop",
                     "HUB_DISPATCH": "from_stop", "OUTLET_DELIVERY": "to_stop"},
    }[audience]
    points = {point["key"]: point for point in f2["option"]["stops"]}
    allocations = {row["wave_no"]: row["allocations"] for row in f3["result"]["waves"]}
    waves = []
    for wave in f4["result"]["waves"]:
        stops = []
        for stop in wave["stops"]:
            if stop["role"] not in hours:
                continue
            stop_key = stop["stop"]
            weights = {
                alloc["demand_id"]: alloc["weight_kg"] for alloc in allocations[wave["wave_no"]]
                if alloc[hours[stop["role"]]] == stop_key
                and alloc["demand_id"] in members and alloc["demand_id"] in stop["demand_ids"]
            }
            if not weights:
                continue
            stops.append({
                "sequence": stop["sequence"], "role": stop["role"], "code": stop["code"],
                "address": points[stop_key]["address"], "arrival": stop["arrival"],
                "start": stop["service_start"], "end": stop["service_end"], "departure": stop["departure"],
                "wait_minutes": stop.get("wait_minutes"),
                "weight_kg": format(sum(map(Decimal, weights.values())), "f"),
                "loads": [
                    {"demand_id": demand_id, "weight_kg": weight,
                     "items": members[demand_id]["items"] if Decimal(weight) == Decimal(members[demand_id]["weight_kg"]) else None}
                    for demand_id, weight in weights.items()
                ],
            })
        if stops:
            vehicle = wave["vehicle"]
            waves.append({"number": wave["wave_no"], "phase": wave["phase"],
                          "vehicle": {"code": vehicle["vehicle_code"], "name": vehicle["vehicle_name"]},
                          "weight_kg": wave["weight_kg"] if audience == "provider" else None, "stops": stops})
    provenance = snapshot["provenance"]
    sent = getattr(plan, "handover", None)
    reply = getattr(sent, "reply", None)
    return {
        "code": str(plan.code), "version": plan.version, "status": publication_state(plan),
        "service_date": f2["basis"]["requested_date"], "published_at": sent.sent_at if sent else None,
        "responded_at": reply.responded_at if reply else None,
        "provider": _entity(plan.provider, "provider_code", "provider_name"),
        "hub": f2["option"].get("hub"), "timezone": f4["configuration"]["timezone"],
        "provenance": {key: provenance[key] for key in
                       ("classification", "provider_independently_verified", "time_source", "price_source")},
        "demands": list(members.values()), "waves": waves, "events": publication_events(plan),
    }


def manager_recipients(plan):
    demands = plan.snapshot["f2"]["basis"]["demands"]
    suppliers, outlets, _ = _labels(demands)
    buyers = defaultdict(dict)
    assignments = UserOutletAccess.objects.filter(
        outlet_id__in=outlets, outlet__is_active=True, is_active=True, user__is_active=True,
        user__capstone_scenario=plan.scenario, user__user_roles__is_active=True,
        user__user_roles__role__code=RoleCode.PURCHASING_STAFF, user__user_roles__role__is_active=True,
    ).values_list("outlet_id", "user_id", "user__full_name").order_by("user__full_name", "user_id")
    for outlet, user, name in assignments:
        buyers[outlet][user] = name
    external = ExternalUserAccess.objects.filter(
        is_active=True, user__is_active=True, user__capstone_scenario=plan.scenario,
        user__user_roles__is_active=True, user__user_roles__role__is_active=True,
        user__user_roles__role__code=F("actor_type"),
    ).filter(
        Q(supplier_id__in=suppliers, supplier__is_active=True)
        | Q(provider_id=plan.provider_id, provider__is_active=True, provider__provider_code="TP001")
    ).values_list("supplier_id", "provider_id", "user_id").distinct()
    external_accounts = defaultdict(set)
    for supplier_id, provider_id, user_id in external:
        external_accounts[(supplier_id, provider_id)].add(user_id)
    state = publication_state(plan)

    def access(count):
        if not count:
            return "NO_ACTIVE_SCOPE"
        if not getattr(plan, "handover", None):
            return "AWAITING_PUBLICATION"
        return "HISTORY_ONLY" if state == "SUPERSEDED" else "AVAILABLE"

    def recipient(entity, count):
        return {**entity, "account_count": count, "view_access": access(count)}

    provider = _entity(plan.provider, "provider_code", "provider_name")
    events = publication_events(plan)
    if plan.supersedes_id:
        events += publication_events(plan.supersedes)
    return {"status": state, "suppliers": [
                recipient(supplier, len(external_accounts[(supplier["id"], None)])) for supplier in suppliers.values()
            ],
            "outlets": [{**recipient(outlet, len(buyers[outlet["id"]])), "purchasing_count": len(buyers[outlet["id"]]),
                         "purchasing_staff": list(buyers[outlet["id"]].values())}
                        for outlet in outlets.values()],
            "provider": recipient(provider, len(external_accounts[(None, plan.provider_id)])),
            "events": sorted(events, key=lambda event: event["at"], reverse=True)}


@transaction.atomic
def read_publications(*, actor, audience, supplier_id=None, code=None):
    begin_snapshot()
    require_storage()
    if audience == "supplier":
        scope_key, scope = "supplier_id", {supplier_id}
    else:
        scope_key, scope = "outlet_id", set(get_active_user_outlet_accesses(actor).values_list("outlet_id", flat=True))
    if not scope:
        if code:
            raise CandidateUnavailable
        return {"plans": [], "events": [], "summary": _metrics([])}
    ownership = Q()
    for key in scope:
        ownership |= Q(snapshot__f2__basis__demands__contains=[{scope_key: key}])
    rows = plans_with_publication().filter(
        ownership, scenario=actor_scenario(actor), handover__isnull=False, decision__outcome=DecisionOutcome.APPROVE,
    )
    if code:
        rows = rows.filter(code=code)
    matched = [(plan, [row for row in plan.snapshot["f2"]["basis"]["demands"] if row[scope_key] in scope])
               for plan in rows.order_by("-handover__sent_at", "-pk")]
    labels = _labels([row for _, members in matched for row in members])
    plans = [publication_detail(plan, members, audience, labels=labels) for plan, members in matched if members]
    if code:
        if not plans:
            raise CandidateUnavailable
        return plans[0]
    return {"plans": plans, "events": sorted([event for plan in plans for event in plan["events"]],
                                             key=lambda event: event["at"], reverse=True), "summary": _metrics(plans)}


def _metrics(plans):
    active = [row for row in plans if row["status"] not in ("SUPERSEDED", "DECLINED")]
    today = timezone.localdate(timezone=ZoneInfo("Asia/Ho_Chi_Minh")).isoformat()
    upcoming = [row for row in active if row["service_date"] >= today]
    upcoming_weight = sum((Decimal(demand["weight_kg"]) for row in upcoming for demand in row["demands"]), Decimal(0))
    return {
        "upcoming": len(upcoming),
        "upcoming_weight_kg": format(upcoming_weight, "f"),
        "awaiting": sum(row["status"] == "AWAITING_TRANSPORT" for row in active),
        "confirmed": sum(row["status"] == "CONFIRMED" for row in active),
        "active_demand_count": len({demand["id"] for row in active for demand in row["demands"]}),
    }


def demand_logistics(demand_ids, scenario, receipt_outlets):
    """Compute read-only logistics fields for rows already authorized by CP04."""
    results = {pk: {"logistics_status": "UNPLANNED", "receipt_plan_code": None} for pk in demand_ids}
    if not results:
        return results
    for pk in GroupDemand.objects.filter(
        demand_id__in=demand_ids, group__plans__f2_structure__isnull=False,
    ).values_list("demand_id", flat=True).distinct():
        results[pk]["logistics_status"] = "OPTION_READY"
    # A rejected or recalculation decision remains actionable until a new final version is approved.
    latest = PlanDecision.objects.filter(group__group_demands__demand_id__in=demand_ids).order_by(
        "group__group_demands__demand_id", "-recorded_at", "-pk",
    ).distinct("group__group_demands__demand_id").values_list("group__group_demands__demand_id", "outcome")
    for pk, decision in latest:
        if decision != DecisionOutcome.APPROVE:
            results[pk]["logistics_status"] = "NEEDS_ADJUSTMENT"
    for key in AuditLog.objects.filter(action="UNPLANNED_DEMAND_CLOSED", entity_type="DEMAND",
            entity_id__in=[str(pk) for pk in demand_ids], new_values__scenario=scenario).values_list("entity_id", flat=True).distinct():
        results[int(key)]["logistics_status"] = "NEEDS_ADJUSTMENT"
    claims = FinalPlanDemand.objects.filter(demand_id__in=demand_ids, plan__scenario=scenario).select_related(
        "plan__handover__reply", "plan__successor", "demand",
    )
    for claim in claims:
        state = publication_state(claim.plan)
        visible_receipt = claim.demand.outlet_id in receipt_outlets and state in ("AWAITING_TRANSPORT", "CONFIRMED", "DECLINED")
        results[claim.demand_id] = {
            "logistics_status": "NEEDS_ADJUSTMENT" if state in ("DECLINED", "SUPERSEDED") else state,
            "receipt_plan_code": str(claim.plan.code) if visible_receipt else None,
        }
    return results
