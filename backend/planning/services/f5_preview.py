"""Read-only F5 comparison anchored to a Manager's exact saved F4 evaluation."""

import json
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
from accounts.capstone import enabled, run_scenario

from planning.f2_structure import validate_f2_structure
from planning.f3_contract import canonical, fingerprint, validate_saved_document
from planning.f4_contract import validate_document
from planning.models import CostProfile, F4Evaluation, PlanningBusinessRule, PlanningParameters
from planning.services.database_evidence import price_evidence
from planning.services.f2_preview import CandidateUnavailable, find_f2_candidate
from planning.services.f3_hub_coverage import uat_hub_coverage_enabled
from planning.services.f4_evidence import read_approved_document, select_scenario
from planning.services.f4_preview import (
    F4MigrationRequired, _begin_read, _configuration, _read_saved, can_evaluate, f4_storage_available,
    visible_f3_sources,
)
from planning.services.f5_economics import (
    RULES, PriceInvalid, allocate, collaborative_cost, independent_costs, recommend, savings, sum_money, wave_inputs,
)
from planning.services.f5_evidence import read_prices
from transportation.models import ProviderVehicleOffer


class F5AnchorBlocked(Exception):
    pass


def f5_storage_available():
    return MigrationRecorder(connection).migration_qs.filter(app="planning", name="0009_f5_economic_evaluation").exists()


def _snapshot_lineage(row):
    if row is None:
        return None
    source = row.f4_structure["inputs"]
    return {
        **source["lineage"],
        "f4_evaluation_code": str(row.evaluation_code), "f4_contract_version": row.contract_version,
        "f4_input_fingerprint": row.input_fingerprint, "f4_configuration_fingerprint": row.configuration_fingerprint,
        "f4_case": source["time_evidence"].get("scenario_id"), "evaluation_context": source["evaluation_context"],
        "f4_configuration_version": row.f4_structure["configuration"]["version"],
    }


def _ready(row):
    doc, evaluation = row.f4_structure, row.f3_evaluation
    result = doc["result"]
    return (
        result["status"] == "PASS" and result["complete"] and result["waves"]
        and all(wave["status"] == "PASS" for wave in result["waves"])
        and (doc["inputs"]["evaluation_context"] != "UAT" or uat_hub_coverage_enabled(connection))
        and (doc["inputs"]["evaluation_context"] != "CAPSTONE"
             or enabled(doc["inputs"]["time_evidence"].get("capstone_scenario")))
        and can_evaluate(evaluation.plan, evaluation)
    )


def _validate(row):
    evaluation = row.f3_evaluation
    f2 = evaluation.plan.f2_structure
    validate_f2_structure(f2)
    validate_saved_document(f2, evaluation.f3_structure, evaluation.input_fingerprint,
                            evaluation.configuration_fingerprint, contract_version=evaluation.contract_version)
    validate_document(evaluation, row.f4_structure, row.input_fingerprint, row.configuration_fingerprint)


def _scenario_rows(*, run, approved, visible, sources, saved, anchor):
    if approved is None or not approved.get("scenario_registry"):
        return {anchor.f3_evaluation.plan_id: anchor}
    eligible = {str(row.evaluation_code): row for row in sources}
    indexed = {(row.f3_evaluation_id, row.input_fingerprint, row.configuration_fingerprint): row for row in saved}
    configuration = _configuration(run)
    selected = {}
    for scope in approved["evaluations"]:
        source = eligible.get(scope["f3_evaluation_code"])
        if source is None:
            continue
        plan, summary = visible[source.plan_id]
        captured = _read_saved(plan, summary, source, configuration, approved).preview
        row = indexed.get((source.pk, captured.get("input_fingerprint"), captured.get("configuration_fingerprint")))
        if row is not None:
            selected[source.plan_id] = row
    if selected.get(anchor.f3_evaluation.plan_id) != anchor:
        raise F5AnchorBlocked("F4_SCENARIO_MISMATCH")
    return selected


def _database_rows(saved, anchor):
    """Compare the newest saved operational evaluation of each visible option."""
    selected = {anchor.f3_evaluation.plan_id: anchor}
    plan = anchor.f3_evaluation.plan
    identities = {(plan.template_type, plan.hub_id)}
    for row in sorted(saved, key=lambda item: (item.evaluated_at, item.pk), reverse=True):
        inputs = row.f4_structure["inputs"]
        plan = row.f3_evaluation.plan
        identity = (plan.template_type, plan.hub_id)
        if (identity not in identities and inputs["evaluation_context"] == anchor.f4_structure["inputs"]["evaluation_context"]
                and "source_records" in inputs["time_evidence"]):
            selected[plan.pk] = row
            identities.add(identity)
    return selected


