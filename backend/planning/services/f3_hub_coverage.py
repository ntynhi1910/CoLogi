"""Resolve exact F2 Hub routes from frozen evidence and a server-side context."""

from datetime import date, datetime

from django.conf import settings
from django.core.exceptions import ValidationError
from accounts.capstone import PROVENANCE as CAPSTONE

from transportation.hub_coverage import CoverageConfirmation, CoverageDirection, CoverageSource


def uat_hub_coverage_enabled(connection):
    return connection.vendor == "postgresql" and connection.settings_dict["NAME"] == getattr(
        settings, "F3_UAT_HUB_COVERAGE_DATABASE", None,
    )


def required_routes(structure):
    option = structure["option"]
    stops = {stop["key"]: stop for stop in option["stops"]}
    routes = {}
    for leg in option["legs"]:
        phase = leg["phase"]
        inbound = phase == CoverageDirection.INBOUND
        stop = stops[leg["from_stop"] if inbound else leg["to_stop"]]
        routes[phase, stop["entity_id"]] = {
            "phase": phase,
            "supplier_id": stop["entity_id"] if inbound else None,
            "outlet_id": None if inbound else stop["entity_id"],
            "endpoint_code": stop["code"],
        }
    return routes


def resolve_hub_coverage(structure, provider, capture):
    """Newest effective record wins within its source class. Operational records take precedence."""
    hub_id = structure["option"]["hub"]["id"]
    candidate = structure["lineage"]["group_code"]
    service_date = structure["basis"]["requested_date"]
    day = date.fromisoformat(service_date)
    required = required_routes(structure)
    context = capture["context"]
    if context not in ("OPERATIONAL", "UAT", "CAPSTONE", "INTERNAL_PLANNING"):
        raise ValidationError("Invalid F3 Hub coverage context.")
    selected, seen = {}, set()
    for evidence in capture["records"]:
        synthetic = evidence["source"] in (CoverageSource.SYNTHETIC_UAT, CAPSTONE)
        inbound = evidence["direction"] == CoverageDirection.INBOUND
        route = evidence["direction"], evidence["supplier_id"] if inbound else evidence["outlet_id"]
        opposite_endpoint = evidence["outlet_id"] if inbound else evidence["supplier_id"]
        recorded_at = datetime.fromisoformat(evidence["recorded_at"])
        evidence_id = evidence["id"]
        if (
            route not in required or opposite_endpoint is not None
            or provider is None or evidence["provider_id"] != provider["id"] or evidence["hub_id"] != hub_id
            or evidence["source"] not in (*CoverageSource.values, CAPSTONE)
            or evidence["confirmation_status"] not in CoverageConfirmation.values
            or not evidence["source_reference"].strip()
            or recorded_at.utcoffset() is None or type(evidence_id) is not int or evidence_id <= 0
            or evidence_id in seen
            or not (date.fromisoformat(evidence["valid_from"]) <= day <= date.fromisoformat(evidence["valid_through"]))
            or evidence["uat_candidate_code"] != (candidate if synthetic else "")
            or (evidence["source"] == CoverageSource.SYNTHETIC_UAT and context != "UAT")
            or (evidence["source"] == CAPSTONE and context not in ("CAPSTONE", "INTERNAL_PLANNING"))
            or (context == "CAPSTONE" and evidence["source"] != CAPSTONE)
        ):
            raise ValidationError("F3 captured Hub evidence does not match the exact route, date or context.")
        seen.add(evidence_id)
        rank = (not synthetic, recorded_at, evidence_id)
        if route not in selected or rank > selected[route][0]:
            selected[route] = (rank, evidence)
    results = []
    for route, endpoint in sorted(required.items()):
        evidence = selected[route][1] if route in selected else None
        confirmed = evidence is not None and evidence["confirmation_status"] == CoverageConfirmation.CONFIRMED
        results.append({
            **endpoint,
            "status": "VERIFIED" if confirmed else "UNVERIFIED",
            "reason": None if confirmed else ("NOT_CONFIRMED" if evidence else "NO_EFFECTIVE_EVIDENCE"),
            "evidence": evidence,
        })
    return {
        "hub_id": hub_id,
        "service_date": service_date,
        "context": context,
        "status": "VERIFIED" if results and all(row["status"] == "VERIFIED" for row in results) else "UNVERIFIED",
        "uses_synthetic": any(
            row["evidence"] and row["evidence"]["source"] in (CoverageSource.SYNTHETIC_UAT, CAPSTONE) for row in results
        ),
        "routes": results,
    }


def hub_scope_diagnostics(coverage):
    return [
        {"code": "HUB_SERVICE_SCOPE_UNVERIFIED", "hub_id": coverage["hub_id"],
         **{key: row[key] for key in ("phase", "supplier_id", "outlet_id", "reason")}}
        for row in coverage["routes"] if row["status"] != "VERIFIED"
    ]
