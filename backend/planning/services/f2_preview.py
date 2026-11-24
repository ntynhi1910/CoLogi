"""Read authorized F1 evidence and adapt it to the F2 preview contract."""

from datetime import date, time
from hashlib import sha256
import json

from django.core.exceptions import ValidationError
from django.db import DatabaseError, connection, transaction

from masterdata.models import Hub
from planning.f1.supplier_confirmation import ConfirmationGateStatus
from planning.models import (
    CollaborationGroup, CollaborationGroupStatus, EligibilityStatus, GroupDemandEligibilityStatus,
    MatchingStatus, PlanningRunStatus, PlanGuardStatus,
)
from planning.services.f2_options import Demand, DemandItem, HubPoint, generate_options
from planning.services.result_presentation import describe_run_configuration
from planning.services.run_results import scoped_f1_runs
from planning.services.run_scope import require_f1_outlet_ids
from planning.services.snapshot_evaluator import _build_confirmation_result, _decimal_value, _latest_request_by_demand
from planning.services.snapshot_reader import _record_index, read_run_snapshots


class CandidateUnavailable(Exception):
    """No Candidate is visible to this Manager for the requested Run."""


class CandidateInvalid(Exception):
    """The visible group does not represent a completed F1 Candidate."""


def _hub_point(hub):
    return HubPoint(hub.pk, hub.hub_code, hub.hub_name, hub.address.strip())


def _usable_hubs():
    return Hub.objects.filter(is_active=True, address__regex=r"\S")


def list_f2_hubs(actor):
    require_f1_outlet_ids(actor)
    return [_hub_point(hub) for hub in _usable_hubs().order_by("hub_code", "pk")]


def _hub_selection(hub_id, *, lock=False):
    # A failed Hub read must not poison the transaction holding the F1 snapshot.
    try:
        with transaction.atomic():
            if hub_id is None:
                return None, {"code": "HUB_SELECTION_REQUIRED" if _usable_hubs().exists() else "NO_USABLE_HUB"}
            hubs = Hub.objects.filter(pk=hub_id)
            hub = (hubs.select_for_update() if lock else hubs).first()
    except DatabaseError:
        return None, {"code": "HUB_SOURCE_UNAVAILABLE", "hub_id": hub_id}
    if hub is None:
        return None, {"code": "HUB_NOT_FOUND", "hub_id": hub_id}
    if not hub.is_active:
        return None, {"code": "HUB_INACTIVE", "hub_id": hub_id}
    if not hub.address.strip():
        return None, {"code": "HUB_ADDRESS_MISSING", "hub_id": hub_id}
    return _hub_point(hub), None


def _date(value):
    try:
        return date.fromisoformat(value)
    except (ValueError, TypeError):
        return None


def _time(value):
    try:
        result = time.fromisoformat(value)
    except (ValueError, TypeError):
        return None
    return result if result.tzinfo is None else None


def _candidate_basis(group, memberships):
    if group.status != CollaborationGroupStatus.CANDIDATE:
        raise CandidateInvalid("F2_REQUIRES_CANDIDATE")
    ids = [member.demand_id for member in memberships]
    if len(ids) < 2 or len(ids) != len(set(ids)) or any(
        member.eligibility_status != GroupDemandEligibilityStatus.INCLUDED for member in memberships
    ):
        raise CandidateInvalid("F2_CANDIDATE_MEMBERSHIP_INVALID")

    metadata = group.matching_reason
    if not isinstance(metadata, dict) or metadata.get("demand_ids") != ids:
        raise CandidateInvalid("F2_CANDIDATE_MEMBERSHIP_INVALID")
    if any(type(pk) is not int or pk < 1 for pk in metadata["demand_ids"]):
        raise CandidateInvalid("F2_CANDIDATE_MEMBERSHIP_INVALID")

    requested = _date(metadata.get("requested_date"))
    start = _time(metadata.get("common_start_time"))
    end = _time(metadata.get("common_end_time"))
    categories = metadata.get("cargo_category_ids")
    if requested is None or start is None or end is None or start > end or not isinstance(categories, list) or (
        not categories or any(type(pk) is not int or pk < 1 for pk in categories)
        or categories != sorted(set(categories))
    ):
        raise CandidateInvalid("F2_CANDIDATE_WINDOW_INVALID")

    return {
        "demand_ids": ids,
        "requested_date": requested.isoformat(),
        "common_start_time": start.isoformat(),
        "common_end_time": end.isoformat(),
        "cargo_category_ids": categories,
    }


