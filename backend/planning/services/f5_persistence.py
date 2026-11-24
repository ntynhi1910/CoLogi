"""Publish complete economic results and replay their sealed snapshots."""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from django.core.exceptions import ValidationError
from django.db import DatabaseError, connection, transaction
from accounts.capstone import run_scenario

from planning.models import CostAllocation, CostComponent, DemandCostInput, EconomicEvaluation
from planning.services.f2_preview import CandidateInvalid, CandidateUnavailable, find_f2_candidate
from planning.services.f3_hub_coverage import uat_hub_coverage_enabled
from planning.services.f4_evidence import F4EvidenceInvalid, F4ScenarioUnavailable
from planning.services.f4_preview import F4MigrationRequired, _begin_read, visible_f3_sources
from planning.services.f5_preview import F5AnchorBlocked, capture_f5, f5_storage_available


class F5MigrationRequired(Exception):
    pass


def _summary(row):
    snapshot = row.snapshot
    result = snapshot["result"]["option"]
    internal = snapshot.get("price_inputs", {}).get("internal_planning")
    return {
        "evaluation_code": str(row.evaluation_code), "calculated_at": row.calculated_at,
        "f4_evaluation_code": snapshot["lineage"]["f4_evaluation_code"], "plan": result["plan"],
        "contract_version": row.contract_version, "input_fingerprint": row.input_fingerprint,
        "configuration_fingerprint": row.configuration_fingerprint, "comparison_fingerprint": snapshot["comparison"]["fingerprint"],
        "configuration_version": snapshot["configuration"]["version"], "scenario": snapshot["scenario"],
        "evaluation_context": snapshot["lineage"]["evaluation_context"],
        **({"internal_planning": internal} if internal else {}),
        "baseline_cost": str(row.baseline_cost), "collaborative_cost": str(row.collaborative_cost),
        "cost_saving": str(row.cost_saving), "saving_rate_pct": str(row.saving_rate_pct) if row.saving_rate_pct is not None else None,
    }


def _insert_cost_lines(row, data, option, prices, timezone):
    quotes = {quote["demand_id"]: quote for quote in prices["baseline"]}
    for item in data["baseline_inputs"]:
        quote = quotes[item["demand_id"]]
        # A single-row insert preserves CHAR(3); PostgreSQL array casts can truncate to CHAR(1).
        DemandCostInput.objects.create(
            evaluation=row, demand_id=item["demand_id"], cost_profile_id=row.cost_profile_id,
            independent_delivery_cost=item["amount"], currency_code=data["configuration"]["currency_code"],
            source_type=quote["source_type"],
            effective_at=datetime.combine(date.fromisoformat(quote["valid_from"]), time.min, tzinfo=timezone),
            notes=quote["source_reference"],
        )
    CostComponent.objects.bulk_create([
        CostComponent(
            evaluation=row, ordinal=ordinal, wave_no=item["wave_no"], component_type=item["component_type"],
            amount=item["amount"], source_type=item["source_type"], pricing_basis=item["pricing_basis"],
            quantity=item["quantity"], unit_code=item["unit_code"], unit_rate=item["unit_rate"],
            source_reference=item["source_reference"], calculation_details=item,
        )
        for ordinal, item in enumerate(option["components"], 1)
    ])
    CostAllocation.objects.bulk_create([
        CostAllocation(
            evaluation=row, outlet_id=item["outlet_id"], baseline_cost=item["baseline_cost"],
            allocation_weight=item["weight_kg"], order_count=item["order_count"],
            allocated_cost=item["allocated_cost"], participant_saving=item["participant_saving"],
        )
        for item in option["allocations"]
    ])


