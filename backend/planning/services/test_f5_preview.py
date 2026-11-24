from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
import json
from threading import Barrier
from uuid import uuid4

import pytest
from django.db import DatabaseError, IntegrityError, connection, connections, transaction
from django.test import override_settings
from rest_framework.test import APIClient

from accounts.models import UserOutletAccess
from planning.f3_contract import fingerprint
from planning.models import CostAllocation, CostComponent, DemandCostInput, EconomicEvaluation, F3Evaluation, F4Evaluation, ReceivingWindow
from planning.services.f4_scheduling import RULES as F4_RULES
from planning.services.f5_economics import RULES, PriceInvalid, allocate, collaborative_cost, independent_costs, recommend, savings
from planning.services.test_f3_persistence import _actor, case
from planning.services.test_f4_persistence import _freeze_f3, _reference
from planning.services.test_f4_preview import _time_scope
from planning.services.test_group6_postgresql import group6_database, pytestmark


def component(method, rate, *covers):
    return {"pricing_basis": method, "rate_vnd": str(rate), "covers": list(covers)}


def quote(*components, **details):
    return {
        "source_reference": "approved fixture", "source_type": "APPROVED_UAT_QUOTE",
        "valid_from": "2020-01-01", "valid_to": "2030-12-31",
        "complete": True, "components": list(components), **details,
    }


def config(method="WEIGHT", distance="FIRST_SERVICE_TO_LAST_SERVICE"):
    return {
        "version": "F5 test approval", "rules": RULES, "currency_code": "VND",
        "rounding_unit_vnd": 1, "rounding_mode": "HALF_UP",
        "allocation_residual": "LARGEST_REMAINDER_OUTLET_ID", "allocation_method": method,
        "distance_basis": distance, "service_basis": "same Candidate delivery date and windows",
    }


def test_costs_distinct_hub_phases_bundle_and_depot():
    basis = {"requested_date": "2026-11-16", "total_required_weight_kg": "650", "demands": range(4)}
    waves = [{"wave_no": no, "offer_id": 3, "distance_km": Decimal(km), "weight_kg": "650",
              "demand_ids": [1, 2, 3, 5], "wait_minutes": Decimal(0), "handling_minutes": Decimal(15)}
             for no, km in ((1, 20), (2, 18))]
    option = {"waves": [
        quote(component("FIXED", 100, "TRANSPORT_BASE"), component("PER_KM", 10, "DISTANCE"), wave_no=1, offer_id=3),
        quote(component("BUNDLED", 200, "TRANSPORT_BASE", "DISTANCE", "WAIT"), wave_no=2, offer_id=3),
    ], "hub": quote(component("PER_KG", 2, "HUB_HANDLING"), hub_id=1)}
    rows = collaborative_cost(basis, waves, 1, option, config())
    assert [(row["wave_no"], row["amount"]) for row in rows] == [(1, 100), (1, 200), (2, 200), (None, 1300)]
    assert [row["unit_code"] for row in rows] == ["TRIP", "KM", "BUNDLE", "KG"]
    assert rows[2]["distance_evidence"]["snapshot_km"] == 18
    option["waves"][1]["components"].append(component("PER_KM", 1, "DISTANCE"))
    with pytest.raises(PriceInvalid, match="PRICE_COMPONENTS_OVERLAP"):
        collaborative_cost(basis, waves, 1, option, config())
    option["waves"][1]["components"].pop()
    option["waves"][1]["components"][0]["covers"].append("HUB_HANDLING")
    with pytest.raises(PriceInvalid, match="PRICE_COMPONENTS_OVERLAP"):
        collaborative_cost(basis, waves, 1, option, config())
    del option["hub"]
    assert len(collaborative_cost(basis, waves, 1, option, config())) == 3
    with pytest.raises(PriceInvalid, match="DEPOT_DISTANCE_REQUIRED"):
        collaborative_cost(basis, waves, 1, option, config(distance="INCLUDING_DEPOT"))
    for row in option["waves"]:
        row["depot"] = {"to_pickup_km": "1", "return_km": "2", "source_reference": "approved fixture route"}
    assert collaborative_cost(basis, waves, 1, option, config(distance="INCLUDING_DEPOT"))[1]["amount"] == 230
    option["waves"][0]["valid_to"] = "2026-11-15"
    with pytest.raises(PriceInvalid, match="PRICE_OUTSIDE_EFFECTIVE_DATE"):
        collaborative_cost(basis, waves, 1, option, config())


