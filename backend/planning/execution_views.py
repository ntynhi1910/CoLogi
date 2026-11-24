from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from rest_framework import serializers
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import ExternalActorType, RoleCode
from accounts.permissions import HasCoLogiRole, get_active_external_access
from masterdata.models import SupplierItem
from planning.delivery_views import _call
from planning.models_execution import InventoryTransaction, StockBalance
from planning.serializers import StrictInputMixin
from planning.services.execution import authorize_simulation, cancel_execution, execution_summary, record_event, read_execution
from planning.services.execution_simulation import COMMERCIAL_EXECUTION, SIMULATION
from planning.services.inventory import (CAPSTONE_OPENING_SOURCE, CATALOG_OPENING_SOURCE, DECLARED_STOCK_REFERENCE,
                                        execution_context, post_stock, reconcile_commitment, require_execution_enabled)
from planning.services.transport_handover import read_manager_plans, read_provider_plans


class Quantity(StrictInputMixin, serializers.Serializer):
    item_id = serializers.IntegerField(min_value=1)
    quantity_kg = serializers.DecimalField(max_digits=14, decimal_places=3, min_value=0)


class EventInput(StrictInputMixin, serializers.Serializer):
    request_id = serializers.UUIDField()
    demand_id = serializers.IntegerField(min_value=1)
    wave = serializers.IntegerField(min_value=1, max_value=100000)
    stop = serializers.IntegerField(min_value=1, max_value=100000)
    action = serializers.ChoiceField(choices=("READY", "ARRIVE", "SUPPLIER_HANDOVER", "CARRIER_PICKUP",
                                              "HUB_RECEIVE", "HUB_DISPATCH", "DELIVER", "RECEIVE", "INCIDENT"))
    quantity_rows = Quantity(many=True, required=False, default=list, max_length=300)
    reason = serializers.CharField(max_length=500, allow_blank=True, default="")
    reason_code = serializers.CharField(max_length=40, allow_blank=True, default="")
    reason_other = serializers.CharField(max_length=300, allow_blank=True, default="")
    note = serializers.CharField(max_length=160, allow_blank=True, default="")
    incident_code = serializers.CharField(max_length=40, allow_blank=True, default="")


class StockInput(StrictInputMixin, serializers.Serializer):
    request_id = serializers.UUIDField()
    supplier_item_id = serializers.IntegerField(min_value=1)
    kind = serializers.ChoiceField(choices=("OPENING", "INBOUND", "ADJUST"))
    amount = serializers.DecimalField(max_digits=14, decimal_places=3)
    reason = serializers.CharField(max_length=500)
    source_reference = serializers.CharField(max_length=200, default="", allow_blank=True)
    reference_kind = serializers.ChoiceField(choices=("COMMERCIAL", "INTERNAL", "DECLARED"), default="COMMERCIAL")
    note = serializers.CharField(max_length=190, default="", allow_blank=True)

    def validate(self, attrs):
        if attrs["reference_kind"] != "DECLARED" and not attrs["source_reference"]:
            raise serializers.ValidationError({"source_reference": "Cần mã chứng từ cho loại giao dịch này."})
        note = attrs.pop("note")
        if note:
            combined = attrs["reason"] + "\nGhi chú · " + note
            if len(combined) > 500:
                raise serializers.ValidationError({"note": "Lý do và ghi chú vượt giới hạn lưu."})
            attrs["reason"] = combined
        return attrs


class InventoryHistoryFilters(serializers.Serializer):
    supplier_item = serializers.IntegerField(min_value=1, required=False)
    kind = serializers.ChoiceField(choices=("OPENING", "INBOUND", "ADJUST", "RESERVE", "RELEASE", "PICKUP"), required=False)
    day = serializers.DateField(required=False)


class ReconciliationInput(StrictInputMixin, serializers.Serializer):
    source_reference = serializers.CharField(max_length=200)


def execution_mode(request):
    return serializers.ChoiceField(choices=(COMMERCIAL_EXECUTION, SIMULATION)).run_validation(
        request.query_params.get("mode", COMMERCIAL_EXECUTION))


class SimulationApprovalView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    required_roles = (RoleCode.MANAGER,)

    class Input(StrictInputMixin, serializers.Serializer):
        request_id = serializers.UUIDField()
        clock_time = serializers.TimeField()

    def post(self, request, code):
        require_execution_enabled()
        data = self.Input(data=request.data)
        data.is_valid(raise_exception=True)
        created = _call(authorize_simulation, retry=True, actor=request.user, code=code, **data.validated_data)
        return Response({"mode": SIMULATION, "status": "AUTHORIZED"}, status=201 if created else 200)


class ExecutionCancelView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    required_roles = (RoleCode.MANAGER,)

    class Input(StrictInputMixin, serializers.Serializer):
        request_id = serializers.UUIDField()
        reason = serializers.CharField(max_length=500)

    def post(self, request, code):
        require_execution_enabled()
        data = self.Input(data=request.data)
        data.is_valid(raise_exception=True)
        created = _call(cancel_execution, retry=True, actor=request.user, code=code, mode=execution_mode(request),
                        **data.validated_data)
        return Response({"status": "CANCELLED"}, status=201 if created else 200)


