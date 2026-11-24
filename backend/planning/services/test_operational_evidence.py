from datetime import date
from decimal import Decimal

from django.core.exceptions import ValidationError
import pytest

from accounts.models import User
from masterdata.models import Outlet
from planning.models import CostProfile, OperationalEvidence, ReceivingSlot, ReceivingWindow
from planning.services.database_evidence import price_evidence, timing_evidence
from planning.services.operational_evidence import CAPSTONE, EvidenceReader, publish


@pytest.fixture
def actor(db):
    return User.objects.create_user(email="ops-revision@example.test", full_name="Operations")


def record(actor, kind, scope, data, **changes):
    defaults = {
        "actor": actor, "kind": kind, "scope": scope, "data": data,
        "valid_from": date(2026, 12, 9), "valid_to": date(2026, 12, 9),
        "approval": "APPROVED", "provenance": "OPERATIONAL", "scenario": "", "source_reference": "Test source",
    }
    return publish(**{**defaults, **changes})


@pytest.mark.django_db
def test_effective_scope_is_directed_versioned_and_separate_from_capstone(actor):
    scope = {"origin": "SUPPLIER:1", "destination": "OUTLET:2"}
    value = {"minutes": 20, "distance_km": "12.8"}
    first, created = record(actor, "TRAVEL", scope, value)
    assert created
    assert record(actor, "TRAVEL", scope, value) == (first, False)
    record(actor, "TRAVEL", scope, {**value, "minutes": 1}, provenance=CAPSTONE, scenario="capstone-01")
    record(actor, "TRAVEL", scope, {**value, "minutes": 1}, approval="REFERENCE")
    reader = EvidenceReader("2026-12-09")
    assert reader.choose("TRAVEL", **scope).data == value
    assert reader.choose("TRAVEL", origin="OUTLET:2", destination="SUPPLIER:1") is None
    assert EvidenceReader("2026-12-10").choose("TRAVEL", **scope) is None
    record(actor, "TRAVEL", scope, value, approval="REVOKED")
    assert EvidenceReader("2026-12-09").choose("TRAVEL", **scope) is None
    with pytest.raises(ValidationError):
        first.save()
    with pytest.raises(ValidationError):
        first.delete()


@pytest.mark.django_db
def test_internal_supplement_uses_pinned_revision_below_verified_sources(actor):
    from planning.services.internal_supplement import SCENARIO

    scope = {"origin": "SUPPLIER:1", "destination": "OUTLET:2"}
    data = {"minutes": 30, "distance_km": "12.8"}
    assumed, _ = record(actor, "TRAVEL", scope, data, provenance=CAPSTONE, scenario=SCENARIO)
    newer, _ = record(actor, "TRAVEL", scope, {**data, "minutes": 45}, provenance=CAPSTONE, scenario=SCENARIO)
    approval = {"record_ids": [assumed.pk]}
    assert EvidenceReader("2026-12-09").choose("TRAVEL", **scope) is None
    assert EvidenceReader("2026-12-09", internal_approval=approval).choose("TRAVEL", **scope) == assumed
    assert EvidenceReader("2026-12-10", internal_approval=approval).choose("TRAVEL", **scope) is None
    assert EvidenceReader("2026-12-09", provenance=CAPSTONE, scenario=SCENARIO).choose("TRAVEL", **scope) == newer
    actual, _ = record(actor, "TRAVEL", scope, {**data, "minutes": 20})
    assert EvidenceReader("2026-12-09", internal_approval=approval).choose("TRAVEL", **scope) == actual
    record(actor, "TRAVEL", scope, data, approval="REVOKED")
    assert EvidenceReader("2026-12-09", internal_approval=approval).choose("TRAVEL", **scope) is None


@pytest.mark.django_db
def test_dated_confirmation_is_required_and_ignores_imported_demo_windows(actor):
    o = Outlet.objects.create(outlet_code="OUT-OPS", outlet_name="Outlet", address="Test")
    day = "2026-12-09"
    for source in ("OPERATIONAL", "SYNTHETIC_V7"):
        ReceivingWindow.objects.create(outlet=o, day_of_week=2, start_time="08:00", end_time="10:00",
                                       source=source, source_mode=source, source_reference="Test window")
    ReceivingSlot.objects.create(outlet=o, slot_date=day, start_time="08:30", end_time="09:00",
                                 slot_type="BLOCKED", status="CONFIRMED", source="OPERATIONAL",
                                 source_mode="OPERATIONAL", source_reference="Test slot")
    f2 = {"basis": {"requested_date": day, "demands": [{"outlet_id": o.pk}]}, "option": {"stops": []}}
    unconfirmed = timing_evidence(f2)["receiving"][0]
    assert unconfirmed["slots"] is None
    assert len(unconfirmed["windows"]) == 1
    row, _ = record(actor, "CALENDAR", {"outlet_id": o.pk}, {})
    confirmed = timing_evidence(f2)
    assert confirmed["receiving"][0]["slot_calendar_confirmed"]
    assert confirmed["receiving"][0]["slots"][0]["slot_type"] == "BLOCKED"
    assert confirmed["source_records"][0]["id"] == row.pk


