"""CP11 reads and writes reference one sealed FinalPlan and its published stop loads."""

from datetime import date, datetime
from decimal import Decimal
from uuid import uuid4
from zoneinfo import ZoneInfo

from django.db import connection, transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound

from accounts.capstone import PROVENANCE as CAPSTONE
from accounts.models import ExternalActorType, RoleCode
from accounts.permissions import get_active_external_access, get_active_user_outlet_accesses
from planning.models import FinalPlanDemand
from planning.models_execution import ExecutionEvent
from planning.services.execution_reasons import INCIDENTS, PRESETS, resolve_reason
from planning.services.execution_simulation import (APPROVAL_ACTION, COMMERCIAL_EXECUTION, SIMULATION, approval_for,
                                                   settle_simulation_pickup, simulated_time, validate_fleet_snapshot,
                                                   validate_pickup)
from planning.services.fleet_hold import release_fleet, reserve_fleet
from planning.services.inventory import (CAPSTONE_STOCK_PROVENANCE, ExecutionBlocked, execution_context, lock_request,
                                        pickup_reservations, require_pickup_stock, settle_pickup)
from planning.services.plan_publication import plans_with_publication, publication_detail, publication_state
from planning.services.run_results import scoped_f1_runs


STOP_ACTIONS = {
    "SUPPLIER_PICKUP": {"supplier": ("READY", "SUPPLIER_HANDOVER"), "provider": ("ARRIVE", "CARRIER_PICKUP")},
    "OUTLET_DELIVERY": {"provider": ("ARRIVE", "DELIVER"), "purchasing": ("RECEIVE",)},
    "HUB_RECEIVE": {"provider": ("ARRIVE", "HUB_RECEIVE")},
    "HUB_DISPATCH": {"provider": ("ARRIVE", "HUB_DISPATCH")},
}
QUANTITY_ACTIONS = {"SUPPLIER_HANDOVER", "CARRIER_PICKUP", "DELIVER", "RECEIVE", "HUB_RECEIVE", "HUB_DISPATCH"}


def _scope(actor, audience):
    if audience in ("supplier", "provider"):
        role = ExternalActorType.SUPPLIER if audience == "supplier" else ExternalActorType.TRANSPORT_PROVIDER
        access = get_active_external_access(actor, role)
        if access is None:
            raise NotFound()
        return {access.supplier_id} if audience == "supplier" else {access.provider_id}
    roles = (RoleCode.MANAGER,) if audience == "manager" else (RoleCode.PURCHASING_STAFF,)
    return set(get_active_user_outlet_accesses(actor, role_codes=roles).values_list("outlet_id", flat=True))


def _projection(actor, audience, code, *, lock=False, mode=COMMERCIAL_EXECUTION):
    scenario, provenance = execution_context(actor)
    if mode == SIMULATION:
        if scenario or provenance != "OPERATIONAL":
            raise NotFound()
        provenance = SIMULATION
    scope = _scope(actor, audience)
    if not scope:
        raise NotFound()
    plans = plans_with_publication().filter(code=code, scenario=scenario, handover__isnull=False)
    if audience == "provider":
        plans = plans.filter(provider_id__in=scope)
    elif audience == "manager":
        plans = plans.filter(decision__actor=actor, decision__group__run_code__in=scoped_f1_runs(actor).values("run_code"))
    plan = (plans.select_for_update(of=("self",)) if lock else plans).first()
    if plan is None:
        raise NotFound()
    demands = plan.snapshot["f2"]["basis"]["demands"]
    if audience in ("provider", "manager"):
        if audience == "manager" and not all(d["outlet_id"] in scope for d in demands):
            raise NotFound()
        projection_audience = "provider"
    else:
        key = "supplier_id" if audience == "supplier" else "outlet_id"
        demands = [d for d in demands if d[key] in scope]
        projection_audience = audience
    if not demands:
        raise NotFound()
    return plan, publication_detail(plan, demands, projection_audience), provenance