def _lineage(run, group):
    config = run.parameters_snapshot
    pinned = describe_run_configuration(config)
    rules = config.get("business_rules") if isinstance(config, dict) else None
    rule_set = config.get("rule_set") if isinstance(config, dict) else None
    valid = (
        isinstance(rule_set, dict) and rule_set.get("id") == run.rule_set_id
        and pinned["rule_set_code"] is not None and (pinned["rule_set_version"] or 0) > 0
        and pinned["configuration_captured_at"] is not None and isinstance(rules, list) and bool(rules)
    )
    rule_codes = [row["rule_code"] for row in rules if isinstance(row, dict) and isinstance(row.get("rule_code"), str)] if isinstance(rules, list) else []
    valid = valid and len(rule_codes) == len(rules) and len(rule_codes) == len(set(rule_codes))
    fingerprint = sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest() if valid else None
    return {
        "run_code": str(run.run_code),
        "group_code": group.group_code,
        "run_status": run.status,
        "candidate_status": group.status,
        "rule_set_id": run.rule_set_id,
        **pinned,
        "f1_rule_codes": rule_codes,
        "configuration_fingerprint": fingerprint,
    }, [] if valid else [{"code": "PINNED_CONFIGURATION_INCOMPLETE"}]


def _demand_input(demand, raw, latest):
    values = demand.demand_values
    if not values["requested_date"]:
        raise ValidationError("F2 requires the captured Demand date.")
    records = _record_index(raw["related_records"])
    outlet = records.get(("OUTLET", str(values["outlet_id"])), {}).get("values", {})
    category = records.get(("CARGO_CATEGORY", str(values["cargo_category_id"])), {}).get("values", {})
    source = latest.get("confirmation") if latest else None
    pickup = records.get(("CAPACITY_SUPPLIER_CONFIRMATION", str(source["id"])), {}).get("values", {}) if source else {}

    confirmation = _build_confirmation_result(demand, latest)
    confirmed = dict(confirmation.confirmed_weight_by_demand_item)
    items = tuple(DemandItem(
        item["item_id"], _decimal_value(item["required_weight_kg"], "item.required_weight_kg"), confirmed.get(item["id"]),
    ) for item in demand.related_records["demand_items"])
    weight = _decimal_value(values["quantity_kg"], "demand.quantity_kg")
    diagnostics = []
    if not items or weight <= 0 or weight != sum(item.required_weight_kg for item in items):
        diagnostics.append("REQUIRED_WEIGHT_INCONSISTENT")
    if confirmation.status != ConfirmationGateStatus.ELIGIBLE or any(
        item.confirmed_weight_kg is None or item.confirmed_weight_kg < item.required_weight_kg for item in items
    ):
        diagnostics.append("CONFIRMED_FULFILLMENT_INCOMPLETE")

    address = pickup.get("PICKUP_ADDRESS")
    if not address or not address.strip():
        diagnostics.append("PICKUP_ADDRESS_MISSING")
    ready_date, start, end = (_date(pickup.get("READY_DATE")), _time(pickup.get("READY_START_TIME")), _time(pickup.get("READY_END_TIME")))
    if ready_date is None or start is None or end is None or start >= end:
        diagnostics.append("PICKUP_WINDOW_INCOMPLETE")
    if not outlet.get("OUTLET_CODE") or not category.get("CATEGORY_CODE"):
        diagnostics.append("STOP_REFERENCE_INCOMPLETE")

    return Demand(
        demand.demand_id, demand.demand_code,
        values["supplier_id"], values["outlet_id"], outlet.get("OUTLET_CODE") or "",
        values["cargo_category_id"], category.get("CATEGORY_CODE") or "", values["requested_date"],
        values["requested_start_time"], values["requested_end_time"], weight, items,
        address.strip() if address else None, pickup.get("READY_DATE"), pickup.get("READY_START_TIME"),
        pickup.get("READY_END_TIME"), latest["id"] if latest else None, source["id"] if source else None,
        raw["captured_at"], raw["schema_version"],
    ), diagnostics


