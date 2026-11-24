from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.exceptions import APIException, NotFound, ValidationError
from rest_framework.response import Response

from planning.f2_views import F2ManagerView
from planning.f4_views import _scenario_field
from planning.serializers import StrictInputMixin
from planning.services.f2_preview import CandidateInvalid, CandidateUnavailable
from planning.services.f4_evidence import F4EvidenceInvalid, F4ScenarioUnavailable
from planning.services.f4_preview import F4MigrationRequired
from planning.services.f5_preview import F5AnchorBlocked, preview_f5
from planning.services.f5_persistence import F5MigrationRequired, read_f5_history, save_f5


class F5Unavailable(APIException):
    status_code = 503
    default_detail = "F5 source is temporarily unavailable."


class F5Blocked(APIException):
    status_code = 409


class F5PreviewView(F2ManagerView):
    @extend_schema(
        tags=["Planning F5"],
        parameters=[OpenApiParameter("scenario", str, description="Previously approved F4 scenario.")],
        responses={
            200: OpenApiTypes.OBJECT,
            409: OpenApiResponse(description="Saved F4 evaluation is blocked or outside the requested scenario."),
        },
    )
    def get(self, request, run_code, group_code, evaluation_code):
        query = request.query_params
        if set(query) - {"scenario"} or len(query.getlist("scenario")) > 1:
            raise ValidationError({"detail": "Only one F4 scenario can be supplied."})
        scenario = _scenario_field().run_validation(query["scenario"]) if "scenario" in query else None
        try:
            result = preview_f5(
                actor=request.user, run_code=run_code, group_code=group_code,
                evaluation_code=evaluation_code, scenario=scenario,
            )
        except (CandidateUnavailable, F4ScenarioUnavailable) as exc:
            raise NotFound() from exc
        except F5AnchorBlocked as exc:
            raise F5Blocked({"code": str(exc), "detail": "The saved F4 evaluation is not eligible in this scenario."}) from exc
        except (CandidateInvalid, DjangoValidationError) as exc:
            raise F5Blocked({"code": "F4_LINEAGE_INVALID", "detail": "The saved planning lineage could not be verified."}) from exc
        except (DatabaseError, F4EvidenceInvalid, F4MigrationRequired) as exc:
            raise F5Unavailable() from exc
        return Response(result)


class F5SaveItem(StrictInputMixin, serializers.Serializer):
    f4_evaluation_code = serializers.UUIDField()
    input_fingerprint = serializers.RegexField(r"\A[0-9a-f]{64}\Z", trim_whitespace=False)
    configuration_fingerprint = serializers.RegexField(r"\A[0-9a-f]{64}\Z", trim_whitespace=False)


class F5SaveRequest(StrictInputMixin, serializers.Serializer):
    scenario = _scenario_field(required=False)
    items = F5SaveItem(many=True, allow_empty=False)

    def validate_items(self, items):
        if len({row["f4_evaluation_code"] for row in items}) != len(items):
            raise serializers.ValidationError("Each F4 evaluation can be requested once.")
        return items


class F5HistoryView(F2ManagerView):
    @extend_schema(tags=["Planning F5"], responses=OpenApiTypes.OBJECT)
    def get(self, request, run_code, group_code, evaluation_code=None):
        try:
            return Response(read_f5_history(
                actor=request.user, run_code=run_code, group_code=group_code, evaluation_code=evaluation_code,
            ))
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except (DatabaseError, F5MigrationRequired) as exc:
            raise F5Unavailable() from exc


class F5EvaluationsView(F5HistoryView):
    @extend_schema(tags=["Planning F5"], request=F5SaveRequest, responses={
        200: OpenApiTypes.OBJECT, 201: OpenApiTypes.OBJECT, 409: OpenApiTypes.OBJECT, 503: OpenApiTypes.OBJECT,
    })
    def post(self, request, run_code, group_code):
        serializer = F5SaveRequest(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data
        try:
            rows = save_f5(actor=request.user, run_code=run_code, group_code=group_code,
                           scenario=payload.get("scenario"), items=payload["items"])
        except CandidateUnavailable as exc:
            raise NotFound() from exc
        except (DatabaseError, F5MigrationRequired) as exc:
            raise F5Unavailable() from exc
        created = sum(row["outcome"] == "CREATED" for row in rows)
        if created == len(rows):
            status = 201
        elif any(row["outcome"] != "REJECTED" for row in rows):
            status = 200
        elif all(row["code"] == "F5_STORAGE_ERROR" for row in rows):
            status = 503
        else:
            status = 409
        return Response({"results": rows, "created_count": created}, status=status)
