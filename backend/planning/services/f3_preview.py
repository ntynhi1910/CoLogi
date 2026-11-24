"""Read F2 and CP7 inputs in one read-only transaction."""

from dataclasses import asdict, dataclass, replace
from datetime import date, time
from decimal import Decimal, InvalidOperation
import json

from django.core.exceptions import ValidationError
from django.db import connection, transaction
from django.db.models import Prefetch, Q

from accounts.capstone import PROVENANCE as CAPSTONE, run_scenario
from planning.services.demand_provenance import OPERATIONAL_SOURCE_REQUIRED, operational_demands_required
from masterdata.models import TransportProvider, VehicleCargoCompatibility
from planning.f2_structure import validate_f2_structure
from planning.f3_contract import (
    MANAGER_ACCEPTED_AVAILABILITY, RULES, canonical, evaluation_contract_version, fingerprint,
    gate_result, hard_checks, rule_issues,
)
from planning.models import FulfillmentPlanStatus, PlanningBusinessRule, PlanningModuleCode, PlanningParameters, PlanningRunStatus
from planning.services.f2_plans import F2MigrationRequired, _saved_plans, _summaries, f2_storage_available
from planning.services.f2_preview import CandidateUnavailable, _lineage, find_f2_candidate
from planning.services.f3_acceptance import (
    AcceptanceEvidenceMismatch, MANIFEST_SHA256, manifest_for_request, overlay_legacy_windows,
    verify_pinned_rows, verify_scope,
)
from planning.services.f3_allocation import Availability, Offer, allocate
from planning.services.f3_hub_coverage import required_routes, resolve_hub_coverage, uat_hub_coverage_enabled
from planning.services.f3_presentation import describe_evaluation
from planning.services.internal_supplement import SCENARIO, display_approval
from planning.services.operational_evidence import EvidenceReader, source_reference
from transportation.hub_coverage import CoverageDirection, CoverageSource
from transportation.models import HubCoverageEvidence, ProviderAvailability, ProviderSupplierCoverage, ProviderVehicleOffer
from transportation.services import BUSINESS_TZ, OPERATIONAL_SOURCE_MODES, legacy_migrated_availability_ids
from transportation.v7_planning import V7_FLEET_SOURCE, V7_WORKBOOK_SHA256, v7_planning_availability


PARAMETER_KEYS = ("TIMEZONE", "WEIGHT_UNIT", "UTILIZATION_WARNING_PCT")


def _configuration(rule_set_id, parameters):
    active = dict(PlanningBusinessRule.objects.filter(
        rule_set_id=rule_set_id, module_code=PlanningModuleCode.F3, is_active=True,
    ).order_by("rule_code").values_list("rule_code", "rule_definition"))
    issues = rule_issues(active)
    warning_pct = None
    for key, (value, data_type) in parameters.items():
        if key == "UTILIZATION_WARNING_PCT":
            try:
                parsed = Decimal(str(value))
                if data_type != "DECIMAL" or not parsed.is_finite() or not 0 <= parsed <= 100:
                    raise ValueError
                warning_pct = parsed
            except (InvalidOperation, ValueError):
                issues.append({"code": "F3_PARAMETER_INVALID", "values": [key]})
        elif data_type != "STRING" or value != {"TIMEZONE": str(BUSINESS_TZ), "WEIGHT_UNIT": "KG"}[key]:
            issues.append({"code": "F3_PARAMETER_INVALID", "values": [key]})
    return issues, warning_pct, {
        "rule_set_id": rule_set_id, "reference_rule_codes": list(RULES),
        "configured_rule_codes": list(active),
        "missing_parameter_keys": sorted(set(PARAMETER_KEYS) - parameters.keys()),
    }, {"rules": active, "parameters": parameters}


def _read_configuration(rule_set_id):
    parameters = {key: (value, kind) for key, value, kind in PlanningParameters.objects.filter(
        parameter_key__in=PARAMETER_KEYS,
    ).order_by("parameter_key").values_list("parameter_key", "parameter_value", "data_type")}
    return _configuration(rule_set_id, parameters)


