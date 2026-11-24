import json
from unittest import TestCase
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.db import DatabaseError

from planning.models import FulfillmentPlan, PlanningBusinessRule, PlanningRuleSet, PlanningRun
from planning.services import fulfillment_plan_guard as source
from planning.services.plan_guard import evaluate_snapshot_plan_guard
from planning.services.test_run_preview import valid_v11_snapshot


class FulfillmentPlanGuardTests(TestCase):
    def capture(self, rows=(), error=None):
        with patch.object(source, "connection") as connection, patch.object(
            source.transaction, "atomic",
        ), patch.object(source, "_finalized_membership", return_value=rows, side_effect=error):
            connection.vendor = "postgresql"
            connection.in_atomic_block = True
            connection.cursor.return_value.__enter__.return_value.fetchone.return_value = ("repeatable read",)
            return source.capture_fulfillment_plan_guard((1, 2))

    def test_complete_empty_source_produces_pass(self):
        evidence = self.capture()
        for demand_id in (1, 2):
            snapshot = valid_v11_snapshot(demand_id=demand_id)
            snapshot["gate_evidence"]["plan_guard"] = evidence[demand_id]
            self.assertEqual(evaluate_snapshot_plan_guard(snapshot), "PASS")

    def test_only_wave_members_have_conflict_and_evidence_contains_revision(self):
        evidence = self.capture([(22, 21, 10, 1), (22, 21, 11, 1), (25, None, 12, 90)])
        self.assertEqual(evidence[1]["status"], "CONFLICT")
        self.assertEqual(evidence[2]["status"], "PASS")
        reference = json.loads(evidence[1]["evidence_reference"])
        self.assertEqual(reference["finalized_plans"], [
            {"plan_id": 22, "revision_id": 22, "supersedes_plan_id": 21},
        ])

    def test_missing_table_returns_unavailable(self):
        self.assertEqual(self.capture(error=DatabaseError("source unavailable")), {})

    def test_incomplete_allocation_and_inconsistent_lineage_fail_closed(self):
        for rows in (
            [(22, None, None, None)],
            [(22, None, 10, None)],
            [(22, 21, 10, 1), (22, 20, 11, 2)],
        ):
            with self.subTest(rows=rows):
                self.assertEqual(self.capture(rows), {})

    def test_snapshot_rejects_malformed_or_mismatched_reference(self):
        snapshot = valid_v11_snapshot("CONFLICT", 1)
        evidence = snapshot["gate_evidence"]["plan_guard"]
        original = json.loads(evidence["evidence_reference"])
        for malformed in (
            "unverified",
            json.dumps({**original, "demand_id": 2}),
            json.dumps({
                **original,
                "finalized_plans": [{"plan_id": 42, "revision_id": 99, "supersedes_plan_id": 41}],
            }),
        ):
            with self.subTest(reference=malformed):
                evidence["evidence_reference"] = malformed
                self.assertEqual(evaluate_snapshot_plan_guard(snapshot), "NOT_EVALUATED")


class PlanningPersistenceWriteTests(TestCase):
    def test_cp08_cannot_create_a_manager_state(self):
        for status in ("APPROVED", "REJECTED", "FINALIZED"):
            with self.subTest(status=status):
                with self.assertRaisesRegex(ValidationError, "creates DRAFT"):
                    FulfillmentPlan(status=status)._validate_write("default", None)

    def test_revision_updates_and_bulk_bypasses_are_blocked(self):
        plan = FulfillmentPlan()
        plan._state.adding = False
        with self.assertRaisesRegex(ValidationError, "new revision"):
            plan.save_base()
        with self.assertRaisesRegex(ValidationError, "retained"):
            plan.delete()
        with self.assertRaises(ValidationError):
            FulfillmentPlan.objects.filter(pk=1).update(status="FINALIZED")
        with self.assertRaises(ValidationError):
            PlanningBusinessRule.objects.bulk_create([])
        with self.assertRaises(ValidationError):
            PlanningBusinessRule.objects.filter(pk=1).delete()
        with self.assertRaises(ValidationError):
            PlanningRuleSet().save_base(raw=True)

    def test_used_rule_set_rejects_adding_business_rules_after_parent_lock(self):
        rule = PlanningBusinessRule(rule_set_id=8)
        with patch("planning.models._require_read_committed") as isolation, patch.object(
            PlanningRuleSet, "objects",
        ) as rule_sets, patch.object(PlanningRun, "objects") as runs:
            runs.using.return_value.filter.return_value.exists.return_value = True
            with self.assertRaisesRegex(ValidationError, "requires a new version"):
                rule._validate_write("default", None)
        isolation.assert_called_once_with("default")
        rule_sets.using.return_value.select_for_update.return_value.get.assert_called_once_with(pk=8)
        runs.using.return_value.filter.assert_called_once_with(rule_set_id=8)

    def test_used_rule_set_allows_retirement_but_rejects_configuration_edits(self):
        record = PlanningRuleSet(pk=8, status="RETIRED")
        prior = PlanningRuleSet(pk=8, status="ACTIVE")
        with patch("planning.models._require_read_committed"), patch.object(
            PlanningRuleSet, "objects",
        ) as rule_sets, patch.object(PlanningRun, "objects") as runs:
            rule_sets.using.return_value.select_for_update.return_value.filter.return_value.first.return_value = prior
            runs.using.return_value.filter.return_value.exists.return_value = True
            record._validate_write("default", {"status"})
            with self.assertRaisesRegex(ValidationError, "requires a new version"):
                record._validate_write("default", {"rule_set_name"})
