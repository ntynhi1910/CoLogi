from copy import deepcopy
from dataclasses import replace
from datetime import date, time
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import UUID

from django.core.exceptions import ValidationError
from django.test import override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from planning.f3_contract import MANAGER_ACCEPTED_AVAILABILITY, fingerprint, validate_saved_document
from planning.f3_views import F3ManagerAcceptanceView
from planning.services.f3_acceptance import (
    AcceptanceEvidenceMismatch, MANIFEST_PATH, MANIFEST_SHA256, manifest_for_request,
    overlay_legacy_windows, verify_pinned_rows, verify_scope,
)
from planning.services.f3_allocation import Availability, Offer
from planning.services.f3_preview import _with_v7_fleet, preview_manager_acceptance_f3
from transportation.v7_planning import V7_FLEET_SOURCE


ROOT = Path(__file__).resolve().parents[3]
MANIFEST = json.loads((ROOT / MANIFEST_PATH).read_bytes())
SCOPE = MANIFEST["scope"]
ACTOR = SimpleNamespace(pk=1, is_authenticated=True, is_active=True, capstone_scenario="")
ROUTE = dict(run_code=UUID(SCOPE["run_uuid"]), group_code=SCOPE["candidate_code"], plan_code=SCOPE["plan_code"])
PROVIDER = {"id": 1, "provider_code": "TP001", "is_active": True}


