"""Stage Capstone-only rows in the shared OperationalEvidence catalog."""

from collections import Counter
from datetime import time
from decimal import Decimal
from hashlib import sha256
from io import BytesIO

from django.core.exceptions import ValidationError
from django.db import connection, transaction
from openpyxl import load_workbook

from accounts.capstone import PROVENANCE
from accounts.models import AuditLog, User, UserRole
from masterdata.models import Hub, Outlet, Supplier
from planning.models import CostProfile, OperationalEvidence
from planning.services.operational_evidence import SCOPE_AND_DATA, key_for
from planning.services.v7_operational_import import _date, _time, source_rows
from transportation.models import ProviderSupplierCoverage, ProviderVehicleOffer


SCENARIO = "v7-supplement-v1"
SOURCE = "SYNTHETIC_CAPSTONE_V7_SUPPLEMENT_V1"
PREFIXED_MODELS = {
    "SUPPLIER": (Supplier, "supplier_code"), "OUTLET": (Outlet, "outlet_code"), "HUB": (Hub, "hub_code"),
}
SHEETS = (
    "68_Locations", "69_Route_Legs", "70_Hub_Coverage", "71_Demo_Tariffs", "72_Baseline_Rates",
    "73_Future_Availability", "74_Receiving_Demo",
)


def _clock(value):
    return _time(value).isoformat()


def _number(value):
    precision = Decimal(str(value))
    return format(precision, "f")


def _interval(row, start, end):
    left, right = _time(row[start]), _time(row[end])
    if left >= right:
        raise ValidationError("Source start must precede end.")
    return left.isoformat(), right.isoformat()


