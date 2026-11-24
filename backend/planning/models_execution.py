from django.conf import settings
from django.db import models
from django.db.models import F, Q


class StockBalance(models.Model):
    supplier_item = models.ForeignKey("masterdata.SupplierItem", on_delete=models.PROTECT)
    scenario = models.CharField(max_length=50, blank=True)
    on_hand_kg = models.DecimalField(max_digits=14, decimal_places=3, default=0)
    reserved_kg = models.DecimalField(max_digits=14, decimal_places=3, default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "inventory_balances"
        constraints = [
            models.UniqueConstraint(fields=("supplier_item", "scenario"), name="uq_cp11_stock_scope"),
            models.CheckConstraint(condition=Q(reserved_kg__gte=0, on_hand_kg__gte=F("reserved_kg")),
                                   name="ck_cp11_stock_available"),
        ]


class StockReservation(models.Model):
    promise = models.OneToOneField("demands.SupplierItemPromise", on_delete=models.PROTECT)
    balance = models.ForeignKey(StockBalance, on_delete=models.PROTECT)
    held_kg = models.DecimalField(max_digits=14, decimal_places=3)
    remaining_kg = models.DecimalField(max_digits=14, decimal_places=3)

    class Meta:
        db_table = "inventory_reservations"
        constraints = [
            models.CheckConstraint(condition=Q(remaining_kg__gte=0, held_kg__gt=0, held_kg__gte=F("remaining_kg")),
                                   name="ck_cp11_stock_reservation"),
        ]


class ExecutionEvent(models.Model):
    plan = models.ForeignKey("planning.FinalPlan", on_delete=models.PROTECT)
    demand = models.ForeignKey("demands.DeliveryDemand", on_delete=models.PROTECT)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.UUIDField()
    wave = models.PositiveIntegerField()
    stop = models.PositiveIntegerField()
    action = models.CharField(max_length=32)
    quantities = models.JSONField(default=dict)
    reason = models.CharField(max_length=500, blank=True)
    exception_code = models.CharField(max_length=40, blank=True)
    occurred_at = models.DateTimeField(auto_now_add=True)
    provenance = models.CharField(max_length=32)

    class Meta:
        db_table = "logistics_execution_events"
        constraints = [
            models.UniqueConstraint(fields=("actor", "request_id"), name="uq_cp11_execution_request"),
            models.CheckConstraint(condition=Q(wave__gt=0, stop__gt=0), name="ck_cp11_execution_stop"),
        ]
        indexes = [models.Index(fields=("plan", "demand", "id"), name="ix_cp11_execution_history")]


class InventoryTransaction(models.Model):
    balance = models.ForeignKey(StockBalance, on_delete=models.PROTECT)
    reservation = models.ForeignKey(StockReservation, on_delete=models.PROTECT, null=True)
    event = models.ForeignKey(ExecutionEvent, on_delete=models.PROTECT, null=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.UUIDField(null=True)
    kind = models.CharField(max_length=16)
    on_hand_delta_kg = models.DecimalField(max_digits=14, decimal_places=3)
    reserved_delta_kg = models.DecimalField(max_digits=14, decimal_places=3)
    reason = models.CharField(max_length=500)
    source_reference = models.CharField(max_length=200, blank=True)
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "inventory_transactions"
        constraints = [
            models.UniqueConstraint(fields=("actor", "request_id"), name="uq_cp11_ledger_request"),
            models.UniqueConstraint(fields=("reservation", "kind"), condition=Q(kind="PICKUP"),
                                    name="uq_cp11_pickup_reservation"),
            models.UniqueConstraint(fields=("balance",), condition=Q(kind="OPENING"), name="uq_cp11_stock_opening"),
        ]


class FleetHold(models.Model):
    plan = models.ForeignKey("planning.FinalPlan", on_delete=models.PROTECT)
    offer = models.ForeignKey("transportation.ProviderVehicleOffer", on_delete=models.PROTECT)
    wave = models.PositiveIntegerField()
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    evidence = models.JSONField()
    released_at = models.DateTimeField(null=True)

    class Meta:
        db_table = "logistics_fleet_holds"
        constraints = [
            models.UniqueConstraint(fields=("plan", "wave"), name="uq_cp11_wave_hold"),
            models.CheckConstraint(condition=Q(starts_at__lt=F("ends_at"), wave__gt=0), name="ck_cp11_wave_hold_window"),
        ]
        indexes = [models.Index(fields=("offer", "starts_at", "ends_at"), name="ix_cp11_fleet_window")]
