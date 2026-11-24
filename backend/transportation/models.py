from django.db import models
from django.db.models import F, Q

from masterdata.models import (
    Hub,
    Outlet,
    Supplier,
    TransportProvider,
    VehicleType,
)
from transportation.hub_coverage import CoverageConfirmation, CoverageDirection, CoverageSource


class HubCoverageEvidence(models.Model):
    provider = models.ForeignKey(TransportProvider, on_delete=models.PROTECT)
    hub = models.ForeignKey(Hub, on_delete=models.PROTECT)
    direction = models.CharField(max_length=8, choices=CoverageDirection.choices)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, null=True, blank=True)
    outlet = models.ForeignKey(Outlet, on_delete=models.PROTECT, null=True, blank=True)
    confirmation_status = models.CharField(max_length=12, choices=CoverageConfirmation.choices)
    valid_from = models.DateField()
    valid_through = models.DateField()
    source = models.CharField(max_length=30, choices=CoverageSource.choices)
    source_reference = models.CharField(max_length=255)
    uat_candidate_code = models.CharField(max_length=40, blank=True, default="")
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "hub_coverage_evidence"
        constraints = [
            models.CheckConstraint(
                condition=Q(direction=CoverageDirection.INBOUND, supplier__isnull=False, outlet__isnull=True)
                | Q(direction=CoverageDirection.OUTBOUND, supplier__isnull=True, outlet__isnull=False),
                name="tr_hub_cov_direction_endpoint",
            ),
            models.CheckConstraint(
                condition=Q(valid_from__lte=F("valid_through")), name="tr_hub_cov_valid_period",
            ),
            models.CheckConstraint(
                condition=Q(confirmation_status__in=CoverageConfirmation.values),
                name="tr_hub_cov_confirmation",
            ),
            models.CheckConstraint(
                condition=Q(source=CoverageSource.SYNTHETIC_UAT, uat_candidate_code__regex=r"^[0-9a-f]{32}$")
                | Q(source__in=CoverageSource.operational(), uat_candidate_code=""),
                name="tr_hub_cov_source_candidate",
            ),
            models.CheckConstraint(
                condition=Q(source_reference__regex=r"\S"), name="tr_hub_cov_reference",
            ),
            models.UniqueConstraint(
                # Identical submissions are duplicates. Overlapping versions are resolved during evaluation.
                fields=("provider", "hub", "direction", "supplier", "outlet", "source", "uat_candidate_code",
                        "valid_from", "valid_through", "confirmation_status", "source_reference"),
                nulls_distinct=False,
                name="tr_hub_cov_evidence_unique",
            ),
        ]


class ProviderSupplierCoverage(models.Model):
    class CoverageStatus(models.TextChoices):
        ACTIVE = "ACTIVE", "Active"
        INACTIVE = "INACTIVE", "Inactive"

    provider = models.ForeignKey(
        TransportProvider,
        on_delete=models.PROTECT,
        related_name="supplier_coverages",
    )
    supplier = models.ForeignKey(
        Supplier,
        on_delete=models.PROTECT,
        related_name="provider_coverages",
    )
    coverage_status = models.CharField(
        max_length=10,
        choices=CoverageStatus.choices,
        default=CoverageStatus.ACTIVE,
    )
    can_pickup = models.BooleanField(default=True)
    service_note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "provider_supplier_coverage"
        ordering = ("provider_id", "supplier_id")
        constraints = [
            models.UniqueConstraint(
                fields=("provider", "supplier"),
                name="tr_cov_provider_supplier_uq",
            ),
        ]

    def __str__(self):
        return (
            f"Provider {self.provider_id} - "
            f"Supplier {self.supplier_id}: {self.coverage_status}"
        )


