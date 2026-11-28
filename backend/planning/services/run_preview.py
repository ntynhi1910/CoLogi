
"""Read-only CP8 F1 run preview; never persists planning results."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from django.core.exceptions import ValidationError

from planning.f1.cargo_compatibility import (
    normalize_cargo_compatibility_matrix,
)
from planning.f1.candidate_groups import (
    CandidateLimitExceeded,
    validate_candidate_limits,
)
from planning.services.plan_guard import (
    evaluate_snapshot_plan_guard,
)
from planning.services.run_configuration import validate_pinned_f1_business_rules
from planning.services.result_presentation import describe_demand_snapshot
from planning.services.snapshot_evaluator import evaluate_f1_snapshots

NOT_EVALUATED = "NOT_EVALUATED"
CONFLICT = "CONFLICT"
PASS = "PASS"


@dataclass(frozen=True)
class DemandRunPreview:
    demand_id: int
    eligibility_status: str
    blockers: tuple[str, ...]
    diagnostics: tuple[str, ...]
    primary_reason_code: str | None
    plan_guard_status: str
    matching_status: str
    detail: str
    capacity_results: tuple = ()
    reason_codes: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    evidence: dict | None = None


@dataclass(frozen=True)
class RunPreview:
    captured_at: str
    rule_set_id: int
    rule_set_code: str
    rule_set_version: int
    business_rule_codes: tuple[str, ...]
    demand_results: tuple[DemandRunPreview, ...]
    candidate_groups: tuple
    business_rules_execution: str
    plan_guard_status: str
    matching_status: str
    ready_to_finalize: bool
    display_labels: dict = field(default_factory=dict)

    @property
    def all_demands_eligible(self):
        return bool(self.demand_results) and all(
            item.eligibility_status == "ELIGIBLE"
            for item in self.demand_results
        )


def _validate_configuration_snapshot(configuration):
    if not isinstance(configuration, Mapping):
        raise ValidationError(
            "RUN_CONFIGURATION_MUST_BE_OBJECT"
        )

    if configuration.get("schema_version") != "1.0":
        raise ValidationError(
            "RUN_CONFIGURATION_SCHEMA_VERSION_INVALID"
        )

    captured_at = configuration.get("captured_at")
    if not isinstance(captured_at, str) or not captured_at:
        raise ValidationError(
            "RUN_CONFIGURATION_CAPTURED_AT_REQUIRED"
        )

    try:
        captured_datetime = datetime.fromisoformat(captured_at)
    except ValueError:
        raise ValidationError(
            "RUN_CONFIGURATION_CAPTURED_AT_INVALID"
        )

    if (
        captured_datetime.tzinfo is None
        or captured_datetime.utcoffset() is None
    ):
        raise ValidationError(
            "RUN_CONFIGURATION_CAPTURED_AT_MUST_BE_AWARE"
        )

    rule_set = configuration.get("rule_set")
    if not isinstance(rule_set, Mapping):
        raise ValidationError(
            "RUN_CONFIGURATION_RULE_SET_INVALID"
        )

    rule_set_id = rule_set.get("id")
    if (
        not isinstance(rule_set_id, int)
        or isinstance(rule_set_id, bool)
        or rule_set_id <= 0
    ):
        raise ValidationError(
            "RUN_CONFIGURATION_RULE_SET_ID_INVALID"
        )

    rule_set_code = rule_set.get("code")
    if not isinstance(rule_set_code, str) or not rule_set_code.strip():
        raise ValidationError(
            "RUN_CONFIGURATION_RULE_SET_CODE_REQUIRED"
        )

    version = rule_set.get("version_no")
    if (
        not isinstance(version, int)
        or isinstance(version, bool)
        or version <= 0
    ):
        raise ValidationError(
            "RUN_CONFIGURATION_RULE_SET_VERSION_INVALID"
        )

    rules = configuration.get("business_rules")
    if not isinstance(rules, (list, tuple)) or not rules:
        raise ValidationError(
            "F1_RULE_CONFIGURATION_MISSING"
        )

    rule_codes = []
    seen_codes = set()

    for rule in rules:
        if not isinstance(rule, Mapping):
            raise ValidationError(
                "RUN_CONFIGURATION_BUSINESS_RULE_INVALID"
            )

        rule_id = rule.get("rule_id")
        if (
            not isinstance(rule_id, int)
            or isinstance(rule_id, bool)
            or rule_id <= 0
        ):
            raise ValidationError(
                "RUN_CONFIGURATION_BUSINESS_RULE_ID_INVALID"
            )

        code = rule.get("rule_code")
        if not isinstance(code, str) or not code.strip():
            raise ValidationError(
                "RUN_CONFIGURATION_BUSINESS_RULE_CODE_REQUIRED"
            )

        if code in seen_codes:
            raise ValidationError(
                "RUN_CONFIGURATION_BUSINESS_RULE_CODE_DUPLICATE"
            )

        if not isinstance(rule.get("rule_definition"), dict):
            raise ValidationError("RUN_CONFIGURATION_RULE_DEFINITION_MUST_BE_OBJECT")

        seen_codes.add(code)
        rule_codes.append(code)

    validate_pinned_f1_business_rules(rules)

    parameters = configuration.get("parameters")
    if not isinstance(parameters, Mapping):
        raise ValidationError(
            "RUN_CONFIGURATION_PARAMETERS_INVALID"
        )
    if "MIN_CANDIDATE_DEMANDS" in parameters:
        minimum = parameters["MIN_CANDIDATE_DEMANDS"]
        value = minimum.get("value") if isinstance(minimum, Mapping) else None
        if type(value) is not int or value != 2:
            raise ValidationError("MIN_CANDIDATE_DEMANDS must agree with RULE-03 for F1.")

    matrix_config = configuration.get("cargo_compatibility_matrix")

    if not isinstance(matrix_config, Mapping):
        raise ValidationError(
            "RUN_CONFIGURATION_CARGO_COMPATIBILITY_MATRIX_INVALID"
        )

    if matrix_config.get("source") != "CoLogi_Dataset_v7":
        raise ValidationError(
            "RUN_CONFIGURATION_CARGO_COMPATIBILITY_SOURCE_INVALID"
        )

    if matrix_config.get("sheet") != "08_Cargo_Compat":
        raise ValidationError(
            "RUN_CONFIGURATION_CARGO_COMPATIBILITY_SHEET_INVALID"
        )

    matrix_rows = matrix_config.get("rows")

    try:
        normalize_cargo_compatibility_matrix(matrix_rows)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc

    return (
        captured_at,
        rule_set_id,
        rule_set_code,
        version,
        tuple(rule_codes),
        matrix_rows,
    )


def _enum_value(value):
    return value.value if hasattr(value, "value") else str(value)


def _candidate_limits(configuration):
    parameters = configuration.get("parameters", {})
    if not isinstance(parameters, Mapping):
        raise ValidationError("RUN_CONFIGURATION_PARAMETERS_INVALID")
    keys = ("max_group_size", "max_candidates_per_run")
    if not any(key in parameters for key in keys):
        # Existing read-only previews may be unbounded. Persistent execution
        # must require both pinned limits before publication.
        return None, None
    values = []
    for key in keys:
        entry = parameters.get(key)
        if not isinstance(entry, Mapping) or "value" not in entry:
            raise ValidationError("RUN_CONFIGURATION_CANDIDATE_LIMIT_INVALID")

        value = entry["value"]

        if key == "max_group_size" and value is None:
            values.append(None)
            continue

        if type(value) is not int:
            raise ValidationError("RUN_CONFIGURATION_CANDIDATE_LIMIT_INVALID")

        values.append(value)
    try:
        validate_candidate_limits(*values)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return tuple(values)


def require_f1_execution_configuration(configuration):
    _validate_configuration_snapshot(configuration)
    size, count = _candidate_limits(configuration)
    if count is None:
        raise ValidationError("F1_EXECUTION_REQUIRES_CANDIDATE_LIMITS")
    return size, count


def _build_plan_guard_status_map(snapshots):
    """Validate snapshots and return {demand_id: Plan Guard status}."""
    statuses = {}

    for snapshot in snapshots:
        if not isinstance(snapshot, Mapping):
            raise ValidationError(
                "RUN_PREVIEW_DEMAND_SNAPSHOT_INVALID"
            )

        demand_ref = snapshot.get("demand_ref")
        if not isinstance(demand_ref, Mapping):
            raise ValidationError(
                "RUN_PREVIEW_DEMAND_REF_INVALID"
            )

        demand_pk = demand_ref.get("pk")

        # The canonical snapshot validator also validates the PK.
        # This preliminary check prevents unsafe ID conversion.
        if (
            not isinstance(demand_pk, str)
            or not demand_pk.isdigit()
            or demand_pk.startswith("0")
        ):
            raise ValidationError(
                "RUN_PREVIEW_DEMAND_ID_INVALID"
            )

        demand_id = int(demand_pk)

        if demand_id <= 0:
            raise ValidationError(
                "RUN_PREVIEW_DEMAND_ID_INVALID"
            )

        if demand_id in statuses:
            raise ValidationError(
                "RUN_PREVIEW_DUPLICATE_DEMAND_SNAPSHOT"
            )

        # This function validates the complete snapshot before
        # returning its canonical v1.0/v1.1 Plan Guard status.
        statuses[demand_id] = evaluate_snapshot_plan_guard(snapshot)

    return statuses


def _aggregate_plan_guard_status(statuses):
    """Aggregate Plan Guard statuses across all selected Demands."""
    statuses = tuple(statuses)

    if not statuses:
        return NOT_EVALUATED

    # Any unresolved evidence fails the mandatory run-level gate,
    # even when another Demand has a known conflict.
    if NOT_EVALUATED in statuses:
        return NOT_EVALUATED

    # A known conflict blocks the affected Demand, not the whole run.
    if CONFLICT in statuses:
        return CONFLICT

    # PASS is allowed only when every selected Demand has PASS evidence.
    if all(status == PASS for status in statuses):
        return PASS

    return NOT_EVALUATED


def _filter_candidate_groups_by_plan_guard(candidate_groups, statuses):
    """Keep only groups whose every Demand has authoritative PASS evidence.

    An unevaluated Plan Guard blocks publication of all groups for this run.
    A conflict blocks only groups containing that Demand.
    """
    if NOT_EVALUATED in statuses.values():
        return ()

    pass_demand_ids = {
        demand_id
        for demand_id, status in statuses.items()
        if status == PASS
    }

    return tuple(
        group
        for group in candidate_groups
        if set(group.demand_ids).issubset(pass_demand_ids)
    )


def preview_f1_run(*, snapshots, configuration_snapshot):
    """Evaluate immutable snapshots without creating or updating DB records.

    Business Rule definitions are validated as configuration data but are
    deliberately not interpreted or executed by this preview service.

    Plan Guard status is read from validated snapshot evidence.
    Candidate Groups are exposed only when every member has Eligibility
    ELIGIBLE and Plan Guard PASS. Any NOT_EVALUATED Plan Guard withholds
    all groups for the run; CONFLICT blocks only groups containing that
    Demand. Matching and Business Rules remain fail-closed.
    """
    (
        captured_at,
        rule_set_id,
        rule_set_code,
        rule_set_version,
        rule_codes,
        cargo_compatibility_rows,
    ) = _validate_configuration_snapshot(configuration_snapshot)

    snapshots = tuple(snapshots)

    if not snapshots:
        raise ValidationError(
            "RUN_PREVIEW_REQUIRES_DEMAND_SNAPSHOTS"
        )

    # Read and validate Plan Guard evidence from each snapshot.
    plan_guard_by_demand_id = _build_plan_guard_status_map(snapshots)

    # Evaluate F1 Eligibility from the same immutable snapshots.
    max_group_size, max_candidates_per_run = _candidate_limits(configuration_snapshot)
    # Filter *before* maximal enumeration. Removing a conflicting member
    # from the search space can make a previously non-maximal group maximal.
    allowed_ids = (
        () if NOT_EVALUATED in plan_guard_by_demand_id.values() else tuple(
            demand_id for demand_id, status in sorted(plan_guard_by_demand_id.items())
            if status == PASS
        )
    )
    try:
        evaluation = evaluate_f1_snapshots(
            snapshots,
            cargo_compatibility_rows=cargo_compatibility_rows,
            candidate_demand_ids=allowed_ids,
            max_group_size=max_group_size,
            max_candidates_per_run=max_candidates_per_run,
        )
    except CandidateLimitExceeded as exc:
        # Preview must never publish a partial candidate result.
        raise ValidationError(str(exc)) from exc

    evaluation_demand_ids = [
        item.demand_id
        for item in evaluation.demand_evaluations
    ]

    if len(evaluation_demand_ids) != len(set(evaluation_demand_ids)):
        raise ValidationError(
            "RUN_PREVIEW_DUPLICATE_EVALUATION_DEMAND"
        )

    if set(evaluation_demand_ids) != set(plan_guard_by_demand_id):
        raise ValidationError(
            "RUN_PREVIEW_DEMAND_SNAPSHOT_MISMATCH"
        )

    snapshots_by_id = {int(snapshot["demand_ref"]["pk"]): snapshot for snapshot in snapshots}
    demand_results = tuple(
        DemandRunPreview(
            demand_id=item.demand_id,
            eligibility_status=_enum_value(
                item.eligibility.eligibility_status
            ),
            blockers=tuple(
                _enum_value(value)
                for value in item.eligibility.blockers
            ),
            diagnostics=tuple(dict.fromkeys((*item.eligibility.diagnostics, *item.eligibility.reason_codes))),
            primary_reason_code=item.eligibility.primary_reason_code,
            plan_guard_status=plan_guard_by_demand_id[item.demand_id],
            matching_status=NOT_EVALUATED,
            detail=item.eligibility.detail,
            capacity_results=item.capacity_results,
            reason_codes=item.eligibility.reason_codes,
            warnings=item.eligibility.diagnostics,
            evidence=describe_demand_snapshot(
                snapshots_by_id[item.demand_id], item.demand_id,
                show_shortfall="PROMISE_INSUFFICIENT" in item.eligibility.reason_codes,
            ),
        )
        for item in evaluation.demand_evaluations
    )

    aggregate_plan_guard_status = _aggregate_plan_guard_status(
        plan_guard_by_demand_id.values()
    )

    return RunPreview(
        captured_at=captured_at,
        rule_set_id=rule_set_id,
        rule_set_code=rule_set_code,
        rule_set_version=rule_set_version,
        business_rule_codes=rule_codes,
        demand_results=demand_results,

        candidate_groups=_filter_candidate_groups_by_plan_guard(
            evaluation.candidate_groups,
            plan_guard_by_demand_id,
        ),

        business_rules_execution=NOT_EVALUATED,
        plan_guard_status=aggregate_plan_guard_status,
        matching_status=NOT_EVALUATED,
        ready_to_finalize=False,
    )
