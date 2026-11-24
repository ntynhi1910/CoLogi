from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.exceptions import APIException, NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status

from accounts.models import RoleCode
from accounts.permissions import HasCoLogiRole
from planning.f2_serializers import (
    F2HubSerializer, F2OptionsQuerySerializer, F2OptionsSerializer, F2PlanDetailSerializer, F2PlanSaveSerializer,
)
from planning.services.f2_plans import F2MigrationRequired, read_f2_plan, save_f2_plan
from planning.services.f2_preview import CandidateInvalid, CandidateUnavailable, list_f2_hubs, preview_f2_options


class F2SourceUnavailable(APIException):
    status_code = 503
    default_detail = "F2 source is temporarily unavailable."
    default_code = "F2_SOURCE_UNAVAILABLE"


class F2CandidateConflict(APIException):
    status_code = 409
    default_detail = "F2 requires a valid Candidate from a completed PlanningRun."


def _candidate_conflict(exc):
    code = str(exc)
    if code == "HUB_SOURCE_UNAVAILABLE":
        return F2SourceUnavailable()
    messages = {
        "OPERATIONAL_DEMAND_PROVENANCE_REQUIRED": "This historical demo Candidate cannot create an operational plan.",
        "F2_REVISION_CONFLICT": "The latest Plan revision changed. Reload the options before saving.",
        "F2_PREVIEW_STALE": "The option changed. Preview it again before saving.",
    }
    return F2CandidateConflict({"detail": messages.get(code, F2CandidateConflict.default_detail), "code": code})


def _storage_unavailable():
    return F2SourceUnavailable({"detail": "The F2 Plan storage migration is required.", "code": "F2_MIGRATION_REQUIRED"})


class F2ManagerView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    required_roles = (RoleCode.MANAGER,)


class F2HubListView(F2ManagerView):
    @extend_schema(tags=["Planning F2"], responses={
        200: F2HubSerializer(many=True),
        403: OpenApiResponse(description="Manager role and active Outlet scope required."),
        503: OpenApiResponse(description="Hub masterdata is unavailable."),
    })
    def get(self, request):
        try:
            hubs = list_f2_hubs(request.user)
        except DatabaseError as exc:
            raise F2SourceUnavailable from exc
        return Response(F2HubSerializer(hubs, many=True).data)


class F2CandidateOptionsView(F2ManagerView):
    @extend_schema(tags=["Planning F2"], parameters=[F2OptionsQuerySerializer], responses={
        200: F2OptionsSerializer,
        400: OpenApiResponse(description="Invalid or duplicated Hub selection."),
        403: OpenApiResponse(description="Manager role and active Outlet scope required."),
        404: OpenApiResponse(description="The Candidate is outside the visible Run scope or does not exist."),
        409: OpenApiResponse(description="The visible group is not a valid completed F1 Candidate."),
        503: OpenApiResponse(description="The F1 source is unavailable."),
    })
    def get(self, request, run_code, group_code):
        if any(len(values) != 1 for _, values in request.query_params.lists()):
            raise ValidationError({"detail": "Duplicate query parameters are not supported."})
        query = F2OptionsQuerySerializer(data=request.query_params.dict())
        query.is_valid(raise_exception=True)
        try:
            options = preview_f2_options(
                actor=request.user, run_code=run_code, group_code=group_code,
                hub_id=query.validated_data.get("hub_id"),
            )
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except CandidateInvalid as exc:
            raise _candidate_conflict(exc) from exc
        except DatabaseError as exc:
            raise F2SourceUnavailable from exc
        return Response(F2OptionsSerializer(options).data)


class F2CandidatePlansView(F2ManagerView):
    @extend_schema(tags=["Planning F2"], request=F2PlanSaveSerializer, responses={
        200: F2PlanDetailSerializer,
        201: F2PlanDetailSerializer,
        400: OpenApiResponse(description="Biểu mẫu hoặc dữ liệu xem trước không hợp lệ."),
        403: OpenApiResponse(description="Yêu cầu quyền Quản lý và phạm vi Điểm vận hành (Outlet) đang hoạt động."),
        404: OpenApiResponse(description="Đơn hàng/Chuyến đề xuất nằm ngoài phạm vi Lộ trình (Run) hiển thị hoặc không tồn tại."),
        409: OpenApiResponse(description="Bản xem trước đã hết hạn, tùy chọn chưa hoàn tất hoặc xảy ra xung đột phiên bản."),
        503: OpenApiResponse(description="Kho lưu trữ F2 hoặc nguồn dữ liệu hiện không khả dụng."),
    })
    def post(self, request, run_code, group_code):
        body = F2PlanSaveSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            plan, created = save_f2_plan(actor=request.user, run_code=run_code, group_code=group_code, **body.validated_data)
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except CandidateInvalid as exc:
            raise _candidate_conflict(exc) from exc
        except DjangoValidationError as exc:
            raise _candidate_conflict(CandidateInvalid("F2_STRUCTURE_INVALID")) from exc
        except F2MigrationRequired as exc:
            raise _storage_unavailable() from exc
        except DatabaseError as exc:
            raise F2SourceUnavailable from exc
        return Response(F2PlanDetailSerializer(plan).data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class F2PlanDetailView(F2ManagerView):
    @extend_schema(tags=["Planning F2"], responses={
        200: F2PlanDetailSerializer,
        403: OpenApiResponse(description="Manager role and active Outlet scope required."),
        404: OpenApiResponse(description="The Plan is outside the visible Candidate scope or does not exist."),
        503: OpenApiResponse(description="F2 storage or source is unavailable."),
    })
    def get(self, request, run_code, group_code, plan_code):
        try:
            plan = read_f2_plan(actor=request.user, run_code=run_code, group_code=group_code, plan_code=plan_code)
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except F2MigrationRequired as exc:
            raise _storage_unavailable() from exc
        except DatabaseError as exc:
            raise F2SourceUnavailable from exc
        return Response(F2PlanDetailSerializer(plan).data)
