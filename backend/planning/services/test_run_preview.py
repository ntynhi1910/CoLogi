from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from planning.services.run_preview import (
    NOT_EVALUATED,
    preview_f1_run,
)

from planning.f1.cargo_compatibility import (
    dataset_v7_cargo_compatibility_rows,
)
from planning.f1.candidate_groups import CandidateLimitExceeded
from planning.services.plan_guard import _authoritative_reference
from planning.services.test_snapshot_evaluator import (
    SnapshotEvaluatorTests,
)
def valid_configuration():
    return {

        "schema_version": "1.0",
        "captured_at": "2026-11-17T10:00:00+07:00",
        "rule_set": {
            "id": 1,
            "code": "CP8-F1",
            "name": "CP8 F1",
            "version_no": 1,
        },
        "business_rules": [
            {
                "rule_id": index,
                "rule_code": f"RULE-{index:02d}",
                "rule_definition": {"expression": expression, "rule_type": rule_type},
            }
            for index, (expression, rule_type) in enumerate((
                ("status == SUBMITTED", "B"),
                ("supplier/outlet/date/weight required", "B"),
                ("candidate_count >= 2", "B"),
                ("distinct_outlets >= 2", "B"),
                ("not finalized_elsewhere", "B"),
                ("cargo_compatibility == TRUE", "B"),
                ("use configured matrix", "B"),
                ("date/time compatibility", "B/R"),
            ), 1)
        ],
        "parameters": {},
        "cargo_compatibility_matrix": {
            "source": "CoLogi_Dataset_v7",
            "sheet": "08_Cargo_Compat",
            "rows": list(dataset_v7_cargo_compatibility_rows()),
        },
        "cost_profile": None,
    }

def fake_snapshot(demand_id=101):
        return {
            "demand_ref": {
                "model_label": "demands.DeliveryDemand",
                "pk": str(demand_id),
            }
        }
def valid_v11_snapshot(status="NOT_EVALUATED", demand_id=101):
    snapshot = SnapshotEvaluatorTests().make_demand(
        demand_id=demand_id,
    )

    evidence = snapshot["gate_evidence"]["plan_guard"]
    evidence["status"] = status

    if status == "NOT_EVALUATED":
        evidence["evaluated_at"] = None
        evidence["evidence_reference"] = None
    else:
        evidence["evaluated_at"] = "2026-11-17T08:00:00Z"
        evidence["evidence_reference"] = _authoritative_reference(
            demand_id, [(42, 41)] if status == "CONFLICT" else (),
        )

    return snapshot
def fake_evaluation(
    *,
    eligibility_status="ELIGIBLE",
    blockers=(),
    diagnostics=(),
    candidate_groups=(),
    demand_ids=(101,),
):
    demand_evaluations = tuple(
        SimpleNamespace(
            demand_id=demand_id,
            capacity_results=(),
            eligibility=SimpleNamespace(
                eligibility_status=eligibility_status,
                blockers=blockers,
                diagnostics=diagnostics,
                primary_reason_code=None,
                reason_codes=(),
                detail="Test evaluation",
            ),
        )
        for demand_id in demand_ids
    )
    return SimpleNamespace(
        demand_evaluations=demand_evaluations,
        candidate_groups=candidate_groups,
    )


