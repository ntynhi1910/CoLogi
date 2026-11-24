from rest_framework import serializers, status
from rest_framework.exceptions import MethodNotAllowed, PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import RoleCode
from accounts.permissions import HasCoLogiRole
from masterdata.outlet_workspace import create_outlet, list_outlets, outlet_detail, save_calendar, set_active, today, update_outlet
from planning.models import ReceivingSlot


class StrictInput(serializers.Serializer):
    def to_internal_value(self, data):
        if hasattr(data, "keys") and set(data) - set(self.fields):
            raise serializers.ValidationError({"non_field_errors": ["Yêu cầu có trường không được hỗ trợ."]})
        return super().to_internal_value(data)


class OutletInput(StrictInput):
    outlet_name = serializers.CharField(max_length=200)
    address = serializers.CharField(max_length=600)
    contact_name = serializers.CharField(max_length=150, allow_blank=True, allow_null=True, required=False)
    phone = serializers.RegexField(r"^[+]?([0-9][ .()-]*){7,15}$", max_length=30,
                                   allow_blank=True, allow_null=True, required=False)


class DayQuery(StrictInput):
    date = serializers.DateField(default=today)


class OutletStateInput(StrictInput):
    is_active = serializers.BooleanField()
    confirm = serializers.BooleanField()
    reason = serializers.CharField(max_length=1000)

    def validate_confirm(self, value):
        if not value:
            raise serializers.ValidationError("Cần xác nhận thay đổi trạng thái.")
        return value


class WindowInput(StrictInput):
    day_of_week = serializers.IntegerField(min_value=0, max_value=6)
    start_time = serializers.TimeField()
    end_time = serializers.TimeField()
    is_active = serializers.BooleanField()


class SlotInput(StrictInput):
    slot_date = serializers.DateField()
    start_time = serializers.TimeField()
    end_time = serializers.TimeField()
    slot_type = serializers.ChoiceField(choices=ReceivingSlot.SlotType)
    status = serializers.ChoiceField(choices=(ReceivingSlot.Status.OPEN, ReceivingSlot.Status.CANCELLED))
    reason = serializers.CharField(required=False, default="", max_length=1000, allow_blank=True)

    def validate(self, attrs):
        if attrs["slot_type"] == ReceivingSlot.SlotType.BLOCKED and not attrs["reason"]:
            raise serializers.ValidationError({"reason": ["Nhập lý do đóng khung nhận."]})
        return attrs


class StaffOutletView(APIView):
    permission_classes = (IsAuthenticated, HasCoLogiRole)
    required_roles = (RoleCode.PURCHASING_STAFF,)

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if request.user.capstone_scenario:
            raise PermissionDenied("Không truy cập workspace vận hành từ phiên Capstone.")


class OutletWorkspaceList(StaffOutletView):
    def get(self, request):
        return Response(list_outlets(request.user))

    def post(self, request):
        form = OutletInput(data=request.data)
        form.is_valid(raise_exception=True)
        return Response(create_outlet(request.user, form.validated_data), status=status.HTTP_201_CREATED)


class OutletWorkspaceDetail(StaffOutletView):
    def get(self, request, outlet_id):
        form = DayQuery(data=request.query_params)
        form.is_valid(raise_exception=True)
        return Response(outlet_detail(request.user, outlet_id, form.validated_data["date"]))

    def patch(self, request, outlet_id):
        form = OutletInput(data=request.data, partial=True)
        form.is_valid(raise_exception=True)
        return Response(update_outlet(request.user, outlet_id, form.validated_data))


class OutletWorkspaceState(StaffOutletView):
    def post(self, request, outlet_id):
        form = OutletStateInput(data=request.data)
        form.is_valid(raise_exception=True)
        return Response(set_active(request.user, outlet_id, form.validated_data["is_active"], form.validated_data["reason"]))


class OutletWorkspaceCalendar(StaffOutletView):
    kind = None

    def _save(self, request, outlet_id, row_id=None):
        form = (WindowInput if self.kind == "windows" else SlotInput)(data=request.data)
        form.is_valid(raise_exception=True)
        data = save_calendar(request.user, outlet_id, self.kind, form.validated_data, row_id)
        return Response(data, status=status.HTTP_200_OK if row_id is not None else status.HTTP_201_CREATED)

    def post(self, request, outlet_id, row_id=None):
        if row_id is not None:
            raise MethodNotAllowed("POST")
        return self._save(request, outlet_id)

    def patch(self, request, outlet_id, row_id=None):
        if row_id is None:
            raise MethodNotAllowed("PATCH")
        return self._save(request, outlet_id, row_id)