def _candidate_demands(run, candidate, outlet_ids):
    ids = candidate["demand_ids"]
    rows = list(run.run_demands.filter(demand_id__in=ids).order_by("demand_id"))
    if [row.demand_id for row in rows] != ids:
        raise CandidateInvalid("F2_CANDIDATE_MEMBERSHIP_INVALID")
    if any(row.eligibility_status != EligibilityStatus.ELIGIBLE or row.plan_guard_status != PlanGuardStatus.PASS or
           row.matching_status not in (MatchingStatus.INCLUDED, MatchingStatus.MULTIPLE_CANDIDATES) for row in rows):
        raise CandidateInvalid("F2_CANDIDATE_RESULTS_INVALID")

    try:
        source = read_run_snapshots([row.demand_snapshot for row in rows])
    except ValidationError:
        return [], [{"code": "CANDIDATE_SNAPSHOT_INCOMPLETE"}]
    if [row.demand_id for row in source.demands] != ids:
        return [], [{"code": "CANDIDATE_SNAPSHOT_IDENTITY_MISMATCH"}]
    if any(row.demand_values["outlet_id"] not in outlet_ids for row in source.demands):
        raise CandidateUnavailable
    latest_by_demand = _latest_request_by_demand(source.capacity_requests)

    entries, diagnostics = [], []
    for row, demand in zip(rows, source.demands, strict=True):
        try:
            entry, issues = _demand_input(demand, row.demand_snapshot, latest_by_demand.get(demand.demand_id))
        except ValidationError:
            issues = ["DEMAND_SNAPSHOT_INCOMPLETE"]
        else:
            entries.append(entry)
        diagnostics.extend({"code": code, "demand_id": row.demand_id} for code in issues)

    if len(entries) == len(ids):
        start_times = [_time(entry.requested_start_time) for entry in entries]
        end_times = [_time(entry.requested_end_time) for entry in entries]
        if (
            any(_date(entry.requested_date) != _date(candidate["requested_date"]) for entry in entries)
            or any(start is None or end is None or start > end for start, end in zip(start_times, end_times, strict=True))
            or max(start_times) != _time(candidate["common_start_time"])
            or min(end_times) != _time(candidate["common_end_time"])
            or sorted({entry.cargo_category_id for entry in entries}) != candidate["cargo_category_ids"]
            or len({entry.outlet_id for entry in entries}) < 2
        ):
            diagnostics.append({"code": "CANDIDATE_SNAPSHOT_BASIS_MISMATCH"})
    return entries, diagnostics


def find_f2_candidate(*, actor, run_code, group_code, lock=False):
    outlet_ids = set(require_f1_outlet_ids(actor))
    run = scoped_f1_runs(actor).filter(run_code=run_code).first()
    if run is None:
        raise CandidateUnavailable
    groups = CollaborationGroup.objects.filter(run_code=run.run_code, group_code=group_code, created_by=actor)
    group = (groups.select_for_update() if lock else groups).first()
    if group is None:
        raise CandidateUnavailable
    return run, group, outlet_ids


def build_f2_options(*, run, group, outlet_ids, hub_id, lock_hub=False):
    if run.status != PlanningRunStatus.COMPLETED:
        raise CandidateInvalid("F2_REQUIRES_COMPLETED_RUN")

    candidate = _candidate_basis(group, list(group.group_demands.order_by("demand_id")))
    lineage, configuration_issues = _lineage(run, group)
    demands, demand_issues = _candidate_demands(run, candidate, outlet_ids)
    hub, hub_issue = _hub_selection(hub_id, lock=lock_hub)
    return generate_options(
        lineage=lineage, candidate=candidate, demands=demands, diagnostics=configuration_issues + demand_issues,
        hub=hub, hub_diagnostic=hub_issue,
    )


@transaction.atomic
def preview_f2_options(*, actor, run_code, group_code, hub_id):
    from planning.services.f2_plans import f2_multi_hub_available, f2_storage_available, plan_summaries

    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    run, group, outlet_ids = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    options = build_f2_options(run=run, group=group, outlet_ids=outlet_ids, hub_id=hub_id)
    has_storage = f2_storage_available()
    options["persistence"] = "AVAILABLE" if has_storage and f2_multi_hub_available() else "MIGRATION_REQUIRED"
    options["saved_plans"] = plan_summaries(group, actor, outlet_ids) if has_storage else []
    return options
