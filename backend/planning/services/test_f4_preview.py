from datetime import time
import json
from unittest.mock import patch
from uuid import uuid4

from django.test import override_settings

from accounts.models import UserOutletAccess
from planning.models import DeliveryWave, F3Evaluation, FulfillmentPlan, WaveDemand
from planning.services.f4_preview import _configuration
from planning.services.f4_scheduling import RULES, wave_visits
from planning.services.test_f3_persistence import _actor, _coverage_rows, case
from planning.services.test_group6_postgresql import group6_database, pytestmark
from transportation.models import HubCoverageEvidence, ProviderVehicleOffer


def _counts():
    return tuple(model.objects.count() for model in (F3Evaluation, FulfillmentPlan, DeliveryWave, WaveDemand))


def test_f4_read_only_scope_blockers_and_saved_revision(case):
    actor, client, f3_path, codes, _, outlets = case
    f4_path = f3_path.replace("/f3/", "/f4/")
    saved = client.post(f3_path + "evaluations/", {"plan_codes": codes}, format="json")
    assert saved.status_code == 201
    direct, hub, _ = saved.json()["evaluations"]
    selected = f"{f4_path}evaluations/{direct['evaluation_code']}/preview/"
    blocked = f"{f4_path}evaluations/{hub['evaluation_code']}/preview/"
    before = _counts()
    first = client.get(selected)
    assert first.status_code == 200
    body = first.json()
    assert body == client.get(selected).json()
    assert body["selected_evaluation_code"] == direct["evaluation_code"]
    assert body["history_available"] is True
    result = body["evaluations"][0]
    assert result["plan"]["plan_code"] == direct["plan"]["plan_code"]
    assert result["inputs"]["f3_input_fingerprint"] == direct["input_fingerprint"]
    assert result["inputs"]["f3_configuration_fingerprint"] == direct["configuration_fingerprint"]
    assert result["status"] == "NOT_EVALUATED" and result["metrics"]["completed_at"] is None
    assert result["diagnostics"][0]["rules"] == list(RULES)
    assert result["metrics"]["not_evaluated_stops"] == 2
    assert client.get(f4_path + "preview/?timezone=UTC").status_code == 400
    assert client.get(blocked).status_code == 409
    assert client.get(f"{f4_path}evaluations/{uuid4()}/preview/").status_code == 404
    assert client.post(f4_path + "preview/", {}, format="json").status_code == 405
    _, staff = _actor("PURCHASING_STAFF", "f4-staff-" + uuid4().hex[:8])
    assert staff.get(selected).status_code == 403
    _, other = _actor("MANAGER", "f4-manager-" + uuid4().hex[:8])
    assert other.get(selected).status_code == 403
    UserOutletAccess.objects.filter(user=actor, outlet_id=outlets[0]).update(is_active=False)
    assert client.get(selected).status_code == 404
    assert _counts() == before


def _time_scope(evaluation):
    f2, f3 = evaluation.plan.f2_structure, evaluation.f3_structure
    ref = {"source": "Isolated integration test only", "reference": "pytest"}
    interval = {"start_time": "06:00:00", "end_time": "20:00:00", **ref}
    travel, services, windows = {}, {}, {}
    for wave in f3["result"]["waves"]:
        visits = wave_visits(f2, wave)
        for row in visits:
            services[row.key, row.role] = {"stop": row.key, "role": row.role, "minutes": 10, **ref}
            if row.role.startswith("HUB_"):
                windows[row.key] = {"stop": row.key, **interval}
        for left, right in zip(visits, visits[1:]):
            travel[left.key, right.key] = {
                "from_stop": left.key, "to_stop": right.key, "minutes": 15, "distance_km": "5", **ref,
            }
    return {
        "f3_evaluation_code": str(evaluation.evaluation_code), "provider_id": f3["result"]["provider"]["id"],
        "service_date": f2["basis"]["requested_date"], "timezone": "Asia/Ho_Chi_Minh",
        "travel": list(travel.values()), "services": list(services.values()), "hub_windows": list(windows.values()),
        "receiving": [
            {"outlet_id": row["outlet_id"], "windows": [interval], "slots": [], **ref}
            for row in f2["basis"]["demands"]
        ],
    }


def test_f4_approved_scoped_evidence_schedules_three_independent_options(case, tmp_path):
    _, client, f3_path, codes, window, _ = case
    rows = _coverage_rows(case, 1) + _coverage_rows(case, 2)
    HubCoverageEvidence.objects.bulk_create([HubCoverageEvidence(**row) for row in rows])
    ProviderVehicleOffer.objects.filter(pk=window.provider_vehicle_offer_id).update(
        operating_start_time=time(6), operating_end_time=time(20),
    )
    saved = client.post(f3_path + "evaluations/", {"plan_codes": codes}, format="json")
    assert saved.status_code == 201 and all(row["ready_for_f4"] for row in saved.json()["evaluations"])
    stored = list(F3Evaluation.objects.select_related("plan", "plan__group"))
    document = {"schema_version": 1, "approval_reference": "pytest", "evaluations": [_time_scope(row) for row in stored]}
    evidence_file = tmp_path / "approved-evidence.json"
    evidence_file.write_text(json.dumps(document), encoding="utf-8")
    before = _counts()
    url = f3_path.replace("/f3/", "/f4/") + "preview/"
    # The shared F3 fixture pins a RuleSet without F4 rules. Isolate the F4 contract for this test.
    def approved_configuration(run):
        return {**_configuration(run), "rules": RULES, "diagnostics": []}

    with override_settings(F4_TIME_EVIDENCE_FILE=evidence_file), patch(
        "planning.services.f4_preview._configuration", side_effect=approved_configuration,
    ):
        response = client.get(url)
        assert response.status_code == 200
        direct, north, south = response.json()["evaluations"]
        assert [row["status"] for row in (direct, north, south)] == ["PASS"] * 3
        assert [len(row["waves"]) for row in (direct, north, south)] == [1, 2, 2]
        assert all(row["metrics"]["on_time_stops"] == 2 for row in (direct, north, south))
        assert len({row["input_fingerprint"] for row in (direct, north, south)}) == 3
        assert [row["f3_evaluation_code"] for row in (direct, north, south)] == [
            row["evaluation_code"] for row in saved.json()["evaluations"]
        ]
        document["evaluations"][0]["provider_id"] += 1
        evidence_file.write_text(json.dumps(document), encoding="utf-8")
        assert client.get(url).status_code == 503
    assert _counts() == before
