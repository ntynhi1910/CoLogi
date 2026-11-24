from decimal import Decimal

from planning.services.reconciliation_metrics import build_goods, build_waves, kpis


def event(pk, action, kg, *, wave=1, stop=1, at="09:30", exception=""):
    return {"id": pk, "action": action, "demand_id": 1, "wave": wave, "stop": stop,
            "occurred_at": f"2026-12-03T{at}:00+07:00", "quantities": {"7": kg}, "exception_code": exception}


PROJECTION = {
    "timezone": "Asia/Ho_Chi_Minh", "service_date": "2026-12-03", "hub": None,
    "demands": [{"id": 1, "code": "DD-TEST", "weight_kg": "60", "supplier": {"id": 1}, "outlet": {"id": 2},
                 "items": [{"id": 7, "weight_kg": "60", "code": "SKU"}]}],
}
BASIS = [{"id": 1, "pickup_ready_date": "2026-12-03", "pickup_ready_start_time": "06:00",
          "pickup_ready_end_time": "08:00", "requested_start_time": "09:00", "requested_end_time": "10:00"}]


def test_missing_or_unacknowledged_execution_keeps_actuals_unavailable():
    goods = build_goods(PROJECTION, BASIS, [event(1, "DELIVER", "60")])
    metrics = kpis([dict(goods, waves=[], cost=None, started=True, code="1")])
    assert goods["lines"][0]["received_kg"] is None
    assert metrics["on_time_delivery_pct"] is None
    assert metrics["otif_pct"] is None
    assert metrics["fill_pct"] is None
    assert kpis([])["load_factor_pct"] is None


def test_latest_receipt_and_hub_do_not_double_count_and_otif_requires_full_quantity():
    rows = [event(1, "PICKUP_COMPLETE", "60", at="07:00"), event(2, "HUB_RECEIVE", "60", stop=2),
            event(3, "HUB_DISPATCH", "60", wave=2), event(4, "DELIVER", "60", wave=2, stop=2),
            event(5, "RECEIVE", "15", wave=2, stop=2), event(6, "RECEIVE", "45", wave=2, stop=2)]
    goods = build_goods({**PROJECTION, "hub": {"code": "HUB"}}, BASIS, rows)
    metrics = kpis([dict(goods, waves=[], cost=None, started=True, code="1")])
    assert metrics["shipped_kg"] == 60 and metrics["received_kg"] == 45
    assert metrics["fill_pct"] == 75 and metrics["otif_pct"] == 0 and metrics["on_time_delivery_pct"] == 100
    assert goods["lines"][0]["hub_received_kg"] == 60
    assert goods["issues"][0]["unresolved_kg"] == 15
    assert set(goods["issues"][0]["codes"]) == {"SHORTAGE", "CUSTODY_MISMATCH"}


def test_load_factor_uses_peak_custody_not_accumulated_pickups():
    rows = [event(1, "PICKUP_COMPLETE", "60"), event(2, "DELIVER", "60"),
            event(3, "PICKUP_COMPLETE", "40"), event(4, "DELIVER", "40")]
    projection = {**PROJECTION, "waves": [{"number": 1, "phase": "DIRECT", "vehicle": {}, "stops": []}]}
    planning = [{"wave_no": 1, "vehicle": {"capacity_kg": "100"}, "weight_kg": "100", "stops": []}]
    waves = build_waves(projection, planning, rows, include_load=True)
    metrics = kpis([dict(build_goods(PROJECTION, BASIS, []), waves=waves, cost=None, started=True, code="1")])
    assert waves[0]["peak_actual_load_kg"] == Decimal(60)
    assert metrics["load_factor_pct"] == Decimal(60)
