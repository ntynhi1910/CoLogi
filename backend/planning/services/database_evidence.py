"""Bind reusable PostgreSQL input records to frozen planning entities."""

from datetime import date, time

from accounts.capstone import PROVENANCE as CAPSTONE
from masterdata.models import VehicleCargoCompatibility
from planning.models import CostProfile, PlanningRunDemand, ReceivingSlot, ReceivingSource, ReceivingWindow
from planning.services.f5_economics import RULES, PriceInvalid
from planning.services.internal_supplement import SOURCE_MODE
from planning.services.operational_evidence import EvidenceReader, source_reference
from transportation.models import ProviderSupplierCoverage, ProviderVehicleOffer


def _party(row):
    kinds = {
        "SUPPLIER_PICKUP": "SUPPLIER", "OUTLET_DELIVERY": "OUTLET",
        "HUB_RECEIVE": "HUB", "HUB_DISPATCH": "HUB",
    }
    return f"{kinds[row['role']]}:{row['entity_id']}"


def _provenance(row):
    return {"source": "POSTGRESQL", "reference": source_reference(row)}


def _period(row, name):
    return {
        "start_time": row.start_time.isoformat(), "end_time": row.end_time.isoformat(),
        "source": row.source, "reference": row.source_reference, "source_mode": row.source_mode,
        "record_id": row.pk, "record_table": name,
    }


def uses_synthetic_confirmation(f2):
    confirmation_ids = {row["id"]: row["supplier_confirmation_id"] for row in f2["basis"]["demands"]}
    rows = PlanningRunDemand.objects.filter(
        planning_run__run_code=f2["lineage"]["run_code"], demand_id__in=confirmation_ids,
    ).values_list("demand_id", "demand_snapshot")
    return any(
        item["source_kind"] == "SUPPLIER_CONFIRMATION" and str(item["pk"]) == str(confirmation_ids[demand_id])
        and item["values"].get("SOURCE_MODE", "").startswith("SYNTHETIC")
        for demand_id, snapshot in rows for item in snapshot["related_records"]
    )


def _reader(day, scenario):
    return EvidenceReader.for_planning(day, scenario)


def _demo_calendar(reader, outlet_id, record):
    base = {"outlet_id": outlet_id, "observed_slots": []}
    if record is None:
        return {**base, "windows": [], "slots": None, "slot_calendar_confirmed": False,
                "source": CAPSTONE, "reference": reader.day.isoformat()}
    data, provenance = record.data, _provenance(record)
    window = {
        "start_time": max(time.fromisoformat(data["window_start"]), time.fromisoformat(data["slot_start"])).isoformat(),
        "end_time": min(time.fromisoformat(data["window_end"]), time.fromisoformat(data["slot_end"])).isoformat(),
        **provenance,
    }
    slot = {**window, "slot_type": "AVAILABLE", "status": "OPEN"}
    return {**base, "windows": [window], "slots": [slot], "slot_calendar_confirmed": True, **provenance}


