"""Scoped data-management endpoints for DSS input sources."""

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import transaction
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import AuditLog, RoleCode
from accounts.capstone import PROVENANCE, actor_scenario
from accounts.permissions import HasCoLogiRole, get_active_external_access
from masterdata.models import Outlet
from planning.models import CostProfile, OperationalEvidence, OperationalEvidenceKind, ReceivingSlot, ReceivingWindow
from planning.services.operational_evidence import checked_scope, identity, manager_may_manage, publish
from planning.services.run_scope import get_f1_outlet_ids
from transportation.models import ProviderVehicleOffer


class EvidenceInput(serializers.Serializer):
    kind = serializers.ChoiceField(choices=OperationalEvidenceKind.choices)
    scope = serializers.DictField()
    data = serializers.DictField()
    valid_from = serializers.DateField()
    valid_to = serializers.DateField()
    source_reference = serializers.CharField(max_length=95)
    approval = serializers.ChoiceField(choices=("REFERENCE", "APPROVED", "REVOKED"))
    provenance = serializers.ChoiceField(choices=("OPERATIONAL", "SYNTHETIC/CAPSTONE"), default="OPERATIONAL")
    scenario = serializers.SlugField(max_length=50, allow_blank=True, default="")

    def validate(self, values):
        if values["valid_from"] > values["valid_to"]:
            raise ValidationError("The effective period is inverted.")
        if values["kind"] == "CALENDAR" and values["valid_from"] != values["valid_to"]:
            raise ValidationError("A receiving confirmation must identify a single date.")
        if bool(values["scenario"]) != (values["provenance"] == "SYNTHETIC/CAPSTONE"):
            raise ValidationError("A Capstone source requires a scenario and an operational source cannot have one.")
        if values["provenance"] == "OPERATIONAL" and "SYNTHETIC" in values["source_reference"].upper():
            raise ValidationError("A synthetic source cannot be listed as operational.")
        return values