@transaction.atomic
def _save_one(*, actor, run_code, group_code, scenario, item):
    data, prices, anchor, run = capture_f5(
        actor=actor, run_code=run_code, group_code=group_code, scenario=scenario,
        evaluation_code=item["f4_evaluation_code"], lock=True,
    )
    selected = str(anchor.evaluation_code)
    option = next(row for row in data["options"] if row["lineage"] and row["lineage"]["f4_evaluation_code"] == selected)
    if option["status"] != "EVALUATED":
        raise F5AnchorBlocked("F5_INCOMPLETE")
    if (
        item["input_fingerprint"] != option["input_fingerprint"]
        or item["configuration_fingerprint"] != data["configuration_fingerprint"]
    ):
        raise F5AnchorBlocked("F5_PREVIEW_STALE")
    keys = {
        "f4_evaluation": anchor, "contract_version": data["contract_version"],
        "input_fingerprint": option["input_fingerprint"], "configuration_fingerprint": data["configuration_fingerprint"],
    }
    snapshot = {
        "run_code": data["run_code"], "group_code": data["group_code"], "scenario": data["scenario"],
        "lineage": option["lineage"], "configuration": data["configuration"], "rule_catalog_v7": data["rule_catalog_v7"],
        "price_inputs": prices, "comparison": {
            "fingerprint": data["fingerprint"], "recommendation": data["recommendation"],
            "options": [{key: candidate[key] for key in ("plan", "status", "collaborative_cost", "rank")}
                        for candidate in data["options"]],
        },
        "result": {
            **{key: data[key] for key in ("baseline_cost", "baseline_inputs", "demands", "service_date", "total_weight_kg")},
            "option": option,
        },
    }
    row, created = EconomicEvaluation.objects.get_or_create(**keys, defaults={
        "plan": anchor.f3_evaluation.plan, "calculated_by": actor,
        "cost_profile_id": prices.get("cost_profile_id", run.cost_profile_id),
        "baseline_cost": data["baseline_cost"], "collaborative_cost": option["collaborative_cost"],
        "cost_saving": option["cost_saving"], "saving_rate_pct": option["saving_rate_pct"],
        "allocation_method": data["configuration"]["allocation_method"], "snapshot": snapshot,
    })
    if created:
        _insert_cost_lines(row, data, option, prices, ZoneInfo(anchor.f4_structure["configuration"]["timezone"]))
        EconomicEvaluation.objects.filter(pk=row.pk).update(sealed=True)
        row.refresh_from_db()
    return {"f4_evaluation_code": selected, "outcome": "CREATED" if created else "EXISTS", "evaluation": _summary(row)}


def save_f5(*, actor, run_code, group_code, scenario, items):
    find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f5_storage_available():
        raise F5MigrationRequired
    result = []
    for item in items:
        try:
            result.append(_save_one(actor=actor, run_code=run_code, group_code=group_code, scenario=scenario, item=item))
            continue
        except F5AnchorBlocked as exc:
            code = str(exc)
        except (CandidateUnavailable, F4ScenarioUnavailable):
            code = "F5_SOURCE_UNAVAILABLE"
        except (CandidateInvalid, ValidationError, F4EvidenceInvalid, F4MigrationRequired):
            code = "F5_SOURCE_INVALID"
        except DatabaseError:
            code = "F5_STORAGE_ERROR"
        result.append({"f4_evaluation_code": str(item["f4_evaluation_code"]), "outcome": "REJECTED", "code": code})
    return result


@transaction.atomic
def read_f5_history(*, actor, run_code, group_code, evaluation_code=None):
    _begin_read()
    run, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f5_storage_available():
        if evaluation_code is not None:
            raise F5MigrationRequired
        return {"available": False, "evaluations": []}
    _, sources = visible_f3_sources(group, actor, outlets)
    rows = EconomicEvaluation.objects.filter(
        f4_evaluation__f3_evaluation_id__in=[row.pk for row in sources], calculated_by=actor, sealed=True,
    ).order_by("-calculated_at", "-pk")
    if run_scenario(run) or not uat_hub_coverage_enabled(connection):
        context = "CAPSTONE" if run_scenario(run) else "OPERATIONAL"
        rows = rows.filter(snapshot__lineage__evaluation_context=context)
    if evaluation_code is None:
        return {"available": True, "evaluations": [_summary(row) for row in rows]}
    row = rows.filter(evaluation_code=evaluation_code).first()
    if row is None:
        raise CandidateUnavailable
    return {**_summary(row), "snapshot": row.snapshot}
