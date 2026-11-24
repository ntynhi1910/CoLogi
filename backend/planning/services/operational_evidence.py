"""Validate, authorize and publish reusable input revisions."""

from datetime import date, time
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import connection, transaction
from jsonschema import Draft202012Validator

from accounts.capstone import PROVENANCE as CAPSTONE
from demands.models import DeliveryDemand
from masterdata.models import Hub, Outlet, Supplier, TransportProvider
from planning.f3_contract import fingerprint
from planning.models import CostProfile, OperationalEvidence, OperationalEvidenceKind
from planning.services.f4_evidence import _object
from planning.services.f5_economics import DISTANCE_BASIS
from planning.services.f5_evidence import COMPONENT, MONEY
from planning.services.internal_supplement import SCENARIO, approval_for_day, display_approval
from planning.services.run_scope import get_f1_outlet_ids
from transportation.models import ProviderVehicleOffer


OPERATIONAL = "OPERATIONAL"
POINT = {"type": "string", "pattern": r"^(SUPPLIER|OUTLET|HUB):[1-9][0-9]{0,9}$"}
ID = {"type": "integer", "minimum": 1, "maximum": 2147483647}
MINUTES = {"type": "integer", "minimum": 1, "maximum": 1440}
COMPONENTS = {"type": "array", "items": COMPONENT, "minItems": 1, "maxItems": 16}
HOUR = {"type": "string", "pattern": r"^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$"}
MINUTES_TRAVEL = {"type": "integer", "minimum": 0, "maximum": 1440}
DISTANCE = {"type": "string", "pattern": r"^[0-9]{1,6}(\.[0-9]{1,3})?$"}
ROLES = {
    "SUPPLIER_PICKUP": "SUPPLIER", "OUTLET_DELIVERY": "OUTLET",
    "HUB_RECEIVE": "HUB", "HUB_DISPATCH": "HUB",
}
POINTS = {"SUPPLIER": Supplier, "OUTLET": Outlet, "HUB": Hub}
DIRECTION = {"enum": ["INBOUND", "OUTBOUND"]}
SCOPE_AND_DATA = {
    "CALENDAR": (_object(outlet_id=ID), {"oneOf": [_object(), _object(
        window_start=HOUR, window_end=HOUR, slot_start=HOUR, slot_end=HOUR, minutes=MINUTES,
    )]}),
    "LOCATION": (_object(point=POINT), _object(start_time=HOUR, end_time=HOUR)),
    "AVAILABILITY": (_object(offer_id=ID), _object(start_time=HOUR, end_time=HOUR,
        count=ID, status={"const": "AVAILABLE"})),
    "TARIFF": (_object(offer_id=ID), _object(rate_vnd=MONEY)),
    "TRAVEL": (_object(origin=POINT, destination=POINT), _object(minutes=MINUTES_TRAVEL, distance_km=DISTANCE)),
    "SERVICE": (_object(point=POINT, role={"enum": list(ROLES)}), _object(minutes=MINUTES)),
    "HUB_HOURS": (_object(hub_id=ID), _object(start_time=HOUR, end_time=HOUR)),
    "HUB_COVERAGE": (_object(provider_id=ID, hub_id=ID, direction=DIRECTION, endpoint=POINT), _object()),
    "QUOTE": (
        _object(offer_id=ID, phase={"enum": ["DIRECT", "INBOUND", "OUTBOUND"]},
                route={"type": "array", "items": POINT, "minItems": 2, "maxItems": 20, "uniqueItems": True}),
        _object(components=COMPONENTS),
    ),
    "HUB_FEE": (_object(hub_id=ID, profile_id=ID), _object(components=COMPONENTS)),
    "BASELINE": (
        {"oneOf": [_object(demand_id=ID, profile_id=ID),
                   _object(supplier_id=ID, outlet_id=ID, profile_id=ID)]},
        {"oneOf": [_object(amount_vnd=MONEY, weight_kg=DISTANCE), _object(components=COMPONENTS),
                   _object(default_offer_id=ID)]},
    ),
    "POLICY": (
        _object(profile_id=ID),
        _object(
            allocation_method={"enum": ["WEIGHT", "ORDER_COUNT"]},
            rounding_unit_vnd={"type": "integer", "minimum": 1, "maximum": 1000000},
            distance_basis={"enum": sorted(DISTANCE_BASIS - {"INCLUDING_DEPOT"})},
            service_basis={"type": "string", "minLength": 1, "maxLength": 180},
        ),
    ),
}
for _kind, (_scope, _data) in list(SCOPE_AND_DATA.items()):
    SCOPE_AND_DATA[_kind] = (Draft202012Validator(_scope), Draft202012Validator(_data))


