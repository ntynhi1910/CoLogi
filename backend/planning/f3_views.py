from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.exceptions import APIException, NotFound, ValidationError
from rest_framework import serializers, status
from rest_framework.response import Response

from planning.f2_serializers import F2PlanSummarySerializer
from planning.f2_views import F2ManagerView
from planning.serializers import StrictInputMixin
from planning.services.f3_acceptance import AcceptanceEvidenceMismatch, manifest_for_request
from planning.services.f2_plans import F2MigrationRequired
from planning.services.f2_preview import CandidateInvalid, CandidateUnavailable
from planning.services.f3_persistence import F3MigrationRequired, f3_storage_available, read_f3_history, save_f3
from planning.services.f3_presentation import describe_evaluation
from planning.services.f3_preview import preview_f3, preview_manager_acceptance_f3


class F3SourceUnavailable(APIException):
    status_code = 503
    default_detail = "F3 source evidence is temporarily unavailable."
    default_code = "F3_SOURCE_UNAVAILABLE"


class F3PersistenceUnavailable(APIException):
    status_code = 503
    default_detail = "F3 evaluation storage requires migration planning/0006."
    default_code = "F3_MIGRATION_REQUIRED"


class F3InvalidDraft(APIException):
    status_code = 409
    default_detail = "The selected F2 revision or its allocation evidence is invalid."
    default_code = "F3_INVALID_SAVED_F2"


class F3ReadinessBlocked(APIException):
    status_code = 409
    default_detail = "This saved F3 evaluation cannot be used to prepare F4 in the current context."
    default_code = "F3_F4_READINESS_BLOCKED"


class F3SaveRequest(StrictInputMixin, serializers.Serializer):
    plan_codes = serializers.ListField(child=serializers.CharField(max_length=40, trim_whitespace=False), allow_empty=False)

    def validate_plan_codes(self, values):
        if len(values) != len(set(values)):
            raise ValidationError("Plan codes must be unique.")
        return values


class F3AllocationView(F2ManagerView):
    @extend_schema(tags=["Planning F3"], responses={
        200: OpenApiResponse(OpenApiTypes.OBJECT, description="Independent evaluations of an exact saved draft or the latest revision per option."),
        403: OpenApiResponse(description="Manager role and active Outlet scope required."),
        404: OpenApiResponse(description="The Candidate or Plan is outside the visible Run scope or does not exist."),
        503: OpenApiResponse(description="F2 storage or CP7 evidence is unavailable."),
    })
    def get(self, request, run_code, group_code, plan_code=None):
        if request.query_params:
            raise ValidationError({"detail": "F3 does not accept query parameters."})
        try:
            result = preview_f3(actor=request.user, run_code=run_code, group_code=group_code, plan_code=plan_code)
            storage = f3_storage_available()
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except (DatabaseError, F2MigrationRequired) as exc:
            raise F3SourceUnavailable from exc
        for evaluation in result["evaluations"]:
            evaluation["plan"] = F2PlanSummarySerializer(evaluation["plan"]).data
        manifest = manifest_for_request(request.user, run_code, group_code, plan_code)
        if manifest is not None:
            approved_code = manifest["scope"]["plan_code"]
            if any(row["plan"]["plan_code"] == approved_code and row["status"] != "INVALID_PLAN"
                   for row in result["evaluations"]):
                result["acceptance_preview_plan_code"] = approved_code
        return Response({**result, "persistence_available": storage})


class F3ManagerAcceptanceView(F2ManagerView):
    @extend_schema(tags=["Planning F3"], responses={200: OpenApiTypes.OBJECT})
    def get(self, request, run_code, group_code, plan_code):
        if request.query_params:
            raise ValidationError({"detail": "F3 acceptance does not accept query parameters."})
        try:
            result = preview_manager_acceptance_f3(actor=request.user, run_code=run_code,
                                                   group_code=group_code, plan_code=plan_code)
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except (AcceptanceEvidenceMismatch, DjangoValidationError) as exc:
            raise F3InvalidDraft({
                "code": "F3_ACCEPTANCE_EVIDENCE_MISMATCH",
                "detail": "The current plan or legacy sources do not match the approved acceptance manifest.",
            }) from exc
        except (DatabaseError, F2MigrationRequired) as exc:
            raise F3SourceUnavailable from exc
        evaluation = result["evaluation"]
        evaluation["plan"] = F2PlanSummarySerializer(evaluation["plan"]).data
        return Response(result, headers={"Cache-Control": "no-store, private"})


class F3EvaluationHistoryView(F2ManagerView):
    def read_history(self, request, run_code, group_code, plan_code=None, evaluation_code=None):
        if request.query_params:
            raise ValidationError({"detail": "F3 history does not accept query parameters."})
        try:
            result = read_f3_history(actor=request.user, run_code=run_code, group_code=group_code,
                                     plan_code=plan_code, evaluation_code=evaluation_code)
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except F3MigrationRequired as exc:
            raise F3PersistenceUnavailable from exc
        except (DatabaseError, F2MigrationRequired) as exc:
            raise F3SourceUnavailable from exc
        return result

    @extend_schema(tags=["Planning F3"], responses={200: OpenApiTypes.OBJECT})
    def get(self, request, run_code, group_code, plan_code=None, evaluation_code=None):
        result = self.read_history(request, run_code, group_code, plan_code, evaluation_code)
        if evaluation_code is not None:
            document = result["f3_structure"]
            result["presentation"] = describe_evaluation(document["result"], document["configuration"]["parameters"])
        return Response(result)


class F3ReadinessView(F3EvaluationHistoryView):
    @extend_schema(tags=["Planning F3"], responses={
        200: OpenApiResponse(OpenApiTypes.OBJECT, description="The exact saved F3 evaluation is eligible to prepare F4."),
        409: OpenApiResponse(description="The saved result is ineligible in the current context."),
    })
    def get(self, request, run_code, group_code, evaluation_code):
        result = self.read_history(request, run_code, group_code, evaluation_code=evaluation_code)
        if not result["ready_for_f4"]:
            raise F3ReadinessBlocked()
        return Response({"evaluation_code": result["evaluation_code"], "ready_for_f4": True})


class F3EvaluationsView(F3EvaluationHistoryView):
    @extend_schema(tags=["Planning F3"], request=F3SaveRequest, responses={
        200: OpenApiTypes.OBJECT, 201: OpenApiTypes.OBJECT,
        409: OpenApiResponse(description="An exact saved F2 revision or its evidence is invalid."),
    })
    def post(self, request, run_code, group_code):
        serializer = F3SaveRequest(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            result = save_f3(actor=request.user, run_code=run_code, group_code=group_code,
                             plan_codes=serializer.validated_data["plan_codes"])
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except (CandidateInvalid, DjangoValidationError) as exc:
            raise F3InvalidDraft from exc
        except F3MigrationRequired as exc:
            raise F3PersistenceUnavailable from exc
        except (DatabaseError, F2MigrationRequired) as exc:
            raise F3SourceUnavailable from exc
        return Response(result, status=status.HTTP_201_CREATED if result["created_count"] else status.HTTP_200_OK)
