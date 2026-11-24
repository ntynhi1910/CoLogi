"""Capture a reproducible F4 preview without updating a planning or operational record."""

import json
from dataclasses import dataclass
from datetime import time

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder

from planning.f2_structure import validate_f2_structure
from planning.f3_contract import canonical, fingerprint, validate_saved_document
from planning.f4_contract import VERSION, make_document
from planning.models import F3Evaluation, F4Evaluation, PlanningBusinessRule, PlanningParameters
from planning.services.database_evidence import timing_evidence, uses_synthetic_confirmation
from planning.services.demand_provenance import operational_demands_required, requires_operational_provenance
from planning.services.f2_plans import _saved_plans, _summaries, f2_storage_available
from planning.services.f2_preview import CandidateUnavailable, find_f2_candidate
from planning.services.f3_persistence import F3MigrationRequired, evaluation_summary, f3_storage_available
from planning.services.f3_hub_coverage import uat_hub_coverage_enabled
from planning.services.f4_evidence import F4ScenarioUnavailable, approved_scope, capture_time_evidence, read_approved_document, select_scenario
from planning.services.f4_scheduling import RULES, UNKNOWN, issue
from transportation.services import BUSINESS_TZ


PARAMETERS = ("TIMEZONE", "SERVICE_DURATION_MINUTES", "ALTERNATE_SLOT_SEARCH")


class F4NotReady(Exception):
    pass


class F4MigrationRequired(Exception):
    pass


def f4_storage_available():
    return MigrationRecorder(connection).migration_qs.filter(app="planning", name="0007_f4_evaluation").exists()


def _configuration_diagnostics(rule_set_id, rules, parameters, timezone):
    diagnostics = []
    missing = sorted(RULES.keys() - rules.keys())
    unsupported = sorted(code for code, definition in rules.items() if RULES.get(code) != definition)
    if missing:
        diagnostics.append(issue("F4_RULES_REQUIRED", rules=missing, rule_set_id=rule_set_id))
    if unsupported:
        diagnostics.append(issue("F4_RULES_UNSUPPORTED", rules=unsupported, rule_set_id=rule_set_id))
    if settings.COLOGI_BUSINESS_TIME_ZONE != timezone or (
        "TIMEZONE" in parameters and parameters["TIMEZONE"] != {"value": timezone, "data_type": "STRING"}
    ):
        diagnostics.append(issue("TIMEZONE_INCONSISTENT", timezone=timezone))
    return diagnostics


def _configuration(run):
    rules = dict(PlanningBusinessRule.objects.filter(
        rule_set_id=run.rule_set_id, module_code="F4", is_active=True,
    ).order_by("rule_code").values_list("rule_code", "rule_definition"))
    parameters = {key: {"value": value, "data_type": kind} for key, value, kind in PlanningParameters.objects.filter(
        parameter_key__in=PARAMETERS,
    ).order_by("parameter_key").values_list("parameter_key", "parameter_value", "data_type")}
    timezone = str(BUSINESS_TZ)
    return {
        "timezone": timezone, "rule_set_id": run.rule_set_id, "rules": rules,
        "parameters": parameters, "diagnostics": _configuration_diagnostics(run.rule_set_id, rules, parameters, timezone),
        "scope": "PINNED_F1_RULE_SET",
        "version": f"ruleset:{run.rule_set_id}:v{run.rule_set.version_no}",
        "sequence_policy": "PICKUPS_THEN_DELIVERIES_BY_DEADLINE_AND_POINT_ID",
        "route_scope": "FIRST_SERVICE_POINT_TO_LAST_SERVICE_POINT",
    }


def _stage_configuration(base, scope, approved, evaluation_code):
    version = scope.get("f4_configuration") if scope else None
    if not version:
        return base
    return {
        **base, **version, "scope": "F4_STAGE",
        "f3_evaluation_code": evaluation_code,
        "approval_reference": scope.get("approval_reference", approved["approval_reference"]),
        "diagnostics": _configuration_diagnostics(
            base["rule_set_id"], version["rules"], version["parameters"], base["timezone"],
        ),
    }