class ProviderVehicleOffer(models.Model):
    class FuelType(models.TextChoices):
        ELECTRIC = "ELECTRIC", "Electric"
        GASOLINE = "GASOLINE", "Gasoline"
        DIESEL = "DIESEL", "Diesel"

    provider = models.ForeignKey(
        TransportProvider,
        on_delete=models.PROTECT,
        related_name="vehicle_offers",
    )
    vehicle_type = models.ForeignKey(
        VehicleType,
        on_delete=models.PROTECT,
        related_name="provider_offers",
    )
    available_vehicle_count = models.PositiveIntegerField()
    fuel_type = models.CharField(
        max_length=20,
        choices=FuelType.choices,
    )
    operating_start_time = models.TimeField(
        null=True,
        blank=True,
    )
    operating_end_time = models.TimeField(
        null=True,
        blank=True,
    )
    fixed_quote_vnd = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        null=True,
        blank=True,
    )
    estimated_cost_per_km_vnd = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        null=True,
        blank=True,
    )
    is_active = models.BooleanField(default=True)
    vehicle_note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "provider_vehicle_offers"
        ordering = ("provider_id", "vehicle_type_id")
        constraints = [
            models.UniqueConstraint(
                fields=("provider", "vehicle_type"),
                name="tr_offer_provider_vehicle_uq",
            ),
            models.CheckConstraint(
                condition=Q(is_active=False)
                | Q(available_vehicle_count__gt=0),
                name="tr_offer_active_capacity_positive",
            ),
            models.CheckConstraint(
                condition=(
                    Q(fixed_quote_vnd__isnull=True)
                    | Q(fixed_quote_vnd__gte=0)
                ),
                name="tr_offer_fixed_quote_nonneg",
            ),
            models.CheckConstraint(
                condition=(
                    Q(estimated_cost_per_km_vnd__isnull=True)
                    | Q(estimated_cost_per_km_vnd__gte=0)
                ),
                name="tr_offer_km_cost_nonneg",
            ),
            models.CheckConstraint(
                condition=(
                    Q(
                        operating_start_time__isnull=True,
                        operating_end_time__isnull=True,
                    )
                    | Q(
                        operating_start_time__isnull=False,
                        operating_end_time__isnull=False,
                        operating_start_time__lt=F("operating_end_time"),
                    )
                ),
                name="tr_offer_operating_hours_pair",
            ),
        ]

    def __str__(self):
        return (
            f"Provider {self.provider_id} - "
            f"Vehicle type {self.vehicle_type_id}"
        )


class ProviderAvailability(models.Model):
    class AvailabilityStatus(models.TextChoices):
        AVAILABLE = "AVAILABLE", "Available"
        UNAVAILABLE = "UNAVAILABLE", "Unavailable"

    class SourceMode(models.TextChoices):
        PROVIDER_PORTAL = "PROVIDER_PORTAL", "Provider Portal"
        PROVIDER_CONFIRMED_IMPORT = (
            "PROVIDER_CONFIRMED_IMPORT",
            "Provider Confirmed Import",
        )
        SYNTHETIC_NOVEMBER_DEMO = (
            "SYNTHETIC_NOVEMBER_DEMO",
            "Synthetic November Demo",
        )
        SYNTHETIC_HISTORICAL_FIXTURE = (
            "SYNTHETIC_HISTORICAL_FIXTURE",
            "Synthetic Historical Fixture",
        )

    provider_vehicle_offer = models.ForeignKey(
        ProviderVehicleOffer,
        on_delete=models.PROTECT,
        db_column="provider_vehicle_id",
        related_name="availability_windows",
    )
    service_date = models.DateField()
    available_vehicle_count = models.PositiveIntegerField()
    start_time = models.TimeField()
    end_time = models.TimeField()
    availability_status = models.CharField(
        max_length=12,
        choices=AvailabilityStatus.choices,
    )
    source_mode = models.CharField(
        max_length=40,
        choices=SourceMode.choices,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "provider_availability"
        ordering = (
            "service_date",
            "start_time",
            "provider_vehicle_offer_id",
        )
        constraints = [
            models.CheckConstraint(
                condition=Q(start_time__lt=F("end_time")),
                name="tr_avail_valid_time_window",
            ),
            models.CheckConstraint(
                condition=(
                    Q(
                        availability_status="AVAILABLE",
                        available_vehicle_count__gt=0,
                    )
                    | Q(
                        availability_status="UNAVAILABLE",
                        available_vehicle_count=0,
                    )
                ),
                name="tr_avail_status_count_match",
            ),
        ]
        indexes = [
            models.Index(
                fields=(
                    "provider_vehicle_offer",
                    "service_date",
                    "source_mode",
                ),
                name="tr_avail_offer_date_src_idx",
            ),
        ]

    def __str__(self):
        return (
            f"Offer {self.provider_vehicle_offer_id} - "
            f"{self.service_date} {self.start_time}-{self.end_time}"
        )
