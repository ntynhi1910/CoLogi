from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import APIException, NotFound, ValidationError
from rest_framework.response import Response

from planning.f2_views import F2ManagerView
from planning.serializers import StrictInputMixin
from planning.services.f2_preview import CandidateUnavailable
from planning.services.f3_persistence import F3MigrationRequired
from planning.services.f4_evidence import F4EvidenceInvalid, F4ScenarioUnavailable
from planning.services.f4_persistence import F4PreviewChanged, read_f4_history, save_f4
from planning.services.f4_preview import F4MigrationRequired, F4NotReady, preview_f4


class F4SourceUnavailable(APIException):
    status_code = 503
    default_detail = "The F4 evidence source or planning storage is unavailable."
    default_code = "F4_SOURCE_UNAVAILABLE"


class F4InvalidSource(APIException):
    status_code = 409
    default_detail = "F4 requires a valid, eligible saved F3 evaluation of this F2 revision."
    default_code = "F4_SAVED_F3_REQUIRED"


class F4PreviewStale(APIException):
    status_code = 409
    default_detail = "F4 inputs or configuration changed. Refresh the preview before saving."
    default_code = "F4_PREVIEW_STALE"


class F4PersistenceUnavailable(APIException):
    status_code = 503
    default_detail = "F4 history requires planning/0007_f4_evaluation."
    default_code = "F4_MIGRATION_REQUIRED"


def _execute(action, request, run_code, group_code, *, scenario_query=False, **kwargs):
    if request.query_params and (
        not scenario_query or set(request.query_params) != {"scenario"}
        or len(request.query_params.getlist("scenario")) != 1
    ):
        raise ValidationError({"detail": "F4 accepts only a registered UAT scenario and no client timing evidence."})
    if scenario_query and "scenario" in request.query_params:
        kwargs["scenario"] = _scenario_field().run_validation(request.query_params["scenario"])
    try:
        return action(actor=request.user, run_code=run_code, group_code=group_code, **kwargs)
    except CandidateUnavailable as exc:
        raise NotFound() from exc
    except F4ScenarioUnavailable as exc:
        raise NotFound("The requested F4 scenario is unavailable in this context.") from exc
    except F4PreviewChanged as exc:
        raise F4PreviewStale from exc
    except F4MigrationRequired as exc:
        raise F4PersistenceUnavailable from exc
    except (F4NotReady, DjangoValidationError) as exc:
        raise F4InvalidSource from exc
    except (DatabaseError, F3MigrationRequired, F4EvidenceInvalid) as exc:
        raise F4SourceUnavailable from exc


class F4SaveItem(StrictInputMixin, serializers.Serializer):
    f3_evaluation_code = serializers.UUIDField()
    input_fingerprint = serializers.RegexField(r"\A[0-9a-f]{64}\Z", trim_whitespace=False)
    configuration_fingerprint = serializers.RegexField(r"\A[0-9a-f]{64}\Z", trim_whitespace=False)


def _scenario_field(**kwargs):
    return serializers.RegexField(r"\A[a-z0-9]+(?:-[a-z0-9]+)*\Z", max_length=50, trim_whitespace=False, **kwargs)


class F4SaveRequest(StrictInputMixin, serializers.Serializer):
    evaluations = F4SaveItem(many=True, allow_empty=False)
    scenario = _scenario_field(required=False)

    def validate_evaluations(self, value):
        if len({row["f3_evaluation_code"] for row in value}) != len(value):
            raise serializers.ValidationError("F3 evaluation codes must be unique.")
        return value


class F4PreviewView(F2ManagerView):
    @extend_schema(tags=["Planning F4"], responses={
        200: OpenApiResponse(OpenApiTypes.OBJECT, description="Read-only time feasibility for independent saved options."),
        409: OpenApiResponse(description="The selected F3 evaluation is unavailable for F4 in the current context."),
        503: OpenApiResponse(description="An evidence source or planning storage is unavailable."),
    })
    def get(self, request, run_code, group_code, evaluation_code=None):
        return Response(_execute(preview_f4, request, run_code, group_code, scenario_query=True, evaluation_code=evaluation_code))


class F4HistoryView(F2ManagerView):
    @extend_schema(tags=["Planning F4"], responses={200: OpenApiTypes.OBJECT})
    def get(self, request, run_code, group_code, evaluation_code=None):
        return Response(_execute(read_f4_history, request, run_code, group_code, evaluation_code=evaluation_code))


class F4EvaluationsView(F4HistoryView):
    @extend_schema(tags=["Planning F4"], request=F4SaveRequest,
                   responses={200: OpenApiTypes.OBJECT, 201: OpenApiTypes.OBJECT})
    def post(self, request, run_code, group_code):
        serializer = F4SaveRequest(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = _execute(save_f4, request, run_code, group_code, **serializer.validated_data)
        return Response(result, status=status.HTTP_201_CREATED if result["created_count"] else status.HTTP_200_OK)


class F4ReadinessBlocked(APIException):
    status_code = 409
    default_detail = "The saved F4 evaluation is not eligible to prepare F5 in this context."
    default_code = "F4_F5_READINESS_BLOCKED"


class F4ReadinessView(F2ManagerView):
    @extend_schema(tags=["Planning F4"], responses={200: OpenApiTypes.OBJECT, 409: OpenApiResponse()})
    def get(self, request, run_code, group_code, evaluation_code):
        result = _execute(read_f4_history, request, run_code, group_code, evaluation_code=evaluation_code)
        if not result["ready_for_f5"]:
            raise F4ReadinessBlocked()
        return Response({"evaluation_code": result["evaluation_code"], "ready_for_f5": True})