def _audit(run, wave_offer_ids):
    params = dict(PlanningParameters.objects.filter(
        parameter_key__in=["CURRENCY_CODE", "ROUNDING_UNIT_VND", "ALLOCATION_METHOD"],
    ).values_list("parameter_key", "parameter_value"))
    rules = list(PlanningBusinessRule.objects.filter(
        rule_set_id=run.rule_set_id, module_code="F5", is_active=True,
    ).order_by("rule_code").values_list("rule_code", flat=True))
    return {
        "cost_profile_count": CostProfile.objects.count(), "run_cost_profile_id": run.cost_profile_id,
        "active_pinned_f5_rules": rules, "database_parameters": params,
        "offers": list(ProviderVehicleOffer.objects.filter(pk__in=wave_offer_ids).order_by("id").values(
            "id", "provider_id", "fixed_quote_vnd", "estimated_cost_per_km_vnd",
        )),
        "offer_price_use": "INDICATIVE_ONLY_REQUIRES_EFFECTIVE_SCOPE",
    }


def _diagnostic(code, **details):
    return {"code": code, **details}


def _price_options(plan, option, row, basis, prices):
    document = row.f4_structure
    waves = wave_inputs(document["result"])
    option["waves"] = [{**wave, "cost": None} for wave in waves]
    if not prices:
        option["diagnostics"].extend(_diagnostic("WAVE_QUOTE_REQUIRED", wave_no=wave["wave_no"], offer_id=wave["offer_id"])
                                     for wave in waves)
        if plan.hub_id is not None:
            option["diagnostics"].append(_diagnostic("HUB_PRICE_REQUIRED", hub_id=plan.hub_id))
        return
    quote = next((item for item in prices["options"] if item["f4_evaluation_code"] == str(row.evaluation_code)), None)
    if quote is None:
        option["diagnostics"].append(_diagnostic("F4_OPTION_PRICE_REQUIRED"))
        return
    if (quote["input_fingerprint"], quote["configuration_fingerprint"]) != (row.input_fingerprint, row.configuration_fingerprint):
        option["diagnostics"].append(_diagnostic("F4_OPTION_PRICE_FINGERPRINT_MISMATCH"))
        return
    try:
        option["components"] = collaborative_cost(basis, waves, plan.hub_id, quote, prices["configuration"])
    except PriceInvalid as exc:
        option["diagnostics"].append(exc.diagnostic)
        return
    option["collaborative_cost"] = sum_money(c["amount"] for c in option["components"])
    for wave in option["waves"]:
        wave["cost"] = sum_money(c["amount"] for c in option["components"] if c["wave_no"] == wave["wave_no"])