def _fleet_sources(dates, provider, excluded_windows, readers):
    if provider is None:
        return None, [], {}, {}
    rows = ProviderVehicleOffer.objects.filter(provider_id=provider["id"]).select_related("vehicle_type").prefetch_related(
        Prefetch("availability_windows", queryset=ProviderAvailability.objects.filter(
            service_date__in=dates, source_mode__in=OPERATIONAL_SOURCE_MODES,
        ).exclude(pk__in=excluded_windows).order_by("service_date", "start_time", "pk"), to_attr="f3_windows"),
    ).order_by("pk")
    capstone = any(reader.scenario for reader in readers.values())
    offers = [
        Offer(
            row.pk, row.vehicle_type_id, row.vehicle_type.vehicle_code, row.vehicle_type.vehicle_name,
            row.vehicle_type.capacity_kg, row.available_vehicle_count, row.is_active, row.vehicle_type.is_active,
            row.operating_start_time, row.operating_end_time, tuple(
                Availability(window.pk, window.service_date, window.start_time, window.end_time,
                             window.available_vehicle_count, window.availability_status, window.source_mode)
                for window in row.f3_windows if not capstone
            ),
        )
        for row in rows
    ]
    if readers:
        offers = [replace(offer, windows=offer.windows + tuple(
            Availability(evidence.pk, day, time.fromisoformat(evidence.data["start_time"]),
                         time.fromisoformat(evidence.data["end_time"]), evidence.data["count"],
                         evidence.data["status"], CAPSTONE)
            for day, reader in readers.items()
            if not any(window.service_date == day for window in offer.windows)
            if (evidence := reader.choose("AVAILABILITY", offer_id=offer.id)) is not None
        )) for offer in offers]
    matrix = {
        (row["vehicle_type_id"], row["cargo_category_id"]): {
            "is_supported": row["is_supported"], "source": row["source"],
        }
        for row in VehicleCargoCompatibility.objects.filter(
            vehicle_type_id__in={offer.vehicle_type_id for offer in offers},
        ).values("vehicle_type_id", "cargo_category_id", "is_supported", "source")
    }
    coverage = {
        row["supplier_id"]: row
        for row in ProviderSupplierCoverage.objects.filter(provider_id=provider["id"]).values(
            "id", "supplier_id", "coverage_status", "can_pickup",
        )
    }
    return provider, offers, matrix, coverage


def _with_v7_fleet(fleet, day, reader, v7_slots):
    provider, offers, matrix, coverage = fleet
    by_offer = {}
    for slot, _origin in v7_slots.values():
        if slot.service_date == day:
            by_offer.setdefault(slot.provider_vehicle_offer_id, []).append(Availability(
                slot.pk, day, slot.start_time, slot.end_time, slot.available_vehicle_count,
                slot.availability_status, V7_FLEET_SOURCE,
            ))
    updated = [replace(offer, windows=offer.windows + tuple(by_offer[offer.id]))
               if offer.id in by_offer and not any(window.service_date == day for window in offer.windows)
               and not reader.has_dated_authority("AVAILABILITY", offer_id=offer.id)
               else offer for offer in offers]
    return provider, updated, matrix, coverage


def _validated_structure(plan, run, group, fingerprint):
    structure = plan.f2_structure
    validate_f2_structure(structure)
    lineage = structure["lineage"]
    hub_id = structure["option"]["hub"]["id"] if structure["option"]["hub"] else None
    if (plan.status != FulfillmentPlanStatus.DRAFT or run.status != PlanningRunStatus.COMPLETED
        or lineage["run_code"] != str(run.run_code) or lineage["configuration_fingerprint"] != fingerprint
        or lineage["rule_set_id"] != run.rule_set_id or lineage["group_code"] != group.group_code
        or structure["option"]["template_type"] != plan.template_type or hub_id != plan.hub_id):
        raise ValidationError("F3 requires a valid saved F2 draft with matching lineage.")
    return structure