class WorkbookMapper:
    def __init__(self, workbook, profile_id):
        self.workbook = workbook
        self.profile_id = profile_id
        self.rows = {sheet: source_rows(workbook, sheet) for sheet in SHEETS}
        self.locations = {row["location_code"]: row for _, row in self.rows[SHEETS[0]]}
        self.routes = {row["route_leg_key"]: row for _, row in self.rows[SHEETS[1]]}
        self.tariffs = {row["quote_key"]: row for _, row in self.rows[SHEETS[3]]}
        self.points = {
            record[name]: (kind, record["pk"], record["is_active"])
            for kind, (model, name) in PREFIXED_MODELS.items()
            for record in model.objects.values("pk", name, "is_active")
        }
        self.offers = {
            (offer.provider.provider_code, offer.vehicle_type.vehicle_code): offer
            for offer in ProviderVehicleOffer.objects.select_related("provider", "vehicle_type")
        }
        self.pickup = set(ProviderSupplierCoverage.objects.filter(
            coverage_status="ACTIVE", can_pickup=True,
        ).values_list("provider_id", "supplier_id"))
        self.policy_origin = next((line, row) for line, row in self.rows[SHEETS[3]] if row["demo_status"] == "PROPOSED_DEMO")

    def point(self, code, kind=None):
        declared = self.locations[code]
        actual, pk, active = self.points[code]
        if actual != declared["location_type"] or kind and actual != kind:
            raise ValidationError(f"{code} has the wrong masterdata type.")
        if not active or not declared["v7_is_active"] or declared["demo_status"] != "PROPOSED_DEMO":
            raise ValidationError(f"{code} is not enabled for this demo.")
        return pk, f"{actual}:{pk}"

    def offer(self, row):
        offer = self.offers[(row["provider_code"], row["vehicle_code"])]
        if not (offer.is_active and offer.provider.is_active and offer.vehicle_type.is_active):
            raise ValidationError("The matched offer is inactive.")
        return offer

    @staticmethod
    def spec(kind, scope, data):
        return kind, scope, data

    def location(self, row):
        kind = row["location_type"]
        pk, point = self.point(row["location_code"], kind)
        start, end = _interval(row, "service_open_ict", "service_close_ict")
        yield self.spec("LOCATION", {"point": point}, {"start_time": start, "end_time": end})
        if kind == "SUPPLIER":
            yield self.spec("SERVICE", {"point": point, "role": "SUPPLIER_PICKUP"}, {"minutes": row["stop_service_min"]})
        if kind == "HUB":
            yield self.spec("HUB_HOURS", {"hub_id": pk}, {"start_time": start, "end_time": end})
            for role, field in (("HUB_RECEIVE", "hub_inbound_min"), ("HUB_DISPATCH", "hub_outbound_min")):
                yield self.spec("SERVICE", {"point": point, "role": role}, {"minutes": row[field]})
            parts = [{"pricing_basis": "FIXED", "rate_vnd": _number(row["hub_fee_vnd"]), "covers": ["HUB_HANDLING"]}]
            yield self.spec("HUB_FEE", {"hub_id": pk, "profile_id": self.profile_id}, {"components": parts})

    def travel(self, row):
        _, origin = self.point(row["from_code"])
        _, destination = self.point(row["to_code"])
        if origin == destination:
            raise ValidationError("Route has identical endpoints.")
        yield self.spec("TRAVEL", {"origin": origin, "destination": destination},
                        {"minutes": row["travel_minutes"], "distance_km": _number(row["distance_km"])})

    def coverage(self, row):
        hub, _ = self.point(row["hub_code"], "HUB")
        pk, point = self.point(row["endpoint_code"], row["endpoint_type"])
        link = self.routes[row["route_leg_key"]]
        if (link["from_code"], link["to_code"]) != (row["from_code"], row["to_code"]):
            raise ValidationError("Coverage and route endpoints differ.")
        carriers = {offer.provider_id for (code, _), offer in self.offers.items()
                    if code == row["provider_code"] and offer.provider.is_active}
        if len(carriers) != 1 or not row["demo_can_service"]:
            raise ValidationError("A Capstone provider or demo coverage is unavailable.")
        provider, = carriers
        expected = "SUPPLIER" if row["direction"] == "INBOUND" else "OUTLET"
        if row["endpoint_type"] != expected or (expected == "SUPPLIER" and (provider, pk) not in self.pickup):
            raise ValidationError("Coverage direction or supplier pickup permission is invalid.")
        yield self.spec("HUB_COVERAGE", {"hub_id": hub, "provider_id": provider,
                        "endpoint": point, "direction": row["direction"]}, {})

    def tariff(self, row):
        offer = self.offer(row)
        if (
            row["pricing_basis"] != "PER_KM" or row["distance_scope"] != "FIRST_SERVICE_TO_LAST_SERVICE"
            or row["include_return"] or row["include_depot"] or row["currency"] != "VND"
            or Decimal(str(row["capacity_kg"])) != offer.vehicle_type.capacity_kg
        ):
            raise ValidationError("The tariff or offer differs from the Capstone charge scope.")
        yield self.spec("TARIFF", {"offer_id": offer.pk}, {"rate_vnd": _number(row["rate_vnd_per_km"])})

    def baseline(self, row):
        supplier, _ = self.point(row["supplier_code"], "SUPPLIER")
        outlet, _ = self.point(row["outlet_code"], "OUTLET")
        leg = self.routes[row["route_leg_key"]]
        tariff = self.tariffs[row["quote_key"]]
        if (
            (leg["from_code"], leg["to_code"]) != (row["supplier_code"], row["outlet_code"])
            or row["service_scope"] != "ONE_DEMAND_ONE_TRIP"
            or row["distance_km"] != leg["distance_km"] or row["rate_vnd_per_km"] != tariff["rate_vnd_per_km"]
            or row["vehicle_code"] != tariff["vehicle_code"]
            or Decimal(str(row["distance_km"])) * Decimal(str(row["rate_vnd_per_km"])) != row["baseline_cost_vnd"]
        ):
            raise ValidationError("The baseline differs from its source route or tariff.")
        yield self.spec("BASELINE", {"supplier_id": supplier, "outlet_id": outlet, "profile_id": self.profile_id},
                        {"default_offer_id": self.offer(tariff).pk})

    def availability(self, row):
        offer = self.offer(row)
        start, end = _interval(row, "start_time_ict", "end_time_ict")
        if row["available_vehicle_count"] > offer.available_vehicle_count:
            raise ValidationError("Availability exceeds the source vehicle fleet.")
        if (offer.operating_start_time and _time(start) < offer.operating_start_time
                or offer.operating_end_time and _time(end) > offer.operating_end_time):
            raise ValidationError("Availability is outside Offer operating hours.")
        yield self.spec("AVAILABILITY", {"offer_id": offer.pk}, {
            "start_time": start, "end_time": end, "count": row["available_vehicle_count"], "status": row["availability_status"],
        })

    def calendar(self, row):
        outlet, _ = self.point(row["outlet_code"], "OUTLET")
        if row["proposed_slot_status"] != "PROPOSED_OPEN":
            raise ValidationError("The source does not propose an open interval.")
        ws, we = _interval(row, "window_start_ict", "window_end_ict")
        ss, se = _interval(row, "slot_start_ict", "slot_end_ict")
        if not (ws <= ss < se <= we):
            raise ValidationError("The proposed slot must be within its dated receiving window.")
        yield self.spec("CALENDAR", {"outlet_id": outlet}, {
            "window_start": ws, "window_end": we, "slot_start": ss, "slot_end": se, "minutes": row["stop_service_min"],
        })

    def entries(self):
        functions = (self.location, self.travel, self.coverage, self.tariff, self.baseline, self.availability, self.calendar)
        input_keys = set()
        for sheet, mapper in zip(SHEETS, functions, strict=True):
            for line, row in self.rows[sheet]:
                key = next(iter(row.values()))
                base = {"sheet": sheet, "row": line, "workbook_key": key, "source_status": row["demo_status"]}
                try:
                    if (sheet, key) in input_keys:
                        raise ValidationError("Duplicate source key.")
                    input_keys.add((sheet, key))
                    if row["source_mode"] != SOURCE or row["version"] != "V7-SUPPLEMENT-v1":
                        raise ValidationError("Wrong provenance or workbook version.")
                    if row["demo_status"] != "PROPOSED_DEMO":
                        yield base, None
                        continue
                    date = row.get("service_date")
                    left = _date(date or row["valid_from"])
                    right = _date(date or row["valid_through"])
                    if left > right:
                        raise ValidationError("Source date range is inverted.")
                    for kind, scope, data in mapper(row):
                        yield {**base, "kind": kind, "valid_from": left.isoformat(), "valid_to": right.isoformat()}, (scope, data)
                except (KeyError, ValueError, TypeError, ValidationError, ArithmeticError) as exc:
                    yield {**base, "conflict": str(exc)}, None
        line, first = self.policy_origin
        yield {
            "sheet": "00_HuongDan", "row": 23, "workbook_key": "CAPSTONE_POLICY_WEIGHT",
            "source_status": "PROPOSED_DEMO", "kind": "POLICY",
            "valid_from": _date(first["valid_from"]).isoformat(), "valid_to": _date(first["valid_through"]).isoformat(),
        }, ({"profile_id": self.profile_id}, {
            "allocation_method": "WEIGHT", "rounding_unit_vnd": 1, "distance_basis": "FIRST_SERVICE_TO_LAST_SERVICE",
            "service_basis": "V7 Supplement Capstone, one independent delivery per Demand",
        })