def _access(actor, role):
    access = get_active_external_access(actor, role)
    if access is None:
        raise NotFound()
    return access


class ExecutionAvailabilityView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"enabled": settings.COLOGI_CP11_ENABLED})


class InventoryView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    required_roles = (RoleCode.SUPPLIER,)

    def get(self, request):
        require_execution_enabled()
        supplier = _access(request.user, ExternalActorType.SUPPLIER).supplier
        scenario, provenance = execution_context(request.user)
        balances = {row.supplier_item_id: row for row in StockBalance.objects.filter(
            supplier_item__supplier=supplier, scenario=scenario)}
        ledger = InventoryTransaction.objects.filter(balance_id__in=[row.pk for row in balances.values()])
        opening_sources = dict(ledger.filter(kind="OPENING").values_list("balance_id", "source_reference"))
        rows = []
        for catalog in SupplierItem.objects.filter(supplier=supplier).select_related("item").order_by("item__item_code"):
            balance = balances.get(catalog.pk)
            source = opening_sources.get(balance.pk) if balance else None
            rows.append({
                "supplier_item_id": catalog.pk, "sku": catalog.item.item_code, "name": catalog.item.item_name, "unit": "KG",
                "on_hand_kg": balance.on_hand_kg if balance else None,
                "reserved_kg": balance.reserved_kg if balance else None,
                "available_kg": balance.on_hand_kg - balance.reserved_kg if balance else None,
                "updated_at": balance.updated_at if balance else None,
                "opening_provenance": {
                    CAPSTONE_OPENING_SOURCE: "MANAGER_APPROVED_SYNTHETIC",
                    CATALOG_OPENING_SOURCE: "SUPPLIER_DECLARED",
                }.get(source) or ("SUPPLIER_DECLARED" if source and source.startswith(DECLARED_STOCK_REFERENCE) else None),
            })
        filters = InventoryHistoryFilters(data=request.query_params)
        filters.is_valid(raise_exception=True)
        criteria = filters.validated_data
        if "supplier_item" in criteria:
            ledger = ledger.filter(balance__supplier_item_id=criteria["supplier_item"])
        if "kind" in criteria:
            ledger = ledger.filter(kind=criteria["kind"])
        if "day" in criteria:
            start = datetime.combine(criteria["day"], time.min, ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE))
            ledger = ledger.filter(recorded_at__gte=start, recorded_at__lt=start + timedelta(days=1))
        history = ledger.order_by("-pk").values("id", "kind", "balance__supplier_item_id", "on_hand_delta_kg",
                                                "reserved_delta_kg", "recorded_at", "reason", "source_reference")[:100]
        return Response({"balances": rows, "history": list(history), "provenance": provenance})

    def post(self, request):
        require_execution_enabled()
        supplier = _access(request.user, ExternalActorType.SUPPLIER).supplier
        data = StockInput(data=request.data)
        data.is_valid(raise_exception=True)
        entry, created = post_stock(actor=request.user, supplier_id=supplier.pk, **data.validated_data)
        return Response({"transaction_id": entry.pk}, status=201 if created else 200)


class ReconcileStockView(InventoryView):
    http_method_names = ["post", "options"]

    def post(self, request, request_id):
        require_execution_enabled()
        supplier = _access(request.user, ExternalActorType.SUPPLIER).supplier
        data = ReconciliationInput(data=request.data)
        data.is_valid(raise_exception=True)
        reconcile_commitment(actor=request.user, supplier_id=supplier.pk, request_id=request_id, **data.validated_data)
        return Response({"status": "RECONCILED"})


class PlanExecutionView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    audience = None

    @property
    def required_roles(self):
        return ({"supplier": RoleCode.SUPPLIER, "provider": RoleCode.TRANSPORT_PROVIDER,
                 "purchasing": RoleCode.PURCHASING_STAFF, "manager": RoleCode.MANAGER}[self.audience],)

    def get(self, request, code=None):
        require_execution_enabled()
        mode = execution_mode(request)
        if mode == SIMULATION and execution_context(request.user) != ("", "OPERATIONAL"):
            raise NotFound()
        if code:
            return Response(_call(read_execution, actor=request.user, audience=self.audience, code=code, mode=mode))
        if self.audience == "manager":
            rows = _call(read_manager_plans, actor=request.user)
        elif self.audience == "provider":
            rows = _call(read_provider_plans, actor=request.user,
                         provider_id=_access(request.user, ExternalActorType.TRANSPORT_PROVIDER).provider_id)
        else:
            raise NotFound()
        plans = []
        for row in rows["plans"]:
            if not row["handover"]:
                continue
            detail = _call(read_execution, actor=request.user, audience=self.audience, code=row["code"], mode=mode)
            plans.append({**row, **execution_summary(detail), "demand_status": detail["demand_status"],
                          "blocker": detail["blocker"]})
        return Response({"plans": plans, "execution_mode": mode})

    def post(self, request, code=None):
        require_execution_enabled()
        if self.audience == "manager" or code is None:
            raise NotFound()
        data = EventInput(data=request.data)
        data.is_valid(raise_exception=True)
        row, created = _call(record_event, retry=True, actor=request.user, audience=self.audience, code=code,
                             mode=execution_mode(request), **data.validated_data)
        return Response(row, status=201 if created else 200)