def test_exact_baseline_savings_and_deterministic_rounding():
    basis = {"requested_date": "2026-11-16", "demands": [
        {"id": pk, "code": f"D{pk}", "outlet_id": outlet, "outlet_code": f"OUT{outlet}", "required_weight_kg": weight}
        for pk, outlet, weight in ((1, 1, "160"), (2, 2, "150"), (3, 3, "140"), (4, 1, "200"))
    ]}
    prices = [quote(component("PER_KM", 10, "DISTANCE"), demand_id=row["id"], outlet_id=row["outlet_id"],
                    weight_kg=row["required_weight_kg"]) for row in basis["demands"]]
    with pytest.raises(PriceInvalid, match="INDEPENDENT_BASELINE_SET_MISMATCH"):
        independent_costs(basis, prices[:-1], config())
    with pytest.raises(PriceInvalid, match="INDEPENDENT_DISTANCE_REQUIRED"):
        independent_costs(basis, prices, config())
    for row, km in zip(prices, ("12", "14", "10", "16"), strict=True):
        row["independent_distance"] = {"distance_km": km, "scope": config()["distance_basis"], "source_reference": f"test-{km}"}
    baseline = independent_costs(basis, prices, config())
    assert [row["amount"] for row in baseline] == [120, 140, 100, 160]
    assert savings(Decimal(520), Decimal(600)) == (Decimal(-80), Decimal("-15.3846"))
    assert savings(Decimal(0), Decimal(600)) == (Decimal(-600), None)
    for method, expected in (("WEIGHT", [56, 23, 22]), ("ORDER_COUNT", [51, 25, 25])):
        allocations = allocate(baseline, Decimal(101), config(method))
        assert [row["allocated_cost"] for row in allocations] == expected
        assert sum(row["allocated_cost"] for row in allocations) == 101
    cases = [{"plan": {"plan_code": key}, "status": state, "collaborative_cost": Decimal(total)}
             for key, state, total in (("a", "EVALUATED", 200), ("b", "EVALUATED", 200), ("c", "BLOCKED", 0))]
    assert recommend(cases)["plan_codes"] == ["a", "b"]
    assert cases[0]["rank"] == cases[1]["rank"] == 1 and "rank" not in cases[2]


