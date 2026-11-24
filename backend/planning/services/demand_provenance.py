"""Keep known demo commitments out of new operational evaluations."""

from django.conf import settings
from django.db.models import Q

from demands.models import DeliveryDemand, SupplierConfirmation


OPERATIONAL_SOURCE_REQUIRED = "OPERATIONAL_DEMAND_PROVENANCE_REQUIRED"
DEMO_SOURCES = (
    SupplierConfirmation.SourceMode.SYNTHETIC_V7,
    SupplierConfirmation.SourceMode.SYNTHETIC_CAPSTONE,
)


def requires_operational_provenance(scenario):
    return not scenario and getattr(settings, "COLOGI_REQUIRE_OPERATIONAL_DEMAND_PROVENANCE", False)


def known_demo_demands():
    return Q(notes__icontains="SYNTHETIC_V7") | Q(supplier_confirmations__source_mode__in=DEMO_SOURCES)


def operational_demands_required(scenario, demand_ids):
    if not requires_operational_provenance(scenario):
        return False
    return DeliveryDemand.objects.filter(pk__in=demand_ids).filter(known_demo_demands()).exists()
