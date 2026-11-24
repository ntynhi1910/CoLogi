"""Group 9.1 acceptance on a disposable PostgreSQL database."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import time, timedelta
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.exceptions import ValidationError
from django.db import DatabaseError, IntegrityError, connection, connections, transaction
from django.test import override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from accounts.models import Role, User, UserOutletAccess, UserRole
from masterdata.models import (
    CargoCategory, Hub, Item, Outlet, Supplier, SupplierItem, TransportProvider, VehicleCargoCompatibility, VehicleType,
)
from planning.f3_contract import RULES, fingerprint, rule_issues, validate_output, validate_saved_document
from planning.models import (
    DeliveryWave, F3Evaluation, FulfillmentPlan, PlanningBusinessRule, PlanningParameters, PlanningRuleSet, WaveDemand,
)
from planning.services.run_configuration import _F1_RULE_DEFINITIONS
from planning.services.f3_hub_coverage import required_routes
from planning.services.test_group6_postgresql import _confirmed_demand, group6_database, pytestmark
from transportation.hub_coverage import CoverageSource
from transportation.models import HubCoverageEvidence, ProviderAvailability, ProviderSupplierCoverage, ProviderVehicleOffer


def _actor(role_code, tag):
    role, _ = Role.objects.get_or_create(code=role_code, defaults={"name": role_code})
    actor = User.objects.create_user(email=f"{tag}@example.invalid", full_name=role_code)
    UserRole.objects.create(user=actor, role=role)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {Token.objects.create(user=actor).key}")
    return actor, client


@pytest.fixture
def case(group6_database, request):
    tag = f"f3-{uuid4().hex[:8]}"
    actor, client = _actor("MANAGER", tag)
    category, _ = CargoCategory.objects.get_or_create(pk=1, defaults={"category_code": tag, "category_name": tag})
    supplier = Supplier.objects.create(supplier_code=tag, supplier_name=tag, address="F3 test")
    item = Item.objects.create(item_code=tag, item_name=tag, cargo_category=category, weight_unit="KG")
    SupplierItem.objects.create(supplier=supplier, item=item, unit_price_vnd_per_kg=100,
                                max_daily_supply_kg=500, minimum_order_kg=1, lead_time_hours=2)
    rules = PlanningRuleSet.objects.create(
        rule_set_code=tag, rule_set_name=tag, version_no=1, status="ACTIVE", created_by=actor,
    )
    for code, (expression, kind) in _F1_RULE_DEFINITIONS.items():
        PlanningBusinessRule.objects.create(rule_set=rules, rule_code=code, module_code="F1", rule_name=code,
                                            rule_definition={"expression": expression, "rule_type": kind})
    if getattr(request, "param", True):
        for code, definition in RULES.items():
            PlanningBusinessRule.objects.create(rule_set=rules, rule_code=code, module_code="F3",
                                                rule_name=code, rule_definition=definition)
    for key, value in (("max_group_size", 4), ("max_candidates_per_run", 100)):
        PlanningParameters.objects.create(parameter_key=key, parameter_value=value, data_type="INTEGER", updated_by=actor)
    day = timezone.localdate() + timedelta(days=15)
    outlet_ids, demand_ids = [], []
    for number in (1, 2):
        code = f"{tag}-{number}"
        outlet = Outlet.objects.create(outlet_code=code, outlet_name=code, address="F3 test")
        UserOutletAccess.objects.create(user=actor, outlet=outlet)
        outlet_ids.append(outlet.pk)
        demand_ids.append(_confirmed_demand(actor, supplier, item, outlet, day, code).pk)
    reply = client.post("/api/planning/f1/runs/", {"demand_ids": demand_ids, "rule_set_id": rules.pk}, format="json")
    assert reply.status_code == 201 and reply.data["status"] == "COMPLETED"
    run_code, group_code = reply.data["run_code"], reply.data["candidate_groups"][0]["group_code"]
    prefix = f"/api/planning/f2/runs/{run_code}/groups/{group_code}/"
    hubs = [Hub.objects.create(hub_code=f"{tag}-H{i}", hub_name=f"Hub {i}", address="F3 test") for i in (1, 2)]
    codes = []
    for hub in [None, *hubs]:
        options = client.get(prefix + "options/", {"hub_id": hub.pk} if hub else {}).data["options"]
        option = options[1 if hub else 0]
        payload = {key: option[key] for key in ("template_type", "option_key")}
        if hub:
            payload["hub_id"] = hub.pk
        draft = client.post(prefix + "plans/", payload, format="json")
        assert draft.status_code == 201, draft.data
        codes.append(draft.data["plan_code"])
    provider = TransportProvider.objects.create(provider_code="TP001", provider_name=tag, provider_type="EXTERNAL",
                                                service_region="F3 test", contact_email=f"{tag}@example.invalid")
    ProviderSupplierCoverage.objects.create(provider=provider, supplier=supplier)
    vehicle = VehicleType.objects.create(vehicle_code=tag, vehicle_name=tag, capacity_kg=100)
    offer = ProviderVehicleOffer.objects.create(provider=provider, vehicle_type=vehicle, available_vehicle_count=3,
                                                fuel_type="DIESEL")
    VehicleCargoCompatibility.objects.create(vehicle_type=vehicle, cargo_category=category, is_supported=True)
    window = ProviderAvailability.objects.create(provider_vehicle_offer=offer, service_date=day, start_time=time(6),
                                                  end_time=time(20), available_vehicle_count=3,
                                                  availability_status="AVAILABLE", source_mode="PROVIDER_CONFIRMED_IMPORT")
    return actor, client, prefix.replace("/f2/", "/f3/"), codes, window, outlet_ids


def test_f3_save_atomic_concurrent_and_immutable(case):
    actor, client, prefix, codes, window, outlets = case
    url = prefix + "evaluations/"
    payload = {"plan_codes": codes}
    draft_count = FulfillmentPlan.objects.count()
    preview = client.get(prefix + "allocations/")
    assert preview.status_code == 200 and preview.data["persistence_available"]
    assert F3Evaluation.objects.count() == 0
    for evaluation, expected in zip(preview.json()["evaluations"], [1, 2, 2], strict=True):
        fleet = evaluation["presentation"]["fleet"]
        assert len(fleet["sources"]) == 1 and fleet["sources"][0]["vehicles_required"] == expected
        assert fleet["available_count"] == 3 and fleet["available_capacity_kg"] == "300.000"
        assert fleet["assigned_capacity_kg"] == f"{expected * 100}.000"
        assert fleet["remaining_assigned_capacity_kg"] == f"{expected * 80}.000"
        assert evaluation["presentation"]["rule_checks"][-1] == {"check": "RULE-15", "status": "VERIFIED"}

    with patch("planning.services.f3_persistence.evaluation_summary", side_effect=DatabaseError("late failure")):
        assert client.post(url, payload, format="json").status_code == 503
    assert F3Evaluation.objects.count() == 0
    assert client.post(url, {"plan_codes": [codes[0], codes[0]]}, format="json").status_code == 400
    assert client.post(url, {"plan_codes": [codes[0], uuid4().hex]}, format="json").status_code == 404

    barrier = Barrier(2)

    def save():
        try:
            worker = APIClient()
            worker.credentials(**client._credentials)
            barrier.wait(timeout=5)
            response = worker.post(url, payload, format="json")
            return response.status_code, response.data
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(save), pool.submit(save)]
        first, repeat = sorted((future.result(timeout=25) for future in futures), reverse=True, key=lambda pair: pair[0])
    assert (first[0], repeat[0]) == (201, 200), (first, repeat)
    assert first[1]["created_count"] == 3 and repeat[1]["created_count"] == 0
    saved = first[1]["evaluations"]
    assert repeat[1]["evaluations"] == saved
    assert [row["plan"]["plan_code"] for row in saved] == codes
    assert [row["gate_status"] for row in saved] == ["ELIGIBLE", "UNVERIFIED", "UNVERIFIED"]
    assert [row["ready_for_f4"] for row in saved] == [True, False, False]
    assert all(row["evaluated_by_id"] == actor.pk for row in saved)
    assert [row["contract_version"] for row in saved] == [1, 2, 2]
    assert F3Evaluation.objects.count() == 3
    assert list(client.get(prefix + f"plans/{codes[0]}/evaluations/").data["evaluations"]) == [saved[0]]

    details = [client.get(f"{url}{row['evaluation_code']}/").json() for row in saved]
    for preview_result, detail in zip(preview.json()["evaluations"], details, strict=True):
        assert preview_result["presentation"] == detail["presentation"]
        assert preview_result["input_fingerprint"] == detail["input_fingerprint"]
        assert preview_result["configuration_fingerprint"] == detail["configuration_fingerprint"]
    readiness = [f"{url}{row['evaluation_code']}/f4-readiness/" for row in saved]
    assert client.get(readiness[0]).json() == {
        "evaluation_code": saved[0]["evaluation_code"], "ready_for_f4": True,
    }
    assert [client.get(path).status_code for path in readiness[1:]] == [409, 409]
    assert all(detail["f3_structure"]["result"]["total_required_weight_kg"] == "20.000" for detail in details)
    assert details[0]["f3_structure"]["inputs"]["cp7"]["offers"][0]["windows"][0]["count"] == 3
    assert details[0]["f3_structure"]["configuration"]["rules"] == RULES
    for detail in details[1:]:
        waves = detail["f3_structure"]["result"]["waves"]
        assert {wave["phase"] for wave in waves} == {"INBOUND", "OUTBOUND"}
        assert all(wave["allocated_weight_kg"] == "20.000" for wave in waves)

    ProviderAvailability.objects.filter(pk=window.pk).update(available_vehicle_count=1)
    changed = client.post(url, payload, format="json")
    assert changed.status_code == 201 and changed.data["created_count"] == 3
    assert changed.data["evaluations"][1]["gate_status"] == "NOT_ELIGIBLE"
    assert changed.data["evaluations"][0]["input_fingerprint"] != saved[0]["input_fingerprint"]
    PlanningParameters.objects.create(
        parameter_key="UTILIZATION_WARNING_PCT", parameter_value="75.00", data_type="DECIMAL", updated_by=actor,
    )
    config = client.post(url, {"plan_codes": codes[:1]}, format="json")
    assert config.status_code == 201 and config.data["created_count"] == 1
    newer = config.data["evaluations"][0]
    prior = changed.data["evaluations"][0]
    assert newer["configuration_fingerprint"] != prior["configuration_fingerprint"]
    assert newer["input_fingerprint"] == prior["input_fingerprint"]
    assert client.get(f"{url}{saved[0]['evaluation_code']}/").json() == details[0]
    assert F3Evaluation.objects.count() == 7 and FulfillmentPlan.objects.count() == draft_count
    assert DeliveryWave.objects.count() == WaveDemand.objects.count() == 0

    stored = F3Evaluation.objects.get(evaluation_code=saved[0]["evaluation_code"])
    with pytest.raises(ValidationError):
        stored.delete()
    with pytest.raises(ValidationError):
        stored.save()
    for statement in ("UPDATE f3_evaluations SET contract_version=1 WHERE id=%s", "DELETE FROM f3_evaluations WHERE id=%s"):
        with pytest.raises(DatabaseError, match="immutable"), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(statement, [stored.pk])

    _check_rule_validators(stored)
    _, staff = _actor("PURCHASING_STAFF", f"f3-staff-{uuid4().hex[:8]}")
    _, other_manager = _actor("MANAGER", f"f3-other-{uuid4().hex[:8]}")
    assert staff.get(url).status_code == 403
    assert staff.get(f"{url}{saved[0]['evaluation_code']}/").status_code == 403
    assert staff.get(readiness[0]).status_code == 403
    assert staff.post(url, payload, format="json").status_code == 403
    assert other_manager.get(url).status_code == 403
    UserOutletAccess.objects.filter(user=actor, outlet_id=outlets[0]).update(is_active=False)
    assert client.get(url).status_code == 404 and client.post(url, payload, format="json").status_code == 404
    assert client.get(readiness[0]).status_code == 404


def _check_rule_validators(stored):
    f2 = stored.plan.f2_structure
    document = stored.f3_structure
    assert rule_issues(RULES) == []
    assert rule_issues({})[0]["code"] == "F3_RULE_CONFIGURATION_MISSING"
    assert rule_issues({**RULES, "RULE-13": {"expression": "load < capacity", "rule_type": "B"}})[0]["code"] == "F3_RULE_CONFIGURATION_UNSUPPORTED"
    for rule in RULES:
        result, cp7 = deepcopy(document["result"]), deepcopy(document["inputs"]["cp7"])
        first_wave = result["waves"][0]
        if rule == "RULE-13":
            first_wave["vehicle"]["capacity_kg"] = cp7["offers"][0]["capacity"] = "19.000"
        elif rule == "RULE-14":
            first_wave["allocations"][0]["weight_kg"] = "5.000"
        else:
            first_wave["utilization_pct"] = "99.00"
        with pytest.raises(ValidationError, match=rule):
            validate_output(f2, result, cp7)


@pytest.mark.parametrize("case", [False], indirect=True)
def test_missing_f3_rules_can_be_saved_but_cannot_prepare_f4(case):
    _, client, prefix, codes, _, _ = case
    saved = client.post(prefix + "evaluations/", {"plan_codes": codes}, format="json")
    assert saved.status_code == 201 and saved.data["created_count"] == 3
    for row in saved.data["evaluations"]:
        assert row["gate_status"] == "UNVERIFIED" and not row["ready_for_f4"]
        replay = client.get(prefix + f"evaluations/{row['evaluation_code']}/").data["f3_structure"]
        assert not replay["configuration"]["rules"]
        assert any(issue["code"] == "F3_RULE_CONFIGURATION_MISSING" for issue in replay["result"]["diagnostics"])


def _coverage_rows(case, option, **overrides):
    _, _, _, codes, window, _ = case
    plan = FulfillmentPlan.objects.get(plan_code=codes[option])
    rows = []
    for _, endpoint in sorted(required_routes(plan.f2_structure).items()):
        rows.append({
            "provider_id": window.provider_vehicle_offer.provider_id,
            "hub_id": plan.hub_id, "direction": endpoint["phase"],
            "supplier_id": endpoint["supplier_id"], "outlet_id": endpoint["outlet_id"],
            "confirmation_status": "CONFIRMED",
            "valid_from": window.service_date, "valid_through": window.service_date,
            "source": CoverageSource.PROVIDER_CONFIRMED_IMPORT,
            "source_reference": "F3 test confirmation",
            **overrides,
        })
    return rows


def test_hub_evidence_is_pinned_independently_and_overlapping_revocations_win(case):
    _, client, prefix, codes, window, _ = case
    hub_one = _coverage_rows(case, 1)
    hub_two = _coverage_rows(case, 2)
    HubCoverageEvidence.objects.bulk_create([HubCoverageEvidence(**row) for row in (*hub_one, *hub_two)])
    url = prefix + "evaluations/"
    saved = client.post(url, {"plan_codes": codes}, format="json")
    assert saved.status_code == 201 and saved.data["created_count"] == 3
    direct, first_hub, second_hub = saved.data["evaluations"]
    assert all(e["ready_for_f4"] and e["gate_status"] == "ELIGIBLE" for e in saved.data["evaluations"])
    first_url = f"{url}{first_hub['evaluation_code']}/"
    detail = client.get(first_url).json()
    result = detail["f3_structure"]["result"]
    assert result["hub_coverage"]["status"] == "VERIFIED" and not result["hub_coverage"]["uses_synthetic"]
    assert [item["phase"] for item in result["hub_coverage"]["routes"]] == ["INBOUND", "OUTBOUND", "OUTBOUND"]
    assert [wave["allocated_weight_kg"] for wave in result["waves"]] == ["20.000", "20.000"]

    plan = FulfillmentPlan.objects.get(plan_code=codes[1])
    rewritten = deepcopy(detail["f3_structure"])
    rewritten["inputs"]["cp7"]["hub_coverage"]["records"][0]["hub_id"] = hub_two[0]["hub_id"]
    with pytest.raises(ValidationError, match="exact route"):
        validate_saved_document(
            plan.f2_structure, rewritten, fingerprint(rewritten["inputs"]), fingerprint(rewritten["configuration"]),
            contract_version=2,
        )

    HubCoverageEvidence.objects.create(**(hub_one[0] | {
        "confirmation_status": "REVOKED",
        "valid_from": window.service_date - timedelta(days=1), "source_reference": "Withdrawal of test confirmation",
    }))
    revised = client.post(url, {"plan_codes": codes}, format="json")
    assert revised.status_code == 201 and revised.data["created_count"] == 1
    assert revised.data["evaluations"][0] == direct and revised.data["evaluations"][2] == second_hub
    revision = revised.data["evaluations"][1]
    assert revision["gate_status"] == "UNVERIFIED" and not revision["ready_for_f4"]
    assert revision["input_fingerprint"] != first_hub["input_fingerprint"]
    failure = client.get(f"{url}{revision['evaluation_code']}/").json()["f3_structure"]["result"]
    assert failure["diagnostics"] == [{
        "code": "HUB_SERVICE_SCOPE_UNVERIFIED", "phase": "INBOUND", "hub_id": plan.hub_id,
        "supplier_id": hub_one[0]["supplier_id"], "outlet_id": None, "reason": "NOT_CONFIRMED",
    }]
    assert client.get(first_url).json() == detail
    repeated = client.post(url, {"plan_codes": codes}, format="json")
    assert repeated.status_code == 200 and repeated.data["created_count"] == 0
    assert repeated.data["evaluations"] == revised.data["evaluations"]


def test_hub_requires_every_exact_endpoint_provider_direction_and_effective_date(case):
    _, client, prefix, _, window, outlets = case
    inbound, first_outbound, missing_outbound = _coverage_rows(case, 1)
    second_hub = _coverage_rows(case, 2)
    other = TransportProvider.objects.create(
        provider_code="TP002", provider_name="Other", provider_type="EXTERNAL", service_region="F3 test",
        contact_email="other@example.invalid",
    )
    wrong_supplier = Supplier.objects.create(supplier_code="OTHER", supplier_name="Other", address="F3 test")
    wrong_outlet = Outlet.objects.create(outlet_code="OTHER", outlet_name="Other", address="F3 test")
    candidates = (
        first_outbound, *second_hub,
        inbound | {"supplier_id": wrong_supplier.pk},
        inbound | {"provider_id": other.pk},
        inbound | {"direction": "OUTBOUND", "supplier_id": None, "outlet_id": first_outbound["outlet_id"],
                   "source_reference": "Wrong direction for the missing inbound route"},
        missing_outbound | {"outlet_id": wrong_outlet.pk},
        missing_outbound | {"provider_id": other.pk},
        missing_outbound | {"valid_from": window.service_date - timedelta(days=1),
                            "valid_through": window.service_date - timedelta(days=1)},
        # Avoid creating a duplicate of the independent Hub's matching grant.
        missing_outbound | {"hub_id": second_hub[0]["hub_id"], "source_reference": "Other Hub"},
    )
    HubCoverageEvidence.objects.bulk_create([HubCoverageEvidence(**row) for row in candidates])
    _, hub_one, hub_two = client.get(prefix + "allocations/").json()["evaluations"]
    assert hub_one["gate_status"] == "UNVERIFIED" and hub_two["gate_status"] == "ELIGIBLE"
    assert [item["status"] for item in hub_one["hub_coverage"]["routes"]] == ["UNVERIFIED", "VERIFIED", "UNVERIFIED"]
    assert [(row["phase"], row["supplier_id"], row["outlet_id"], row["reason"])
            for row in hub_one["diagnostics"]] == [
        ("INBOUND", inbound["supplier_id"], None, "NO_EFFECTIVE_EVIDENCE"),
        ("OUTBOUND", None, outlets[1], "NO_EFFECTIVE_EVIDENCE"),
    ]
    HubCoverageEvidence.objects.create(**inbound)
    after = client.get(prefix + "allocations/").json()["evaluations"][1]
    assert after["gate_status"] == "UNVERIFIED" and len(after["diagnostics"]) == 1
    assert after["diagnostics"][0]["outlet_id"] == outlets[1]


def test_hub_synthetic_evidence_is_limited_to_server_uat_and_candidate(case):
    _, client, prefix, codes, _, _ = case
    candidate = prefix.split("/")[-2]
    synthetic = {"source": CoverageSource.SYNTHETIC_UAT, "uat_candidate_code": candidate}
    hub_one = _coverage_rows(case, 1, **synthetic)
    hub_two = _coverage_rows(case, 2, **(synthetic | {"uat_candidate_code": uuid4().hex}))
    HubCoverageEvidence.objects.bulk_create([HubCoverageEvidence(**row) for row in (*hub_one, *hub_two)])
    url = prefix + "evaluations/"
    assert client.get(prefix + "allocations/?context=UAT").status_code == 400
    assert client.post(url, {"plan_codes": codes, "context": "UAT"}, format="json").status_code == 400
    preview = client.get(prefix + "allocations/").json()["evaluations"]
    assert [row["gate_status"] for row in preview] == ["ELIGIBLE", "UNVERIFIED", "UNVERIFIED"]
    assert not any(row["hub_coverage"]["uses_synthetic"] for row in preview[1:])

    with override_settings(F3_UAT_HUB_COVERAGE_DATABASE=connection.settings_dict["NAME"]):
        saved = client.post(url, {"plan_codes": codes}, format="json")
        assert saved.status_code == 201
        _, first_hub, second_hub = saved.data["evaluations"]
        assert first_hub["ready_for_f4"] and not second_hub["ready_for_f4"]
        detail_url = f"{url}{first_hub['evaluation_code']}/"
        detail = client.get(detail_url).json()
        assert client.get(detail_url + "f4-readiness/").status_code == 200
        assert detail["f3_structure"]["inputs"]["cp7"]["hub_coverage"]["context"] == "UAT"
        assert detail["f3_structure"]["result"]["hub_coverage"]["uses_synthetic"]
        HubCoverageEvidence.objects.create(**(hub_one[0] | {
            "source": CoverageSource.PROVIDER_PORTAL, "uat_candidate_code": "", "confirmation_status": "PENDING",
        }))
        pending = client.get(prefix + "allocations/").json()["evaluations"][1]
        assert pending["gate_status"] == "UNVERIFIED"
        assert pending["hub_coverage"]["routes"][0]["evidence"]["source"] == CoverageSource.PROVIDER_PORTAL
    operational = client.get(detail_url).json()
    assert operational["f3_structure"] == detail["f3_structure"] and not operational["ready_for_f4"]
    assert client.get(detail_url + "f4-readiness/").status_code == 409


def test_f3_parameter_roles_and_invalid_contract_configuration(case):
    actor, client, prefix, _, _, _ = case
    path = prefix + "allocations/"
    first = client.get(path).json()["evaluations"][0]
    assert first["gate_status"] == "ELIGIBLE"
    parameters = {item["key"]: item for item in first["presentation"]["parameters"]}
    assert parameters["TIMEZONE"]["value"] == "Asia/Ho_Chi_Minh" and not parameters["TIMEZONE"]["configured"]
    assert parameters["WEIGHT_UNIT"]["value"] == "KG" and not parameters["WEIGHT_UNIT"]["configured"]
    assert parameters["UTILIZATION_WARNING_PCT"]["value"] is None
    PlanningParameters.objects.create(
        parameter_key="UTILIZATION_WARNING_PCT", parameter_value="50.0", data_type="DECIMAL", updated_by=actor,
    )
    warning = client.get(path).json()["evaluations"][0]
    assert warning["gate_status"] == "ELIGIBLE"
    assert any(item["code"] == "LOW_UTILIZATION" for item in warning["diagnostics"])
    PlanningParameters.objects.create(parameter_key="WEIGHT_UNIT", parameter_value="LB", data_type="STRING", updated_by=actor)
    invalid = client.get(path).json()["evaluations"][0]
    assert invalid["gate_status"] == "UNVERIFIED"
    assert {"code": "F3_PARAMETER_INVALID", "values": ["WEIGHT_UNIT"]} in invalid["diagnostics"]


def test_hub_evidence_database_constraints(case, subtests):
    inbound, outbound, _ = _coverage_rows(case, 1)
    HubCoverageEvidence.objects.create(**inbound)
    HubCoverageEvidence.objects.create(**outbound)
    invalid = {
        "duplicate inbound with null outlet": inbound,
        "duplicate outbound with null supplier": outbound,
        "missing supplier": inbound | {"supplier_id": None},
        "missing outlet": outbound | {"outlet_id": None},
        "two endpoints": inbound | {"outlet_id": outbound["outlet_id"]},
        "wrong direction": inbound | {"direction": "OUTBOUND"},
        "bad period": inbound | {"valid_from": inbound["valid_through"] + timedelta(days=1)},
        "bad confirmation": inbound | {"confirmation_status": "ACTIVE"},
        "synthetic without candidate": inbound | {"source": CoverageSource.SYNTHETIC_UAT},
        "operational with candidate": inbound | {"uat_candidate_code": uuid4().hex},
        "empty reference": inbound | {"source_reference": "  "},
        "missing provider FK": inbound | {"provider_id": 2**62},
        "missing Hub FK": inbound | {"hub_id": 2**62},
        "missing Supplier FK": inbound | {"supplier_id": 2**62},
        "missing Outlet FK": outbound | {"outlet_id": 2**62},
    }
    for label, row in invalid.items():
        with subtests.test(label), pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
            HubCoverageEvidence.objects.create(**row)
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
    assert HubCoverageEvidence.objects.count() == 2