def _gate(plan, projection, provenance, approval=None):
    if ExecutionEvent.objects.filter(plan=plan, provenance=provenance, action="CANCELLED").exists():
        return "EXECUTION_CANCELLED"
    if publication_state(plan) != "CONFIRMED":
        return "FINAL_PLAN_NOT_CONFIRMED_CURRENT"
    if provenance == SIMULATION:
        return None if approval else "SIMULATION_MANAGER_APPROVAL_REQUIRED"
    source = plan.snapshot["provenance"]
    if provenance == CAPSTONE_STOCK_PROVENANCE and (
        source["classification"], source["time_source"], source["price_source"],
    ) != ("CAPSTONE", CAPSTONE, CAPSTONE):
        return "CAPSTONE_PLAN_REQUIRED"
    if provenance == "OPERATIONAL":
        if (source["classification"] != "OPERATIONAL_EVIDENCE" or source["time_source"] != "OPERATIONAL"
                or source["price_source"] != "OPERATIONAL"):
            return "COMMERCIAL_EVIDENCE_REQUIRED"
    today = timezone.localdate(timezone=ZoneInfo(projection["timezone"]))
    if today < date.fromisoformat(projection["service_date"]):
        return "SERVICE_DATE_NOT_REACHED"
    return None


def _event_record(event, approval=None):
    result = {"id": event.pk, "demand_id": event.demand_id, "wave": event.wave, "stop": event.stop,
            "action": event.action, "quantities": event.quantities, "reason": event.reason,
            "exception_code": event.exception_code, "occurred_at": event.occurred_at, "provenance": event.provenance}
    if approval:
        result["simulation_at"] = simulated_time(approval, event.occurred_at)
    return result


def _status(events):
    actions = {event.action for event in events}
    if "CANCELLED" in actions:
        return "CANCELLED"
    exception = ""
    for event in events:
        if event.action == "PICKUP_COMPLETE" and exception == "PICKUP_QUANTITY_MISMATCH":
            exception = ""
        if event.exception_code:
            exception = event.exception_code
    if "RECEIVE_COMPLETE" in actions:
        return "COMPLETED"
    if exception:
        return "EXCEPTION"
    if "DELIVER" in actions:
        return "AWAITING_RECEIPT"
    if "PICKUP_COMPLETE" in actions:
        return "IN_TRANSIT"
    if actions & {"ARRIVE", "SUPPLIER_HANDOVER", "CARRIER_PICKUP"}:
        return "PICKING_UP"
    return "AWAITING_PICKUP"


def read_execution(*, actor, audience, code, mode=COMMERCIAL_EXECUTION):
    plan, projection, provenance = _projection(actor, audience, code, mode=mode)
    approval = approval_for(plan) if provenance == SIMULATION else None
    ids = [row["id"] for row in projection["demands"]]
    history = list(ExecutionEvent.objects.filter(plan=plan, demand_id__in=ids, provenance=provenance)
                   .exclude(action=APPROVAL_ACTION).order_by("pk"))
    # Show plan progress per scoped demand, but never return an unrelated party's stop or notes.
    visible_stops = {(wave["number"], stop["sequence"], load["demand_id"])
                     for wave in projection["waves"] for stop in wave["stops"] for load in stop["loads"]}
    visible_events = [event for event in history if (event.wave, event.stop, event.demand_id) in visible_stops]
    if audience in ("manager", "provider"):
        by_wave = {wave["number"]: Decimal(0) for wave in projection["waves"]}
        for event in visible_events:
            weight = sum((Decimal(value) for value in event.quantities.values()), Decimal(0))
            if event.action in ("PICKUP_COMPLETE", "HUB_DISPATCH"):
                by_wave[event.wave] += weight
            elif event.action in ("HUB_RECEIVE", "DELIVER"):
                by_wave[event.wave] -= weight
        for wave in projection["waves"]:
            wave["in_transit_kg"] = format(by_wave[wave["number"]], "f")
    return {**projection, "execution_provenance": provenance, "execution_mode": mode,
            "simulation_started_at": approval.reason if approval else None,
            "blocker": _gate(plan, projection, provenance, approval),
            "reason_presets": PRESETS,
            "demand_status": {str(pk): _status([event for event in history if event.demand_id == pk]) for pk in ids},
            "events": [_event_record(event, approval) for event in visible_events]}


