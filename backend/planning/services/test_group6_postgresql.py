"""Opt-in F1 acceptance on a disposable Django PostgreSQL test database."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import time, timedelta
from decimal import Decimal
from ipaddress import ip_address
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.exceptions import ValidationError
from django.db import DatabaseError, IntegrityError, connection, connections, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from accounts.models import AuditLog, Role, User, UserOutletAccess, UserRole
from demands.models import DeliveryDemand, DemandSourcingOption, SupplierConfirmation, SupplierItemPromise, SupplierRequest
from demands.services import create_draft_demand, submit_demand
from masterdata.models import (
    CargoCategory, Hub, Item, Outlet, Supplier, SupplierItem, TransportProvider, VehicleCargoCompatibility, VehicleType,
)
from planning.models import (
    CollaborationGroup, DeliveryWave, FulfillmentPlan, GroupDemand, PlanningBusinessRule, PlanningParameters,
    PlanningRuleSet, PlanningRun, PlanningRunDemand, WaveDemand,
)
from planning.services.f3_preview import RULES as F3_RULES
from planning.services.plan_persistence import create_draft_plan
from planning.services.run_configuration import _F1_RULE_DEFINITIONS, create_rule_set_version
from planning.services.run_execution import _evaluate_for_execution
from suppliers.services import respond_to_supplier_request
from transportation.models import ProviderAvailability, ProviderSupplierCoverage, ProviderVehicleOffer


pytestmark = pytest.mark.skipif(
    os.environ.get("COLOGI_GROUP6_TESTS") != "1", reason="Enable the PostgreSQL Golden Scenario explicitly",
)


@pytest.fixture
def group6_database(transactional_db):
    target = connection.settings_dict["NAME"]
    assert connection.vendor == "postgresql" and target.startswith("test_")
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database(), inet_server_addr()::text, current_schema()")
        name, address, schema = cursor.fetchone()
    assert name == target and ip_address(address.split("/")[0]).is_loopback and schema == "public"
    executor = MigrationExecutor(connection)
    graph = executor.loader.graph
    targets = graph.leaf_nodes("planning") + graph.leaf_nodes("accounts") + graph.leaf_nodes("authtoken")
    targets.append(("transportation", "0001_initial"))
    required = {node for target in targets for node in graph.forwards_plan(target)}
    missing = required - executor.loader.applied_migrations.keys()
    assert not missing, f"Test prerequisites are missing: {sorted(missing)}"
    return MigrationLoader(None).project_state().apps


def _cleanup(historical_apps, actor, tag, created_role_id, created_category):
    historical = lambda name: historical_apps.get_model("planning", name)
    with transaction.atomic():
        plans = historical("FulfillmentPlan").objects.filter(created_by_id=actor.pk)
        historical("WaveDemand").objects.filter(wave__plan__in=plans).delete()
        historical("DeliveryWave").objects.filter(plan__in=plans).delete()
        # Revisions reference their predecessors through PROTECT.
        for plan in plans.order_by("-pk"):
            plan.delete()
        Hub.objects.filter(hub_code__in=[
            f"{tag}-f2", f"{tag}-f2-alt", f"{tag}-legacy-a", f"{tag}-legacy-b",
        ]).delete()
        runs = PlanningRun.objects.filter(initiated_by=actor)
        groups = CollaborationGroup.objects.filter(created_by=actor)
        GroupDemand.objects.filter(group__in=groups).delete()
        groups.delete()
        PlanningRunDemand.objects.filter(planning_run__in=runs).delete()
        runs.delete()
        rule_sets = historical("PlanningRuleSet").objects.filter(created_by_id=actor.pk)
        historical("PlanningBusinessRule").objects.filter(rule_set__in=rule_sets).delete()
        rule_sets.delete()
        PlanningParameters.objects.filter(updated_by=actor).delete()
        demands = DeliveryDemand.objects.filter(created_by=actor)
        SupplierItemPromise.objects.filter(supplier_request__demand__in=demands).delete()
        SupplierRequest.objects.filter(demand__in=demands).delete()
        SupplierConfirmation.objects.filter(demand__in=demands).delete()
        demands.delete()
        SupplierItem.objects.filter(item__item_code=tag).delete()
        Item.objects.filter(item_code=tag).delete()
        VehicleType.objects.filter(vehicle_code=tag).delete()
        UserOutletAccess.objects.filter(user=actor).delete()
        Outlet.objects.filter(outlet_code__startswith=f"{tag}-").delete()
        Supplier.objects.filter(supplier_code=tag).delete()
        AuditLog.objects.filter(actor_user=actor).delete()
        UserRole.objects.filter(user=actor).delete()
        Token.objects.filter(user=actor).delete()
        # Remove only this actor without Django traversing unrelated app tables.
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM public.users WHERE id = %s AND email = %s", [actor.pk, actor.email])
        if created_role_id is not None:
            Role.objects.filter(pk=created_role_id).delete()
        if created_category:
            CargoCategory.objects.filter(pk=1, category_code=tag).delete()


def _confirmed_demand(actor, supplier, item, outlet, delivery_day, code):
    demand = create_draft_demand(
        demand_code=code, supplier_id=supplier.pk, outlet_id=outlet.pk, created_by=actor,
        requested_date=delivery_day, requested_start_time=time(9), requested_end_time=time(11),
        items=[{"item_id": item.pk, "required_weight_kg": "10", "unit_of_measure": "KG"}],
    )
    request = submit_demand(demand_id=demand.pk, submitted_by=actor)
    respond_to_supplier_request(
        request_id=request.pk, supplier_id=supplier.pk, actor=actor,
        response_data={
            "ready_date": delivery_day, "ready_start_time": time(7), "ready_end_time": time(9),
            "items": [{"promise_id": request.item_promises.get().pk, "confirmed_weight_kg": Decimal("10")}],
        },
    )
    return demand


def _check_f2_preview(client, matched, demand_ids, tag):
    group_code = matched["candidate_groups"][0]["group_code"]
    url = f"/api/planning/f2/runs/{matched['run_code']}/groups/{group_code}/options/"
    hubs_url = "/api/planning/f2/hubs/"
    hub = Hub.objects.create(hub_code=tag, hub_name=tag, address="Địa chỉ Hub kiểm thử")
    try:
        assert APIClient().get(url).status_code == 401
        assert client.get(hubs_url).data[0]["id"] == hub.pk
        assert client.get(f"{url}?hub_id={hub.pk}&hub_id={hub.pk}").status_code == 400
        assert client.get(f"{url}?demand_ids=99").status_code == 400
        assert client.post(url, {"hub_id": hub.pk}, format="json").status_code == 405
        plan_count = FulfillmentPlan.objects.count()
        response = client.get(url, {"hub_id": hub.pk})
        assert response.status_code == 200, response.data
        assert client.get(url, {"hub_id": hub.pk}).data == response.data
        assert response.data["lineage"]["group_code"] == group_code
        assert response.data["lineage"]["run_code"] == matched["run_code"]
        assert response.data["persistence"] == "AVAILABLE"
        assert response.data["saved_plans"] == []
        for option in response.data["options"]:
            assert option["demand_ids"] == demand_ids[:2]
            assert option["total_required_weight_kg"] == "20.000"
            assert option["status"] == "DRAFT" and option["structural_status"] == "COMPLETE"
            assert not option["ready_for_f3"]
        assert FulfillmentPlan.objects.count() == plan_count

        DeliveryDemand.objects.filter(pk=demand_ids[0]).update(requested_date=timezone.localdate())
        try:
            assert client.get(url, {"hub_id": hub.pk}).data == response.data
        finally:
            DeliveryDemand.objects.filter(pk=demand_ids[0]).update(requested_date=response.data["basis"]["requested_date"])

        assert client.get(url, {"hub_id": hub.pk + 10_000}).data["options"][1]["diagnostics"][0]["code"] == "HUB_NOT_FOUND"
        Hub.objects.filter(pk=hub.pk).update(is_active=False)
        assert client.get(hubs_url).data == []
        assert client.get(url, {"hub_id": hub.pk}).data["options"][1]["diagnostics"][0]["code"] == "HUB_INACTIVE"
        with patch("planning.services.f2_preview._usable_hubs", side_effect=DatabaseError("Hub unavailable")):
            assert client.get(hubs_url).status_code == 503
            direct, indirect = client.get(url).data["options"]
            assert direct["structural_status"] == "COMPLETE"
            assert indirect["diagnostics"][0]["code"] == "HUB_SOURCE_UNAVAILABLE"
        with patch("planning.services.f2_preview.read_run_snapshots", side_effect=ValidationError("incomplete")):
            incomplete = client.get(url).data
            assert incomplete["basis"]["demand_ids"] == demand_ids[:2]
            assert all(option["structural_status"] == "INCOMPLETE" and not option["legs"] for option in incomplete["options"])

        CollaborationGroup.objects.filter(group_code=group_code).update(status="ACCEPTED")
        try:
            assert client.get(url).status_code == 409
        finally:
            CollaborationGroup.objects.filter(group_code=group_code).update(status="CANDIDATE")
    finally:
        hub.delete()
    return url


def _concurrent_f2_save(client, plans_url, body):
    barrier = Barrier(2)

    def save():
        worker = APIClient()
        worker.credentials(**client._credentials)
        try:
            barrier.wait(timeout=5)
            reply = worker.post(plans_url, body, format="json")
            return reply.status_code, reply.data
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(save), pool.submit(save)]
        attempts = sorted((future.result(timeout=20) for future in futures), key=lambda result: result[0])
    assert [status for status, _ in attempts] == [200, 201], attempts
    assert attempts[0][1] == attempts[1][1]
    return attempts[1][1]


def _check_f2_persistence(client, options_url, tag, historical_apps):
    plans_url = options_url.replace("/options/", "/plans/")
    hub = Hub.objects.create(hub_code=f"{tag}-f2", hub_name="Hub F2 test", address="Hub test address A")
    second_hub = Hub.objects.create(hub_code=f"{tag}-f2-alt", hub_name="Second Hub F2 test", address="Second Hub address")
    before_waves = historical_apps.get_model("planning", "DeliveryWave").objects.count()
    preview = client.get(options_url, {"hub_id": hub.pk}).data
    direct, via_hub = preview["options"]
    direct_body = {"template_type": direct["template_type"], "option_key": direct["option_key"]}
    hub_body = {"template_type": via_hub["template_type"], "option_key": via_hub["option_key"], "hub_id": hub.pk}

    with patch("planning.services.f2_plans.f2_storage_available", return_value=False):
        unavailable = client.get(options_url)
        assert unavailable.status_code == 200 and unavailable.data["persistence"] == "MIGRATION_REQUIRED"
        assert client.post(plans_url, direct_body, format="json").data["code"] == "F2_MIGRATION_REQUIRED"

    assert APIClient().post(plans_url, direct_body, format="json").status_code == 401
    assert client.post(plans_url, {**direct_body, "f2_structure": {}}, format="json").status_code == 400
    assert client.post(plans_url, {**hub_body, "hub_id": hub.pk + 10_000}, format="json").data["code"] == "HUB_NOT_FOUND"
    Hub.objects.filter(pk=hub.pk).update(is_active=False)
    assert client.post(plans_url, hub_body, format="json").data["code"] == "HUB_INACTIVE"
    Hub.objects.filter(pk=hub.pk).update(is_active=True, address="   ")
    assert client.post(plans_url, hub_body, format="json").data["code"] == "HUB_ADDRESS_MISSING"
    Hub.objects.filter(pk=hub.pk).update(address=hub.address)

    baseline = FulfillmentPlan.objects.count()
    with patch("planning.services.f2_plans._plan_detail", side_effect=DatabaseError("Response assembly after insert")):
        rolled_back = client.post(plans_url, direct_body, format="json")
        assert rolled_back.status_code == 503
    assert FulfillmentPlan.objects.count() == baseline

    direct_plan = _concurrent_f2_save(client, plans_url, direct_body)
    stored_hub = client.post(plans_url, hub_body, format="json")
    assert stored_hub.status_code == 201, stored_hub.data
    hub_plan = stored_hub.data
    second_preview = client.get(options_url, {"hub_id": second_hub.pk}).data
    assert second_preview["options"][0] == direct
    second_option = second_preview["options"][1]
    second_body = {"template_type": "HUB_BASED", "option_key": second_option["option_key"], "hub_id": second_hub.pk}
    second_plan = _concurrent_f2_save(client, plans_url, second_body)
    returned = client.get(options_url, {"hub_id": hub.pk}).data
    assert returned["options"] == [direct, via_hub]
    assert [(row["hub_id"], row["plan_code"]) for row in returned["saved_plans"]] == [
        (None, direct_plan["plan_code"]), (hub.pk, hub_plan["plan_code"]), (second_hub.pk, second_plan["plan_code"]),
    ]
    for draft, option in ((direct_plan, direct), (hub_plan, via_hub), (second_plan, second_option)):
        assert draft["status"] == "DRAFT" and draft["revision"] == 1 and draft["supersedes_plan_code"] is None
        assert draft["f2_structure"]["option"] == option
        assert draft["f2_structure"]["basis"] == preview["basis"]
        assert draft["f2_structure"]["lineage"] == preview["lineage"]
        assert draft["f2_structure"]["schema_version"] == 1
    repeat = client.post(plans_url, hub_body, format="json")
    assert repeat.status_code == 200 and repeat.data == hub_plan
    assert FulfillmentPlan.objects.count() == baseline + 3
    assert FulfillmentPlan.objects.filter(
        group__group_code=preview["lineage"]["group_code"], f2_structure__isnull=False, supersedes_plan_id__isnull=True,
    ).count() == 3

    plan_url = f"{plans_url}{hub_plan['plan_code']}/"
    assert client.get(plan_url).data == hub_plan
    first = preview["basis"]["demands"][0]
    DeliveryDemand.objects.filter(pk=first["id"]).update(demand_code=f"{tag}-live")
    try:
        assert client.get(plan_url).data == hub_plan
        assert client.get(options_url, {"hub_id": hub.pk}).data["basis"] == preview["basis"]
    finally:
        DeliveryDemand.objects.filter(pk=first["id"]).update(demand_code=first["code"])
    # The database also rejects malformed structure and multiple chain roots.
    historical_plan = historical_apps.get_model("planning", "FulfillmentPlan")
    original = historical_plan.objects.get(plan_code=direct_plan["plan_code"])
    for structure, constraint in (
        ({}, "ck_fulfillment_plan_f2_structure"),
        (original.f2_structure, "uq_fulfillment_plan_f2_identity_root"),
    ):
        with pytest.raises(IntegrityError) as failure, transaction.atomic():
            historical_plan.objects.create(
                plan_code=uuid4().hex, group_id=original.group_id, created_by_id=original.created_by_id,
                template_type=original.template_type, status="DRAFT", f2_structure=structure,
            )
        assert failure.value.__cause__.diag.constraint_name == constraint

    Hub.objects.filter(pk=hub.pk).update(address="Hub test address B")
    assert client.get(plan_url).data == hub_plan
    stale = {**hub_body, "supersedes_plan_code": hub_plan["plan_code"]}
    assert client.post(plans_url, stale, format="json").data["code"] == "F2_PREVIEW_STALE"
    updated = client.get(options_url, {"hub_id": hub.pk}).data["options"][1]
    new_hub_body = {**stale, "option_key": updated["option_key"]}
    assert client.post(plans_url, {**hub_body, "option_key": updated["option_key"]}, format="json").data["code"] == "F2_REVISION_CONFLICT"
    wrong_hub = client.post(plans_url, {
        **new_hub_body, "supersedes_plan_code": second_plan["plan_code"],
    }, format="json")
    assert wrong_hub.status_code == 409 and wrong_hub.data["code"] == "F2_REVISION_CONFLICT"
    revision = client.post(plans_url, new_hub_body, format="json")
    assert revision.status_code == 201, revision.data
    assert revision.data["revision"] == 2 and revision.data["supersedes_plan_code"] == hub_plan["plan_code"]
    assert client.post(plans_url, new_hub_body, format="json").status_code == 200
    assert client.post(plans_url, hub_body, format="json").data == hub_plan
    assert client.post(plans_url, {
        **new_hub_body, "supersedes_plan_code": revision.data["plan_code"],
    }, format="json").data == revision.data
    assert client.get(plan_url).data["f2_structure"]["option"]["hub"]["address"] == "Hub test address A"
    assert revision.data["f2_structure"]["option"]["hub"]["address"] == "Hub test address B"
    assert client.post(plans_url, second_body, format="json").data == second_plan
    assert len(client.get(options_url).data["saved_plans"]) == 4
    assert FulfillmentPlan.objects.count() == baseline + 4
    assert historical_apps.get_model("planning", "DeliveryWave").objects.count() == before_waves
    return plans_url, direct_body, plan_url


def _check_f2_legacy_identity(client, matched, tag):
    assert connection.settings_dict["NAME"].startswith("test_")
    run_code = matched["run_code"]
    group_code = matched["candidate_groups"][0]["group_code"]
    group = CollaborationGroup.objects.get(run_code=run_code, group_code=group_code)
    base_url = f"/api/planning/f2/runs/{run_code}/groups/{group_code}/"
    options_url, plans_url = base_url + "options/", base_url + "plans/"
    hub_a = Hub.objects.create(hub_code=f"{tag}-legacy-a", hub_name="Legacy A", address="Legacy A address")
    hub_b = Hub.objects.create(hub_code=f"{tag}-legacy-b", hub_name="Legacy B", address="Legacy B address")
    preview_a = client.get(options_url, {"hub_id": hub_a.pk}).data
    preview_b = client.get(options_url, {"hub_id": hub_b.pk}).data
    direct, option_a = preview_a["options"]
    option_b = preview_b["options"][1]
    before, after = ("planning", "0004_group8_f2_structure"), ("planning", "0005_f2_option_identity")

    def submit(option, predecessor=None):
        payload = {"template_type": option["template_type"], "option_key": option["option_key"]}
        if option["hub"]:
            payload["hub_id"] = option["hub"]["id"]
        if predecessor:
            payload["supersedes_plan_code"] = predecessor
        return client.post(plans_url, payload, format="json")

    MigrationExecutor(connection).migrate([before])
    old_apps = MigrationLoader(None).project_state([before]).apps
    old_plans = old_apps.get_model("planning", "FulfillmentPlan").objects
    previous = None
    for option in (direct, option_b, option_a, option_b, option_a, option_b, option_a, option_b):
        previous = old_plans.create(
            plan_code=uuid4().hex, group_id=group.pk, created_by_id=group.created_by_id,
            hub_id=option["hub"]["id"] if option["hub"] else None,
            supersedes_plan_id=previous.pk if previous and option["hub"] and previous.hub_id else None,
            template_type=option["template_type"], status="DRAFT",
            f2_structure={"schema_version": 1, "lineage": preview_a["lineage"], "basis": preview_a["basis"], "option": option},
        )

    legacy = list(old_plans.filter(group_id=group.pk).order_by("pk").values())
    pre_migration = client.get(options_url, {"hub_id": hub_a.pk})
    assert pre_migration.status_code == 200 and pre_migration.data["persistence"] == "MIGRATION_REQUIRED"
    assert len(pre_migration.data["saved_plans"]) == 8
    read_before = [client.get(f"{plans_url}{row['plan_code']}/").data for row in legacy]
    needs_migration = submit(option_a)
    assert needs_migration.status_code == 503 and needs_migration.data["code"] == "F2_MIGRATION_REQUIRED"
    assert old_plans.filter(group_id=group.pk).count() == 8

    MigrationExecutor(connection).migrate([after])
    assert list(old_plans.filter(group_id=group.pk).order_by("pk").values()) == legacy
    summary = client.get(options_url, {"hub_id": hub_a.pk}).data
    assert summary["persistence"] == "AVAILABLE"
    assert summary["saved_plans"] == pre_migration.data["saved_plans"]
    assert [client.get(f"{plans_url}{row['plan_code']}/").data for row in legacy] == read_before
    latest_a, latest_b = legacy[-2], legacy[-1]
    for option, row in ((option_a, latest_a), (option_b, latest_b)):
        existing = submit(option)
        assert existing.status_code == 200 and existing.data["plan_code"] == row["plan_code"]
    assert old_plans.filter(group_id=group.pk).count() == 8

    Hub.objects.filter(pk=hub_a.pk).update(address="Legacy A address changed")
    revised_a = client.get(options_url, {"hub_id": hub_a.pk}).data["options"][1]
    assert submit(revised_a).data["code"] == "F2_REVISION_CONFLICT"
    assert submit(revised_a, latest_b["plan_code"]).data["code"] == "F2_REVISION_CONFLICT"
    new_revision = submit(revised_a, latest_a["plan_code"])
    assert new_revision.status_code == 201, new_revision.data
    assert new_revision.data["supersedes_plan_code"] == latest_a["plan_code"]
    assert new_revision.data["hub_id"] == hub_a.pk and new_revision.data["revision"] == read_before[-2]["revision"] + 1
    assert submit(revised_a, latest_a["plan_code"]).data == new_revision.data
    assert submit(option_b).data["plan_code"] == latest_b["plan_code"]
    assert list(old_plans.filter(pk__in=[row["id"] for row in legacy]).order_by("pk").values()) == legacy
    assert old_plans.filter(group_id=group.pk).count() == 9


def _check_f3_preview(client, f2_url, supplier, vehicle, category, day):
    url = f2_url.replace("/f2/", "/f3/").replace("/options/", "/allocations/")
    detail = f2_url.replace("/f2/", "/f3/").replace("/options/", "/plans/")
    provider = TransportProvider.objects.create(
        provider_code="TP001", provider_name="CP7 test", provider_type="EXTERNAL",
        service_region="Test scope", contact_email="provider@example.invalid",
    )
    try:
        ProviderSupplierCoverage.objects.create(provider=provider, supplier=supplier)
        offer = ProviderVehicleOffer.objects.create(
            provider=provider, vehicle_type=vehicle, available_vehicle_count=2, fuel_type="DIESEL",
        )
        VehicleCargoCompatibility.objects.create(vehicle_type=vehicle, cargo_category=category, is_supported=True)
        window = ProviderAvailability.objects.create(
            provider_vehicle_offer=offer, service_date=day, start_time=time(6), end_time=time(20),
            available_vehicle_count=2, availability_status="AVAILABLE", source_mode="SYNTHETIC_HISTORICAL_FIXTURE",
        )
        missing = client.get(url)
        assert missing.status_code == 200
        assert all(row["status"] == "NOT_ALLOCATED" and "AVAILABILITY_MISSING" in {
            issue["code"] for issue in row["diagnostics"]
        } for row in missing.data["evaluations"])
        ProviderAvailability.objects.filter(pk=window.pk).update(source_mode="PROVIDER_CONFIRMED_IMPORT")
        plan_codes = list(FulfillmentPlan.objects.order_by("pk").values_list("plan_code", flat=True))
        wave_counts = DeliveryWave.objects.count(), WaveDemand.objects.count()
        reply = client.get(url)
        assert reply.status_code == 200, reply.data
        assert client.get(url).data == reply.data
        assert client.get(url + "?unused=1").status_code == 400
        assert client.post(url, {}, format="json").status_code == 405
        assert APIClient().get(url).status_code == 401
        direct, first_hub, second_hub = reply.data["evaluations"]
        assert direct["status"] == "ALLOCATION_VERIFIED" and direct["vehicles_required"] == 1
        assert direct["configuration"]["configured_rule_codes"] == list(F3_RULES)
        assert first_hub["plan"]["hub_id"] != second_hub["plan"]["hub_id"]
        for result in (direct, first_hub, second_hub):
            assert result["total_required_weight_kg"] == "20.000"
            assert result["availability_envelope"]["date"] == day.isoformat()
            assert all(wave["vehicle"]["available_vehicle_count"] == 2 for wave in result["waves"])
            assert all(wave["allocated_weight_kg"] == "20.000" for wave in result["waves"])
            assert client.get(f"{detail}{result['plan']['plan_code']}/allocation/").data["evaluations"] == [result]
        for hub in (first_hub, second_hub):
            assert hub["status"] == "EVIDENCE_INCOMPLETE" and hub["vehicles_required"] == 2
            assert {wave["phase"] for wave in hub["waves"]} == {"INBOUND", "OUTBOUND"}
        assert client.get(f"{detail}{uuid4().hex}/allocation/").status_code == 404
        assert list(FulfillmentPlan.objects.order_by("pk").values_list("plan_code", flat=True)) == plan_codes
        assert (DeliveryWave.objects.count(), WaveDemand.objects.count()) == wave_counts
        return url, f"{detail}{direct['plan']['plan_code']}/allocation/"
    finally:
        ProviderAvailability.objects.filter(provider_vehicle_offer__provider=provider).delete()
        ProviderVehicleOffer.objects.filter(provider=provider).delete()
        ProviderSupplierCoverage.objects.filter(provider=provider).delete()
        VehicleCargoCompatibility.objects.filter(vehicle_type=vehicle, cargo_category=category).delete()
        provider.delete()


def test_f1_golden_scenarios_with_real_rbac(group6_database):
    tag = f"cp08g6-{uuid4().hex[:12]}"
    actor = User.objects.create_user(email=f"{tag}@example.invalid", full_name="CP08 Group 6")
    created_role_id = None
    created_category = False
    try:
        role, new_role = Role.objects.get_or_create(code="MANAGER", defaults={"name": "Manager"})
        created_role_id = role.pk if new_role else None
        assert role.is_active
        UserRole.objects.create(user=actor, role=role)
        category, created_category = CargoCategory.objects.get_or_create(
            pk=1, defaults={"category_code": tag, "category_name": "CP08 fixture"},
        )
        item = Item.objects.create(item_code=tag, item_name=tag, cargo_category=category, weight_unit="KG")
        supplier = Supplier.objects.create(supplier_code=tag, supplier_name=tag, address="CP08 test")
        offer = SupplierItem.objects.create(
            supplier=supplier, item=item, unit_price_vnd_per_kg=100,
            max_daily_supply_kg=500, minimum_order_kg=1, lead_time_hours=2,
        )
        vehicle = VehicleType.objects.create(vehicle_code=tag, vehicle_name=tag, capacity_kg=100)
        rules = PlanningRuleSet.objects.create(
            rule_set_code=tag, rule_set_name=tag, version_no=1, status="ACTIVE", created_by=actor,
        )
        for code, (expression, rule_type) in _F1_RULE_DEFINITIONS.items():
            PlanningBusinessRule.objects.create(
                rule_set=rules, rule_code=code, module_code="F1", rule_name=code,
                rule_definition={"expression": expression, "rule_type": rule_type},
            )
        for code, definition in F3_RULES.items():
            PlanningBusinessRule.objects.create(
                rule_set=rules, rule_code=code, module_code="F3", rule_name=code, rule_definition=definition,
            )
        for key, value in (("max_group_size", 4), ("max_candidates_per_run", 100)):
            parameter, _ = PlanningParameters.objects.get_or_create(
                parameter_key=key, defaults={"parameter_value": value, "data_type": "INTEGER", "updated_by": actor},
            )
            assert parameter.parameter_value == value

        delivery_day = timezone.localdate() + timedelta(days=15)
        demand_ids = []
        outlet_ids = []
        for index in range(10):
            code = f"{tag}-{index}"
            outlet = Outlet.objects.create(outlet_code=code, outlet_name=code, address="CP08 test")
            UserOutletAccess.objects.create(user=actor, outlet=outlet)
            demand_ids.append(_confirmed_demand(actor, supplier, item, outlet, delivery_day, code).pk)
            outlet_ids.append(outlet.pk)

        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Token {Token.objects.create(user=actor).key}")
        runs_url = "/api/planning/f1/runs/"
        scope_url = "/api/planning/f1/scope/"
        rules_url = "/api/planning/f1/rule-sets/"
        preview_url = "/api/planning/f1/preview/"
        assert APIClient().get(scope_url).status_code == 401
        assert client.get("/api/auth/me/").data["roles"] == ["MANAGER"]
        assert client.get(scope_url).data == {"outlet_ids": sorted(outlet_ids)}
        assert client.get(runs_url).data["count"] == 0

        for suffix, config in (
            ("incomplete", {"status": "ACTIVE"}),
            ("future", {"status": "ACTIVE", "effective_from": timezone.now() + timedelta(days=1)}),
            ("draft", {"status": "DRAFT"}),
        ):
            other = PlanningRuleSet.objects.create(
                rule_set_code=f"{tag}-{suffix}", rule_set_name=suffix,
                version_no=1, created_by=actor, **config,
            )
            for code, (expression, rule_type) in _F1_RULE_DEFINITIONS.items():
                if suffix == "incomplete" and code == "RULE-05":
                    continue
                PlanningBusinessRule.objects.create(
                    rule_set=other, rule_code=code, module_code="F1", rule_name=code,
                    rule_definition={"expression": expression, "rule_type": rule_type},
                )
        listed = client.get(rules_url)
        assert listed.status_code == 200
        assert [row["id"] for row in listed.data if row["rule_set_code"].startswith(tag)] == [rules.pk]
        group_size = PlanningParameters.objects.get(parameter_key="max_group_size")
        try:
            PlanningParameters.objects.filter(pk=group_size.pk).update(parameter_value=1)
            assert all(row["id"] != rules.pk for row in client.get(rules_url).data)
        finally:
            PlanningParameters.objects.filter(pk=group_size.pk).update(parameter_value=group_size.parameter_value)

        def run(ids):
            response = client.post(runs_url, {"demand_ids": ids, "rule_set_id": rules.pk}, format="json")
            assert response.status_code == 201, response.data
            return response.data

        preview = client.post(
            preview_url, {"demand_ids": demand_ids[:2], "rule_set_id": rules.pk}, format="json",
        )
        assert preview.status_code == 200 and len(preview.data["candidate_groups"]) == 1
        assert preview.data["demand_results"][0]["capacity_results"] == [
            {"item_id": item.pk, "status": "VERIFIED"},
        ]
        assert preview.data["ready_to_finalize"] is False
        assert not PlanningRun.objects.filter(initiated_by=actor).exists()
        display = preview.data["display_labels"][str(demand_ids[0])]
        assert display["source"] == "CURRENT_MASTERDATA"
        assert display["supplier"] == {"code": supplier.supplier_code, "name": supplier.supplier_name}
        assert display["items"][str(item.pk)] == {"code": item.item_code, "name": item.item_name}

        matched = run(demand_ids[:2])
        assert matched["status"] == "COMPLETED" and matched["matching_outcome"] == "MATCHED"
        assert [member["demand_id"] for member in matched["candidate_groups"][0]["memberships"]] == demand_ids[:2]
        assert {"stage": "CAPACITY", "code": "VERIFIED", "severity": "INFO", "item_id": item.pk} in matched["demand_results"][0]["diagnostics"]
        detail_url = f"{runs_url}{matched['run_code']}/"
        assert client.get(detail_url).data == matched
        assert matched["demand_count"] == matched["evaluated_count"] == matched["matched_count"] == 2
        assert matched["candidate_count"] == 1
        original_evidence = matched["demand_results"][0]["evidence"]
        assert original_evidence["outlet_code"] == f"{tag}-0"
        assert original_evidence["outlet_name"] is None
        original_outlet = Outlet.objects.get(pk=outlet_ids[0])
        assert matched["display_labels"][str(demand_ids[0])]["outlet"]["name"] == original_outlet.outlet_name
        DeliveryDemand.objects.filter(pk=demand_ids[0]).update(demand_code=f"{tag}-renamed")
        Outlet.objects.filter(pk=outlet_ids[0]).update(outlet_name="Nhãn danh mục hiện tại")
        try:
            detail = client.get(detail_url).data
            assert detail["demand_results"][0]["evidence"] == original_evidence
            assert detail["display_labels"][str(demand_ids[0])]["outlet"]["name"] == "Nhãn danh mục hiện tại"
        finally:
            DeliveryDemand.objects.filter(pk=demand_ids[0]).update(demand_code=original_evidence["demand_code"])
            Outlet.objects.filter(pk=outlet_ids[0]).update(outlet_name=original_outlet.outlet_name)
        f2_url = _check_f2_preview(client, matched, demand_ids, tag)
        try:
            _check_f2_legacy_identity(client, run(demand_ids[:2]), tag)
        finally:
            # The legacy scenario rewinds planning. Restore every current planning migration
            # before the live ORM traverses FK relations in later assertions or cleanup.
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes("planning"))
        f2_plans_url, f2_save_body, f2_saved_url = _check_f2_persistence(client, f2_url, tag, group6_database)
        f3_url, f3_saved_url = _check_f3_preview(client, f2_url, supplier, vehicle, category, delivery_day)
        empty = run(demand_ids[1:2])
        assert empty["status"] == "COMPLETED" and empty["matching_outcome"] == "NO_CANDIDATE"
        assert client.get(f2_url.replace(matched["run_code"], empty["run_code"])).status_code == 404

        stored = PlanningRun.objects.get(run_code=matched["run_code"])
        snapshots = tuple(stored.run_demands.order_by("demand_id").values_list("demand_snapshot", flat=True))
        original = _evaluate_for_execution(snapshots, stored.parameters_snapshot)
        group = CollaborationGroup.objects.get(run_code=stored.run_code)
        draft = create_draft_plan(
            group=group, actor=actor, template_type="DIRECT_CONSOLIDATED",
            waves=[{
                "wave_no": 1, "vehicle_type_id": vehicle.pk, "planned_date": delivery_day,
                "total_load_kg": Decimal("10"), "allocations": [(demand_ids[0], Decimal("10"))],
            }],
        )
        revision = create_draft_plan(group=group, actor=actor, template_type="DIRECT_CONSOLIDATED", supersedes=draft)
        assert revision.status == "DRAFT" and revision.supersedes_plan_id == draft.pk
        assert revision.plan_code != draft.plan_code
        # Authoritative upstream state fixture, through the migration model only.
        group6_database.get_model("planning", "FulfillmentPlan").objects.filter(pk=draft.pk).update(status="FINALIZED")
        mixed = run(demand_ids[:3])
        assert mixed["status"] == "COMPLETED"
        assert [row["plan_guard_status"] for row in mixed["demand_results"]] == ["CONFLICT", "PASS", "PASS"]
        assert mixed["demand_results"][0]["primary_reason_code"] is None
        assert [member["demand_id"] for member in mixed["candidate_groups"][0]["memberships"]] == demand_ids[1:3]
        assert _evaluate_for_execution(snapshots, stored.parameters_snapshot) == original

        def fail_plan_query():
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1 / 0")

        with patch("planning.services.fulfillment_plan_guard._finalized_membership", side_effect=fail_plan_query):
            unavailable = run(demand_ids[:2])
        assert unavailable["status"] == "FAILED" and not unavailable["candidate_groups"]
        assert unavailable["failure_diagnostics"][0]["code"] == "PLAN_GUARD_NOT_EVALUATED"
        assert len(unavailable["demand_results"]) == 2

        overflow = run(demand_ids)
        assert overflow["status"] == "FAILED" and overflow["matching_outcome"] == "MATCHING_INCOMPLETE"
        assert not overflow["candidate_groups"]
        assert all(row["matching_status"] == "NOT_EVALUATED" for row in overflow["demand_results"])
        assert not CollaborationGroup.objects.filter(run_code=overflow["run_code"]).exists()

        insert_scope = PlanningRunDemand.objects.bulk_create

        def fail_after_scope_insert(rows):
            assert insert_scope(rows)
            raise RuntimeError("Fixture failure after inserting the scope")

        with patch.object(PlanningRunDemand.objects, "bulk_create", side_effect=fail_after_scope_insert):
            capture_rollback = run(demand_ids[1:3])
        assert capture_rollback["status"] == "FAILED"
        assert capture_rollback["failure_diagnostics"][0]["stage"] == "CAPTURE"
        assert not capture_rollback["demand_results"] and not capture_rollback["candidate_groups"]
        assert not PlanningRunDemand.objects.filter(planning_run__run_code=capture_rollback["run_code"]).exists()

        insert_memberships = GroupDemand.objects.bulk_create

        def fail_after_result_insert(rows):
            assert insert_memberships(rows)
            raise RuntimeError("Fixture failure after inserting the candidate's memberships")

        with patch.object(GroupDemand.objects, "bulk_create", side_effect=fail_after_result_insert):
            result_rollback = run(demand_ids[1:3])
        assert result_rollback["status"] == "FAILED"
        assert result_rollback["failure_diagnostics"][0]["stage"] == "RESULT"
        assert not result_rollback["candidate_groups"]
        assert not GroupDemand.objects.filter(group__run_code=result_rollback["run_code"]).exists()
        assert not CollaborationGroup.objects.filter(run_code=result_rollback["run_code"]).exists()
        assert PlanningRunDemand.objects.filter(
            planning_run__run_code=result_rollback["run_code"],
            eligibility_status="NOT_EVALUATED", matching_status="NOT_EVALUATED",
        ).count() == 2

        not_submitted = create_draft_demand(
            demand_code=f"{tag}-draft", supplier_id=supplier.pk, outlet_id=outlet_ids[1],
            created_by=actor, requested_date=delivery_day,
            requested_start_time=time(9), requested_end_time=time(11),
            items=[{"item_id": item.pk, "required_weight_kg": "10", "unit_of_measure": "KG"}],
        )
        excluded = run([not_submitted.pk])
        assert excluded["status"] == "COMPLETED" and excluded["matching_outcome"] == "NO_CANDIDATE"
        outcome = excluded["demand_results"][0]
        assert outcome["primary_reason_code"] == "DEMAND_NOT_SUBMITTED"
        assert {"DEMAND_NOT_SUBMITTED", "LATEST_REQUEST_MISSING"} <= {row["code"] for row in outcome["diagnostics"]}
        submit_demand(demand_id=not_submitted.pk, submitted_by=actor)
        waiting = run([not_submitted.pk])
        assert waiting["demand_results"][0]["primary_reason_code"] == "LATEST_REQUEST_NOT_RESPONDED"

        selected_item = DeliveryDemand.objects.get(pk=demand_ids[1]).items.get()
        # Record-level invalid data fixture. The normal CP6 validation
        # requires an exclusion reason for INELIGIBLE options.
        option = DemandSourcingOption.objects.create(
            demand_item=selected_item, supplier_item=offer, option_type="SELECTED_EXISTING",
            evaluation_status="INELIGIBLE", unit_price_vnd_per_kg_snapshot=offer.unit_price_vnd_per_kg,
        )
        invalid_source = run(demand_ids[1:2])
        assert invalid_source["status"] == "COMPLETED"
        assert invalid_source["demand_results"][0]["primary_reason_code"] == "INVALID_SOURCE_ITEM"
        option.delete()

        SupplierItem.objects.filter(pk=offer.pk).update(max_daily_supply_kg=1)
        capacity_outcome = run(demand_ids[1:2])["demand_results"][0]
        assert capacity_outcome["eligibility_status"] == "EXCLUDED"
        assert capacity_outcome["primary_reason_code"] is None and capacity_outcome["plan_guard_status"] == "PASS"
        assert any(
            row["stage"] == "CAPACITY" and row["code"] == "CAPACITY_EXCEEDED"
            for row in capacity_outcome["diagnostics"]
        )
        SupplierItem.objects.filter(pk=offer.pk).update(max_daily_supply_kg=500)

        with pytest.raises(ValidationError, match="requires a new version"):
            rules.rule_set_name = "Edited after pin"
            rules.save(update_fields=["rule_set_name"])
        rule_revision = create_rule_set_version(source_rule_set_id=rules.pk, rule_set_code=f"{tag}-v2", actor=actor)
        assert rule_revision.version_no == 2 and rule_revision.business_rules.count() == rules.business_rules.count()

        # The Manager needs explicit Outlet assignments for F1.
        manager = User.objects.create_user(email=f"{tag}-manager@example.invalid", full_name="CP08 test Manager")
        new_manager_role = None
        try:
            manager_role, created = Role.objects.get_or_create(code="MANAGER", defaults={"name": "Manager"})
            new_manager_role = manager_role.pk if created else None
            assert manager_role.is_active
            UserRole.objects.create(user=manager, role=manager_role)
            manager_client = APIClient()
            manager_client.credentials(HTTP_AUTHORIZATION=f"Token {Token.objects.create(user=manager).key}")
            assert manager_client.get("/api/auth/me/").data["roles"] == ["MANAGER"]
            assert manager_client.get("/api/demands/").status_code == 200
            body = {"demand_ids": demand_ids[1:3], "rule_set_id": rules.pk}
            assert manager_client.get(scope_url).status_code == 403
            assert manager_client.get(rules_url).status_code == 403
            assert manager_client.get(runs_url).status_code == 403
            assert manager_client.post(preview_url, body, format="json").status_code == 403
            assert manager_client.post(runs_url, body, format="json").status_code == 403
            assert manager_client.get(detail_url).status_code == 404
            assert manager_client.get(f2_url).status_code == 403
            assert not PlanningRun.objects.filter(initiated_by=manager).exists()

            for outlet_id in outlet_ids[1:3]:
                UserOutletAccess.objects.create(user=manager, outlet_id=outlet_id, assigned_by=actor)
            assert manager_client.get(scope_url).data == {"outlet_ids": sorted(outlet_ids[1:3])}
            assert any(rule["id"] == rules.pk for rule in manager_client.get(rules_url).data)
            assert manager_client.post(preview_url, body, format="json").status_code == 200
            manager_run = manager_client.post(runs_url, body, format="json")
            assert manager_run.status_code == 201
            assert manager_run.data["matching_outcome"] == "MATCHED"
            manager_detail_url = f"{runs_url}{manager_run.data['run_code']}/"
            assert manager_client.get(manager_detail_url).data == manager_run.data
            assert manager_client.get(detail_url).status_code == 404
            assert manager_client.get(f2_url).status_code == 404
            assert manager_client.post(f2_plans_url, f2_save_body, format="json").status_code == 404
            assert manager_client.get(f2_saved_url).status_code == 404
            assert manager_client.get(f3_saved_url).status_code == 404
            assert client.get(manager_detail_url).status_code == 404
            history = manager_client.get(runs_url).data
            assert history["count"] == 1 and history["results"][0]["run_code"] == manager_run.data["run_code"]
            assert history["results"][0]["matching_outcome"] == "MATCHED"
            unauthorized = {"demand_ids": [demand_ids[-1]], "rule_set_id": rules.pk}
            assert manager_client.post(preview_url, unauthorized, format="json").status_code == 403
            assert manager_client.post(runs_url, unauthorized, format="json").status_code == 403
            UserOutletAccess.objects.filter(user=manager, outlet_id=outlet_ids[1]).update(is_active=False)
            assert manager_client.get(manager_detail_url).status_code == 404
            assert manager_client.get(runs_url).data["count"] == 0
        finally:
            _cleanup(group6_database, manager, f"{tag}-manager", new_manager_role, False)

        staff = User.objects.create_user(email=f"{tag}-staff@example.invalid", full_name="CP08 test Purchasing Staff")
        new_staff_role_id = None
        try:
            staff_role, created = Role.objects.get_or_create(
                code="PURCHASING_STAFF", defaults={"name": "Purchasing Staff"},
            )
            new_staff_role_id = staff_role.pk if created else None
            UserRole.objects.create(user=staff, role=staff_role)
            UserOutletAccess.objects.create(user=staff, outlet_id=outlet_ids[0], assigned_by=actor)
            staff_client = APIClient()
            staff_client.credentials(HTTP_AUTHORIZATION=f"Token {Token.objects.create(user=staff).key}")
            staff_demands = staff_client.post("/api/demands/", {
                "supplier_id": supplier.pk,
                "outlet_id": outlet_ids[0],
                "requested_date": delivery_day.isoformat(),
                "items": [{"item_id": item.pk, "required_weight_kg": "10", "unit_of_measure": "KG"}],
            }, format="json")
            assert staff_demands.status_code == 201, staff_demands.data
            staff_demand_id = staff_demands.data["id"]
            staff_list = staff_client.get("/api/demands/")
            assert staff_list.status_code == 200
            assert [demand["id"] for demand in staff_list.data] == [staff_demand_id]
            assert staff_client.get(f"/api/demands/{staff_demand_id}/").status_code == 200
            assert staff_client.get(f"/api/demands/{staff_demand_id}/status/").data["status"] == "DRAFT"

            body = {"demand_ids": [staff_demand_id], "rule_set_id": rules.pk}
            for url in (scope_url, rules_url, runs_url, detail_url):
                assert staff_client.get(url).status_code == 403
            for url in (preview_url, runs_url):
                assert staff_client.post(url, body, format="json").status_code == 403
            assert staff_client.get(f2_url).status_code == 403
            assert staff_client.get("/api/planning/f2/hubs/").status_code == 403
            assert staff_client.post(f2_plans_url, f2_save_body, format="json").status_code == 403
            assert staff_client.get(f2_saved_url).status_code == 403
            assert staff_client.get(f3_url).status_code == 403
            assert staff_client.get(f3_saved_url).status_code == 403
            assert not PlanningRun.objects.filter(initiated_by=staff).exists()
        finally:
            _cleanup(group6_database, staff, f"{tag}-staff", new_staff_role_id, False)

        history = client.get(runs_url).data
        assert history["count"] > 10 and len(history["results"]) == 10 and history["next"]
        assert client.get(f"{runs_url}?page=2").data["previous"]
        run_count = PlanningRun.objects.filter(initiated_by=actor).count()
        UserOutletAccess.objects.filter(user=actor, outlet_id=outlet_ids[0]).delete()
        assert client.get(detail_url).status_code == 404
        assert client.get(f2_url).status_code == 404
        assert client.post(f2_plans_url, f2_save_body, format="json").status_code == 404
        assert client.get(f2_saved_url).status_code == 404
        assert client.get(f3_url).status_code == 404
        assert all(row["run_code"] != matched["run_code"] for row in client.get(runs_url).data["results"])
        assert client.post(preview_url, {"demand_ids": demand_ids[:2], "rule_set_id": rules.pk}, format="json").status_code == 403
        assert client.post(runs_url, {"demand_ids": demand_ids[:2], "rule_set_id": rules.pk}, format="json").status_code == 403
        assert PlanningRun.objects.filter(initiated_by=actor).count() == run_count
    finally:
        _cleanup(group6_database, actor, tag, created_role_id, created_category)