def _point(kind, pk):
    return f"{kind}:{pk}"


def checked_scope(kind, scope, data=None):
    validator, contents = SCOPE_AND_DATA[kind]
    if not validator.is_valid(scope) or (data is not None and not contents.is_valid(data)):
        raise ValidationError("The evidence fields do not match this record type.")
    points = set(scope.get("route", []))
    points.update(scope[key] for key in ("origin", "destination", "point", "endpoint") if key in scope)
    if "hub_id" in scope:
        points.add(_point("HUB", scope["hub_id"]))
    if "outlet_id" in scope:
        points.add(_point("OUTLET", scope["outlet_id"]))
    if "supplier_id" in scope:
        points.add(_point("SUPPLIER", scope["supplier_id"]))
    if kind == "BASELINE" and data is not None and ("demand_id" in scope) != ("amount_vnd" in data):
        raise ValidationError("Use a fixed amount for a Demand or components for a supplier-to-Outlet tariff.")
    if kind == "BASELINE" and "demand_id" in scope:
        demand = DeliveryDemand.objects.filter(pk=scope["demand_id"], capstone_scenario="").first()
        if demand is None:
            raise ValidationError("Unknown Demand.")
        points.add(_point("OUTLET", demand.outlet_id))
        if data is not None and demand.quantity_kg != Decimal(data["weight_kg"]):
            raise ValidationError("Baseline weight must match the Demand.")
    if "profile_id" in scope and not CostProfile.objects.filter(pk=scope["profile_id"]).exists():
        raise ValidationError("Unknown CostProfile.")
    if "offer_id" in scope and not ProviderVehicleOffer.objects.filter(pk=scope["offer_id"]).exists():
        raise ValidationError("Unknown Vehicle Offer.")
    if kind == "SERVICE" and not scope["point"].startswith(ROLES[scope["role"]] + ":"):
        raise ValidationError("The stop role does not match its type.")
    if kind == "TRAVEL" and scope["origin"] == scope["destination"]:
        raise ValidationError("Route origin and destination must differ.")
    if data and "components" in data:
        coverage = [item for part in data["components"] for item in part["covers"]]
        if len(coverage) != len(set(coverage)):
            raise ValidationError("Price components cannot cover the same charge twice.")
        if kind == "HUB_FEE" and set(coverage) != {"HUB_HANDLING"}:
            raise ValidationError("A hub fee covers hub handling only.")
        if kind == "QUOTE" and (not set(coverage) & {"TRANSPORT_BASE", "DISTANCE"} or "HUB_HANDLING" in coverage):
            raise ValidationError("Wave quotes contain transport charges. Record hub handling against the Hub.")
        if kind == "BASELINE" and (not set(coverage) & {"TRANSPORT_BASE", "DISTANCE"}
                                   or set(coverage) & {"HUB_HANDLING", "WAIT", "STOP_HANDLING"}):
            raise ValidationError("An automatic baseline tariff requires transport rates and optional surcharge.")
    if data:
        for start, end in (("start_time", "end_time"), ("window_start", "window_end"), ("slot_start", "slot_end")):
            if start in data and time.fromisoformat(data[start]) >= time.fromisoformat(data[end]):
                raise ValidationError("Opening must precede closing.")
    if kind == "HUB_COVERAGE":
        expected = "SUPPLIER:" if scope["direction"] == "INBOUND" else "OUTLET:"
        if not scope["endpoint"].startswith(expected) or not TransportProvider.objects.filter(pk=scope["provider_id"], is_active=True).exists():
            raise ValidationError("The carrier or direction does not match the coverage.")
    for p in points:
        entity, pk = p.split(":")
        if not POINTS[entity].objects.filter(pk=int(pk), is_active=True).exists():
            raise ValidationError(f"Unknown or inactive point {p}.")
    return {int(p.split(":")[1]) for p in points if p.startswith("OUTLET:")}