def execution_summary(detail):
    pickups, receipts = {}, {}
    for event in detail["events"]:
        target = pickups if event["action"] == "PICKUP_COMPLETE" else receipts if event["action"] == "RECEIVE" else None
        if target is not None:
            target[event["demand_id"], event["wave"], event["stop"]] = sum(
                map(Decimal, event["quantities"].values()), Decimal(0))
    return {
        "provider": detail["provider"], "provenance": detail["provenance"],
        "execution_mode": detail["execution_mode"], "execution_provenance": detail["execution_provenance"],
        "demand_codes": [demand["code"] for demand in detail["demands"]],
        "weight": sum((Decimal(demand["weight_kg"]) for demand in detail["demands"]), Decimal(0)),
        "pickup_kg": sum(pickups.values(), Decimal(0)), "receipt_kg": sum(receipts.values(), Decimal(0)),
        "wave_count": len(detail["waves"]), "vehicles": sorted({wave["vehicle"]["code"] for wave in detail["waves"]}),
        "template": "HUB" if detail["hub"] else "DIRECT", "hub": detail["hub"],
    }


def _load(projection, demand_id, wave_number, stop_number):
    for wave in projection["waves"]:
        if wave["number"] == wave_number:
            for stop in wave["stops"]:
                if stop["sequence"] == stop_number:
                    for load in stop["loads"]:
                        if load["demand_id"] == demand_id:
                            return stop, load
    raise NotFound()


def _new_event(*, plan, actor, payload, quantities, provenance, exception_code=""):
    return ExecutionEvent.objects.create(plan=plan, actor=actor, **payload, quantities=quantities,
                                         provenance=provenance, exception_code=exception_code)


def _begin_execution_write():
    # Production API calls own the outer transaction. Rehearsal can roll back a whole scenario.
    if len(connection.atomic_blocks) == 1:
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")


@transaction.atomic
def authorize_simulation(*, actor, code, request_id, clock_time):
    _begin_execution_write()
    lock_request(actor, request_id)
    plan, projection, provenance = _projection(actor, "manager", code, lock=True, mode=SIMULATION)
    anchor = datetime.combine(date.fromisoformat(projection["service_date"]), clock_time,
                              ZoneInfo(projection["timezone"])).isoformat()
    request_event = ExecutionEvent.objects.filter(actor=actor, request_id=request_id).first()
    existing = approval_for(plan)
    if request_event is not None and request_event != existing:
        raise ExecutionBlocked("IDEMPOTENCY_KEY_REUSED")
    if existing:
        if existing.reason != anchor:
            raise ExecutionBlocked("SIMULATION_CLOCK_ALREADY_CONFIRMED")
        return False
    if publication_state(plan) != "CONFIRMED":
        raise ExecutionBlocked("FINAL_PLAN_NOT_CONFIRMED_CURRENT")
    ids = {demand["id"] for demand in projection["demands"]}
    if ids != set(FinalPlanDemand.objects.select_for_update().filter(plan=plan).values_list("demand_id", flat=True)):
        raise ExecutionBlocked("FINAL_PLAN_SUPERSEDED")
    validate_fleet_snapshot(plan)
    wave = projection["waves"][0]
    stop = wave["stops"][0]
    _new_event(plan=plan, actor=actor, payload={
        "demand_id": stop["loads"][0]["demand_id"], "wave": wave["number"], "stop": stop["sequence"],
        "action": APPROVAL_ACTION, "request_id": request_id, "reason": anchor,
    }, quantities={}, provenance=provenance)
    return True