@pytest.fixture
def published_f4(case, tmp_path):
    actor, client, _, _, _, outlets = case
    root, f3 = _freeze_f3(case)
    evaluation = F3Evaluation.objects.select_related("plan__group").get(evaluation_code=f3[0]["evaluation_code"])
    scope = _time_scope(evaluation)
    scope.update(source_mode="SYNTHETIC/UAT", f4_configuration={"version": "F4 isolated", "rules": F4_RULES, "parameters": {}})
    for row in [*scope["travel"], *scope["services"], *scope["receiving"]]:
        row["source"] = "SYNTHETIC/UAT"
    for row in scope["receiving"]:
        for window in row["windows"]:
            window["source"] = "SYNTHETIC/UAT"
            ReceivingWindow.objects.create(
                outlet_id=row["outlet_id"], source="test", source_mode="SYNTHETIC/UAT",
                source_reference=window["reference"], day_of_week=date.fromisoformat(scope["service_date"]).weekday(),
                start_time=window["start_time"], end_time=window["end_time"],
            )
    blocked = deepcopy(scope)
    blocked["receiving"][0]["slots"] = [{
        "start_time": "09:00:00", "end_time": "11:00:00", "slot_type": "BLOCKED", "status": "CONFIRMED",
        "source": "SYNTHETIC/UAT", "reference": "blocked",
    }]
    group = evaluation.plan.group
    time_file = tmp_path / "f4.json"
    time_file.write_text(json.dumps({
        "schema_version": 2, "approval_reference": "isolated approval", "run_code": str(group.run_code),
        "group_code": group.group_code, "default_scenario": "final-acceptance",
        "scopes": {"direct-on-time": scope, "direct-blocked": blocked},
        "scenarios": {"final-acceptance": {"label": "Final", "cases": ["direct-on-time"]},
                      "blocked": {"label": "Blocked", "cases": ["direct-blocked"]}},
    }), encoding="utf-8")
    with override_settings(F4_TIME_EVIDENCE_FILE=time_file, F3_UAT_HUB_COVERAGE_DATABASE=connection.settings_dict["NAME"]):
        codes = []
        for scenario, status in (("final-acceptance", "PASS"), ("blocked", "HARD_CONFLICT")):
            source = client.get(root + "preview/", {"scenario": scenario}).json()["evaluations"][0]
            assert source["status"] == status
            response = client.post(root + "evaluations/", {"evaluations": [_reference(source)], "scenario": scenario}, format="json")
            assert response.status_code == 201
            codes.append(response.json()["evaluations"][0]["evaluation_code"])
        url = root.replace("/f4/", "/f5/") + f"evaluations/{codes[0]}/preview/"
        assert client.get(url.replace(codes[0], codes[1]), {"scenario": "final-acceptance"}).status_code == 409
        assert client.get(url, {"scenario": "blocked"}).status_code == 409
        result = client.get(url, {"scenario": "final-acceptance"})
        assert result.status_code == 200, result.data
        data = result.json()
        assert data["options"][0]["lineage"]["f4_evaluation_code"] == codes[0]
        assert data["options"][0]["status"] == "NOT_EVALUATED" and data["baseline_cost"] is None
        assert data["recommendation"]["plan_codes"] == []
        assert all(row["status"] == "BLOCKED" for row in data["options"][1:])
        assert client.post(url, {}, format="json").status_code == 405
        assert client.get(url, {"fixed_quote_vnd": "1"}).status_code == 400
        row = F4Evaluation.objects.get(evaluation_code=codes[0])
        basis = row.f4_structure["inputs"]["f2"]["basis"]
        offer = row.f4_structure["result"]["waves"][0]["vehicle"]["offer_id"]
        price_file = tmp_path / "prices.json"
        price_file.write_text(json.dumps({
            "schema_version": 1, "approval_reference": "approved unit-test only", "source_mode": "SYNTHETIC/UAT",
            "run_code": str(group.run_code), "group_code": group.group_code, "scenario": "final-acceptance",
            "service_date": basis["requested_date"], "demand_basis_fingerprint": fingerprint(basis), "configuration": config(),
            "baseline": [quote(component("FIXED", 100, "TRANSPORT_BASE"), demand_id=d["id"], outlet_id=d["outlet_id"],
                               weight_kg=d["required_weight_kg"]) for d in basis["demands"]],
            "options": [{"f4_evaluation_code": codes[0], "input_fingerprint": row.input_fingerprint,
                         "configuration_fingerprint": row.configuration_fingerprint, "waves": [
                             quote(component("FIXED", 73, "TRANSPORT_BASE"), wave_no=1, offer_id=offer),
                         ]}],
        }), encoding="utf-8")
        with override_settings(F5_PRICE_EVIDENCE_FILE=price_file):
            yield actor, client, outlets, url, codes, price_file


def test_f5_exact_scenario_approved_prices_and_access(published_f4):
    actor, client, outlets, url, _, _ = published_f4
    actual = client.get(url, {"scenario": "final-acceptance"}).json()
    assert actual["options"][0]["status"] == "EVALUATED", actual
    assert Decimal(actual["options"][0]["collaborative_cost"]) == 73
    assert sum(Decimal(part["allocated_cost"]) for part in actual["options"][0]["allocations"]) == 73
    assert actual["baseline_cost"] == "200"
    assert client.get(url, {"scenario": "final-acceptance"}).json()["fingerprint"] == actual["fingerprint"]
    with override_settings(F3_UAT_HUB_COVERAGE_DATABASE=None):
        assert client.get(url, {"scenario": "final-acceptance"}).status_code == 409
    assert F4Evaluation.objects.count() == 2
    _, staff = _actor("PURCHASING_STAFF", "f5-staff-" + uuid4().hex[:8])
    assert staff.get(url).status_code == 403
    UserOutletAccess.objects.filter(user=actor, outlet_id=outlets[0]).update(is_active=False)
    assert client.get(url).status_code == 404


def _save_request(client, preview_url):
    preview = client.get(preview_url, {"scenario": "final-acceptance"}).json()
    option = preview["options"][0]
    return preview_url.split("evaluations/")[0] + "evaluations/", {
        "scenario": "final-acceptance",
        "items": [{
            "f4_evaluation_code": option["lineage"]["f4_evaluation_code"],
            "input_fingerprint": option["input_fingerprint"],
            "configuration_fingerprint": preview["configuration_fingerprint"],
        }],
    }


