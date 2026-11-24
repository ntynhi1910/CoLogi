"""Outlet-level preflight using the same effective evidence as DSS."""

from types import SimpleNamespace

from masterdata.models import Hub, Supplier, TransportProvider
from planning.services.database_evidence import _profile, timing_evidence
from planning.services.f3_hub_coverage import resolve_hub_coverage
from planning.services.f3_preview import _capture_hub_coverage
from planning.services.f5_economics import PriceInvalid
from planning.services.operational_evidence import EvidenceReader
from transportation.models import ProviderVehicleOffer


def _coverage(outlet, hub, providers, day, reader):
    structure = {
        "lineage": {"group_code": ""},
        "basis": {"requested_date": day.isoformat()},
        "option": {
            "hub": {"id": hub.pk},
            "stops": [{"key": "outlet", "entity_id": outlet.pk, "code": outlet.outlet_code}],
            "legs": [{"phase": "OUTBOUND", "to_stop": "outlet"}],
        },
    }
    for provider_id in providers:
        carrier = {"id": provider_id}
        captured = _capture_hub_coverage(structure, carrier, "", reader)
        if resolve_hub_coverage(structure, carrier, captured)["status"] == "VERIFIED":
            return True
    return False


def _baseline(reader, supplier_id, outlet_id, profile_id):
    if profile_id is None:
        return False
    scope = {"supplier_id": supplier_id, "outlet_id": outlet_id}
    record = reader.choose("BASELINE", profile_id=profile_id, **scope)
    supplement = reader.internal_approval and reader.internal_approval["profile_id"]
    if record is None and supplement and supplement != profile_id and reader.effective("BASELINE", profile_id=profile_id, **scope) is None:
        record = reader.supplement("BASELINE", profile_id=supplement, **scope)
    if record is None:
        return False
    offer = record.data.get("default_offer_id")
    if offer is None:
        return bool(record.data.get("components"))
    return (
        ProviderVehicleOffer.objects.filter(pk=offer, is_active=True, provider__is_active=True, vehicle_type__is_active=True).exists()
        and reader.choose("TARIFF", offer_id=offer) is not None
    )


def planning_readiness(outlet, day):
    reader = EvidenceReader.for_planning(day)
    location = f"OUTLET:{outlet.pk}"
    suppliers = list(Supplier.objects.filter(is_active=True).only("supplier_code"))
    hubs = list(Hub.objects.filter(is_active=True).only("hub_code"))
    providers = list(TransportProvider.objects.filter(is_active=True).values_list("pk", flat=True))
    timing = timing_evidence({
        "basis": {"requested_date": day.isoformat(), "demands": [{"outlet_id": outlet.pk}]},
        "option": {"stops": [{"key": "outlet", "kind": "OUTLET", "entity_id": outlet.pk}]},
    })
    receiving = timing["receiving"][0]
    checks = []

    def add(key, phase, missing, applicable=True):
        checks.append({
            "code": key, "phase": phase, "status": ("NOT_APPLICABLE" if not applicable else "MISSING" if missing else "READY"),
            "missing": missing,
        })

    add("RECEIVING_WINDOWS", "F4", [] if receiving["windows"] else [outlet.outlet_code])
    add("RECEIVING_SLOTS", "F4", [] if receiving["slot_calendar_confirmed"] else [outlet.outlet_code])
    add("SERVICE_DURATION", "F4", [] if timing["services"] else [outlet.outlet_code])
    supplier_routes = {
        supplier.supplier_code: reader.choose("TRAVEL", origin=f"SUPPLIER:{supplier.pk}", destination=location)
        for supplier in suppliers
    }
    add("SUPPLIER_OUTLET_DISTANCE", "F4", [
        code for code, evidence in supplier_routes.items() if evidence is None or "distance_km" not in evidence.data
    ], bool(suppliers))
    hub_routes = {
        hub.hub_code: reader.choose("TRAVEL", origin=f"HUB:{hub.pk}", destination=location) for hub in hubs
    }
    add("HUB_OUTLET_DISTANCE", "F4", [
        code for code, evidence in hub_routes.items() if evidence is None or "distance_km" not in evidence.data
    ], bool(hubs))
    add("TRAVEL_TIME", "F4", [
        code for code, evidence in (*supplier_routes.items(), *hub_routes.items()) if evidence is None or "minutes" not in evidence.data
    ], bool(suppliers or hubs))
    add("HUB_COVERAGE", "F3", [hub.hub_code for hub in hubs if not _coverage(outlet, hub, providers, day, reader)], bool(hubs))
    try:
        policy = _profile(reader, SimpleNamespace(cost_profile_id=None))
    except PriceInvalid:
        policy = None
    profile = policy.scope["profile_id"] if policy else None
    add("BASELINE_COST", "F5", [supplier.supplier_code for supplier in suppliers if not _baseline(reader, supplier.pk, outlet.pk, profile)],
        bool(suppliers))
    return {"date": day.isoformat(), "checks": checks,
            "ready": all(row["status"] != "MISSING" for row in checks)}