class AcceptanceTests(TestCase):
    def test_trusted_manifest_matches_pinned_bytes(self):
        self.assertEqual(sha256((ROOT / MANIFEST_PATH).read_bytes()).hexdigest(), MANIFEST_SHA256)

    @override_settings(COLOGI_MANAGER_ACCEPTANCE_PREVIEW=True)
    def test_scope_rejects_wrong_actor_database_run_group_plan_and_context(self):
        with patch("planning.services.f3_acceptance.connection", settings_dict={"NAME": "cologi"}):
            self.assertEqual(manifest_for_request(ACTOR, **ROUTE), MANIFEST)
            for key, wrong in (("run_code", UUID(int=1)), ("group_code", "wrong"), ("plan_code", "wrong")):
                self.assertIsNone(manifest_for_request(ACTOR, **{**ROUTE, key: wrong}))
            for fields in ({"pk": 2}, {"is_active": False}, {"capstone_scenario": "other"}):
                self.assertIsNone(manifest_for_request(SimpleNamespace(**{**vars(ACTOR), **fields}), **ROUTE))
        with patch("planning.services.f3_acceptance.connection", settings_dict={"NAME": "other"}):
            self.assertIsNone(manifest_for_request(ACTOR, **ROUTE))

    @override_settings(COLOGI_MANAGER_ACCEPTANCE_PREVIEW=False)
    def test_scope_disabled(self):
        self.assertIsNone(manifest_for_request(ACTOR, **ROUTE))

    @override_settings(COLOGI_MANAGER_ACCEPTANCE_PREVIEW=True)
    def test_missing_or_tampered_manifest_is_not_trusted(self):
        for effect in (OSError(), [b'{"status":"tampered"}']):
            with patch("pathlib.Path.read_bytes", side_effect=effect):
                self.assertIsNone(manifest_for_request(ACTOR, **ROUTE))

    def test_f2_lineage_rejects_wrong_revision_owner_and_fingerprint(self):
        manifest = deepcopy(MANIFEST)
        structure = {"basis": {"requested_date": "2026-11-24", "demand_ids": [42, 43],
                               "total_required_weight_kg": "400.000"}}
        manifest["scope"]["f2_fingerprint"] = fingerprint(structure)
        run = SimpleNamespace(pk=11, run_code=ROUTE["run_code"], rule_set_id=2, initiated_by_id=1)
        group = SimpleNamespace(pk=21, group_code=ROUTE["group_code"], status="CANDIDATE")
        plan = SimpleNamespace(pk=18, group_id=21, created_by_id=1, plan_code=SCOPE["plan_code"],
                               template_type="DIRECT_CONSOLIDATED", hub_id=None, f2_structure=structure)
        verify_scope(manifest, run, group, plan, 1)
        for fields, revision in (({}, 2), ({"pk": 19}, 1), ({"created_by_id": 14}, 1),
                                 ({"f2_structure": {**structure, "change": True}}, 1)):
            with self.assertRaises(AcceptanceEvidenceMismatch):
                verify_scope(manifest, run, group, SimpleNamespace(**{**vars(plan), **fields}), revision)

    def test_audit_or_legacy_drift_fails_closed(self):
        case = deepcopy(MANIFEST)
        source = case["sources"]["v7_availability"]
        source["audit_row_sha256"] = sha256(b"audit").hexdigest()
        source["legacy_rows_sha256"] = sha256(b"rows").hexdigest()
        for one, two, three, passes in (
            ("cologi", "audit", "rows", True), ("clone", "audit", "rows", False),
            ("cologi", "substitute", "rows", False), ("cologi", "audit", "drift", False),
        ):
            cursor = MagicMock()
            cursor.fetchone.side_effect = [(one,), (two,), (three,)]
            if passes:
                verify_pinned_rows(case, cursor)
                self.assertEqual(cursor.execute.call_args.args[1], [[99, 100, 101, 102, 103, 104]])
            else:
                with self.assertRaises(AcceptanceEvidenceMismatch):
                    verify_pinned_rows(case, cursor)

    def offers(self):
        return [Offer(row["offer_id"], row["offer_id"], row["vehicle_type"], row["vehicle_type"],
                      Decimal(2000), 3, True, True, time(6), time(20), ())
                for row in MANIFEST["sources"]["v7_availability"]["rows"]]

    def test_overlay_preserves_real_blocked_windows_and_dated_authority(self):
        offers = self.offers()
        native_block = Availability(900, date(2026, 11, 24), time(8), time(9), 0, "UNAVAILABLE", "PROVIDER_PORTAL")
        offers[4] = replace(offers[4], windows=(native_block,))
        fleet, admitted = overlay_legacy_windows(MANIFEST, (PROVIDER, offers, {}, {}), set(range(99, 105)),
                                                lambda oid: oid == 6)
        self.assertEqual(fleet[1][4].windows, (native_block,))
        self.assertEqual(fleet[1][5].windows, ())
        self.assertEqual([row["legacy_id"] for row in admitted], [99, 100, 101, 102])
        self.assertEqual(fleet[1][0].windows[0].source, MANAGER_ACCEPTED_AVAILABILITY)
        self.assertEqual(admitted[0]["original_provenance"], "SYNTHETIC_NOVEMBER_DEMO")

    def test_overlay_rejects_missing_audited_id_and_foreign_provider(self):
        for provider, ids in ((PROVIDER, {99, 100}), ({**PROVIDER, "id": 2}, set(range(99, 105)))):
            with self.assertRaises(AcceptanceEvidenceMismatch):
                overlay_legacy_windows(MANIFEST, (provider, self.offers(), {}, {}), ids, lambda _oid: False)

    def test_default_v7_fallback_is_dated_and_never_overrides_native_or_revoked_authority(self):
        day = date(2026, 11, 24)
        offers = self.offers()
        block = Availability(900, day, time(8), time(9), 0, "UNAVAILABLE", "PROVIDER_PORTAL")
        offers[0] = replace(offers[0], windows=(block,))
        slots = {offer.id: (SimpleNamespace(pk=offer.id, provider_vehicle_offer_id=offer.id,
                   service_date=day if offer.id != 3 else date(2026, 11, 25), start_time=time(6), end_time=time(20),
                   available_vehicle_count=2, availability_status="AVAILABLE"), "SYNTHETIC_NOVEMBER_DEMO")
                 for offer in offers}
        reader = SimpleNamespace(has_dated_authority=lambda _, offer_id: offer_id == 2)
        _, resolved, _, _ = _with_v7_fleet((PROVIDER, offers, {}, {}), day, reader, slots)
        self.assertEqual(resolved[0].windows, (block,))
        self.assertFalse(resolved[1].windows)
        self.assertFalse(resolved[2].windows)
        self.assertEqual(resolved[3].windows[0].source, V7_FLEET_SOURCE)

    def test_preview_starts_read_only_transaction(self):
        with patch("planning.services.f3_preview.manifest_for_request", return_value=MANIFEST), \
             patch("planning.services.f3_preview.connection") as connection, \
             patch("planning.services.f3_preview.find_f2_candidate", side_effect=PermissionError) as find:
            cursor = connection.cursor.return_value.__enter__.return_value
            with self.assertRaises(PermissionError):
                preview_manager_acceptance_f3.__wrapped__(actor=ACTOR, **ROUTE)
            cursor.execute.assert_called_once_with("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            find.assert_called_once_with(actor=ACTOR, run_code=ROUTE["run_code"], group_code=ROUTE["group_code"])

    def test_acceptance_cannot_be_persisted_in_standard_contract(self):
        for cp7 in ({"manager_acceptance": {}}, {"offers": [{"windows": [{"source": MANAGER_ACCEPTED_AVAILABILITY}]}]}):
            with self.assertRaisesRegex(ValidationError, "cannot be persisted"):
                validate_saved_document({}, {"inputs": {"cp7": cp7}, "configuration": {}, "result": {}}, "", "")

    def test_view_enforces_auth_role_and_has_no_write_handler(self):
        factory = APIRequestFactory()
        view = F3ManagerAcceptanceView.as_view()
        self.assertEqual(view(factory.get("/"), **ROUTE).status_code, 401)
        with patch("accounts.permissions.UserRole.objects.filter") as roles:
            request = factory.get("/")
            force_authenticate(request, user=ACTOR)
            roles.return_value.exists.return_value = False
            self.assertEqual(view(request, **ROUTE).status_code, 403)
            self.assertIn("MANAGER", roles.call_args.kwargs["role__code__in"])
            roles.return_value.exists.return_value = True
            request = factory.post("/", {})
            force_authenticate(request, user=ACTOR)
            self.assertEqual(view(request, **ROUTE).status_code, 405)
