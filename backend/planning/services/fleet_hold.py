"""Version-bound reservations over the actual F4 wave intervals."""

from datetime import datetime, time
from zoneinfo import ZoneInfo

from django.utils import timezone

from accounts.capstone import PROVENANCE as CAPSTONE
from planning.models_execution import ExecutionEvent, FleetHold
from planning.services.execution_simulation import SIMULATION
from planning.services.inventory import CAPSTONE_STOCK_PROVENANCE, ExecutionBlocked
from transportation.models import ProviderAvailability, ProviderVehicleOffer
from transportation.services import legacy_migrated_availability_ids


def reserve_fleet(plan, *, rehearsal=False, capstone=False):
    f4 = plan.snapshot["f4"]
    waves = f4["result"]["waves"]
    zone = ZoneInfo(f4["configuration"]["timezone"])
    offer_ids = {wave["vehicle"]["offer_id"] for wave in waves}
    offers = {offer.pk: offer for offer in ProviderVehicleOffer.objects.select_for_update().filter(
        pk__in=offer_ids, provider_id=plan.provider_id, is_active=True,
    ).order_by("pk")}
    if not waves or offer_ids != offers.keys():
        raise ExecutionBlocked("FLEET_OFFER_UNAVAILABLE")
    legacy = legacy_migrated_availability_ids()
    held_waves = set(FleetHold.objects.filter(plan=plan, released_at__isnull=True).values_list("wave", flat=True))
    for wave in waves:
        vehicle = wave["vehicle"]
        offer = offers[vehicle["offer_id"]]
        start = datetime.fromisoformat(wave["stops"][0]["arrival"]).astimezone(zone)
        end = datetime.fromisoformat(wave["stops"][-1]["departure"]).astimezone(zone)
        if start >= end or start.date() != end.date():
            raise ExecutionBlocked("FLEET_WINDOW_INVALID")
        if (offer.operating_start_time is not None and start.time() < offer.operating_start_time
                or offer.operating_end_time is not None and end.time() > offer.operating_end_time):
            raise ExecutionBlocked("FLEET_OUTSIDE_OPERATING_HOURS")
        evidence = ProviderAvailability.objects.filter(
            pk__in=[window["id"] for window in vehicle["windows"] if type(window.get("id")) is int],
            provider_vehicle_offer=offer, service_date=start.date(), start_time__lte=start.time(),
            end_time__gte=end.time(), availability_status="AVAILABLE",
            source_mode__in=("PROVIDER_PORTAL", "PROVIDER_CONFIRMED_IMPORT"),
        ).exclude(pk__in=legacy).first()
        if capstone:
            windows = [window for window in vehicle["windows"]
                       if window.get("source") == CAPSTONE and window["status"] == "AVAILABLE"
                       and window["service_date"] == start.date().isoformat()
                       and time.fromisoformat(window["start_time"]) <= start.time()
                       and time.fromisoformat(window["end_time"]) >= end.time()]
            if not windows:
                raise ExecutionBlocked("CAPSTONE_FLEET_WINDOW_REQUIRED")
            capacity = min(offer.available_vehicle_count, int(vehicle["available_vehicle_count"]),
                           min(window["count"] for window in windows))
            captured = {"source": CAPSTONE_STOCK_PROVENANCE, "availability_ids": [window["id"] for window in windows],
                        "count": capacity}
        elif evidence:
            capacity = min(offer.available_vehicle_count, evidence.available_vehicle_count)
            captured = {"availability_id": evidence.pk, "source": evidence.source_mode, "count": capacity}
        elif rehearsal:
            capacity = int(vehicle["available_vehicle_count"])
            captured = {"source": "SYNTHETIC/CP11_REHEARSAL", "count": capacity}
        else:
            raise ExecutionBlocked("VERIFIED_FLEET_AVAILABILITY_REQUIRED")
        overlapping = FleetHold.objects.filter(
            offer=offer, plan__scenario=plan.scenario, released_at__isnull=True, starts_at__lt=end, ends_at__gt=start,
        ).exclude(plan=plan, wave=wave["wave_no"]).values_list("starts_at", "ends_at")
        # Half-open intervals let sequential waves reuse a vehicle without overbooking.
        changes = [(max(left, start), 1) for left, _ in overlapping]
        changes.extend((min(right, end), -1) for _, right in overlapping)
        in_use = 1
        if capacity < in_use:
            raise ExecutionBlocked("FLEET_CAPACITY_RESERVED")
        for _, delta in sorted(changes):
            in_use += delta
            if in_use > capacity:
                raise ExecutionBlocked("FLEET_CAPACITY_RESERVED")
        if wave["wave_no"] not in held_waves:
            FleetHold.objects.create(plan=plan, offer=offer, wave=wave["wave_no"], starts_at=start,
                                     ends_at=end, evidence=captured)


def release_fleet(plan):
    FleetHold.objects.filter(plan=plan, released_at__isnull=True).update(released_at=timezone.now())


def guard_replacement(plan):
    events = ExecutionEvent.objects.filter(plan=plan).exclude(provenance=SIMULATION)
    if not events.filter(action="CANCELLED").exists() and events.filter(action__in=(
        "ARRIVE", "SUPPLIER_HANDOVER", "CARRIER_PICKUP", "PICKUP_COMPLETE", "HUB_RECEIVE", "HUB_DISPATCH", "DELIVER",
    )).exists():
        raise ExecutionBlocked("PLAN_EXECUTION_ALREADY_STARTED")
    release_fleet(plan)