def test_f5_saved_snapshot_reconciles_and_does_not_change_with_prices(published_f4):
    _, client, _, preview, codes, price_file = published_f4
    root, payload = _save_request(client, preview)
    blocked = {**payload["items"][0], "f4_evaluation_code": codes[1]}
    result = client.post(root, {**payload, "items": [*payload["items"], blocked]}, format="json")
    assert result.status_code == 200, result.data
    saved, rejected = result.json()["results"]
    assert saved["outcome"] == "CREATED" and rejected["outcome"] == "REJECTED"
    assert saved["evaluation"]["f4_evaluation_code"] == codes[0]
    details = root + saved["evaluation"]["evaluation_code"] + "/"
    original = client.get(details).json()
    repeated = client.post(root, payload, format="json")
    assert repeated.status_code == 200 and repeated.json()["results"][0]["outcome"] == "EXISTS"
    row = EconomicEvaluation.objects.get()
    assert row.sealed
    assert sum(row.components.values_list("amount", flat=True)) == row.collaborative_cost == 73
    assert sum(row.demand_cost_inputs.values_list("independent_delivery_cost", flat=True)) == row.baseline_cost == 200
    assert sum(row.allocations.values_list("allocated_cost", flat=True)) == row.collaborative_cost
    assert sum(row.allocations.values_list("participant_saving", flat=True)) == row.cost_saving == 127
    with pytest.raises(DatabaseError, match="immutable"), transaction.atomic():
        EconomicEvaluation.objects.filter(pk=row.pk).update(snapshot={})
    with pytest.raises(DatabaseError, match="immutable"), transaction.atomic():
        row.components.update(amount=0)
    with pytest.raises(DatabaseError, match="immutable"), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("DELETE FROM economic_evaluations WHERE id = %s", [row.pk])
    extra = row.components.first()
    extra.pk = None
    extra.ordinal = 2
    with pytest.raises(DatabaseError, match="open evaluation"), transaction.atomic():
        extra.save(force_insert=True)

    prices = json.loads(price_file.read_text(encoding="utf-8"))
    for quote_row in prices["baseline"]:
        quote_row["components"][0]["rate_vnd"] = "0"
    prices["configuration"]["version"] = "F5 updated approval"
    price_file.write_text(json.dumps(prices), encoding="utf-8")
    assert client.post(root, payload, format="json").status_code == 409
    _, updated = _save_request(client, preview)
    created = client.post(root, updated, format="json")
    assert created.status_code == 201, created.data
    assert EconomicEvaluation.objects.count() == 2
    latest = created.json()["results"][0]["evaluation"]
    assert Decimal(latest["cost_saving"]) == -73 and latest["saving_rate_pct"] is None
    assert client.get(details).json() == original
    assert [row["evaluation_code"] for row in client.get(root).json()["evaluations"]] == [
        latest["evaluation_code"], saved["evaluation"]["evaluation_code"],
    ]


def test_f5_concurrent_save_and_outlet_access(published_f4):
    actor, client, outlets, preview, _, _ = published_f4
    root, payload = _save_request(client, preview)
    _, staff = _actor("PURCHASING_STAFF", "f5-staff-" + uuid4().hex[:8])
    assert staff.post(root, payload, format="json").status_code == 403
    assert staff.get(root).status_code == 403
    barrier = Barrier(2, timeout=20)

    def publish():
        worker = APIClient()
        worker.credentials(**client._credentials)
        try:
            barrier.wait()
            return worker.post(root, payload, format="json").status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(lambda _: publish(), range(2))) == [200, 201]
    row = EconomicEvaluation.objects.get()
    details = root + str(row.evaluation_code) + "/"
    with override_settings(F3_UAT_HUB_COVERAGE_DATABASE=None):
        assert client.post(root, payload, format="json").status_code == 409
        assert client.get(root).json()["evaluations"] == []
        assert client.get(details).status_code == 404
    UserOutletAccess.objects.filter(user=actor, outlet_id=outlets[0]).update(is_active=False)
    assert client.post(root, payload, format="json").status_code == 404
    assert client.get(root).status_code == 404
    assert client.get(details).status_code == 404


@pytest.mark.parametrize("model", [CostComponent, CostAllocation])
def test_f5_child_failure_rolls_back_every_row(published_f4, model, monkeypatch):
    _, client, _, preview, _, _ = published_f4
    root, payload = _save_request(client, preview)
    invalid = deepcopy(payload)
    invalid["items"][0]["collaborative_cost"] = "0"
    assert client.post(root, invalid, format="json").status_code == 400
    with monkeypatch.context() as broken:
        def fail(_rows):
            raise IntegrityError("injected test failure")

        broken.setattr(model.objects, "bulk_create", fail)
        response = client.post(root, payload, format="json")
    assert response.status_code == 503, response.data
    for table in (EconomicEvaluation, DemandCostInput, CostComponent, CostAllocation):
        assert not table.objects.exists()
    assert client.post(root, payload, format="json").status_code == 201
