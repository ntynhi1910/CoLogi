from datetime import date, time
from copy import deepcopy
import json

import pytest
from django.db import IntegrityError, connection, transaction
from django.test import override_settings

from planning.models import F3Evaluation, F4Evaluation, ReceivingSlot, ReceivingWindow
from planning.services.f4_evidence import read_receiving_calendars
from planning.services.f4_scheduling import RULES
from planning.services.test_f3_persistence import case
from planning.services.test_f4_persistence import _freeze_f3, _reference
from planning.services.test_f4_preview import _time_scope
from planning.services.test_group6_postgresql import group6_database, pytestmark


def test_operational_receiving_rows_do_not_attest_calendar_completeness(case, subtests):
    _, _, _, _, availability, outlets = case
    day = availability.service_date
    common = {"outlet_id": outlets[0], "source": "test", "source_reference": "window-1", "source_mode": "OPERATIONAL",
              "start_time": time(8), "end_time": time(10)}
    window = ReceivingWindow.objects.create(day_of_week=day.weekday(), **common)
    slot = ReceivingSlot.objects.create(slot_date=day, slot_type="BLOCKED", status="CONFIRMED", **common)
    calendar, empty = read_receiving_calendars(day, outlets, None)
    assert not calendar["slot_calendar_confirmed"] and calendar["slots"] is None
    assert len(calendar["observed_slots"]) == 1 and not empty["observed_slots"]
    assert calendar["windows"][0]["reference"] == common["source_reference"]
    declaration = {"receiving": [{"outlet_id": window.outlet_id, "windows": [], "slots": [],
                                 "source": "test approval", "reference": "full-day"}]}
    actual = read_receiving_calendars(day, [window.outlet_id], declaration)[0]
    assert actual["slot_calendar_confirmed"] and actual["slots"][0]["status"] == slot.status
    invalid = {
        "weekday": (ReceivingWindow, {"day_of_week": 7, **common}),
        "range": (ReceivingWindow, {"day_of_week": 0, **(common | {"end_time": time(8)})}),
        "duplicate": (ReceivingWindow, {"day_of_week": day.weekday(), **common}),
        "status": (ReceivingSlot, {"slot_date": day, "slot_type": "BLOCKED", "status": "INVALID", **common}),
        "provenance": (ReceivingWindow, {"day_of_week": 0, **(common | {"source_reference": ""})}),
    }
    for label, (model, data) in invalid.items():
        with subtests.test(label), pytest.raises(IntegrityError), transaction.atomic():
            model.objects.create(**data)


def test_scenarios_verify_v7_windows_and_keep_same_f3_histories_independent(case, tmp_path):
    _, client, _, _, _, _ = case
    root, sources = _freeze_f3(case)
    evaluation = F3Evaluation.objects.select_related("plan", "plan__group").get(evaluation_code=sources[0]["evaluation_code"])
    scope = _time_scope(evaluation)
    scope["source_mode"] = "SYNTHETIC/UAT"
    scope["f4_configuration"] = {
        "version": "V7-test", "rules": RULES,
        "parameters": {"SERVICE_DURATION_MINUTES": {"value": 30, "data_type": "INTEGER"},
                       "ALTERNATE_SLOT_SEARCH": {"value": "AFTER_ORIGINAL", "data_type": "STRING"}},
    }
    for row in [*scope["travel"], *scope["services"]]:
        row["source"] = "SYNTHETIC/UAT"
    for row in scope["receiving"]:
        row["source"] = "SYNTHETIC/UAT"
        row["windows"] = [{**period, "source": "SYNTHETIC/UAT"} for period in row["windows"]]
        for period in row["windows"]:
            ReceivingWindow.objects.create(
                outlet_id=row["outlet_id"], source="Dataset V7 test", source_mode="SYNTHETIC/UAT",
                source_reference=period["reference"], day_of_week=date.fromisoformat(scope["service_date"]).weekday(),
                start_time=period["start_time"], end_time=period["end_time"],
            )
    blocked = deepcopy(scope)
    blocked["approval_reference"] = "separate scenario approval"
    blocked["receiving"][0]["slots"] = [{
        "start_time": "09:00:00", "end_time": "11:00:00", "slot_type": "BLOCKED",
        "status": "CONFIRMED", "source": "SYNTHETIC/UAT", "reference": "blocked test",
    }]
    group = evaluation.plan.group
    registry = {
        "schema_version": 2, "approval_reference": "isolated pytest", "run_code": str(group.run_code),
        "group_code": group.group_code, "default_scenario": "direct",
        "scopes": {"direct-on-time": scope, "direct-blocked": blocked},
        "scenarios": {"direct": {"label": "Direct", "cases": ["direct-on-time"]},
                      "final": {"label": "Newest comparison", "cases": ["direct-on-time"]},
                      "blocked": {"label": "Blocked", "cases": ["direct-blocked"]}},
    }
    path = tmp_path / "scenarios.json"
    path.write_text(json.dumps(registry), encoding="utf-8")
    preview, save = root + "preview/", root + "evaluations/"
    with override_settings(F4_TIME_EVIDENCE_FILE=path):
        assert client.get(preview + "?scenario=blocked").status_code == 404
        assert client.get(preview).json()["scenarios"] == []
        with override_settings(F3_UAT_HUB_COVERAGE_DATABASE=connection.settings_dict["NAME"]):
            first = client.get(preview).json()["evaluations"][0]
            assert first["status"] == "PASS" and first["scenario_id"] == "direct-on-time"
            assert client.get(preview + "?scenario=blocked&scenario=direct").status_code == 400
            second = client.get(preview + "?scenario=blocked").json()["evaluations"][0]
            assert second["status"] == "HARD_CONFLICT" and second["scenario_id"] == "direct-blocked"
            assert first["input_fingerprint"] != second["input_fingerprint"]
            assert first["configuration_fingerprint"] != second["configuration_fingerprint"]
            assert first["inputs"]["time_evidence"]["approval_reference"] == "isolated pytest"
            assert second["inputs"]["time_evidence"]["approval_reference"] == "separate scenario approval"
            assert second["configuration"]["approval_reference"] == "separate scenario approval"
            for row, scenario in [(first, "direct"), (second, "blocked")]:
                response = client.post(save, {"evaluations": [_reference(row)], "scenario": scenario}, format="json")
                assert response.status_code == 201
            assert client.post(save, {"evaluations": [_reference(second)], "scenario": "direct"}, format="json").status_code == 404
            registry["default_scenario"] = "final"
            path.write_text(json.dumps(registry), encoding="utf-8")
            assert client.get(preview).json()["evaluations"][0] == first
            assert client.post(save, {"evaluations": [_reference(first)], "scenario": "final"}, format="json").status_code == 200
            archived = client.get(save).json()["evaluations"]
            assert len(archived) == F4Evaluation.objects.count() == 2 and ReceivingSlot.objects.count() == 0
            assert {row["scenario_id"] for row in archived} == {"direct-on-time", "direct-blocked"}
            assert sum(row["ready_for_f5"] for row in archived) == 1
            ReceivingWindow.objects.first().delete()
            assert client.get(preview).json()["evaluations"][0]["status"] == "NOT_EVALUATED"
