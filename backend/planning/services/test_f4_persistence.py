from concurrent.futures import ThreadPoolExecutor
from datetime import time
import json
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.exceptions import ValidationError
from django.db import DatabaseError, connection, connections, transaction
from django.test import override_settings
from rest_framework.test import APIClient

from accounts.models import UserOutletAccess
from planning.f3_contract import fingerprint
from planning.models import F3Evaluation, F4Evaluation, PlanningBusinessRule
from planning.services.f4_scheduling import RULES
from planning.services.test_f3_persistence import _actor, _coverage_rows, case
from planning.services.test_f4_preview import _time_scope
from planning.services.test_group6_postgresql import group6_database, pytestmark
from transportation.models import HubCoverageEvidence, ProviderVehicleOffer


def _reference(row):
    return {key: row[key] for key in ("f3_evaluation_code", "input_fingerprint", "configuration_fingerprint")}


def _freeze_f3(case, cover_hubs=False):
    _, client, f3_path, codes, window, _ = case
    ProviderVehicleOffer.objects.filter(pk=window.provider_vehicle_offer_id).update(
        operating_start_time=time(6), operating_end_time=time(20),
    )
    if cover_hubs:
        coverage = _coverage_rows(case, 1) + _coverage_rows(case, 2)
        HubCoverageEvidence.objects.bulk_create([HubCoverageEvidence(**row) for row in coverage])
    response = client.post(f3_path + "evaluations/", {"plan_codes": codes}, format="json")
    assert response.status_code == 201
    return f3_path.replace("/f3/", "/f4/"), response.json()["evaluations"]


def test_f4_immutable_blocker_batch_atomic_retry_and_permissions(case):
    actor, client, _, _, _, outlets = case
    root, sources = _freeze_f3(case, cover_hubs=True)
    url = root + "evaluations/"
    options = client.get(root + "preview/").json()["evaluations"]
    references = [_reference(row) for row in options]
    payload = {"evaluations": references}
    assert client.get(url).json() == {"evaluations": []}
    assert client.post(url, {"evaluations": [references[0], references[0]]}, format="json").status_code == 400
    assert client.post(url, {"evaluations": [references[0] | {"minutes": 15}]}, format="json").status_code == 400
    stale = dict(references[2], input_fingerprint="0" * 64)
    assert client.post(url, {"evaluations": [*references[:2], stale]}, format="json").status_code == 409
    assert F4Evaluation.objects.count() == 0
    with patch("planning.services.f4_persistence._summary", side_effect=DatabaseError("forced late error")):
        assert client.post(url, payload, format="json").status_code == 503
    assert F4Evaluation.objects.count() == 0

    barrier = Barrier(2)

    def save():
        try:
            worker = APIClient()
            worker.credentials(**client._credentials)
            barrier.wait(timeout=5)
            return worker.post(url, payload, format="json")
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(save) for _ in range(2)]
        outcomes = sorted((future.result(timeout=20) for future in futures), key=lambda row: row.status_code)
    assert [row.status_code for row in outcomes] == [200, 201]
    assert [row.json()["created_count"] for row in outcomes] == [0, 3]
    rows = outcomes[1].json()["evaluations"]
    assert rows == outcomes[0].json()["evaluations"]
    assert [row["f3_evaluation_code"] for row in rows] == [row["evaluation_code"] for row in sources]
    assert all(row["status"] == "NOT_EVALUATED" and not row["ready_for_f5"] for row in rows)
    assert F4Evaluation.objects.count() == 3 and F3Evaluation.objects.count() == 3
    detail = f"{url}{rows[0]['evaluation_code']}/"
    assert client.get(detail + "f5-readiness/").status_code == 409
    pinned = client.get(detail).json()
    assert pinned["lineage"]["f2_revision"] == 1 and pinned["lineage"]["f3_evaluation_code"] == sources[0]["evaluation_code"]
    stored = F4Evaluation.objects.get(evaluation_code=rows[0]["evaluation_code"])
    assert stored.input_fingerprint == fingerprint(stored.f4_structure["inputs"])
    assert stored.f4_structure["inputs"]["f2"] == stored.f3_evaluation.plan.f2_structure
    assert stored.f4_structure["inputs"]["f3"] == stored.f3_evaluation.f3_structure
    with pytest.raises(ValidationError):
        stored.save()
    with pytest.raises(ValidationError):
        stored.delete()
    for sql in ("UPDATE f4_evaluations SET contract_version=1 WHERE id=%s", "DELETE FROM f4_evaluations WHERE id=%s"):
        with pytest.raises(DatabaseError, match="immutable"), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(sql, [stored.pk])
    assert client.get(detail).json() == pinned
    _, staff = _actor("PURCHASING_STAFF", "f4-save-staff-" + uuid4().hex[:8])
    assert staff.get(detail).status_code == staff.post(url, payload, format="json").status_code == 403
    UserOutletAccess.objects.filter(user=actor, outlet_id=outlets[0]).update(is_active=False)
    assert client.get(detail).status_code == client.post(url, payload, format="json").status_code == 404