@dataclass(frozen=True)
class F3Capture:
    plan_id: int
    result: dict
    document: dict | None = None


def _capture_hub_coverage(structure, provider, scenario, reader):
    uat = uat_hub_coverage_enabled(connection)
    capture = {"context": "CAPSTONE" if scenario else "UAT" if uat else "OPERATIONAL", "records": []}
    if provider is None:
        return capture
    required = required_routes(structure)
    suppliers = [endpoint for direction, endpoint in required if direction == CoverageDirection.INBOUND]
    outlets = [endpoint for direction, endpoint in required if direction == CoverageDirection.OUTBOUND]
    day = structure["basis"]["requested_date"]
    sources = Q(source__in=CoverageSource.operational())
    if uat:
        sources |= Q(source=CoverageSource.SYNTHETIC_UAT, uat_candidate_code=structure["lineage"]["group_code"])
    rows = HubCoverageEvidence.objects.filter(
        sources,
        Q(direction=CoverageDirection.INBOUND, supplier_id__in=suppliers)
        | Q(direction=CoverageDirection.OUTBOUND, outlet_id__in=outlets),
        provider_id=provider["id"], hub_id=structure["option"]["hub"]["id"],
        valid_from__lte=day, valid_through__gte=day,
    ).order_by("id").values(
        "id", "provider_id", "hub_id", "direction", "supplier_id", "outlet_id", "confirmation_status",
        "valid_from", "valid_through", "source", "source_reference", "uat_candidate_code", "recorded_at",
    )
    records = [] if scenario else list(rows)
    if scenario or not uat:
        for direction, endpoint in required:
            inbound = direction == CoverageDirection.INBOUND
            scope = {
                "provider_id": provider["id"], "hub_id": structure["option"]["hub"]["id"], "direction": direction,
                "endpoint": f"{'SUPPLIER' if inbound else 'OUTLET'}:{endpoint}",
            }
            evidence = reader.effective("HUB_COVERAGE", **scope)
            if evidence is None and not any(
                row["direction"] == direction and row["supplier_id" if inbound else "outlet_id"] == endpoint
                for row in records
            ):
                evidence = reader.supplement("HUB_COVERAGE", **scope)
            if evidence:
                assumed = evidence.provenance == CAPSTONE
                if assumed and not scenario:
                    capture["context"] = "INTERNAL_PLANNING"
                records.append({
                    "id": 10**12 + evidence.pk, "provider_id": provider["id"], "hub_id": evidence.scope["hub_id"],
                    "direction": direction, "supplier_id": endpoint if inbound else None,
                    "outlet_id": None if inbound else endpoint,
                    "confirmation_status": "CONFIRMED" if evidence.approval == "APPROVED" else "REVOKED",
                    "valid_from": evidence.valid_from, "valid_through": evidence.valid_to,
                    "source": CAPSTONE if assumed else CoverageSource.PROVIDER_CONFIRMED_IMPORT,
                    "source_reference": source_reference(evidence),
                    "uat_candidate_code": structure["lineage"]["group_code"] if assumed else "",
                    "recorded_at": evidence.recorded_at,
                })
    capture["records"] = json.loads(canonical(records))
    return capture


