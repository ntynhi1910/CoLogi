"""Source-only lifecycle tests: every ORM and transaction boundary is mocked.

These tests require Django imports but do not create a DB, run migrations,
or verify real PostgreSQL rollback/isolation. Those need an approved DB.
"""

from datetime import date, datetime, time, timezone
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.core.exceptions import ValidationError

from planning.models import (
    EligibilityStatus, MatchingStatus, PlanGuardStatus, PlanningRun,
    PlanningRunDemand, PlanningRunStatus,
)
from planning.services import run_execution as service, test_snapshot_evaluator
from planning.services.plan_guard import _authoritative_reference
from planning.services.run_preview import preview_f1_run
from planning.services.test_run_preview import valid_configuration, valid_v11_snapshot


class RunExecutionTests(TestCase):
    def setUp(self):
        self.actor = SimpleNamespace(pk=3)
        self.run = SimpleNamespace(
            pk=7, run_code=uuid4(), initiated_by_id=3,
            status=PlanningRunStatus.IN_PROGRESS,
            started_at=datetime(2026, 11, 24, tzinfo=timezone.utc),
            parameters_snapshot=valid_configuration(), save=MagicMock(),
        )
        self.run.parameters_snapshot["parameters"] = {
            "max_group_size": {"value": 4},
            "max_candidates_per_run": {"value": 100},
        }

    def test_model_has_pending_eligibility_and_failure_diagnostics(self):
        self.assertIn("NOT_EVALUATED", EligibilityStatus.values)
        self.assertEqual(PlanningRunDemand._meta.get_field("eligibility_status").default,
                         EligibilityStatus.NOT_EVALUATED)
        self.assertEqual(PlanningRun._meta.get_field("failure_diagnostics").get_default(), [])

    def test_execution_requires_both_pinned_limits(self):
        with self.assertRaisesRegex(ValidationError, "F1_EXECUTION_REQUIRES_CANDIDATE_LIMITS"):
            service.require_f1_execution_configuration(valid_configuration())

    def test_execution_rejects_missing_mandatory_rule(self):
        configuration = self.run.parameters_snapshot
        configuration["business_rules"].pop(4)
        with self.assertRaisesRegex(ValidationError, "Mandatory F1 BusinessRules are missing: RULE-05"):
            service.require_f1_execution_configuration(configuration)

    def test_execution_rejects_unknown_rule_and_unapproved_definition(self):
        configuration = self.run.parameters_snapshot
        rule = configuration["business_rules"][0]
        with self.subTest("unknown code"):
            rule["rule_code"] = "UNREVIEWED"
            with self.assertRaisesRegex(ValidationError, "no supported definition: UNREVIEWED"):
                service.require_f1_execution_configuration(configuration)
        with self.subTest("changed definition"):
            rule["rule_code"] = "RULE-01"
            rule["rule_definition"]["expression"] = "always pass"
            with self.assertRaisesRegex(ValidationError, "definition is invalid: RULE-01"):
                service.require_f1_execution_configuration(configuration)

    def test_execution_accepts_known_nonmandatory_rows(self):
        configuration = self.run.parameters_snapshot
        configuration["business_rules"].extend([
            {"rule_id": 9, "rule_code": "RULE-09", "rule_definition": {
                "expression": "no auto final approval", "rule_type": "B",
            }},
            {"rule_id": 26, "rule_code": "RULE-26", "rule_definition": {
                "expression": "override_reason required", "rule_type": "B",
            }},
        ])
        self.assertEqual(service.require_f1_execution_configuration(configuration), (4, 100))

    def test_execution_validates_bounds_and_fixed_minimum(self):
        configuration = self.run.parameters_snapshot
        parameters = configuration["parameters"]
        for key, invalid in (
            ("max_group_size", 1), ("max_group_size", True),
            ("max_candidates_per_run", 0), ("max_candidates_per_run", "10"),
        ):
            with self.subTest(key=key, invalid=invalid):
                previous = parameters[key]["value"]
                parameters[key]["value"] = invalid
                with self.assertRaises(ValidationError):
                    service.require_f1_execution_configuration(configuration)
                parameters[key]["value"] = previous
        parameters["MIN_CANDIDATE_DEMANDS"] = {"value": 3}
        with self.assertRaisesRegex(ValidationError, "MIN_CANDIDATE_DEMANDS must agree with RULE-03"):
            service.require_f1_execution_configuration(configuration)

    def test_initialization_pins_configuration_and_requires_lock_before_create(self):
        configuration = self.run.parameters_snapshot
        calls = []
        with patch.object(service.transaction, "atomic") as atomic, \
                patch.object(service, "connection") as connection, \
                patch.object(service, "_check_scope", side_effect=lambda *_: calls.append("scope") or ((1, 2), ())), \
                patch.object(service, "preflight_f1_dates", side_effect=lambda *_, **__: calls.append("dates")), \
                patch.object(service, "load_run_configuration", side_effect=lambda **_: calls.append("pin") or configuration) as load, \
                patch.object(service.PlanningRun, "objects") as runs:
            cursor = connection.cursor.return_value.__enter__.return_value
            cursor.execute.side_effect = lambda sql: calls.append(sql)
            runs.create.side_effect = lambda **_: calls.append("create") or self.run
            run, ids = service._initialize_run(self.actor, [2, 1], 1, None, "MANUAL")
        self.assertEqual(calls, [
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED", "scope", "dates", "pin", "create",
        ])
        self.assertEqual(ids, (1, 2))
        self.assertIs(run, self.run)
        self.assertTrue(load.call_args.kwargs["lock_rule_set"])
        self.assertEqual(runs.create.call_args.kwargs["parameters_snapshot"], configuration)
        self.assertEqual(runs.create.call_args.kwargs["status"], PlanningRunStatus.IN_PROGRESS)
        atomic.assert_called_once_with(durable=True)

    def test_capture_requires_complete_scope_before_persisting(self):
        with patch.object(service.transaction, "atomic") as atomic, \
                patch.object(service, "_set_repeatable_read") as repeatable, \
                patch.object(service, "_locked_in_progress_run", return_value=self.run), \
                patch.object(service, "_check_scope", return_value=((1, 2), ())), \
                patch.object(service, "validate_f1_dates"), \
                patch.object(service, "load_f1_orm_data", return_value=SimpleNamespace(
                    selected_demands=[SimpleNamespace(pk=1), SimpleNamespace(pk=2)], capacity_requests=[])), \
                patch.object(service, "build_demand_snapshots", return_value={1: valid_v11_snapshot(demand_id=1)}), \
                patch.object(service.PlanningRunDemand, "objects") as demands:
            demands.filter.return_value.exists.return_value = False
            with self.assertRaisesRegex(service.RunExecutionError, "RUN_CAPTURE_SNAPSHOT_SET_MISMATCH"):
                service._capture_scope(self.run.pk, self.actor, (1, 2))
            demands.bulk_create.assert_not_called()
            atomic.assert_called_once_with(durable=True)
            repeatable.assert_called_once()

    def test_capture_writes_pending_rows_only_after_validating_all_snapshots(self):
        snapshots = {i: valid_v11_snapshot(demand_id=i) for i in (1, 2)}
        calls = []
        with patch.object(service.transaction, "atomic"), \
                patch.object(service, "_set_repeatable_read", side_effect=lambda: calls.append("isolation")), \
                patch.object(service, "_locked_in_progress_run", side_effect=lambda _: calls.append("lock") or self.run), \
                patch.object(service, "_check_scope", return_value=((1, 2), ())), \
                patch.object(service, "validate_f1_dates"), \
                patch.object(service, "load_f1_orm_data", return_value=SimpleNamespace(
                    selected_demands=[SimpleNamespace(pk=1), SimpleNamespace(pk=2)], capacity_requests=[])), \
                patch.object(service, "build_demand_snapshots", return_value=snapshots), \
                patch.object(service.PlanningRunDemand, "objects") as demands:
            demands.filter.return_value.exists.return_value = False
            service._capture_scope(self.run.pk, self.actor, (1, 2))
        self.assertEqual(calls, ["isolation", "lock"])
        rows = demands.bulk_create.call_args.args[0]
        self.assertEqual([row.demand_id for row in rows], [1, 2])
        self.assertEqual([row.eligibility_status for row in rows], [EligibilityStatus.NOT_EVALUATED] * 2)
        self.assertEqual([row.demand_snapshot for row in rows], list(snapshots.values()))

    def test_result_reads_only_persisted_snapshot_and_pinned_configuration(self):
        rows, completed = self._result_fixture()
        for row in rows:
            row.demand_snapshot = valid_v11_snapshot(demand_id=row.demand_id)
        with patch.object(service.transaction, "atomic") as atomic, \
                patch.object(service, "_locked_in_progress_run", return_value=self.run), \
                patch.object(service.PlanningRunDemand, "objects") as demands, \
                patch.object(service, "_evaluate_for_execution", return_value=completed) as evaluate, \
                patch.object(service, "_persist_completed_results") as persist, \
                patch.object(service, "load_f1_orm_data") as orm, \
                patch.object(service, "load_run_configuration") as config:
            demands.select_for_update.return_value.filter.return_value.order_by.return_value = rows
            service._evaluate_and_persist(self.run.pk, (1, 2))
        atomic.assert_called_once_with(durable=True)
        evaluate.assert_called_once_with(tuple(row.demand_snapshot for row in rows), self.run.parameters_snapshot)
        persist.assert_called_once_with(self.run, rows, completed)
        orm.assert_not_called()
        config.assert_not_called()

    def test_result_rejects_snapshots_attached_to_wrong_demands(self):
        rows = [
            SimpleNamespace(demand_id=row_id, demand_snapshot=valid_v11_snapshot(demand_id=snapshot_id))
            for row_id, snapshot_id in ((1, 2), (2, 1))
        ]
        with patch.object(service.transaction, "atomic"), \
                patch.object(service, "_locked_in_progress_run", return_value=self.run), \
                patch.object(service.PlanningRunDemand, "objects") as demands, \
                patch.object(service, "_evaluate_for_execution") as evaluate, \
                patch.object(service, "_persist_completed_results") as persist:
            demands.select_for_update.return_value.filter.return_value.order_by.return_value = rows
            with self.assertRaisesRegex(service.RunExecutionError, "RUN_RESULT_SCOPE_MISMATCH"):
                service._evaluate_and_persist(self.run.pk, (1, 2))
        evaluate.assert_not_called()
        persist.assert_not_called()

    def test_result_rejects_snapshots_from_different_capture_times(self):
        first = valid_v11_snapshot(demand_id=1)
        second = valid_v11_snapshot(demand_id=2)
        second["captured_at"] = "2026-11-17T01:00:01Z"
        rows = [
            SimpleNamespace(demand_id=1, demand_snapshot=first),
            SimpleNamespace(demand_id=2, demand_snapshot=second),
        ]
        with patch.object(service.transaction, "atomic"), \
                patch.object(service, "_locked_in_progress_run", return_value=self.run), \
                patch.object(service.PlanningRunDemand, "objects") as demands, \
                patch.object(service, "_evaluate_for_execution") as evaluate:
            demands.select_for_update.return_value.filter.return_value.order_by.return_value = rows
            with self.assertRaisesRegex(service.RunExecutionError, "RUN_RESULT_SCOPE_MISMATCH"):
                service._evaluate_and_persist(self.run.pk, (1, 2))
        evaluate.assert_not_called()

    def test_initialization_failure_does_not_attempt_capture_or_failure_record(self):
        with patch.object(service, "connection") as connection, \
                patch.object(service, "_initialize_run", side_effect=ValidationError("invalid scope")), \
                patch.object(service, "_capture_scope") as capture, \
                patch.object(service, "_record_failure") as record:
            connection.vendor = "postgresql"
            connection.in_atomic_block = False
            connection.get_autocommit.return_value = True
            with self.assertRaises(ValidationError):
                service.execute_f1_run_for_actor(actor=self.actor, demand_ids=[1], rule_set_id=5)
            capture.assert_not_called()
            record.assert_not_called()

    def _execute_with_failure(self, stage, error, recording_error=None):
        with patch.object(service, "connection") as connection, \
                patch.object(service, "_initialize_run", return_value=(self.run, (1, 2))), \
                patch.object(service, "_capture_scope") as capture, \
                patch.object(service, "_evaluate_and_persist") as result, \
                patch.object(service, "_record_failure") as failure:
            connection.vendor = "postgresql"
            connection.in_atomic_block = False
            connection.get_autocommit.return_value = True
            (capture if stage == "CAPTURE" else result).side_effect = error
            failure.return_value = SimpleNamespace(status=PlanningRunStatus.FAILED)
            failure.side_effect = recording_error
            if recording_error:
                with self.assertRaises(service.RunFailureRecordingError):
                    service.execute_f1_run_for_actor(actor=self.actor, demand_ids=[1, 2], rule_set_id=5)
            else:
                returned = service.execute_f1_run_for_actor(actor=self.actor, demand_ids=[1, 2], rule_set_id=5)
                self.assertEqual(returned.status, PlanningRunStatus.FAILED)
            failure.assert_called_once_with(self.run.pk, stage, error)
            if stage == "CAPTURE":
                result.assert_not_called()

    def test_capture_failure_routes_to_separate_failure_handler(self):
        self._execute_with_failure("CAPTURE", ValueError("capture failed"))

    def test_result_failure_routes_to_separate_failure_handler(self):
        self._execute_with_failure("RESULT", ValueError("result failed"))

    def test_failure_recording_error_is_not_reported_as_failed(self):
        self._execute_with_failure("RESULT", ValueError("result failed"), RuntimeError("DB unavailable"))

    def test_mixed_plan_guard_fails_closed_and_preserves_conflict_ids(self):
        statuses = ("PASS", "PASS", "CONFLICT", "PASS", "NOT_EVALUATED")
        scope_ids = tuple(range(1, len(statuses) + 1))
        fixture = test_snapshot_evaluator.SnapshotEvaluatorTests()
        requests = [
            fixture.make_request(
                request_id=600 + demand_id, demand_id=demand_id,
                demand_item_id=400 + demand_id, supplier_item_id=501,
            )
            for demand_id in scope_ids
        ]
        rows = []
        for demand_id, status in zip(scope_ids, statuses):
            snapshot = fixture.make_demand(
                demand_id=demand_id, outlet_id=100 + demand_id, request_list=requests,
            )
            if status != "NOT_EVALUATED":
                snapshot["gate_evidence"]["plan_guard"].update(
                    status=status, evaluated_at=snapshot["captured_at"],
                    evidence_reference=_authoritative_reference(
                        demand_id, [(42, 41)] if status == "CONFLICT" else (),
                    ),
                )
            rows.append(SimpleNamespace(demand_id=demand_id, demand_snapshot=snapshot))
        preview = preview_f1_run(
            snapshots=[row.demand_snapshot for row in rows],
            configuration_snapshot=self.run.parameters_snapshot,
        )
        self.assertTrue(preview.all_demands_eligible)
        self.assertEqual(preview.candidate_groups, ())
        with patch.object(service.transaction, "atomic"), \
                patch.object(service, "_locked_in_progress_run", return_value=self.run), \
                patch.object(service.PlanningRunDemand, "objects") as demands, \
                patch.object(service, "_persist_completed_results") as persist:
            demands.select_for_update.return_value.filter.return_value.order_by.return_value = rows
            with self.assertRaises(service.RunExecutionError) as error:
                service._evaluate_and_persist(self.run.pk, scope_ids)
        self.assertEqual(error.exception.code, "PLAN_GUARD_NOT_EVALUATED")
        self.assertEqual(error.exception.details["demand_ids"], [5])
        self.assertEqual(error.exception.details["conflict_demand_ids"], [3])
        persist.assert_not_called()

    def test_execution_returns_same_groups_on_snapshot_replay(self):
        fixture = test_snapshot_evaluator.SnapshotEvaluatorTests()
        scope = (1, 2, 3)
        requests = [
            fixture.make_request(
                request_id=600 + demand_id, demand_id=demand_id,
                demand_item_id=400 + demand_id, supplier_item_id=501,
            )
            for demand_id in scope
        ]
        snapshots = []
        for demand_id in scope:
            snapshot = fixture.make_demand(
                demand_id=demand_id, outlet_id=100 + demand_id, request_list=requests,
            )
            status = "CONFLICT" if demand_id == 3 else "PASS"
            snapshot["gate_evidence"]["plan_guard"].update(
                status=status, evaluated_at=snapshot["captured_at"],
                evidence_reference=_authoritative_reference(demand_id, [(42, 41)] if demand_id == 3 else ()),
            )
            snapshots.append(snapshot)
        first = service._evaluate_for_execution(tuple(snapshots), self.run.parameters_snapshot)
        replay = service._evaluate_for_execution(tuple(snapshots), self.run.parameters_snapshot)
        self.assertEqual(first, replay)
        self.assertEqual([group.demand_ids for group in first.candidate_groups], [(1, 2)])
        self.assertEqual(first.demand_results[2].plan_guard_status, "CONFLICT")

    def test_overflow_has_explicit_incomplete_outcome(self):
        with patch.object(service, "evaluate_f1_snapshots", side_effect=service.CandidateLimitExceeded()):
            with self.assertRaises(service.RunExecutionError) as error:
                service._evaluate_for_execution((valid_v11_snapshot("PASS"),), self.run.parameters_snapshot)
        self.assertEqual(error.exception.details["matching_outcome"], "MATCHING_INCOMPLETE")

    def test_failure_does_not_include_raw_exception_text(self):
        with patch.object(service.transaction, "atomic"), \
                patch.object(service.PlanningRun, "objects") as manager:
            manager.select_for_update.return_value.get.return_value = self.run
            service._record_failure(self.run.pk, "RESULT", ValueError("sensitive data"))
        self.assertEqual(self.run.status, PlanningRunStatus.FAILED)
        self.assertEqual(self.run.failure_diagnostics, [{"stage": "RESULT", "code": "RUN_RESULT_FAILED"}])
        self.run.save.assert_called_once_with(update_fields=["status", "completed_at", "failure_diagnostics"])

    def test_failure_handler_does_not_overwrite_terminal_run(self):
        self.run.status = PlanningRunStatus.COMPLETED
        with patch.object(service.transaction, "atomic"), \
                patch.object(service.PlanningRun, "objects") as manager:
            manager.select_for_update.return_value.get.return_value = self.run
            returned = service._record_failure(self.run.pk, "RESULT", ValueError())
        self.assertEqual(returned.status, PlanningRunStatus.COMPLETED)
        self.run.save.assert_not_called()

    def _result_fixture(self, conflict=False):
        rows = [SimpleNamespace(demand_id=i, demand_snapshot={"unchanged": i}) for i in (1, 2)]
        outcomes = tuple(SimpleNamespace(
            demand_id=i, eligibility_status=EligibilityStatus.ELIGIBLE,
            plan_guard_status=PlanGuardStatus.CONFLICT if conflict and i == 2 else PlanGuardStatus.PASS,
            primary_reason_code=None, blockers=(), diagnostics=(),
        ) for i in (1, 2))
        group = SimpleNamespace(demand_ids=(1, 2), requested_date=date(2026, 11, 20),
                                cargo_category_ids=(1,), common_start_time=time(8), common_end_time=time(9))
        return rows, service.CompletedF1Evaluation(outcomes, (group,))

    def test_completed_result_persists_memberships_and_status_without_changing_snapshots(self):
        rows, result = self._result_fixture()
        with patch.object(service, "connection") as connection, \
                patch.object(service.CollaborationGroup, "objects") as groups, \
                patch.object(service.GroupDemand, "objects") as members, \
                patch.object(service.PlanningRunDemand, "objects") as demands:
            connection.in_atomic_block = True
            groups.filter.return_value.exists.return_value = False
            groups.create.return_value = SimpleNamespace(pk=11)
            service._persist_completed_results(self.run, rows, result)
        self.assertEqual(self.run.status, PlanningRunStatus.COMPLETED)
        self.assertEqual([r.matching_status for r in rows], [MatchingStatus.INCLUDED] * 2)
        self.assertEqual([r.demand_snapshot for r in rows], [{"unchanged": 1}, {"unchanged": 2}])
        self.assertEqual([m.demand_id for m in members.bulk_create.call_args.args[0]], [1, 2])
        self.assertNotIn("demand_snapshot", demands.bulk_update.call_args.args[1])
        self.run.save.assert_called_once_with(update_fields=["status", "completed_at"])

    def test_invalid_group_containing_conflict_rejected_before_writes(self):
        rows, result = self._result_fixture(conflict=True)
        with patch.object(service, "connection") as connection, \
                patch.object(service.CollaborationGroup, "objects") as groups:
            connection.in_atomic_block = True
            with self.assertRaisesRegex(service.RunExecutionError, "RUN_RESULT_CANDIDATE_GATE_BLOCKED"):
                service._persist_completed_results(self.run, rows, result)
            groups.create.assert_not_called()
        self.run.save.assert_not_called()

    def test_read_only_preview_never_qualifies_as_completed_result(self):
        with self.assertRaisesRegex(service.RunExecutionError, "F1_COMPLETED_EVALUATION_REQUIRED"):
            service._persist_completed_results(self.run, [], SimpleNamespace(candidate_groups=()))