@pytest.mark.django_db
def test_capstone_uses_intersection_of_its_dated_slot_and_receiving_window(actor):
    outlet = Outlet.objects.create(outlet_code="OUT-DEMO", outlet_name="Demo", address="Test")
    day = "2026-12-09"
    scenario = "capstone-01"
    record(actor, "CALENDAR", {"outlet_id": outlet.pk}, {
        "window_start": "08:00", "window_end": "12:00",
        "slot_start": "09:00", "slot_end": "10:30", "minutes": 10,
    }, provenance=CAPSTONE, scenario=scenario)
    stop = {"kind": "OUTLET", "key": "outlet", "entity_id": outlet.pk}
    f2 = {"basis": {"requested_date": day, "demands": [{"outlet_id": outlet.pk}]}, "option": {"stops": [stop]}}
    demo = timing_evidence(f2, scenario)
    window, = demo["receiving"][0]["windows"]
    assert (window["start_time"], window["end_time"], demo["services"][0]["minutes"]) == ("09:00:00", "10:30:00", 10)
    for context in ("", "other-scenario"):
        result = timing_evidence(f2, context)
        assert not result["services"] and result["receiving"][0]["slots"] is None
    f2["basis"]["requested_date"] = "2026-12-10"
    assert timing_evidence(f2, scenario)["receiving"][0]["slots"] is None


@pytest.mark.django_db
def test_policy_conflicts_fail_closed(actor):
    from types import SimpleNamespace

    from planning.services.f5_economics import PriceInvalid

    body = {"allocation_method": "WEIGHT", "rounding_unit_vnd": 1,
            "distance_basis": "FIRST_SERVICE_TO_LAST_SERVICE", "service_basis": "Common service"}
    for code in ("A", "B"):
        profile = CostProfile.objects.create(
            profile_code=code, profile_name=code, currency_code="VND",
            fixed_transport_cost=Decimal(0), additional_handling_cost=Decimal(0),
        )
        record(actor, "POLICY", {"profile_id": profile.pk}, body)
    with pytest.raises(PriceInvalid) as exc:
        price_evidence(SimpleNamespace(cost_profile_id=None), None, {"requested_date": "2026-12-09"}, None, [])
    assert exc.value.diagnostic["code"] == "COST_PROFILE_AMBIGUOUS"
    assert OperationalEvidence.objects.count() == 2


@pytest.mark.django_db
def test_distance_based_independent_tariff_uses_an_effective_direct_leg(actor):
    from types import SimpleNamespace

    from planning.services.f5_economics import independent_costs

    profile = CostProfile.objects.create(
        profile_code="TEST-RATE", profile_name="Test rate", currency_code="VND",
        fixed_transport_cost=0, additional_handling_cost=0,
    )
    record(actor, "POLICY", {"profile_id": profile.pk}, {
        "allocation_method": "WEIGHT", "rounding_unit_vnd": 1,
        "distance_basis": "FIRST_SERVICE_TO_LAST_SERVICE", "service_basis": "Common scope",
    })
    record(actor, "BASELINE", {"supplier_id": 1, "outlet_id": 2, "profile_id": profile.pk}, {
        "components": [{"pricing_basis": "PER_KM", "rate_vnd": "2000", "covers": ["DISTANCE"]}],
    })
    basis = {"requested_date": "2026-12-09", "demands": [{
        "id": 99, "code": "D99", "outlet_id": 2, "outlet_code": "OUT002",
        "supplier_id": 1, "required_weight_kg": "15",
    }]}
    run = SimpleNamespace(run_code="RUN-TEST", cost_profile_id=None)
    group = SimpleNamespace(group_code="group")
    assert price_evidence(run, group, basis, "basis", [])["baseline"] == []
    record(actor, "TRAVEL", {"origin": "SUPPLIER:1", "destination": "OUTLET:2"}, {
        "minutes": 30, "distance_km": "12.5",
    })
    prices = price_evidence(run, group, basis, "basis", [])
    assert independent_costs(basis, prices["baseline"], prices["configuration"])[0]["amount"] == Decimal("25000")