def _evaluate(structure, summary, fleet, config, scenario="", reader=None, v7_source=None, v7_slots=None):
    provider, offers, matrix, coverage = fleet
    issues, warning, configuration, captured_config = config
    basis = structure["basis"]
    date_key = basis["requested_date"]
    dated_offers = [
        replace(offer, windows=tuple(row for row in offer.windows if row.service_date.isoformat() == date_key))
        for offer in offers
    ]
    suppliers = {row["supplier_id"] for row in basis["demands"]}
    hub_reader = (EvidenceReader(date_key, internal_approval=reader.internal_approval)
                  if reader and reader.internal_approval else reader)
    captured_hub = _capture_hub_coverage(
        structure, provider, scenario, hub_reader or EvidenceReader(date_key),
    ) if summary["hub_id"] else None
    hub_coverage = resolve_hub_coverage(structure, provider, captured_hub) if captured_hub is not None else None
    cp7 = {
        "provider": provider,
        "offers": [asdict(offer) for offer in dated_offers],
        "compatibility": [
            {"vehicle_type_id": vehicle, "cargo_category_id": category, **row}
            for (vehicle, category), row in sorted(matrix.items()) if category in basis["cargo_category_ids"]
        ],
        "supplier_coverage": [coverage[pk] for pk in sorted(suppliers & coverage.keys())],
        "missing_pickup_demand_ids": [row["id"] for row in basis["demands"] if row["supplier_id"] not in coverage],
        "hub_coverage": captured_hub or {"hub_id": None, "status": "NOT_APPLICABLE"},
    }
    if scenario:
        cp7["capstone_scenario"] = scenario
        selected_windows = {row.id for offer in dated_offers for row in offer.windows}
        cp7["source_records"] = [row for row in reader.references() if row["id"] in selected_windows]
    elif reader and reader.internal_approval:
        window_ids = {row.id for offer in dated_offers for row in offer.windows if row.source == CAPSTONE}
        sources = [row for row in reader.references() if row["kind"] == "AVAILABILITY" and row["id"] in window_ids]
        if hub_reader:
            sources.extend(hub_reader.references())
        if sources:
            cp7["internal_planning"] = display_approval(reader.internal_approval)
            cp7["source_records"] = sources
    result = {
        "plan": summary, "configuration": configuration, "stops": structure["option"]["stops"],
        **allocate(structure, provider=provider, offers=dated_offers, matrix=matrix,
                   coverage=coverage, configuration_issues=issues, warning_pct=warning, hub_coverage=hub_coverage),
    }
    if v7_source:
        v7_ids = {window["id"] for wave in result["waves"] for window in wave["vehicle"]["windows"]
                  if window["source"] == V7_FLEET_SOURCE}
        if v7_ids:
            cp7["internal_planning"] = v7_source
            cp7.setdefault("source_records", []).extend({
                "id": pk, "kind": "AVAILABILITY", "version": 1, "provenance": v7_slots[pk][1],
                "scenario": "", "source_reference": f"Dataset V7 · 48_Provider_Availability · AuditLog {v7_source['approval_id']}",
                "valid_from": date_key, "valid_to": date_key, "workbook_sha256": V7_WORKBOOK_SHA256,
                "fingerprint": fingerprint([pk, date_key, v7_slots[pk][1], V7_WORKBOOK_SHA256]),
                "provider_independently_verified": False, "source": V7_FLEET_SOURCE,
            } for pk in sorted(v7_ids))
    if hub_coverage is not None:
        result["hub_coverage"] = hub_coverage
    result["gate_status"] = gate_result(result, cp7)
    result["hard_constraints"] = hard_checks(result, cp7, bool(summary["hub_id"]))
    return json.loads(canonical({
        "inputs": {"f2_fingerprint": fingerprint(structure), "cp7": cp7},
        "configuration": {
            "rule_set": {key: structure["lineage"][key] for key in (
                "rule_set_id", "rule_set_code", "rule_set_version", "configuration_fingerprint",
            )},
            **captured_config,
        },
        "result": result,
    }))


@transaction.atomic
def capture_f3(*, actor, run_code, group_code, plan_codes=None):
    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    return capture_f3_in_snapshot(actor=actor, run_code=run_code, group_code=group_code, plan_codes=plan_codes)