def can_evaluate(plan, evaluation):
    if not evaluation or plan.status != "DRAFT" or not evaluation_summary(evaluation)["ready_for_f4"]:
        return False
    if not requires_operational_provenance(""):
        return True
    scenario = evaluation.f3_structure["inputs"]["cp7"].get("capstone_scenario", "")
    demands = plan.f2_structure["basis"]["demands"]
    return not operational_demands_required(scenario, [row["id"] for row in demands])


@dataclass
class F4Capture:
    evaluation: F3Evaluation | None
    preview: dict
    document: dict | None = None


def _read_saved(plan, summary, evaluation, configuration, approved):
    if not can_evaluate(plan, evaluation):
        return F4Capture(evaluation, {
            "plan": summary, "status": UNKNOWN, "complete": False, "metrics": None, "waves": [],
            "f3_evaluation_code": str(evaluation.evaluation_code) if evaluation else None,
            "diagnostics": [issue("SAVED_F3_ELIGIBLE_REQUIRED")],
        })
    f2, f3 = plan.f2_structure, evaluation.f3_structure
    validate_f2_structure(f2)
    validate_saved_document(f2, f3, evaluation.input_fingerprint, evaluation.configuration_fingerprint,
                            contract_version=evaluation.contract_version)
    source_plan = f3["result"]["plan"]
    if any(source_plan[key] != summary[key] for key in ("plan_code", "hub_id", "template_type", "revision")):
        raise ValidationError("F4 requires the exact saved F2 revision from the F3 evaluation.")
    basis = f2["basis"]
    if time.fromisoformat(basis["common_start_time"]) >= time.fromisoformat(basis["common_end_time"]):
        raise ValidationError("F4 requires the strict F1 common time intersection.")
    code = str(evaluation.evaluation_code)
    scope = approved_scope(
        approved, evaluation_code=code, provider_id=f3["result"]["provider"]["id"],
        timezone=configuration["timezone"], day=basis["requested_date"],
    )
    if approved and approved.get("scenario_registry") and scope is None:
        return F4Capture(evaluation, {
            "plan": summary, "status": UNKNOWN, "complete": False, "metrics": None, "waves": [],
            "service_date": basis["requested_date"], "demand_weight_kg": basis["total_required_weight_kg"],
            "f3_evaluation_code": code, "diagnostics": [issue("F4_OPTION_OUTSIDE_SCENARIO")],
        })
    stage = _stage_configuration(configuration, scope, approved, code)
    capstone = f3["inputs"]["cp7"].get("capstone_scenario", "")
    database_mode = capstone or (approved is None and not uat_hub_coverage_enabled(connection))
    if database_mode and not capstone and uses_synthetic_confirmation(f2):
        return F4Capture(evaluation, {
            "plan": summary, "status": UNKNOWN, "complete": False, "metrics": None, "waves": [],
            "f3_evaluation_code": code, "diagnostics": [issue("OPERATIONAL_SUPPLIER_PROVENANCE_REQUIRED")],
        })
    evidence = timing_evidence(f2, capstone) if database_mode else (
        capture_time_evidence(
            approved, scope, day=basis["requested_date"],
            outlets=sorted({row["outlet_id"] for row in basis["demands"]}),
        )
    )
    document = make_document(evaluation, summary["revision"], evidence, stage)
    inputs = document["inputs"]
    internal = evidence.get("internal_planning") or f3["inputs"]["cp7"].get("internal_planning")
    return F4Capture(evaluation, {
        **document["result"],
        "plan": summary, "f3_evaluation_code": code,
        "service_date": basis["requested_date"], "demand_weight_kg": basis["total_required_weight_kg"],
        "f1_common_window": {
            "start_time": basis["common_start_time"], "end_time": basis["common_end_time"],
            "scope": "F1_GROUP_ELIGIBILITY",
        },
        "scenario_id": evidence["scenario_id"],
        "f3_uses_synthetic": bool(f3["result"].get("hub_coverage", {}).get("uses_synthetic")),
        "inputs": {**inputs["lineage"], "time_evidence": evidence},
        "evaluation_context": inputs["evaluation_context"], "source_mode": evidence["source_mode"],
        **({"internal_planning": internal} if internal else {}),
        "configuration": stage, "contract_version": VERSION,
        "input_fingerprint": fingerprint(inputs), "configuration_fingerprint": fingerprint(stage),
    }, document)