def _match_approved(approved, digest, data):
    ledger = ("sheet", "row", "kind", "workbook_key", "source_reference", "scope", "data", "valid_from", "valid_to")

    def values(rows):
        return Counter(key_for({key: row.get(key) for key in ledger}) for row in rows)

    if (approved.get("file_sha256") != digest or approved.get("scenario") != SCENARIO
            or not isinstance(approved.get("records"), list) or values(approved["records"]) != values(data)):
        raise ValidationError("Supplement dry-run manifest differs from the supplied approval.")


@transaction.atomic
def inspect_supplement(workbook_bytes, *, actor_id=None, apply=False, approved_manifest=None):
    digest = sha256(workbook_bytes).hexdigest()
    workbook = load_workbook(BytesIO(workbook_bytes), read_only=True, data_only=True)
    try:
        if apply:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(%s)", [12040110])
        profile = CostProfile.objects.filter(profile_code="CP_GOLDEN").first()
        if not profile or profile.is_active or profile.currency_code != "VND":
            raise ValidationError("Run the approved base V7 profile import first; CP_GOLDEN must be inactive.")
        actor = None
        if apply:
            actor = User.objects.filter(pk=actor_id, is_active=True, capstone_scenario="").first()
            if not actor or not UserRole.objects.filter(
                user=actor, is_active=True, role__is_active=True, role__code="MANAGER",
            ).exists():
                raise ValidationError("Use an active operational Manager as the import audit actor.")
        mapper = WorkbookMapper(workbook, profile.pk)
        previous = {
            (row.kind, row.business_key, row.valid_from.isoformat(), row.valid_to.isoformat()): row
            for row in OperationalEvidence.objects.filter(provenance=PROVENANCE, scenario=SCENARIO).order_by("version")
        }
        records, new, seen = [], [], {}
        for base, fields in mapper.entries():
            if fields is None:
                records.append({**base, "action": "CONFLICT" if "conflict" in base else "SKIP_SOURCE_STATUS"})
                continue
            kind = base["kind"]
            scope, payload = fields
            schemas = SCOPE_AND_DATA[kind]
            if not all(schema.is_valid(value) for schema, value in zip(schemas, fields, strict=True)):
                records.append({**base, "action": "CONFLICT", "conflict": "Evidence schema rejected the mapped row."})
                continue
            key = key_for(scope)
            start, end = base["valid_from"], base["valid_to"]
            identity = (kind, key, start, end)
            periods = seen.setdefault((kind, key), [])
            overlap = any(start <= old_end and end >= old_start for old_start, old_end in periods)
            periods.append((start, end))
            reference = f"V7S:{digest[:16]}:{base['sheet']}!{base['row']}:{base['workbook_key']}"
            record = {**base, "business_key": key, "scope": scope, "data": payload, "source_reference": reference}
            exact = previous.get(identity)
            if exact and exact.approval == "APPROVED" and exact.data == payload and exact.source_reference == reference:
                action = "SKIP"
            elif exact or overlap or any(a == kind and b == key and start <= d and end >= c
                                         for a, b, c, d in previous):
                action = "CONFLICT"
            else:
                action = "INSERT"
                new.append(record)
            record["action"] = "CONFLICT" if overlap else action
            records.append(record)
        if approved_manifest is not None:
            _match_approved(approved_manifest, digest, records)
        conflicted = any(record["action"] == "CONFLICT" for record in records)
        if apply and not conflicted:
            versions = {}
            for row in previous.values():
                key = row.kind, row.business_key
                versions[key] = max(versions.get(key, 0), row.version)
            # All rows pass the catalog validators before insertion. bulk SQL is deliberately avoided
            # here: these are immutable revisions and must run the model's validation hooks.
            for record in new:
                key = record["kind"], record["business_key"]
                versions[key] = versions.get(key, 0) + 1
                row = OperationalEvidence.objects.create(
                    **{field: record[field] for field in (
                        "kind", "business_key", "source_reference", "scope", "data", "valid_from", "valid_to",
                    )}, version=versions[key], approval="APPROVED", provenance=PROVENANCE, scenario=SCENARIO,
                    recorded_by=actor,
                )
                record["record_id"] = row.pk
            if new:
                AuditLog.objects.create(actor_user=actor, action="V7_SUPPLEMENT_IMPORTED", entity_type="operational_evidence",
                    entity_id=SCENARIO, new_values={"file_sha256": digest, "scenario": SCENARIO,
                    "records": [{"id": row["record_id"], "sheet": row["sheet"], "row": row["row"]} for row in new]})
        return {"file_sha256": digest, "scenario": SCENARIO, "provenance": PROVENANCE,
                "source_rows": {sheet: len(rows) for sheet, rows in mapper.rows.items()},
                "actions": dict(Counter(row["action"] for row in records)),
                "applied": apply and not conflicted, "records": records}
    finally:
        workbook.close()