def capture_f3_in_snapshot(*, actor, run_code, group_code, plan_codes=None):
    """Capture F3 inside the caller's already-established transaction snapshot."""
    run, group, outlet_ids = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f2_storage_available():
        raise F2MigrationRequired
    visible = _summaries(_saved_plans(group, actor), outlet_ids)
    if plan_codes is not None:
        by_code = {plan.plan_code: (plan, summary) for plan, summary in visible}
        if any(code not in by_code for code in plan_codes):
            raise CandidateUnavailable
        plans = [by_code[code] for code in plan_codes]
    else:
        latest = {(plan.template_type, plan.hub_id): (plan, summary) for plan, summary in visible}
        plans = [latest[key] for key in sorted(latest, key=lambda key: (key[0], key[1] or 0))]

    valid, results = [], {}
    scenario = run_scenario(run)
    lineage, _ = _lineage(run, group)
    for plan, summary in plans:
        try:
            structure = _validated_structure(plan, run, group, lineage["configuration_fingerprint"])
        except ValidationError:
            results[plan.pk] = F3Capture(plan.pk, {
                "plan": summary, "status": "INVALID_PLAN", "gate_status": "NOT_ELIGIBLE",
                "diagnostics": [{"code": "INVALID_SAVED_F2"}],
            })
        else:
            if operational_demands_required(scenario, [row["id"] for row in structure["basis"]["demands"]]):
                results[plan.pk] = F3Capture(plan.pk, {
                    "plan": summary, "status": "INVALID_PLAN", "gate_status": "NOT_ELIGIBLE",
                    "diagnostics": [{"code": OPERATIONAL_SOURCE_REQUIRED}],
                })
                continue
            valid.append((plan, summary, structure))
    if valid:
        dates = {structure["basis"]["requested_date"] for _, _, structure in valid}
        uat = uat_hub_coverage_enabled(connection)
        readers = {
            day: EvidenceReader.for_planning(day, scenario) for day in map(date.fromisoformat, sorted(dates))
        } if not uat or scenario else {}
        providers = TransportProvider.objects.order_by("provider_code", "pk")
        providers = providers.filter(provider_code="TP001") if uat else providers.filter(is_active=True)
        excluded = legacy_migrated_availability_ids()
        v7_source, v7_slots = v7_planning_availability() if not scenario and not uat else (None, {})
        fleets = [_fleet_sources(dates, row, excluded, readers) for row in providers.values(
            "id", "provider_code", "provider_name", "is_active", "service_region",
        )] or [(None, [], {}, {})]
        config = _read_configuration(run.rule_set_id)
        for plan, summary, structure in valid:
            document = None
            day = date.fromisoformat(structure["basis"]["requested_date"])
            for fleet in fleets:
                candidate = _evaluate(structure, summary, fleet, config, scenario, readers.get(day))
                if document is None or candidate["result"]["gate_status"] == "ELIGIBLE":
                    document = candidate
                if document["result"]["gate_status"] == "ELIGIBLE":
                    break
            if document["result"]["gate_status"] != "ELIGIBLE" and v7_slots and day in readers:
                for fleet in fleets:
                    fallback = _with_v7_fleet(fleet, day, readers[day], v7_slots)
                    if fallback == fleet:
                        continue
                    candidate = _evaluate(structure, summary, fallback, config, scenario, readers[day], v7_source, v7_slots)
                    if candidate["result"]["gate_status"] == "ELIGIBLE" or (
                        candidate["result"]["waves"] and not document["result"]["waves"]
                    ):
                        document = candidate
                    if document["result"]["gate_status"] == "ELIGIBLE":
                        break
            results[plan.pk] = F3Capture(plan.pk, document["result"], document)
    return [results[plan.pk] for plan, _ in plans]