@transaction.atomic
def record_event(*, actor, audience, code, quantity_rows, reason="", reason_code="", reason_other="",
                 note="", incident_code="", mode=COMMERCIAL_EXECUTION, **payload):
    _begin_execution_write()
    lock_request(actor, payload["request_id"])
    plan, projection, provenance = _projection(actor, audience, code, lock=True, mode=mode)
    approval = approval_for(plan) if provenance == SIMULATION else None
    demand_id, wave, stop_number, action = (payload[key] for key in ("demand_id", "wave", "stop", "action"))
    stop, load = _load(projection, demand_id, wave, stop_number)
    if action not in (*STOP_ACTIONS[stop["role"]].get(audience, ()), "INCIDENT") or audience == "manager":
        raise NotFound()
    demand = next(row for row in projection["demands"] if row["id"] == demand_id)
    if load["items"] is None:
        raise ExecutionBlocked("SKU_ALLOCATION_NOT_CAPTURED")
    expected = {str(row["id"]): Decimal(row["weight_kg"]) for row in load["items"]}
    quantities = {str(row["item_id"]): row["quantity_kg"] for row in quantity_rows}
    if action in QUANTITY_ACTIONS:
        if len(quantities) != len(quantity_rows) or quantities.keys() != expected.keys():
            raise ExecutionBlocked("EXACT_SCOPED_SKUS_REQUIRED")
        if any(weight > expected[item] for item, weight in quantities.items()):
            raise ExecutionBlocked("QUANTITY_EXCEEDS_PLAN")
    elif quantities:
        raise ExecutionBlocked("UNEXPECTED_QUANTITIES")
    serialized = {item: format(weight, ".3f") for item, weight in quantities.items()}
    payload["reason"] = resolve_reason(action, short=action in QUANTITY_ACTIONS and quantities != expected,
                                       legacy=reason, code=reason_code, other=reason_other, note=note,
                                       incident=incident_code)
    previous = ExecutionEvent.objects.filter(actor=actor, request_id=payload["request_id"]).first()
    if previous:
        if previous.plan_id != plan.pk or previous.provenance != provenance or previous.quantities != serialized or any(
            getattr(previous, key) != value for key, value in payload.items()
        ):
            raise ExecutionBlocked("IDEMPOTENCY_KEY_REUSED")
        return _event_record(previous, approval), False
    blocker = _gate(plan, projection, provenance, approval)
    if blocker and (blocker != "SERVICE_DATE_NOT_REACHED" or action != "READY"):
        raise ExecutionBlocked(blocker)
    if not FinalPlanDemand.objects.select_for_update().filter(demand_id=demand_id, plan=plan).exists():
        raise ExecutionBlocked("FINAL_PLAN_SUPERSEDED")
    mode_events = ExecutionEvent.objects.filter(plan=plan, provenance=provenance).exclude(action=APPROVAL_ACTION)
    events = list(mode_events.filter(demand_id=demand_id).order_by("pk"))
    at_stop = {event.action: event for event in events if (event.wave, event.stop) == (wave, stop_number)}
    completed = {event.action: event for event in events}
    if action == "INCIDENT":
        kind, _, detail = payload["reason"].partition(":")
        if kind not in INCIDENTS or not detail.strip():
            raise ExecutionBlocked("INCIDENT_CODE_REQUIRED")
        return _event_record(_new_event(plan=plan, actor=actor, payload=payload, quantities={},
                                       provenance=provenance, exception_code=kind), approval), True
    if provenance != SIMULATION and action != "READY" and not mode_events.filter(action="PICKUP_COMPLETE").exists():
        reserve_fleet(plan, rehearsal=provenance == "SYNTHETIC/CP11_REHEARSAL",
                      capstone=provenance == CAPSTONE_STOCK_PROVENANCE)
    if ("RECEIVE_COMPLETE" in completed
            or action in at_stop and action not in {"RECEIVE", "SUPPLIER_HANDOVER", "CARRIER_PICKUP"}
            or action in {"SUPPLIER_HANDOVER", "CARRIER_PICKUP"} and "PICKUP_COMPLETE" in completed):
        raise ExecutionBlocked("EXECUTION_ACTION_ALREADY_COMPLETED")
    if action in ("READY", "SUPPLIER_HANDOVER", "CARRIER_PICKUP"):
        if provenance == SIMULATION:
            validate_pickup(plan, demand_id, demand["supplier"]["id"], quantities or expected)
        else:
            reservations = pickup_reservations(demand_id, demand["supplier"]["id"]).filter(remaining_kg__gt=0)
            if not reservations.exists():
                raise ExecutionBlocked("PICKUP_RESERVATION_MISSING_OR_INSUFFICIENT")
            if provenance == "OPERATIONAL" and action != "READY":
                require_pickup_stock(reservations, quantities)
    prerequisite = {
        "SUPPLIER_HANDOVER": ("READY", "ARRIVE"), "CARRIER_PICKUP": ("READY", "ARRIVE"),
        "HUB_RECEIVE": ("ARRIVE",), "HUB_DISPATCH": ("ARRIVE",), "DELIVER": ("ARRIVE",), "RECEIVE": ("DELIVER",),
    }.get(action, ())
    if any(key not in at_stop for key in prerequisite):
        raise ExecutionBlocked("PREVIOUS_STOP_ACTION_REQUIRED")
    upstream = {"HUB_RECEIVE": "PICKUP_COMPLETE", "HUB_DISPATCH": "HUB_RECEIVE",
                "DELIVER": "HUB_DISPATCH" if projection["hub"] else "PICKUP_COMPLETE"}.get(action)
    if upstream and (upstream not in completed or serialized != completed[upstream].quantities):
        raise ExecutionBlocked("TRANSFER_QUANTITY_NOT_RECONCILED")
    if upstream and not any(quantities.values()):
        raise ExecutionBlocked("NOTHING_TO_TRANSFER")
    if action == "RECEIVE" and any(Decimal(quantity) > Decimal(at_stop["DELIVER"].quantities[item])
                                    for item, quantity in serialized.items()):
        raise ExecutionBlocked("RECEIPT_EXCEEDS_DELIVERY")
    exception = ""
    other = at_stop.get("CARRIER_PICKUP" if action == "SUPPLIER_HANDOVER" else "SUPPLIER_HANDOVER")
    if action in ("SUPPLIER_HANDOVER", "CARRIER_PICKUP") and other and other.quantities != serialized:
        exception = "PICKUP_QUANTITY_MISMATCH"
    if action == "RECEIVE" and quantities != expected:
        exception = "RECEIPT_DISCREPANCY"
    now = timezone.now()
    effective_now = simulated_time(approval, now) if approval else now
    if action == "DELIVER" and stop["end"] and effective_now > datetime.fromisoformat(stop["end"]):
        exception = "DELIVERY_LATE"
    event = _new_event(plan=plan, actor=actor, payload=payload, quantities=serialized, provenance=provenance,
                       exception_code=exception)
    if action in ("SUPPLIER_HANDOVER", "CARRIER_PICKUP") and other and not exception:
        completed_event = _new_event(
            plan=plan, actor=actor, payload={**payload, "request_id": uuid4(), "action": "PICKUP_COMPLETE"},
            quantities=serialized, provenance=provenance, exception_code="SHORT_PICKUP" if quantities != expected else
            "PICKUP_LATE" if stop["end"] and effective_now > datetime.fromisoformat(stop["end"]) else "",
        )
        if provenance == SIMULATION:
            settle_simulation_pickup(completed_event, demand["supplier"]["id"], quantities)
        else:
            settle_pickup(event=completed_event, supplier_id=demand["supplier"]["id"], quantities=quantities)
    if action == "RECEIVE" and quantities == expected and serialized == at_stop["DELIVER"].quantities:
        _new_event(plan=plan, actor=actor, payload={**payload, "request_id": uuid4(), "action": "RECEIVE_COMPLETE"},
                   quantities=serialized, provenance=provenance)
    return _event_record(event, approval), True