class RunPreviewTests(SimpleTestCase):
    def test_conflict_removed_before_real_maximal_enumeration(self):
        fixture = SnapshotEvaluatorTests()
        requests = [fixture.make_request(
            request_id=600 + i, demand_id=i, demand_item_id=400 + i,
            supplier_item_id=501,
        ) for i in range(1, 4)]
        snapshots = [fixture.make_demand(
            demand_id=i, outlet_id=100 + i, request_list=requests,
        ) for i in range(1, 4)]
        for i, snapshot in enumerate(snapshots, 1):
            snapshot["gate_evidence"]["plan_guard"].update(
                status="CONFLICT" if i == 3 else "PASS",
                evaluated_at=snapshot["captured_at"],
                evidence_reference=_authoritative_reference(i, [(42, 41)] if i == 3 else ()),
            )
        result = preview_f1_run(
            snapshots=snapshots, configuration_snapshot=valid_configuration(),
        )
        self.assertEqual([g.demand_ids for g in result.candidate_groups], [(1, 2)])
        self.assertEqual(len(result.demand_results), 3)
        self.assertEqual(result.plan_guard_status, "CONFLICT")

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    def test_unresolved_gate_skips_candidate_enumeration(self, evaluate):
        evaluate.return_value = fake_evaluation(demand_ids=(101, 102))
        preview_f1_run(snapshots=[valid_v11_snapshot("PASS", 101),
                                  valid_v11_snapshot("NOT_EVALUATED", 102)],
                       configuration_snapshot=valid_configuration())
        self.assertEqual(evaluate.call_args.kwargs["candidate_demand_ids"], ())

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    def test_pinned_limits_forwarded_to_evaluator(self, evaluate):
        evaluate.return_value = fake_evaluation()
        configuration = valid_configuration()
        configuration["parameters"] = {
            "max_group_size": {"value": 4},
            "max_candidates_per_run": {"value": 100},
        }
        preview_f1_run(snapshots=[valid_v11_snapshot("PASS")],
                       configuration_snapshot=configuration)
        self.assertEqual(evaluate.call_args.kwargs["max_group_size"], 4)
        self.assertEqual(evaluate.call_args.kwargs["max_candidates_per_run"], 100)

    def test_missing_one_pinned_limit_rejects_preview(self):
        configuration = valid_configuration()
        configuration["parameters"] = {"max_group_size": {"value": 4}}
        with self.assertRaises(ValidationError):
            preview_f1_run(snapshots=[valid_v11_snapshot("PASS")],
                           configuration_snapshot=configuration)

    @patch("planning.services.run_preview.evaluate_f1_snapshots",
           side_effect=CandidateLimitExceeded())
    def test_overflow_is_an_error_not_an_empty_success(self, evaluate):
        with self.assertRaisesMessage(ValidationError, "CANDIDATE_LIMIT_EXCEEDED"):
            preview_f1_run(snapshots=[valid_v11_snapshot("PASS")],
                           configuration_snapshot=valid_configuration())

    def test_missing_cargo_compatibility_matrix_is_rejected(self):
        configuration = valid_configuration()
        del configuration["cargo_compatibility_matrix"]

        with self.assertRaises(ValidationError):
            preview_f1_run(
                snapshots=[{"demand_ref": {"demand_id": 101}}],
                configuration_snapshot=configuration,
            )

    def test_invalid_cargo_compatibility_matrix_is_rejected(self):
        configuration = valid_configuration()
        configuration["cargo_compatibility_matrix"]["rows"] = []

        with self.assertRaises(ValidationError):
            preview_f1_run(
                snapshots=[{"demand_ref": {"demand_id": 101}}],
                configuration_snapshot=configuration,
            )
    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    @patch(
        "planning.services.run_preview.evaluate_snapshot_plan_guard",
        return_value=NOT_EVALUATED,
    )
    def test_eligible_demand_keeps_all_unimplemented_gates_closed(
        self, evaluate_plan_guard, evaluate,
    ):
        evaluate.return_value = fake_evaluation()
        preview = preview_f1_run(
            snapshots=[fake_snapshot(101)],
            configuration_snapshot=valid_configuration(),
        )

        self.assertEqual(preview.demand_results[0].eligibility_status, "ELIGIBLE")
        self.assertEqual(preview.plan_guard_status, NOT_EVALUATED)
        self.assertEqual(preview.matching_status, NOT_EVALUATED)
        self.assertEqual(
            preview.business_rules_execution,
            NOT_EVALUATED,
        )
        self.assertFalse(preview.ready_to_finalize)
        self.assertTrue(preview.all_demands_eligible)
        evaluate.assert_called_once()

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    @patch(
        "planning.services.run_preview.evaluate_snapshot_plan_guard",
        return_value=NOT_EVALUATED,
    )
    def test_excluded_demand_remains_excluded(
        self, evaluate_plan_guard, evaluate,
    ):
        evaluate.return_value = fake_evaluation(
            eligibility_status="EXCLUDED",
            blockers=("CAPACITY_EXCEEDED",),
            diagnostics=("CAPACITY_DIAGNOSTIC",),
        )
        preview = preview_f1_run(
            snapshots=[fake_snapshot(101)],
            configuration_snapshot=valid_configuration(),
        )

        result = preview.demand_results[0]
        self.assertEqual(result.eligibility_status, "EXCLUDED")
        self.assertEqual(result.blockers, ("CAPACITY_EXCEEDED",))
        self.assertEqual(result.diagnostics, ("CAPACITY_DIAGNOSTIC",))
        self.assertFalse(preview.all_demands_eligible)
        self.assertFalse(preview.ready_to_finalize)

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    @patch(
        "planning.services.run_preview.evaluate_snapshot_plan_guard",
        return_value=NOT_EVALUATED,
    )
    def test_candidate_groups_are_withheld_when_plan_guard_not_evaluated(
        self, evaluate_plan_guard, evaluate,
    ):
        candidate = object()
        evaluate.return_value = fake_evaluation(
            candidate_groups=(candidate,),
        )

        preview = preview_f1_run(
            snapshots=[fake_snapshot(101)],
            configuration_snapshot=valid_configuration(),
        )

        self.assertEqual(preview.candidate_groups, ())
        self.assertEqual(preview.plan_guard_status, NOT_EVALUATED)
        self.assertFalse(preview.ready_to_finalize)

    def test_missing_business_rule_is_rejected(self):
        configuration = valid_configuration()
        configuration["business_rules"] = []

        with self.assertRaises(ValidationError):
            preview_f1_run(
                snapshots=[{"demand_ref": {"demand_id": 101}}],
                configuration_snapshot=configuration,
            )

    def test_invalid_or_naive_configuration_timestamp_is_rejected(self):
        for value in ("not-a-date", "2026-11-17T10:00:00"):
            configuration = valid_configuration()
            configuration["captured_at"] = value

            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    preview_f1_run(
                        snapshots=[{"demand_ref": {"demand_id": 101}}],
                        configuration_snapshot=configuration,
                    )

    def test_empty_snapshots_are_rejected(self):
        with self.assertRaises(ValidationError):
            preview_f1_run(
                snapshots=[],
                configuration_snapshot=valid_configuration(),
            )

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    @patch(
        "planning.services.run_preview.evaluate_snapshot_plan_guard",
        return_value=NOT_EVALUATED,
    )
    def test_preview_does_not_mutate_inputs(
        self, evaluate_plan_guard, evaluate,
    ):
        evaluate.return_value = fake_evaluation()

        snapshots = [fake_snapshot(101)]
        configuration = valid_configuration()

        original_snapshots = deepcopy(snapshots)
        original_configuration = deepcopy(configuration)

        preview_f1_run(
            snapshots=snapshots,
            configuration_snapshot=configuration,
        )

        self.assertEqual(snapshots, original_snapshots)
        self.assertEqual(configuration, original_configuration)

    def test_invalid_configuration_object_is_rejected(self):
        with self.assertRaises(ValidationError):
            preview_f1_run(
                snapshots=[{"demand_ref": {"demand_id": 101}}],
                configuration_snapshot=None,
            )

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    def test_plan_guard_pass_is_read_from_v11_snapshot(
        self, evaluate,
    ):
        evaluate.return_value = fake_evaluation()

        preview = preview_f1_run(
            snapshots=[valid_v11_snapshot("PASS")],
            configuration_snapshot=valid_configuration(),
        )

        self.assertEqual(preview.plan_guard_status, "PASS")
        self.assertEqual(
            preview.demand_results[0].plan_guard_status,
            "PASS",
        )
        self.assertEqual(preview.candidate_groups, ())
        self.assertFalse(preview.ready_to_finalize)

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    def test_plan_guard_conflict_is_read_from_v11_snapshot(
        self, evaluate,
    ):
        evaluate.return_value = fake_evaluation()

        preview = preview_f1_run(
            snapshots=[valid_v11_snapshot("CONFLICT")],
            configuration_snapshot=valid_configuration(),
        )

        self.assertEqual(preview.plan_guard_status, "CONFLICT")
        self.assertEqual(
            preview.demand_results[0].plan_guard_status,
            "CONFLICT",
        )
        self.assertEqual(preview.candidate_groups, ())
        self.assertFalse(preview.ready_to_finalize)

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    def test_plan_guard_not_evaluated_is_read_from_v11_snapshot(
        self, evaluate,
    ):
        evaluate.return_value = fake_evaluation()

        preview = preview_f1_run(
            snapshots=[valid_v11_snapshot("NOT_EVALUATED")],
            configuration_snapshot=valid_configuration(),
        )

        self.assertEqual(
            preview.plan_guard_status,
            "NOT_EVALUATED",
        )
        self.assertEqual(
            preview.demand_results[0].plan_guard_status,
            "NOT_EVALUATED",
        )
        self.assertEqual(preview.candidate_groups, ())
        self.assertFalse(preview.ready_to_finalize)

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    def test_candidate_group_is_exposed_when_every_demand_passes_plan_guard(
        self, evaluate,
    ):
        candidate = SimpleNamespace(demand_ids=(101, 102))
        evaluate.return_value = fake_evaluation(
            demand_ids=(101, 102),
            candidate_groups=(candidate,),
        )

        preview = preview_f1_run(
            snapshots=[
                valid_v11_snapshot("PASS", 101),
                valid_v11_snapshot("PASS", 102),
            ],
            configuration_snapshot=valid_configuration(),
        )

        self.assertEqual(preview.candidate_groups, (candidate,))
        self.assertEqual(preview.plan_guard_status, "PASS")
        self.assertEqual(preview.matching_status, NOT_EVALUATED)
        self.assertFalse(preview.ready_to_finalize)

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    def test_conflict_blocks_only_candidate_groups_containing_that_demand(
        self, evaluate,
    ):
        unaffected = SimpleNamespace(demand_ids=(101, 102))
        blocked = SimpleNamespace(demand_ids=(101, 103))
        evaluate.return_value = fake_evaluation(
            demand_ids=(101, 102, 103),
            candidate_groups=(unaffected, blocked),
        )

        preview = preview_f1_run(
            snapshots=[
                valid_v11_snapshot("PASS", 101),
                valid_v11_snapshot("PASS", 102),
                valid_v11_snapshot("CONFLICT", 103),
            ],
            configuration_snapshot=valid_configuration(),
        )

        self.assertEqual(preview.candidate_groups, (unaffected,))
        self.assertEqual(preview.plan_guard_status, "CONFLICT")
        self.assertFalse(preview.ready_to_finalize)

    @patch("planning.services.run_preview.evaluate_f1_snapshots")
    def test_not_evaluated_withholds_all_groups_even_with_other_conflict(
        self, evaluate,
    ):
        candidate = SimpleNamespace(demand_ids=(101, 102))
        evaluate.return_value = fake_evaluation(
            demand_ids=(101, 102, 103),
            candidate_groups=(candidate,),
        )

        preview = preview_f1_run(
            snapshots=[
                valid_v11_snapshot("PASS", 101),
                valid_v11_snapshot("CONFLICT", 102),
                valid_v11_snapshot("NOT_EVALUATED", 103),
            ],
            configuration_snapshot=valid_configuration(),
        )

        self.assertEqual(preview.candidate_groups, ())
        self.assertEqual(preview.plan_guard_status, NOT_EVALUATED)
        self.assertFalse(preview.ready_to_finalize)