def preview_f3(*, actor, run_code, group_code, plan_code=None):
    captures = capture_f3(actor=actor, run_code=run_code, group_code=group_code,
                          plan_codes=[plan_code] if plan_code else None)
    evaluations = []
    for capture in captures:
        if capture.document is None:
            evaluations.append(capture.result)
            continue
        document = capture.document
        evaluations.append({
            **capture.result,
            **({"internal_planning": document["inputs"]["cp7"]["internal_planning"]}
               if "internal_planning" in document["inputs"]["cp7"] else {}),
            "contract_version": evaluation_contract_version(capture.result["plan"]["hub_id"]),
            "input_fingerprint": fingerprint(document["inputs"]),
            "configuration_fingerprint": fingerprint(document["configuration"]),
            "presentation": describe_evaluation(capture.result, document["configuration"]["parameters"]),
        })
    return {"evaluations": evaluations}


@transaction.atomic
def preview_manager_acceptance_f3(*, actor, run_code, group_code, plan_code):
    manifest = manifest_for_request(actor, run_code, group_code, plan_code)
    if manifest is None or not plan_code:
        raise CandidateUnavailable
    with connection.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    run, group, outlets = find_f2_candidate(actor=actor, run_code=run_code, group_code=group_code)
    if not f2_storage_available():
        raise F2MigrationRequired
    selected = next(((plan, summary) for plan, summary in _summaries(_saved_plans(group, actor), outlets)
                     if plan.plan_code == plan_code), None)
    if selected is None:
        raise CandidateUnavailable
    plan, summary = selected
    lineage, _ = _lineage(run, group)
    structure = _validated_structure(plan, run, group, lineage["configuration_fingerprint"])
    verify_scope(manifest, run, group, plan, summary["revision"])
    if run_scenario(run) or operational_demands_required("", structure["basis"]["demand_ids"]):
        raise AcceptanceEvidenceMismatch
    with connection.cursor() as cursor:
        verify_pinned_rows(manifest, cursor)

    scope = manifest["scope"]
    day = date.fromisoformat(scope["requested_service_date"])
    reader = EvidenceReader.for_planning(day)
    supplement = manifest["sources"]["supplement"]
    approval = reader.internal_approval
    internal_reader = None
    if approval and (approval["approval_id"], approval["file_sha256"]) == (
        supplement["approval_audit_log_id"], supplement["sha256"],
    ):
        internal_reader = EvidenceReader(day, provenance=CAPSTONE, scenario=SCENARIO,
                                         approved_ids=approval["record_ids"])
    else:
        reader = EvidenceReader(day)

    def has_dated_authority(offer_id):
        return (reader.effective("AVAILABILITY", offer_id=offer_id) is not None
                or (internal_reader is not None and
                    internal_reader.effective("AVAILABILITY", offer_id=offer_id) is not None))

    provider = TransportProvider.objects.filter(pk=scope["provider_id"], provider_code=scope["provider_code"]).values(
        "id", "provider_code", "provider_name", "is_active", "service_region",
    ).first()
    excluded = legacy_migrated_availability_ids()
    fleet = _fleet_sources({day}, provider, excluded, {day: reader})
    fleet, admitted = overlay_legacy_windows(manifest, fleet, excluded, has_dated_authority)
    document = _evaluate(structure, summary, fleet, _read_configuration(run.rule_set_id), reader=reader)
    result = document["result"]
    expected = {"date": day.isoformat(),
                "start_time": scope["required_vehicle_envelope"]["start"],
                "end_time": scope["required_vehicle_envelope"]["end"]}
    if result["availability_envelope"] != expected:
        raise AcceptanceEvidenceMismatch
    selected_ids = sorted({
        window["id"] for wave in result["waves"] for window in wave["vehicle"]["windows"]
        if window["source"] == MANAGER_ACCEPTED_AVAILABILITY
    })
    return {
        "evaluation_context": "MANAGER_ACCEPTANCE",
        "preview_only": True, "persistence_available": False, "ready_for_f4": False,
        "decision_reference": manifest["decision_reference"], "manifest_sha256": MANIFEST_SHA256,
        "classification": MANAGER_ACCEPTED_AVAILABILITY,
        "provider_independently_verified": False,
        "admitted_sources": admitted, "selected_legacy_ids": selected_ids,
        "dated_source_records": reader.references(), "evaluation": result,
    }
