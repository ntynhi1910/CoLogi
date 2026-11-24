from copy import deepcopy

import pytest

from planning.services.f4_scheduling import HARD, PASS, SOFT, UNKNOWN, aggregate, evaluate_schedule, wave_visits


DAY = "2026-11-16"
TZ = "Asia/Ho_Chi_Minh"
SOURCE = {"source": "Unit test only", "reference": "test input"}
CONFIG = {"timezone": TZ, "diagnostics": []}


def times(first, last):
    return {"start_time": first + ":00", "end_time": last + ":00", **SOURCE}


def demand(number, pickup, outlet):
    return {
        "id": number, "code": f"DD{number}", "required_weight_kg": "15.000", "outlet_id": outlet,
        "supplier_confirmation_id": number, "pickup_ready_date": DAY,
        "pickup_ready_start_time": pickup + ":00", "pickup_ready_end_time": "09:00:00",
        "requested_start_time": "09:00:00", "requested_end_time": "10:00:00",
    }


def wave(number, phase, pairs):
    return {
        "wave_no": number, "phase": phase, "vehicle": {"offer_id": 3}, "allocated_weight_kg": str(15 * len(pairs)),
        "allocations": [{"demand_id": n, "from_stop": start, "to_stop": end} for n, start, end in pairs],
    }


def inputs(hub=False):
    demands = [demand(1, "07:00", 1), demand(2, "07:15", 2)]
    pair = [(1, "pickup-1", "outlet-1"), (2, "pickup-2", "outlet-2")]
    waves = [wave(1, "DIRECT", pair)]
    if hub:
        waves = [
            wave(1, "INBOUND", [(n, start, "hub-1") for n, start, _ in pair]),
            wave(2, "OUTBOUND", [(n, "hub-1", end) for n, _, end in pair]),
        ]
    f2 = {
        "basis": {"requested_date": DAY, "demands": demands},
        "option": {"stops": [
            {"key": key, "entity_id": n, "code": key}
            for n, key in enumerate(("pickup-1", "pickup-2", "outlet-1", "outlet-2", "hub-1"), 1)
        ]},
    }
    for stop in f2["option"]["stops"]:
        stop["entity_id"] = int(stop["key"].split("-")[-1])
    offer = {
        "id": 3, "count": 2, "operating_start": "06:00:00", "operating_end": "12:00:00",
        "windows": [{"id": 18, "service_date": DAY, "start": "06:00:00", "end": "12:00:00",
                     "count": 2, "status": "AVAILABLE", **SOURCE}],
    }
    f3 = {"inputs": {"cp7": {"offers": [offer]}}, "result": {"waves": waves}}
    travel, services = [], []
    for proposed in waves:
        visits = wave_visits(f2, proposed)
        services.extend({"stop": row.key, "role": row.role, "minutes": 10, **SOURCE} for row in visits)
        travel.extend({"from_stop": left.key, "to_stop": right.key, "minutes": 15, "distance_km": "4.2", **SOURCE}
                      for left, right in zip(visits, visits[1:]))
    evidence = {
        "services": services, "travel": travel, "hub_windows": [{"stop": "hub-1", **times("07:00", "12:00")}],
        "receiving": [{"outlet_id": pk, "windows": [times("08:30", "12:00")], "slots": [], **SOURCE} for pk in (1, 2)],
    }
    return f2, f3, evidence


def test_direct_deterministic_schedule_with_strict_receiving_boundary():
    f2, f3, evidence = inputs()
    evidence["receiving"][0]["slots"] = [
        {**times("09:10", "09:20"), "slot_type": "BLOCKED", "status": "CONFIRMED"},
    ]
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    assert result == evaluate_schedule(f2, f3, evidence, CONFIG)
    assert result["status"] == PASS and result["complete"]
    assert result["metrics"]["travel_minutes"] == 45
    assert result["metrics"]["distance_km"] == "12.6"
    assert result["metrics"]["wait_minutes"] == 70 and result["metrics"]["on_time_stops"] == 2
    stops = result["waves"][0]["stops"]
    assert [row["stop"] for row in stops] == ["pickup-1", "pickup-2", "outlet-1", "outlet-2"]
    assert stops[2]["service_end"].isoformat() == "2026-11-16T09:10:00+07:00"
    assert result["waves"][0]["receiving_status"] == "NONE"
    assert [row["conflict_type"] for row in stops[2:]] == ["NONE", "NONE"]