@transaction.atomic
def cancel_execution(*, actor, code, request_id, reason, mode=COMMERCIAL_EXECUTION):
    _begin_execution_write()
    lock_request(actor, request_id)
    plan, projection, provenance = _projection(actor, "manager", code, lock=True, mode=mode)
    previous = ExecutionEvent.objects.filter(actor=actor, request_id=request_id).first()
    if previous:
        if previous.plan_id != plan.pk or previous.provenance != provenance or previous.action != "CANCELLED" or previous.reason != reason:
            raise ExecutionBlocked("IDEMPOTENCY_KEY_REUSED")
        return False
    if publication_state(plan) != "CONFIRMED":
        raise ExecutionBlocked("FINAL_PLAN_NOT_CONFIRMED_CURRENT")
    if provenance == SIMULATION and not approval_for(plan):
        raise ExecutionBlocked("SIMULATION_MANAGER_APPROVAL_REQUIRED")
    events = ExecutionEvent.objects.filter(plan=plan, provenance=provenance)
    if events.filter(action__in={"SUPPLIER_HANDOVER", "CARRIER_PICKUP", "PICKUP_COMPLETE"}).exists():
        raise ExecutionBlocked("CANCELLATION_AFTER_HANDOVER_REQUIRES_RECONCILIATION")
    if events.filter(action="CANCELLED").exists():
        raise ExecutionBlocked("EXECUTION_CANCELLED")
    locations = {}
    for wave in projection["waves"]:
        for stop in wave["stops"]:
            for load in stop["loads"]:
                locations.setdefault(load["demand_id"], (wave["number"], stop["sequence"]))
    for index, (demand_id, (wave, stop)) in enumerate(locations.items()):
        _new_event(plan=plan, actor=actor, payload={"demand_id": demand_id, "wave": wave, "stop": stop,
                   "action": "CANCELLED", "request_id": request_id if index == 0 else uuid4(), "reason": reason},
                   quantities={}, provenance=provenance)
    if not locations:
        raise ExecutionBlocked("NO_PUBLISHED_STOPS")
    if provenance != SIMULATION:
        release_fleet(plan)
    return True