def capture_f5(*, actor, run_code, group_code, evaluation_code, scenario, lock=False):
    run, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code, lock=lock)
    if not f4_storage_available():
        raise F4MigrationRequired
    visible, sources = visible_f3_sources(group, actor, outlets)
    saved = list(F4Evaluation.objects.filter(
        f3_evaluation_id__in=[row.pk for row in sources], evaluated_by=actor,
    ).select_related("f3_evaluation__plan"))
    anchor = next((row for row in saved if row.evaluation_code == UUID(str(evaluation_code))), None)
    if anchor is None:
        raise CandidateUnavailable
    if not _ready(anchor):
        raise F5AnchorBlocked("F4_HARD_GATE_REQUIRED")
    _validate(anchor)
    doc = anchor.f4_structure["inputs"]
    uat = doc["evaluation_context"] == "UAT"
    capstone = run_scenario(run)
    if capstone and (doc["evaluation_context"] != "CAPSTONE"
                     or doc["time_evidence"].get("capstone_scenario") != capstone):
        raise F5AnchorBlocked("F4_CAPSTONE_CONTEXT_MISMATCH")
    approved, _, active_scenario = select_scenario(
        read_approved_document(), run_code=run_code, group_code=group_code, requested=scenario,
    )
    if uat and (not approved or not approved.get("scenario_registry")):
        raise F5AnchorBlocked("F4_SCENARIO_REQUIRED")
    database_mode = capstone or (not uat and not settings.F5_PRICE_EVIDENCE_FILE)
    scenario_rows = _database_rows(saved, anchor) if database_mode else _scenario_rows(
        run=run, approved=approved, visible=visible, sources=sources, saved=saved, anchor=anchor,
    )
    basis = doc["f2"]["basis"]
    basis_hash = fingerprint(basis)
    diagnostics, baseline_rows, baseline_cost = [], [], None
    prices = None
    try:
        prices = price_evidence(run, group, basis, basis_hash, scenario_rows.values(), capstone) if database_mode else read_prices(
            run_code=run_code, group_code=group_code, scenario=active_scenario, uat=uat,
        )
        if prices and (prices["service_date"], prices["demand_basis_fingerprint"]) != (basis["requested_date"], basis_hash):
            prices = None
            raise PriceInvalid("COMPARABLE_PRICE_BASIS_MISMATCH")
        if prices:
            baseline_rows = independent_costs(basis, prices["baseline"], prices["configuration"])
            baseline_cost = sum_money(row["amount"] for row in baseline_rows)
        else:
            diagnostics.append(_diagnostic("APPROVED_PRICE_CONFIGURATION_REQUIRED"))
    except PriceInvalid as exc:
        diagnostics.append(exc.diagnostic)
    if baseline_cost is None:
        diagnostics.append(_diagnostic("INDEPENDENT_BASELINE_REQUIRED", demand_codes=[row["code"] for row in basis["demands"]]))
    options = []
    offers = set()
    by_identity = {(plan.template_type, plan.hub_id): (plan, summary) for plan, summary in visible.values()}
    # The explicitly selected saved revision takes precedence for its own logical option.
    for pk in scenario_rows:
        plan, summary = visible[pk]
        by_identity[plan.template_type, plan.hub_id] = plan, summary
    for plan, summary in sorted(by_identity.values(), key=lambda pair: (pair[0].template_type, pair[0].hub_id or 0)):
        row = scenario_rows.get(plan.pk)
        option = {
            "plan": summary, "lineage": _snapshot_lineage(row), "status": "BLOCKED", "rank": None,
            "f4_status": row.f4_structure["result"]["status"] if row else None,
            "f4_diagnostics": [item["code"] for item in row.f4_structure["result"]["diagnostics"]] if row else [],
            "collaborative_cost": None, "cost_saving": None, "saving_rate_pct": None,
            "waves": [], "components": [], "allocations": [], "diagnostics": [],
        }
        options.append(option)
        if row is None:
            option["diagnostics"].append(_diagnostic("F4_REFERENCE_REQUIRED"))
            continue
        if not _ready(row):
            option["diagnostics"].append(_diagnostic("F4_HARD_GATE_REQUIRED", status=option["f4_status"]))
            continue
        if row != anchor:
            _validate(row)
        inputs = row.f4_structure["inputs"]
        if inputs["evaluation_context"] != doc["evaluation_context"] or fingerprint(inputs["f2"]["basis"]) != basis_hash:
            option["diagnostics"].append(_diagnostic("COMPARABLE_F4_BASIS_MISMATCH"))
            continue
        option["status"] = "NOT_EVALUATED"
        _price_options(plan, option, row, basis, prices)
        offers.update(wave["offer_id"] for wave in option["waves"])
        if option["collaborative_cost"] is None or baseline_cost is None:
            continue
        option["status"] = "EVALUATED"
        option["cost_saving"], option["saving_rate_pct"] = savings(baseline_cost, option["collaborative_cost"])
        option["allocations"] = allocate(baseline_rows, option["collaborative_cost"], prices["configuration"])
        option["diagnostics"].extend(_diagnostic("NEGATIVE_PARTICIPANT_SAVING", outlet_id=row["outlet_id"])
                                     for row in option["allocations"] if row["participant_saving"] < 0)
    recommendation = recommend(options)
    config = prices["configuration"] if prices else None
    config_hash = fingerprint(config) if config else None
    comparison_hash = fingerprint({
        "contract_version": 1, "run_code": str(run_code), "group_code": group_code, "scenario": active_scenario,
        "lineages": [row["lineage"] for row in options], "quotes": prices,
    })
    for row in options:
        row["input_fingerprint"] = fingerprint({
            "comparison_fingerprint": comparison_hash,
            "f4_evaluation_code": row["lineage"]["f4_evaluation_code"],
        }) if row["status"] == "EVALUATED" else None
    payload = json.loads(canonical({
        "contract_version": 1, "run_code": str(run_code), "group_code": group_code, "scenario": active_scenario,
        "evaluation_context": doc["evaluation_context"], "service_date": basis["requested_date"],
        "demand_basis_fingerprint": basis_hash, "total_weight_kg": basis["total_required_weight_kg"],
        "demands": [{k: row[k] for k in ("id", "code", "outlet_id", "outlet_code", "required_weight_kg")} for row in basis["demands"]],
        "selected_f4_evaluation_code": str(anchor.evaluation_code), "options": options,
        "baseline_cost": baseline_cost, "baseline_inputs": baseline_rows, "recommendation": recommendation,
        "configuration": config, "rule_catalog_v7": RULES, "audit": _audit(run, offers), "diagnostics": diagnostics,
        "price_evidence": {
            "approval_reference": prices["approval_reference"], "source_mode": prices["source_mode"],
            **({"internal_planning": prices["internal_planning"]} if "internal_planning" in prices else {}),
        } if prices else None,
        "fingerprint": comparison_hash, "configuration_fingerprint": config_hash,
        "persistence_available": f5_storage_available(),
    }))
    return payload, prices, anchor, run


@transaction.atomic
def preview_f5(**kwargs):
    _begin_read()
    payload, _, _, _ = capture_f5(**kwargs)
    return payload