def timing_evidence(f2, scenario=""):
    day = date.fromisoformat(f2["basis"]["requested_date"])
    reader = _reader(day, scenario)
    stops = f2["option"]["stops"]
    travel, services, hub_windows, receiving = [], [], [], []
    for stop in stops:
        point = f"{stop['kind']}:{stop['entity_id']}"
        for other in stops:
            if stop["key"] == other["key"]:
                continue
            destination = f"{other['kind']}:{other['entity_id']}"
            leg = reader.choose("TRAVEL", origin=point, destination=destination)
            if leg:
                travel.append({"from_stop": stop["key"], "to_stop": other["key"], **leg.data, **_provenance(leg)})
        roles = {"SUPPLIER": ("SUPPLIER_PICKUP",), "OUTLET": ("OUTLET_DELIVERY",),
                 "HUB": ("HUB_RECEIVE", "HUB_DISPATCH")}
        for role in roles[stop["kind"]]:
            service = reader.choose("SERVICE", point=point, role=role)
            if not service and (scenario or reader.internal_approval) and role == "OUTLET_DELIVERY":
                if reader.effective("SERVICE", point=point, role=role) is not None:
                    continue
                calendar = (reader.choose("CALENDAR", outlet_id=stop["entity_id"]) if scenario
                            else reader.supplement("CALENDAR", outlet_id=stop["entity_id"]))
                if calendar:
                    services.append({"stop": stop["key"], "role": role, "minutes": calendar.data["minutes"],
                                     **_provenance(calendar)})
                continue
            if service:
                row = {"stop": stop["key"], "role": role, **service.data, **_provenance(service)}
                if service.provenance == CAPSTONE and role == "SUPPLIER_PICKUP":
                    location = reader.choose("LOCATION", point=point)
                    if not location:
                        continue
                    row["site_hours"] = location.data
                services.append(row)
        if stop["kind"] == "HUB":
            hours = reader.choose("HUB_HOURS", hub_id=stop["entity_id"])
            if hours:
                hub_windows.append({"stop": stop["key"], **hours.data, **_provenance(hours)})
    for outlet_id in sorted({row["outlet_id"] for row in f2["basis"]["demands"]}):
        if scenario:
            confirmation = reader.choose("CALENDAR", outlet_id=outlet_id)
            receiving.append(_demo_calendar(reader, outlet_id, confirmation))
            continue
        windows = ReceivingWindow.objects.filter(
            outlet_id=outlet_id, day_of_week=day.weekday(),
            source_mode=ReceivingSource.OPERATIONAL, is_active=True,
        ).order_by("start_time", "end_time", "pk")
        slots = ReceivingSlot.objects.filter(
            outlet_id=outlet_id, slot_date=day, source_mode=ReceivingSource.OPERATIONAL,
        ).order_by("start_time", "end_time", "pk")
        periods = [{**_period(r, "receiving_slots"), "slot_type": r.slot_type,
                    "status": r.status, "reason": r.reason} for r in slots]
        actual = reader.effective("CALENDAR", outlet_id=outlet_id)
        if actual is None and not periods and not windows.exists():
            assumed = reader.supplement("CALENDAR", outlet_id=outlet_id)
            if assumed:
                receiving.append(_demo_calendar(reader, outlet_id, assumed))
                continue
        confirmation = reader.choose("CALENDAR", outlet_id=outlet_id) if actual else None
        receiving.append({
            "outlet_id": outlet_id, "windows": [_period(r, "receiving_windows") for r in windows],
            "slots": periods if confirmation else None, "observed_slots": periods,
            "slot_calendar_confirmed": bool(confirmation),
            **(_provenance(confirmation) if confirmation else {"source": "POSTGRESQL", "reference": day.isoformat()}),
        })
    internal = reader.internal_source()
    return {
        "approval_reference": scenario or "Approved PostgreSQL source revisions", "scenario_id": None,
        "source_mode": CAPSTONE if scenario else SOURCE_MODE if internal else "OPERATIONAL",
        **({"internal_planning": internal} if internal else {}),
        **({"capstone_scenario": scenario} if scenario else {}),
        "travel": travel, "services": services, "hub_windows": hub_windows,
        "receiving": receiving, "source_records": reader.references(),
    }


def _priced(row, components, scenario):
    return {
        "source_reference": source_reference(row),
        "source_type": (
            ("APPROVED_CAPSTONE_QUOTE" if scenario else "APPROVED_INTERNAL_ASSUMPTION")
            if row.provenance == CAPSTONE else "APPROVED_OPERATIONAL_QUOTE"
        ),
        "valid_from": row.valid_from.isoformat(), "valid_to": row.valid_to.isoformat(),
        "complete": True, "components": components,
    }


def _profile(reader, run):
    candidates = [row for row in reader.policies() if run.cost_profile_id in (None, row.scope["profile_id"])]
    active = set(CostProfile.objects.filter(
        pk__in=[row.scope["profile_id"] for row in candidates], currency_code="VND",
        is_active=not bool(reader.scenario),
    ).values_list("pk", flat=True))
    available = [row for row in candidates if row.scope["profile_id"] in active]
    if len(available) > 1:
        raise PriceInvalid("COST_PROFILE_AMBIGUOUS")
    if available:
        return available[0]
    if reader.internal_approval:
        profile = reader.internal_approval["profile_id"]
        if run.cost_profile_id in (None, profile):
            return reader.supplement("POLICY", profile_id=profile)
    return None


def _tariff_components(tariff):
    return [{"pricing_basis": "PER_KM", "rate_vnd": tariff.data["rate_vnd"], "covers": ["DISTANCE"]}]


def _baseline_tariff(reader, demand, default_offer):
    category = demand["cargo_category_id"]
    vehicle_ids = VehicleCargoCompatibility.objects.filter(
        cargo_category_id=category, is_supported=True,
    ).values_list("vehicle_type_id", flat=True)
    carriers = ProviderSupplierCoverage.objects.filter(
        supplier_id=demand["supplier_id"], coverage_status="ACTIVE", can_pickup=True,
    ).values_list("provider_id", flat=True)
    offers = ProviderVehicleOffer.objects.select_related("vehicle_type").filter(
        is_active=True, provider__is_active=True, provider_id__in=carriers, vehicle_type_id__in=vehicle_ids,
        vehicle_type__is_active=True,
        vehicle_type__capacity_kg__gte=demand["required_weight_kg"],
    ).order_by("vehicle_type__capacity_kg", "pk")
    best = sorted(offers, key=lambda offer: offer.pk != default_offer)
    for offer in best:
        tariff = reader.choose("TARIFF", offer_id=offer.pk)
        if tariff:
            return tariff
    return None