class EvidenceView(APIView):
    permission_classes = (IsAuthenticated, HasCoLogiRole)
    required_roles = (RoleCode.MANAGER, RoleCode.TRANSPORT_PROVIDER)

    @staticmethod
    def role(request):
        return bool(get_f1_outlet_ids(request.user)), get_active_external_access(request.user, RoleCode.TRANSPORT_PROVIDER)

    @staticmethod
    def belongs(provider, kind, scope):
        if not provider:
            return False
        if kind == "HUB_COVERAGE":
            return provider.provider_id == scope["provider_id"]
        if kind == "QUOTE":
            return ProviderVehicleOffer.objects.filter(pk=scope["offer_id"], provider_id=provider.provider_id).exists()
        return False

    def get(self, request):
        manager, provider = self.role(request)
        scenario = actor_scenario(request.user)
        rows = OperationalEvidence.objects.filter(scenario=scenario).order_by("kind", "business_key", "-version")
        kind = request.query_params.get("kind")
        if kind:
            if kind not in OperationalEvidenceKind.values:
                raise ValidationError("Invalid evidence kind.")
            rows = rows.filter(kind=kind)
        visible, seen = [], set()
        for row in rows.iterator():
            key = (row.kind, row.business_key, row.provenance, row.scenario)
            if key in seen:
                continue
            seen.add(key)
            if manager:
                try:
                    outlets = checked_scope(row.kind, row.scope)
                except ModelValidationError:
                    continue
                allowed = manager_may_manage(request.user, outlets)
            else:
                allowed = self.belongs(provider, row.kind, row.scope)
            if allowed:
                visible.append({**identity(row), "approval": row.approval, "scope": row.scope, "data": row.data})
        return Response(visible)

    def post(self, request):
        manager, provider = self.role(request)
        serializer = EvidenceInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        scenario = actor_scenario(request.user)
        if values["scenario"] != scenario or (values["provenance"] == PROVENANCE) != bool(scenario):
            raise PermissionDenied("Evidence and actor must belong to the same evaluation context.")
        if scenario:
            raise PermissionDenied("Capstone evidence revisions are published through the approved importer.")
        if (values["kind"] in {"LOCATION", "TARIFF", "AVAILABILITY"}
                or "default_offer_id" in values["data"]
                or values["kind"] == "CALENDAR" and values["data"]):
            raise ValidationError("These evidence fields are reserved for the Capstone workbook.")
        try:
            outlets = checked_scope(values["kind"], values["scope"], values["data"])
        except ModelValidationError as exc:
            raise ValidationError(exc.messages) from exc
        if manager:
            if not manager_may_manage(request.user, outlets):
                raise PermissionDenied("The record is outside your Outlet scope.")
        elif (values["approval"] != "REFERENCE"
              or not self.belongs(provider, values["kind"], values["scope"])):
            raise PermissionDenied("Carriers may only submit references for their own fleet or coverage.")
        row, created = publish(actor=request.user, **values)
        return Response({**identity(row), "scope": row.scope, "data": row.data, "approval": row.approval},
                        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class ReceivingWindowInput(serializers.ModelSerializer):
    class Meta:
        model = ReceivingWindow
        fields = ("id", "outlet", "day_of_week", "start_time", "end_time", "is_active", "source", "source_reference")


class ReceivingSlotInput(serializers.ModelSerializer):
    class Meta:
        model = ReceivingSlot
        fields = ("id", "outlet", "slot_date", "start_time", "end_time", "slot_type", "status", "reason", "source",
                  "source_reference")


def _audit(actor, action, row, old, new):
    AuditLog.objects.create(
        actor_user=actor, action=action, entity_type=row._meta.db_table, entity_id=str(row.pk),
        old_values=old, new_values=new,
    )


class CalendarView(APIView):
    permission_classes = (IsAuthenticated, HasCoLogiRole)
    required_roles = (RoleCode.MANAGER,)
    kind = None

    def _spec(self, request):
        if actor_scenario(request.user):
            raise PermissionDenied("Operational calendars cannot be accessed by a Capstone actor.")
        outlet_ids = get_f1_outlet_ids(request.user)
        if self.kind == "windows":
            return ReceivingWindowInput, ReceivingWindow.objects.filter(outlet_id__in=outlet_ids, source_mode="OPERATIONAL")
        return ReceivingSlotInput, ReceivingSlot.objects.filter(outlet_id__in=outlet_ids, source_mode="OPERATIONAL")

    def get(self, request):
        serializer, rows = self._spec(request)
        return Response(serializer(rows.order_by("outlet_id", "pk"), many=True).data)

    @transaction.atomic
    def _save(self, request, pk=None):
        serializer, rows = self._spec(request)
        instance = rows.select_for_update().filter(pk=pk).first() if pk is not None else None
        if pk is not None and instance is None:
            raise NotFound()
        old = dict(serializer(instance).data) if instance else None
        form = serializer(instance, data=request.data, partial=instance is not None)
        form.is_valid(raise_exception=True)
        fields = form.validated_data
        outlet = fields.get("outlet", instance.outlet if instance else None)
        if not outlet or outlet.pk not in get_f1_outlet_ids(request.user) or (instance and outlet.pk != instance.outlet_id):
            raise PermissionDenied("The receiving record is outside your Outlet scope.")
        Outlet.objects.select_for_update().get(pk=outlet.pk)

        def value(name):
            return fields.get(name, getattr(instance, name, None))

        start, end = value("start_time"), value("end_time")
        if start >= end:
            raise ValidationError("Start time must precede end time.")
        conflicts = rows.filter(outlet=outlet, start_time__lt=end, end_time__gt=start).exclude(pk=pk)
        if self.kind == "windows":
            weekday = value("day_of_week")
            if weekday not in range(7):
                raise ValidationError("Weekday must be in 0–6.")
            if fields.get("is_active", instance.is_active if instance else True) and conflicts.filter(
                    day_of_week=weekday, is_active=True).exists():
                raise ValidationError("This window overlaps another active window.")
        elif value("status") not in ("CANCELLED", "REJECTED"):
            if conflicts.filter(slot_date=value("slot_date"), slot_type=value("slot_type")).exclude(
                    status__in=("CANCELLED", "REJECTED")).exists():
                raise ValidationError("This slot overlaps another slot of the same type.")
        # The physical DB key also applies to inactive records.
        matches = rows.filter(outlet=outlet, start_time=start, end_time=end).exclude(pk=pk)
        unique_day = {"day_of_week": value("day_of_week")} if self.kind == "windows" else {
            "slot_date": value("slot_date"), "slot_type": value("slot_type"),
        }
        if matches.filter(**unique_day).exists():
            raise ValidationError("A receiving record already exists for the same interval.")
        row = form.save(source_mode="OPERATIONAL")
        _audit(request.user, "DSS_RECEIVING_UPDATED", row, old, dict(form.data))
        return Response(form.data, status=status.HTTP_200_OK if instance else status.HTTP_201_CREATED)

    def post(self, request):
        return self._save(request)

    def patch(self, request, pk):
        return self._save(request, pk)


class CostProfileInput(serializers.ModelSerializer):
    class Meta:
        model = CostProfile
        fields = ("id", "profile_code", "profile_name", "currency_code", "fixed_transport_cost", "cost_per_km",
                  "additional_handling_cost", "is_active")

    def validate(self, fields):
        if fields.get("currency_code", "VND") != "VND":
            raise ValidationError("Only VND is supported.")
        for key in ("fixed_transport_cost", "cost_per_km", "additional_handling_cost"):
            value = fields.get(key)
            if value is not None and value < 0:
                raise ValidationError("Costs must be non-negative.")
        return fields


class CostProfileView(APIView):
    permission_classes = (IsAuthenticated, HasCoLogiRole)
    required_roles = (RoleCode.MANAGER,)

    def get(self, request):
        if actor_scenario(request.user) or not get_f1_outlet_ids(request.user):
            raise PermissionDenied()
        return Response(CostProfileInput(CostProfile.objects.order_by("profile_code"), many=True).data)

    @transaction.atomic
    def _save(self, request, pk=None):
        if actor_scenario(request.user):
            raise PermissionDenied("A Capstone actor cannot modify global CostProfiles.")
        if not manager_may_manage(request.user, set()):
            raise PermissionDenied("Global cost profiles require access to all active Outlets.")
        row = CostProfile.objects.select_for_update().filter(pk=pk).first() if pk is not None else None
        if pk is not None and row is None:
            raise NotFound()
        old = dict(CostProfileInput(row).data) if row else None
        form = CostProfileInput(row, data=request.data, partial=row is not None)
        form.is_valid(raise_exception=True)
        if row and form.validated_data.get("profile_code", row.profile_code) != row.profile_code:
            raise ValidationError("A CostProfile code cannot change.")
        saved = form.save()
        _audit(request.user, "DSS_COST_PROFILE_UPDATED", saved, old, dict(form.data))
        return Response(form.data, status=status.HTTP_200_OK if row else status.HTTP_201_CREATED)

    def post(self, request):
        return self._save(request)

    def patch(self, request, pk):
        return self._save(request, pk)
