from django.db import models


class CoverageDirection(models.TextChoices):
    INBOUND = "INBOUND", "Supplier to Hub"
    OUTBOUND = "OUTBOUND", "Hub to Outlet"


class CoverageConfirmation(models.TextChoices):
    CONFIRMED = "CONFIRMED", "Confirmed"
    PENDING = "PENDING", "Pending"
    REVOKED = "REVOKED", "Revoked"


class CoverageSource(models.TextChoices):
    PROVIDER_CONFIRMED_IMPORT = "PROVIDER_CONFIRMED_IMPORT", "Provider-confirmed import"
    PROVIDER_PORTAL = "PROVIDER_PORTAL", "Provider portal"
    SYNTHETIC_UAT = "SYNTHETIC/UAT", "Synthetic UAT evidence"

    @classmethod
    def operational(cls):
        return (cls.PROVIDER_CONFIRMED_IMPORT, cls.PROVIDER_PORTAL)