def price_evidence(run, group, basis, basis_hash, options, scenario=""):
    reader = _reader(basis["requested_date"], scenario)
    policy = _profile(reader, run)
    if not policy:
        return None
    reader.used[policy.pk] = policy
    profile = policy.scope["profile_id"]
    assumed_profile = reader.internal_approval["profile_id"] if reader.internal_approval else profile
    baselines, quotes = [], []
    for demand in basis["demands"]:
        entry = reader.choose("BASELINE", demand_id=demand["id"], profile_id=profile)
        if entry:
            baselines.append({
                "demand_id": demand["id"], "outlet_id": demand["outlet_id"], "weight_kg": entry.data["weight_kg"],
                **_priced(entry, [{"pricing_basis": "FIXED", "rate_vnd": entry.data["amount_vnd"], "covers": ["TRANSPORT_BASE"]}], scenario),
            })
            continue
        if reader.effective("BASELINE", demand_id=demand["id"], profile_id=profile) is not None:
            continue
        pair = {"supplier_id": demand["supplier_id"], "outlet_id": demand["outlet_id"]}
        tariff = reader.choose("BASELINE", **pair, profile_id=profile)
        if tariff is None and assumed_profile != profile and reader.effective("BASELINE", **pair, profile_id=profile) is None:
            tariff = reader.supplement("BASELINE", **pair, profile_id=assumed_profile)
        if tariff is None:
            continue
        if "default_offer_id" in tariff.data:
            rated = _baseline_tariff(reader, demand, tariff.data["default_offer_id"])
            if rated is None:
                continue
            components = _tariff_components(rated)
        else:
            rated = tariff
            components = tariff.data["components"]
        baseline = {
            "demand_id": demand["id"], "outlet_id": demand["outlet_id"], "weight_kg": demand["required_weight_kg"],
            **_priced(rated, components, scenario),
        }
        if any(part["pricing_basis"] == "PER_KM" for part in components):
            leg = reader.choose("TRAVEL", origin=f"SUPPLIER:{demand['supplier_id']}", destination=f"OUTLET:{demand['outlet_id']}")
            if leg is None:
                continue
            baseline["independent_distance"] = {
                "distance_km": leg.data["distance_km"], "scope": policy.data["distance_basis"],
                "source_reference": source_reference(leg),
            }
        baselines.append(baseline)
    for saved in sorted(options, key=lambda row: row.f3_evaluation.plan_id):
        result = saved.f4_structure["result"]
        if result["status"] != "PASS":
            continue
        waves = []
        for wave in result["waves"]:
            offer_id = wave["vehicle"]["offer_id"]
            route = [_party(stop) for stop in wave["stops"]]
            quote_scope = {"offer_id": offer_id, "phase": wave["phase"], "route": route}
            entry = reader.choose("TARIFF", offer_id=offer_id) if scenario else reader.choose("QUOTE", **quote_scope)
            if not scenario and entry is None and reader.effective("QUOTE", **quote_scope) is None:
                entry = reader.supplement("TARIFF", offer_id=offer_id)
            if entry:
                waves.append({"wave_no": wave["wave_no"], "offer_id": offer_id,
                              **_priced(entry, _tariff_components(entry) if entry.kind == "TARIFF" else entry.data["components"], scenario)})
        quote = {
            "f4_evaluation_code": str(saved.evaluation_code), "input_fingerprint": saved.input_fingerprint,
            "configuration_fingerprint": saved.configuration_fingerprint, "waves": waves,
        }
        hub = saved.f3_evaluation.plan.hub_id
        if hub:
            fee = reader.choose("HUB_FEE", hub_id=hub, profile_id=profile)
            if fee is None and assumed_profile != profile and reader.effective("HUB_FEE", hub_id=hub, profile_id=profile) is None:
                fee = reader.supplement("HUB_FEE", hub_id=hub, profile_id=assumed_profile)
            if fee:
                quote["hub"] = {"hub_id": hub, **_priced(fee, fee.data["components"], scenario)}
        quotes.append(quote)
    internal = reader.internal_source()
    for saved in options:
        if internal:
            break
        inputs = saved.f4_structure.get("inputs", {})
        internal = (inputs.get("time_evidence", {}).get("internal_planning")
                    or inputs.get("f3", {}).get("inputs", {}).get("cp7", {}).get("internal_planning"))
    return {
        "schema_version": 1, "approval_reference": scenario or "Approved PostgreSQL source revisions",
        "source_mode": CAPSTONE if scenario else SOURCE_MODE if internal else "OPERATIONAL", "run_code": str(run.run_code),
        **({"internal_planning": internal} if internal else {}),
        "group_code": group.group_code, "scenario": scenario or None,
        "service_date": basis["requested_date"], "demand_basis_fingerprint": basis_hash,
        "configuration": {
            "version": f"db:{profile}:policy:{policy.pk}:v{policy.version}", "rules": RULES,
            "currency_code": "VND", "rounding_mode": "HALF_UP",
            "allocation_residual": "LARGEST_REMAINDER_OUTLET_ID", **policy.data,
        },
        "cost_profile_id": profile, "source_records": reader.references(), "baseline": baselines, "options": quotes,
    }
