import json
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest import TestCase

from django.core.exceptions import ValidationError
from django.test import override_settings
from django.utils import timezone

from planning.models import PlanningModuleCode, RuleSetStatus
from planning.services.run_configuration import build_parameters_snapshot


class RunConfigurationSnapshotTests(TestCase):
    def setUp(self):
        self.now = timezone.now()

        self.rule_set = SimpleNamespace(
            pk=1,
            rule_set_code="F1-DEFAULT",
            rule_set_name="F1 Default",
            version_no=1,
            status=RuleSetStatus.ACTIVE,
            effective_from=self.now - timedelta(days=1),
        )

        self.rule = SimpleNamespace(
            pk=10,
            rule_code="F1_ELIGIBILITY",
            rule_name="F1 Eligibility",
            module_code=PlanningModuleCode.F1,
            priority=1,
            is_active=True,
            rule_definition={"enabled": True, "threshold": 10},
        )

    def build(self, **overrides):
        values = {
            "rule_set": self.rule_set,
            "business_rules": [self.rule],
            "parameters": [],
            "cost_profile": None,
            "captured_at": self.now,
        }
        values.update(overrides)
        return build_parameters_snapshot(**values)

    def test_builds_json_safe_snapshot(self):
        snapshot = self.build()

        self.assertEqual(snapshot["schema_version"], "1.0")
        self.assertEqual(snapshot["rule_set"]["code"], "F1-DEFAULT")
        self.assertEqual(len(snapshot["business_rules"]), 1)
        self.assertEqual(
            snapshot["business_rules"][0]["rule_definition"],
            {"enabled": True, "threshold": 10},
        )
        json.dumps(snapshot, allow_nan=False)

    def test_requires_active_rule_set(self):
        self.rule_set.status = "DRAFT"

        with self.assertRaises(ValidationError):
            self.build()

    def test_rejects_future_effective_rule_set(self):
        self.rule_set.effective_from = self.now + timedelta(days=1)

        with self.assertRaises(ValidationError):
            self.build()

    def test_requires_at_least_one_active_f1_rule(self):
        inactive_rule = SimpleNamespace(
            **{**vars(self.rule), "is_active": False}
        )

        with self.assertRaisesRegex(
            ValidationError,
            "F1_RULE_CONFIGURATION_MISSING",
        ):
            self.build(business_rules=[inactive_rule])

    def test_ignores_inactive_and_non_f1_rules(self):
        inactive_rule = SimpleNamespace(
            **{**vars(self.rule), "pk": 11, "is_active": False}
        )
        other_module_rule = SimpleNamespace(
            **{
                **vars(self.rule),
                "pk": 12,
                "module_code": "F2",
            }
        )

        snapshot = self.build(
            business_rules=[
                self.rule,
                inactive_rule,
                other_module_rule,
            ]
        )

        self.assertEqual(
            [item["rule_code"] for item in snapshot["business_rules"]],
            ["F1_ELIGIBILITY"],
        )

    def test_sorts_business_rules_deterministically(self):
        second_rule = SimpleNamespace(
            **{
                **vars(self.rule),
                "pk": 11,
                "rule_code": "F1_CAPACITY",
                "priority": 2,
            }
        )

        snapshot = self.build(
            business_rules=[second_rule, self.rule]
        )

        self.assertEqual(
            [item["rule_code"] for item in snapshot["business_rules"]],
            ["F1_ELIGIBILITY", "F1_CAPACITY"],
        )

    def test_serializes_parameters_and_cost_profile(self):
        parameter = SimpleNamespace(
            parameter_key="candidate_limit",
            parameter_value=20,
            data_type="INTEGER",
            updated_at=self.now,
        )
        cost_profile = SimpleNamespace(
            pk=5,
            profile_code="COST-01",
            profile_name="Default VND",
            currency_code="VND",
            fixed_transport_cost=Decimal("100000.00"),
            cost_per_km=Decimal("5000.00"),
            additional_handling_cost=Decimal("20000.00"),
            is_active=True,
        )

        snapshot = self.build(
            parameters=[parameter],
            cost_profile=cost_profile,
        )

        self.assertEqual(
            snapshot["parameters"]["candidate_limit"]["value"],
            20,
        )
        self.assertEqual(
            snapshot["cost_profile"]["fixed_transport_cost"],
            "100000.00",
        )
        self.assertEqual(
            snapshot["cost_profile"]["cost_per_km"],
            "5000.00",
        )
        json.dumps(snapshot, allow_nan=False)

    def test_rejects_inactive_cost_profile(self):
        cost_profile = SimpleNamespace(
            is_active=False,
            currency_code="VND",
        )

        with self.assertRaisesRegex(
            ValidationError,
            "COST_PROFILE_NOT_ACTIVE",
        ):
            self.build(cost_profile=cost_profile)

    def test_rejects_non_vnd_cost_profile(self):
        cost_profile = SimpleNamespace(
            is_active=True,
            currency_code="USD",
        )

        with self.assertRaisesRegex(
            ValidationError,
            "COST_PROFILE_CURRENCY_INVALID",
        ):
            self.build(cost_profile=cost_profile)

    def test_rejects_naive_capture_time(self):
        naive_time = self.now.replace(tzinfo=None)

        with self.assertRaisesRegex(
            ValidationError,
            "captured_at must be timezone-aware.",
        ):
            self.build(captured_at=naive_time)

    def test_rejects_non_json_business_rule_definition(self):
        invalid_rule = SimpleNamespace(
            **{
                **vars(self.rule),
                "rule_definition": {"invalid": {1, 2, 3}},
            }
        )

        with self.assertRaises(ValidationError):
            self.build(business_rules=[invalid_rule])

    def test_requires_json_object_for_business_rule_definition(self):
        self.rule.rule_definition = ["configuration"]
        with self.assertRaisesRegex(ValidationError, "RUN_CONFIGURATION_RULE_DEFINITION_MUST_BE_OBJECT"):
            self.build()