@pytest.mark.parametrize(
    "state, expected, code",
    [("CONFIRMED", HARD, "RECEIVING_BLOCKED"), ("RESERVED", SOFT, "RECEIVING_RESERVED"), ("CANCELLED", PASS, None)],
)
def test_receiving_conflict_source_and_wave_aggregation(state, expected, code):
    f2, f3, evidence = inputs()
    evidence["receiving"][0]["slots"] = [{**times("09:00", "10:00"), "slot_type": "BLOCKED", "status": state}]
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    assert result["status"] == expected
    assert result["waves"][0]["receiving_status"] == ("NONE" if expected == PASS else expected)
    assert result["metrics"]["conflict_stops"] == int(expected != PASS)
    if code:
        assert result["waves"][0]["stops"][2]["diagnostics"][0]["code"] == code


def test_waits_for_valid_receiving_window_and_skips_confirmed_block():
    f2, f3, evidence = inputs()
    evidence["receiving"][0]["windows"] = [times("07:00", "08:00"), times("09:00", "10:30")]
    evidence["receiving"][0]["slots"] = [{**times("09:00", "09:10"), "slot_type": "BLOCKED", "status": "CONFIRMED"}]
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    stop = result["waves"][0]["stops"][2]
    assert stop["service_start"].isoformat() == "2026-11-16T09:10:00+07:00"
    assert stop["evidence"]["used_window"]["start_time"] == "09:00:00"
    assert stop["diagnostics"][0]["code"] == "RECEIVING_BLOCK_AVOIDED"
    assert result["status"] == PASS


def test_missing_evidence_leaves_every_unchecked_stop_unresolved():
    f2, f3, evidence = inputs()
    evidence["travel"].pop()
    evidence["receiving"][0]["slots"] = None
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    assert result["status"] == UNKNOWN and not result["complete"]
    assert result["metrics"]["completed_at"] is None and result["metrics"]["not_evaluated_stops"] == 2
    assert {
        row["code"] for stop in result["waves"][0]["stops"] for row in stop["diagnostics"]
    } == {"TRAVEL_EVIDENCE_REQUIRED", "RECEIVING_SLOTS_REQUIRED"}
    assert aggregate([UNKNOWN, SOFT]) == SOFT and aggregate([SOFT, HARD]) == HARD


def test_hub_outbound_starts_after_all_required_demand_finishes_inbound():
    f2, f3, evidence = inputs(hub=True)
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    inbound, outbound = result["waves"]
    assert result["status"] == PASS and result["metrics"]["hub_handling_minutes"] == 20
    assert inbound["weight_kg"] == outbound["weight_kg"] == "30"
    assert inbound["demand_ids"] == outbound["demand_ids"] == [1, 2]
    assert outbound["stops"][0]["service_start"] >= inbound["stops"][-1]["service_end"]
    assert outbound["stops"][0]["evidence"]["inbound_released_at"] == {1: inbound["end"], 2: inbound["end"]}
    evidence["hub_windows"] = [dict(evidence["hub_windows"][0], end_time="07:01:00")]
    failed = evaluate_schedule(f2, f3, evidence, CONFIG)
    assert failed["status"] == HARD and failed["waves"][1]["diagnostics"][0]["code"] == "HUB_INBOUND_NOT_READY"


