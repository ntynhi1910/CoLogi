from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import SimpleTestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from accounts.permissions import HasCoLogiRole
from planning.services.run_preview import (
    DemandRunPreview,
    NOT_EVALUATED,
    RunPreview,
)
from planning.models import PlanningRun
from planning.views import F1RunCreateView, F1RunDetailView, F1RunPreviewView


class F1ManagerAPITestCase(SimpleTestCase):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(HasCoLogiRole, "has_permission", return_value=True))


class F1RunPreviewAPITests(F1ManagerAPITestCase):
    def setUp(self):
        super().setUp()
        self.factory = APIRequestFactory()
        self.url = "/api/planning/f1/preview/"
        self.actor = SimpleNamespace(is_authenticated=True)

        self.preview = RunPreview(
            captured_at="2026-11-17T10:00:00+07:00",
            rule_set_id=1,
            rule_set_code="CP8-F1",
            rule_set_version=1,
            business_rule_codes=("F1-RULE-001",),
            demand_results=(
                DemandRunPreview(
                    demand_id=101,
                    eligibility_status="ELIGIBLE",
                    blockers=(),
                    diagnostics=(),
                    primary_reason_code=None,
                    plan_guard_status=NOT_EVALUATED,
                    matching_status=NOT_EVALUATED,
                    detail="Test evaluation",
                ),
            ),
            candidate_groups=(),
            business_rules_execution=NOT_EVALUATED,
            plan_guard_status=NOT_EVALUATED,
            matching_status=NOT_EVALUATED,
            ready_to_finalize=False,
        )

    @patch("planning.views.preview_f1_run_for_actor")
    def test_authenticated_request_returns_read_only_preview(self, preview_service):
        preview_service.return_value = self.preview

        request = self.factory.post(
            self.url,
            {
                "demand_ids": [101],
                "rule_set_id": 1,
            },
            format="json",
        )
        force_authenticate(request, user=self.actor)

        response = F1RunPreviewView.as_view()(request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["rule_set_code"], "CP8-F1")
        self.assertEqual(response.data["demand_results"][0]["demand_id"], 101)
        self.assertTrue(response.data["all_demands_eligible"])
        self.assertFalse(response.data["ready_to_finalize"])
        self.assertEqual(response.data["plan_guard_status"], NOT_EVALUATED)
        preview_service.assert_called_once_with(
            actor=self.actor,
            demand_ids=[101],
            rule_set_id=1,
            cost_profile_id=None,
        )

    @patch("planning.views.preview_f1_run_for_actor")
    def test_unknown_request_field_is_rejected(self, preview_service):
        request = self.factory.post(
            self.url,
            {
                "demand_ids": [101],
                "rule_set_id": 1,
                "unexpected": True,
            },
            format="json",
        )
        force_authenticate(request, user=self.actor)

        response = F1RunPreviewView.as_view()(request)

        self.assertEqual(response.status_code, 400)
        preview_service.assert_not_called()

    @patch("planning.views.preview_f1_run_for_actor")
    def test_unauthenticated_request_is_rejected(self, preview_service):
        request = self.factory.post(
            self.url,
            {
                "demand_ids": [101],
                "rule_set_id": 1,
            },
            format="json",
        )

        response = F1RunPreviewView.as_view()(request)

        self.assertEqual(response.status_code, 401)
        preview_service.assert_not_called()


class F1RunResultAPITests(F1ManagerAPITestCase):
    def setUp(self):
        super().setUp()
        self.factory = APIRequestFactory()
        self.actor = SimpleNamespace(is_authenticated=True)
        self.run_code = uuid4()

    @patch("planning.views.get_f1_run_detail")
    @patch("planning.views.execute_f1_run_for_actor")
    def test_execution_returns_persisted_failure_diagnostics(self, execute, detail):
        execute.return_value = SimpleNamespace(run_code=self.run_code)
        detail.return_value = {
            "run_code": self.run_code, "status": "FAILED", "source_mode": "API",
            "started_at": datetime.now(timezone.utc), "completed_at": datetime.now(timezone.utc),
            "rule_set_id": 9, "rule_set_version": 2, "matching_outcome": "MATCHING_INCOMPLETE",
            "failure_diagnostics": [{"code": "CANDIDATE_LIMIT_EXCEEDED"}],
            "demand_results": [], "candidate_groups": [],
        }
        request = self.factory.post("/api/planning/f1/runs/", {"demand_ids": [1], "rule_set_id": 9}, format="json")
        force_authenticate(request, user=self.actor)
        response = F1RunCreateView.as_view()(request)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["status"], "FAILED")
        self.assertEqual(response.data["matching_outcome"], "MATCHING_INCOMPLETE")
        self.assertEqual(response.data["failure_diagnostics"][0]["code"], "CANDIDATE_LIMIT_EXCEEDED")
        execute.assert_called_once_with(actor=self.actor, source_mode="API", demand_ids=[1], rule_set_id=9)
        detail.assert_called_once_with(actor=self.actor, run_code=self.run_code)

    @patch("planning.views.get_f1_run_detail", side_effect=PlanningRun.DoesNotExist)
    def test_detail_does_not_reveal_out_of_scope_runs(self, read):
        request = self.factory.get(f"/api/planning/f1/runs/{self.run_code}/")
        force_authenticate(request, user=self.actor)
        response = F1RunDetailView.as_view()(request, run_code=self.run_code)
        self.assertEqual(response.status_code, 404)
        read.assert_called_once_with(actor=self.actor, run_code=self.run_code)