def manager_may_manage(actor, outlets):
    assigned = set(get_f1_outlet_ids(actor))
    if not assigned:
        return False
    if outlets:
        return outlets <= assigned
    return not Outlet.objects.filter(is_active=True).exclude(pk__in=assigned).exists()


def key_for(scope):
    return fingerprint(scope)


@transaction.atomic
def publish(*, actor, kind, scope, data, valid_from, valid_to, approval, provenance, scenario, source_reference):
    key = key_for(scope)
    selector = {"kind": kind, "business_key": key, "provenance": provenance, "scenario": scenario}
    revision = fingerprint(selector)
    lock = int(revision[:15], 16)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [lock])
    previous = OperationalEvidence.objects.filter(**selector).order_by("-version").first()
    payload = {"valid_from": valid_from, "valid_to": valid_to, "approval": approval,
               "scope": scope, "data": data, "source_reference": source_reference}
    if previous and all(getattr(previous, key) == value for key, value in payload.items()):
        return previous, False
    return OperationalEvidence.objects.create(
        **selector, **payload, recorded_by=actor, version=previous.version + 1 if previous else 1,
    ), True


class EvidenceReader:
    def __init__(self, day, *, provenance=OPERATIONAL, scenario="", internal_approval=None, approved_ids=None):
        self.provenance = provenance
        self.scenario = scenario
        self.day = date.fromisoformat(day) if isinstance(day, str) else day
        self.used = {}
        self.by_kind = {}
        self.internal_approval = internal_approval
        self.approved_ids = approved_ids
        self._internal = (
            EvidenceReader(self.day, provenance=CAPSTONE, scenario=SCENARIO,
                           approved_ids=internal_approval["record_ids"]) if internal_approval else None
        )

    @classmethod
    def for_planning(cls, day, scenario=""):
        if scenario:
            return cls(day, provenance=CAPSTONE, scenario=scenario)
        return cls(day, internal_approval=approval_for_day(day))

    def _query(self, kind):
        rows = OperationalEvidence.objects.filter(
            kind=kind, provenance=self.provenance, scenario=self.scenario,
            valid_from__lte=self.day, valid_to__gte=self.day,
        ).exclude(approval="REFERENCE")
        return rows.filter(pk__in=self.approved_ids) if self.approved_ids is not None else rows

    def effective(self, kind, **scope):
        if kind not in self.by_kind:
            index = {}
            for row in self._query(kind).order_by("business_key", "-version"):
                index.setdefault(row.business_key, row)
            self.by_kind[kind] = index
        return self.by_kind[kind].get(key_for(scope))

    def choose(self, kind, **scope):
        record = self.effective(kind, **scope)
        if record is None:
            return self.supplement(kind, **scope)
        if record and record.approval == "APPROVED":
            self.used[record.pk] = record
            return record
        return None

    def supplement(self, kind, **scope):
        if not self._internal:
            return None
        row = self._internal.effective(kind, **scope)
        if row and row.approval == "APPROVED":
            self.used[row.pk] = row
            return row
        return None

    def has_dated_authority(self, kind, **scope):
        """An explicit blocked or revoked record stays authoritative for the key."""
        return self.effective(kind, **scope) is not None or (
            self._internal is not None and self._internal.effective(kind, **scope) is not None
        )

    def internal_source(self):
        if self.internal_approval and any(row.provenance == CAPSTONE for row in self.used.values()):
            return display_approval(self.internal_approval)
        return None

    def policies(self):
        candidates = {}
        for row in self._query(OperationalEvidenceKind.POLICY).order_by("business_key", "-version"):
            candidates.setdefault(row.business_key, row)
        return [row for row in candidates.values() if row.approval == "APPROVED"]

    def references(self):
        return [identity(row) for row in sorted(self.used.values(), key=lambda row: row.pk)]


def identity(row):
    return {"id": row.pk, "kind": row.kind, "version": row.version,
            "provenance": row.provenance, "scenario": row.scenario, "source_reference": row.source_reference,
            "valid_from": row.valid_from.isoformat(), "valid_to": row.valid_to.isoformat(),
            "fingerprint": fingerprint([row.scope, row.data, row.source_reference, row.version])}


def source_reference(row):
    return f"DB:{row.kind}:{row.pk}:v{row.version} {row.source_reference}"