def visible_f3_sources(group, actor, outlets):
    visible = {plan.pk: (plan, summary) for plan, summary in _summaries(_saved_plans(group, actor), outlets)}
    results = list(F3Evaluation.objects.filter(plan_id__in=visible, evaluated_by=actor).select_related(
        "plan",
    ).order_by("-evaluated_at", "-pk"))
    return visible, results


def _begin_read():
    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")


@transaction.atomic
def preview_f4(*, actor, run_code, group_code, evaluation_code=None, scenario=None):
    _begin_read()
    run, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f2_storage_available() or not f3_storage_available():
        raise F3MigrationRequired
    visible, results = visible_f3_sources(group, actor, outlets)
    latest = {}
    for result in results:
        latest.setdefault(result.plan_id, result)
    options = {(plan.template_type, plan.hub_id): (plan, summary, latest.get(plan.pk)) for plan, summary in visible.values()}
    if evaluation_code is not None:
        selected = next((row for row in results if row.evaluation_code == evaluation_code), None)
        if selected is None:
            raise CandidateUnavailable
        plan, summary = visible[selected.plan_id]
        if not can_evaluate(plan, selected):
            raise F4NotReady
        options[plan.template_type, plan.hub_id] = plan, summary, selected
    configuration = _configuration(run)
    approved, scenarios, active = select_scenario(
        read_approved_document(), run_code=run.run_code, group_code=group.group_code, requested=scenario,
    )
    evaluations = [
        _read_saved(*options[key], configuration, approved).preview
        for key in sorted(options, key=lambda identity: (identity[0], identity[1] or 0))
    ]
    return json.loads(canonical({
        "contract_version": VERSION, "run_code": str(run.run_code), "group_code": group.group_code,
        "selected_evaluation_code": str(evaluation_code) if evaluation_code else None,
        "scenarios": scenarios, "active_scenario": active,
        "configuration": configuration, "configuration_fingerprint": fingerprint(configuration),
        "history_available": f4_storage_available(), "evaluations": evaluations,
    }))


@transaction.atomic
def capture_for_save(*, actor, run_code, group_code, requests, scenario=None):
    _begin_read()
    run, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f2_storage_available() or not f3_storage_available():
        raise F3MigrationRequired
    if not f4_storage_available():
        raise F4MigrationRequired
    visible, accountable = visible_f3_sources(group, actor, outlets)
    by_code = {row.evaluation_code: row for row in accountable}
    evaluation_codes = [request["f3_evaluation_code"] for request in requests]
    if not all(code in by_code for code in evaluation_codes):
        raise CandidateUnavailable
    sources = [by_code[code] for code in evaluation_codes]
    if any(not can_evaluate(visible[row.plan_id][0], row) for row in sources):
        raise F4NotReady

    # A lost response can be retried even after the operator publishes new evidence.
    captures = []
    configuration, approved = None, None
    if scenario is not None:
        approved, _, _ = select_scenario(
            read_approved_document(), run_code=run.run_code, group_code=group.group_code, requested=scenario,
        )
    allowed = {(row["f3_evaluation_code"], row["scenario_id"]) for row in approved["evaluations"]} if approved else set()
    for source, request in zip(sources, requests, strict=True):
        fingerprints = {key: request[key] for key in ("input_fingerprint", "configuration_fingerprint")}
        existing = F4Evaluation.objects.filter(
            f3_evaluation=source, contract_version=VERSION, evaluated_by=actor, **fingerprints,
        ).first()
        if existing:
            case = existing.f4_structure["inputs"]["time_evidence"].get("scenario_id")
            if scenario is not None and (str(source.evaluation_code), case) not in allowed:
                raise F4ScenarioUnavailable
            captures.append(F4Capture(source, fingerprints, existing.f4_structure))
            continue
        if configuration is None:
            configuration = _configuration(run)
            if scenario is None:
                approved, _, _ = select_scenario(
                    read_approved_document(), run_code=run.run_code, group_code=group.group_code, requested=None,
                )
        capture = _read_saved(*visible[source.plan_id], source, configuration, approved)
        if capture.document is None:
            raise F4ScenarioUnavailable
        captures.append(capture)
    return captures