def test_f4_selective_history_fingerprints_and_synthetic_f5_guard(case, tmp_path):
    _, client, _, _, _, _ = case
    root, sources = _freeze_f3(case)
    evaluation = F3Evaluation.objects.get(evaluation_code=sources[0]["evaluation_code"])
    original_rules = list(PlanningBusinessRule.objects.order_by("pk").values())
    scope = _time_scope(evaluation)
    scope.update(source_mode="SYNTHETIC/UAT", f4_configuration={"version": "V7-TEST-1", "rules": RULES, "parameters": {}})
    document = {"schema_version": 1, "approval_reference": "isolated-test", "evaluations": [scope]}
    path = tmp_path / "approved-synthetic.json"
    preview, url = root + "preview/", root + "evaluations/"

    def write():
        path.write_text(json.dumps(document), encoding="utf-8")

    def get():
        result = client.get(preview)
        assert result.status_code == 200
        return result.json()["evaluations"][0]

    def save(ref):
        result = client.post(url, {"evaluations": [ref]}, format="json")
        assert result.status_code == 201
        return result.json()["evaluations"][0]

    write()
    with override_settings(F4_TIME_EVIDENCE_FILE=path):
        assert get()["source_mode"] == "UNAVAILABLE"
        with override_settings(F3_UAT_HUB_COVERAGE_DATABASE=connection.settings_dict["NAME"]):
            first = get()
            assert first["status"] == "PASS"
            assert first["configuration"]["scope"] == "F4_STAGE"
            saved = save(_reference(first))
            assert saved["evaluation_context"] == "UAT" and saved["ready_for_f5"]
            detail = f"{url}{saved['evaluation_code']}/"
            original = client.get(detail).json()
            assert client.get(detail + "f5-readiness/").status_code == 200
            scope["f4_configuration"]["version"] = "V7-TEST-2"
            write()
            second = get()
            assert second["input_fingerprint"] == first["input_fingerprint"]
            assert second["configuration_fingerprint"] != first["configuration_fingerprint"]
            retry = client.post(url, {"evaluations": [_reference(first)]}, format="json")
            assert retry.status_code == 200 and retry.json()["evaluations"] == [saved]
            save(_reference(second))
            scope["receiving"][0]["slots"] = [{
                **scope["receiving"][0]["windows"][0], "slot_type": "BLOCKED", "status": "CONFIRMED",
                "source": "SYNTHETIC/UAT",
            }]
            write()
            third = get()
            assert third["configuration_fingerprint"] == second["configuration_fingerprint"]
            assert third["input_fingerprint"] != second["input_fingerprint"]
            assert third["status"] == "HARD_CONFLICT"
            blocked = save(_reference(third))
            assert not blocked["ready_for_f5"]
            scope["receiving"][0]["slots"][0]["status"] = "RESERVED"
            write()
            soft = get()
            assert soft["status"] == "SOFT_CONFLICT" and soft["complete"]
            assert not save(_reference(soft))["ready_for_f5"]
            assert client.get(detail).json() == original
        assert client.get(detail + "f5-readiness/").status_code == 409
        assert client.get(detail).json()["result"]["evaluation_context"] == "UAT"
    assert list(PlanningBusinessRule.objects.order_by("pk").values()) == original_rules
