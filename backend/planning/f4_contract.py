"""Immutable F4 snapshot, with the stop checks as the replayable source of truth."""

import json

from django.core.exceptions import ValidationError
from accounts.capstone import PROVENANCE

from planning.f3_contract import canonical, fingerprint
from planning.services.f4_scheduling import evaluate_schedule


VERSION = 2
SYNTHETIC = "SYNTHETIC/UAT"


def lineage_for(evaluation, plan_revision):
    f2 = evaluation.plan.f2_structure
    return {
        "run_code": f2["lineage"]["run_code"], "group_code": f2["lineage"]["group_code"],
        "f1_rule_set_id": f2["lineage"]["rule_set_id"], "f1_rule_set_version": f2["lineage"]["rule_set_version"],
        "f2_plan_code": evaluation.plan.plan_code, "f2_revision": plan_revision,
        "f2_fingerprint": evaluation.f3_structure["inputs"]["f2_fingerprint"],
        "f3_evaluation_code": str(evaluation.evaluation_code), "f3_contract_version": evaluation.contract_version,
        "f3_input_fingerprint": evaluation.input_fingerprint,
        "f3_configuration_fingerprint": evaluation.configuration_fingerprint,
    }


def make_document(evaluation, plan_revision, evidence, configuration):
    f2, f3 = evaluation.plan.f2_structure, evaluation.f3_structure
    synthetic = (
        evidence["source_mode"] == SYNTHETIC or (
            f3["result"].get("hub_coverage", {}).get("uses_synthetic", False)
            and f3["result"]["hub_coverage"].get("context") != "INTERNAL_PLANNING"
        )
    )
    capstone = evidence.get("capstone_scenario")
    if (capstone or f3["inputs"]["cp7"].get("capstone_scenario")) and (
        evidence["source_mode"] != PROVENANCE or capstone != f3["inputs"]["cp7"].get("capstone_scenario")
    ):
        raise ValidationError("F4 evidence and F3 must belong to the same Capstone scenario.")
    return json.loads(canonical({
        "inputs": {
            "lineage": lineage_for(evaluation, plan_revision), "f2": f2, "f3": f3, "time_evidence": evidence,
            "evaluation_context": "CAPSTONE" if capstone else "UAT" if synthetic else "OPERATIONAL",
        },
        "configuration": configuration,
        "result": evaluate_schedule(f2, f3, evidence, configuration),
    }))


def validate_document(evaluation, document, input_hash, configuration_hash):
    try:
        inputs = document["inputs"]
        configuration = document["configuration"]
        if fingerprint(inputs) != input_hash or fingerprint(configuration) != configuration_hash:
            raise ValidationError("F4 fingerprints do not match the captured inputs.")
        if configuration["scope"] not in ("PINNED_F1_RULE_SET", "F4_STAGE") or not configuration["version"]:
            raise ValidationError("F4 requires a versioned configuration.")
        if configuration["rule_set_id"] != evaluation.plan.f2_structure["lineage"]["rule_set_id"] or (
            configuration["scope"] == "F4_STAGE"
            and configuration["f3_evaluation_code"] != str(evaluation.evaluation_code)
        ):
            raise ValidationError("F4 configuration is not bound to this lineage.")
        replay = make_document(
            evaluation, evaluation.f3_structure["result"]["plan"]["revision"], inputs["time_evidence"], configuration,
        )
        if document != replay:
            raise ValidationError("F4 evaluation must reproduce the exact F3 lineage and stop-level results.")
    except (KeyError, TypeError, ValueError, ArithmeticError) as exc:
        raise ValidationError("Malformed F4 evaluation snapshot.") from exc