from unittest.mock import patch

from planning.models import CostProfile, PlanningRuleSet
from planning.services.run_configuration import load_run_configuration


class LoadRunConfigurationTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.rule_set = SimpleNamespace(
            pk=1,
            rule_set_code="F1-DEFAULT",
            rule_set_name="F1 Default",
            version_no=1,
            status=RuleSetStatus.ACTIVE,
            effective_from=self.now - timedelta(days=1),
        )
        self.rule = SimpleNamespace(
            pk=10,
            rule_code="F1_ELIGIBILITY",
            rule_name="F1 Eligibility",
            module_code=PlanningModuleCode.F1,
            priority=1,
            is_active=True,
            rule_definition={"enabled": True, "threshold": 10},
        )

    def test_execution_locks_parent_before_reading_configuration(self):
        from planning.services import run_configuration as service
        calls = []
        with patch.object(service, "connection") as connection, \
                patch.object(service.PlanningRuleSet, "objects") as rulesets, \
                patch.object(service.PlanningBusinessRule, "objects") as rules, \
                patch.object(service.PlanningParameters, "objects") as parameters:
            connection.in_atomic_block = True
            connection.ops.quote_name.side_effect = lambda table: f'"{table}"'
            cursor = connection.cursor.return_value.__enter__.return_value
            cursor.execute.side_effect = lambda sql: calls.append(sql)
            rulesets.select_for_update.return_value.get.side_effect = (
                lambda **kwargs: calls.append("lock") or self.rule_set
            )
            rules.filter.side_effect = (
                lambda **kwargs: calls.append("rules") or rules.filter.return_value
            )
            rules.filter.return_value.order_by.return_value = [self.rule]
            parameters.all.side_effect = lambda: calls.append("parameters") or parameters.all.return_value
            parameters.all.return_value.order_by.return_value = []
            snapshot = load_run_configuration(rule_set_id=1, captured_at=self.now, lock_rule_set=True)
        self.assertEqual(calls, [
            "lock", 'LOCK TABLE "business_rules", "planning_parameters" IN SHARE MODE',
            "rules", "parameters",
        ])
        self.assertEqual(snapshot["rule_set"]["id"], 1)
        rulesets.get.assert_not_called()

    def test_execution_rejects_lock_outside_transaction(self):
        from planning.services import run_configuration as service
        with patch.object(service, "connection") as connection:
            connection.in_atomic_block = False
            with self.assertRaisesRegex(RuntimeError, "RULE_SET_LOCK_REQUIRES_TRANSACTION"):
                load_run_configuration(rule_set_id=1, lock_rule_set=True)

    @override_settings(COLOGI_F1_MVCC_CONFIGURATION_PIN=True)
    def test_restricted_role_requires_a_stable_configuration_snapshot(self):
        from planning.services import run_configuration as service

        with patch.object(service, "connection") as connection, \
                patch.object(service.PlanningRuleSet, "objects") as rulesets, \
                patch.object(service.PlanningBusinessRule, "objects") as rules, \
                patch.object(service.PlanningParameters, "objects") as parameters:
            connection.in_atomic_block = True
            cursor = connection.cursor.return_value.__enter__.return_value
            rulesets.select_for_update.return_value.get.return_value = self.rule_set
            rules.filter.return_value.order_by.return_value = [self.rule]
            parameters.all.return_value.order_by.return_value = []
            cursor.fetchone.return_value = ("read committed",)
            with self.assertRaisesRegex(RuntimeError, "MVCC_CONFIGURATION_PIN_REQUIRES_A_STABLE_SNAPSHOT"):
                load_run_configuration(rule_set_id=1, captured_at=self.now, lock_rule_set=True)
            rules.filter.assert_not_called()

            cursor.reset_mock()
            cursor.fetchone.return_value = ("repeatable read",)
            snapshot = load_run_configuration(rule_set_id=1, captured_at=self.now, lock_rule_set=True)
            cursor.execute.assert_called_once_with("SHOW transaction_isolation")
            self.assertEqual(snapshot["rule_set"]["id"], self.rule_set.pk)

    @patch("planning.services.run_configuration.PlanningParameters.objects")
    @patch("planning.services.run_configuration.PlanningBusinessRule.objects")
    @patch("planning.services.run_configuration.PlanningRuleSet.objects")
    def test_loads_active_configuration(
        self,
        rule_set_manager,
        business_rule_manager,
        parameter_manager,
    ):
        rule_set_manager.get.return_value = self.rule_set
        business_rule_manager.filter.return_value.order_by.return_value = [
            self.rule
        ]
        parameter_manager.all.return_value.order_by.return_value = []

        snapshot = load_run_configuration(
            rule_set_id=1,
            captured_at=self.now,
        )

        self.assertEqual(snapshot["rule_set"]["code"], "F1-DEFAULT")
        self.assertEqual(
            snapshot["business_rules"][0]["rule_code"],
            "F1_ELIGIBILITY",
        )
        rule_set_manager.get.assert_called_once_with(pk=1)
        business_rule_manager.filter.assert_called_once()

    @patch("planning.services.run_configuration.PlanningRuleSet.objects")
    def test_rejects_missing_rule_set(self, rule_set_manager):
        rule_set_manager.get.side_effect = PlanningRuleSet.DoesNotExist

        with self.assertRaisesRegex(
            ValidationError,
            "PLANNING_RULE_SET_NOT_FOUND",
        ):
            load_run_configuration(rule_set_id=999, captured_at=self.now)

    @patch("planning.services.run_configuration.PlanningRuleSet.objects")
    def test_rejects_inactive_rule_set_before_loading_rules(
        self,
        rule_set_manager,
    ):
        self.rule_set.status = "DRAFT"
        rule_set_manager.get.return_value = self.rule_set

        with patch(
            "planning.services.run_configuration.PlanningBusinessRule.objects"
        ) as business_rule_manager:
            with self.assertRaisesRegex(
                ValidationError,
                "PLANNING_RULE_SET_NOT_ACTIVE",
            ):
                load_run_configuration(
                    rule_set_id=1,
                    captured_at=self.now,
                )

        business_rule_manager.filter.assert_not_called()

    @patch("planning.services.run_configuration.PlanningRuleSet.objects")
    @patch("planning.services.run_configuration.PlanningBusinessRule.objects")
    def test_rejects_missing_active_f1_rule(
        self,
        business_rule_manager,
        rule_set_manager,
    ):
        rule_set_manager.get.return_value = self.rule_set
        business_rule_manager.filter.return_value.order_by.return_value = []

        with self.assertRaisesRegex(
            ValidationError,
            "F1_RULE_CONFIGURATION_MISSING",
        ):
            load_run_configuration(
                rule_set_id=1,
                captured_at=self.now,
            )

    @patch("planning.services.run_configuration.CostProfile.objects")
    @patch("planning.services.run_configuration.PlanningParameters.objects")
    @patch("planning.services.run_configuration.PlanningBusinessRule.objects")
    @patch("planning.services.run_configuration.PlanningRuleSet.objects")
    def test_rejects_missing_cost_profile(
        self,
        rule_set_manager,
        business_rule_manager,
        parameter_manager,
        cost_profile_manager,
    ):
        rule_set_manager.get.return_value = self.rule_set
        business_rule_manager.filter.return_value.order_by.return_value = [
            self.rule
        ]
        parameter_manager.all.return_value.order_by.return_value = []
        cost_profile_manager.get.side_effect = CostProfile.DoesNotExist

        with self.assertRaisesRegex(
            ValidationError,
            "COST_PROFILE_NOT_FOUND",
        ):
            load_run_configuration(
                rule_set_id=1,
                cost_profile_id=999,
                captured_at=self.now,
            )