def test_fleet_checks_whole_execution_and_does_not_sum_overlapping_availability():
    f2, f3, evidence = inputs()
    f3["result"]["waves"] = [
        wave(1, "DIRECT", [(1, "pickup-1", "outlet-1")]),
        wave(2, "DIRECT", [(2, "pickup-2", "outlet-2")]),
    ]
    evidence["travel"].append({"from_stop": "pickup-1", "to_stop": "outlet-1", "minutes": 15, "distance_km": "1", **SOURCE})
    evidence["travel"].append({"from_stop": "pickup-2", "to_stop": "outlet-2", "minutes": 15, "distance_km": "1", **SOURCE})
    offer = f3["inputs"]["cp7"]["offers"][0]
    offer["windows"][0]["count"] = 1
    offer["windows"].append(dict(offer["windows"][0], id=19))
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    assert result["waves"][0]["status"] == PASS and result["waves"][1]["status"] == HARD
    assert result["waves"][1]["diagnostics"][0]["code"] == "VEHICLE_FLEET_CONFLICT"
    offer["windows"][0]["end"] = "08:00:00"
    offer["windows"].pop()
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    assert result["waves"][0]["status"] == UNKNOWN
    assert result["waves"][0]["diagnostics"][0]["code"] == "VEHICLE_PERIOD_UNVERIFIED"


def test_supplier_conflict_and_stop_membership_are_independent_of_f3_totals():
    f2, f3, evidence = inputs()
    f2["basis"]["demands"].append(dict(deepcopy(f2["basis"]["demands"][0]), id=5, code="DD5"))
    f3["result"]["waves"][0]["allocations"].append({"demand_id": 5, "from_stop": "pickup-1", "to_stop": "outlet-1"})
    f2["basis"]["demands"][0]["pickup_ready_end_time"] = "07:05:00"
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    first, _, third, _ = result["waves"][0]["stops"]
    assert first["demand_ids"] == third["demand_ids"] == [1, 5]
    assert first["status"] == HARD and first["diagnostics"][0]["code"] == "PICKUP_WINDOW_CONFLICT"
    assert third["status"] == UNKNOWN and result["waves"][0]["receiving_status"] == UNKNOWN


def test_failed_sequence_preserves_stop_conflict_without_claiming_infeasibility():
    f2, f3, evidence = inputs()
    next(row for row in evidence["travel"] if row["to_stop"] == "outlet-1")["minutes"] = 180
    result = evaluate_schedule(f2, f3, evidence, CONFIG)
    assert result["status"] == UNKNOWN and result["diagnostics"][0]["code"] == "F4_SEQUENCE_NOT_EXHAUSTIVE"
    pickup, _, outlet, _ = result["waves"][0]["stops"]
    assert pickup["departure"] == pickup["service_end"]
    assert outlet["status"] == HARD and not outlet["diagnostics"][0]["independent_of_sequence"]


def test_alternate_is_proposed_outside_full_block_and_needs_demand_reconfirmation():
    f2, f3, evidence = inputs()
    evidence["receiving"][0]["slots"] = [
        {**times("09:00", "10:00"), "slot_type": "BLOCKED", "status": "CONFIRMED"},
        {**times("10:00", "10:05"), "slot_type": "AVAILABLE", "status": "RESERVED"},
    ]
    parameters = {
        "SERVICE_DURATION_MINUTES": {"value": 30, "data_type": "INTEGER"},
        "ALTERNATE_SLOT_SEARCH": {"value": "AFTER_ORIGINAL", "data_type": "STRING"},
    }
    result = evaluate_schedule(f2, f3, evidence, CONFIG | {"parameters": parameters})
    stop = result["waves"][0]["stops"][2]
    alternate, = stop["alternate_slots"]
    assert result["status"] == HARD and stop["service_start"] is None
    assert alternate["start"].time().isoformat() == "10:05:00" and alternate["end"].time().isoformat() == "10:35:00"
    assert alternate["status"] == "PROPOSED" and alternate["requires_demand_window_change"]
    assert not alternate["within_requested_window"]
    normal = evaluate_schedule(*inputs(), CONFIG | {"parameters": parameters})
    completed = normal["waves"][0]["stops"][2]
    assert (completed["service_end"] - completed["service_start"]).total_seconds() == 600
