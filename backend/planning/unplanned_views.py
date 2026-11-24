from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import RoleCode
from accounts.permissions import HasCoLogiRole
from planning.serializers import StrictInputMixin
from planning.services.inventory import ExecutionBlocked
from planning.services.unplanned_demands import ERRORS, close_unplanned, current_request, read_notices


class CloseInput(StrictInputMixin, serializers.Serializer):
    supplier_request_id = serializers.IntegerField(min_value=1)
    run_code = serializers.UUIDField(required=False)
    reason = serializers.CharField(max_length=500)
    confirm_finished = serializers.BooleanField()

    def validate_confirm_finished(self, value):
        if not value:
            raise serializers.ValidationError("Manager phải xác nhận đã kết thúc lần lập kế hoạch.")
        return value


class CloseUnplannedView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    required_roles = (RoleCode.MANAGER,)

    def get(self, request, demand_id):
        try:
            return Response(current_request(request.user, demand_id))
        except DjangoPermissionDenied as exc:
            raise PermissionDenied() from exc

    def post(self, request, demand_id):
        body = CloseInput(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            row = close_unplanned(actor=request.user, demand_id=demand_id, run_code=body.validated_data.get("run_code"),
                                  supplier_request_id=body.validated_data["supplier_request_id"],
                                  reason=body.validated_data["reason"])
        except DjangoPermissionDenied as exc:
            raise PermissionDenied() from exc
        except ExecutionBlocked as exc:
            code = str(exc.detail["code"])
            return Response({"code": code, "detail": ERRORS.get(code, code)}, status=409)
        return Response(row, status=201 if row["created"] else 200)


class UnplannedNoticesView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    audience = None

    @property
    def required_roles(self):
        return ({"supplier": RoleCode.SUPPLIER, "purchasing": RoleCode.PURCHASING_STAFF,
                 "manager": RoleCode.MANAGER}[self.audience],)

    def get(self, request):
        return Response(read_notices(actor=request.user, audience=self.audience))
