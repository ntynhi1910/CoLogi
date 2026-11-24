from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError
from rest_framework import serializers, status
from rest_framework.exceptions import APIException, NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from planning.f2_views import F2ManagerView
from planning.models import CarrierOutcome, DecisionOutcome
from planning.serializers import StrictInputMixin
from planning.services.f2_preview import CandidateInvalid, CandidateUnavailable
from planning.services.f4_evidence import F4EvidenceInvalid, F4ScenarioUnavailable
from planning.services.f4_preview import F4MigrationRequired
from planning.services.f5_preview import F5AnchorBlocked
from planning.services.final_delivery import (
    DeliveryConflict, DeliveryStorageUnavailable, decision_timeline, record_decision, review_index, workbench,
)
from planning.services.transport_handover import read_manager_plan, read_manager_plans, read_provider_plans, respond_to_plan, send_plan
from transportation.permissions import ProviderScopeMixin


class WorkflowBlocked(APIException):
    status_code = 409


class WorkflowUnavailable(APIException):
    status_code = 503


class ReasonSerializer(StrictInputMixin, serializers.Serializer):
    reason = serializers.CharField(max_length=2000)


class DecisionRequest(ReasonSerializer):
    request_id = serializers.UUIDField()
    evaluation_code = serializers.UUIDField()
    outcome = serializers.ChoiceField(choices=DecisionOutcome.values)
    replaces = serializers.UUIDField(required=False, allow_null=True)


class CarrierRequest(ReasonSerializer):
    outcome = serializers.ChoiceField(choices=CarrierOutcome.values)


class HistoryFilter(StrictInputMixin, serializers.Serializer):
    outcome = serializers.ChoiceField(choices=DecisionOutcome.values, required=False)
    code = serializers.UUIDField(required=False)
    date_from = serializers.DateField(required=False)
    date_to = serializers.DateField(required=False)
    actor_id = serializers.IntegerField(min_value=1, required=False)
    version = serializers.IntegerField(min_value=1, required=False)
    search = serializers.CharField(max_length=120, required=False)
    page = serializers.IntegerField(min_value=1, max_value=100000, required=False)
    history_only = serializers.BooleanField(required=False)

    def validate(self, attrs):
        left, right = attrs.get("date_from"), attrs.get("date_to")
        if left and right and left > right:
            raise ValidationError({"date_to": "End date must be on or after start date."})
        return attrs


def _call(operation, *, retry=False, **kwargs):
    for attempt in range(3 if retry else 1):
        try:
            return operation(**kwargs)
        except (CandidateUnavailable, F4ScenarioUnavailable) as exc:
            raise NotFound() from exc
        except DeliveryStorageUnavailable as exc:
            raise WorkflowUnavailable({"code": "DELIVERY_MIGRATION_REQUIRED"}) from exc
        except F4MigrationRequired as exc:
            raise WorkflowUnavailable({"code": "DELIVERY_SOURCE_UNAVAILABLE"}) from exc
        except (CandidateInvalid, DjangoValidationError, F4EvidenceInvalid) as exc:
            raise WorkflowBlocked({"code": "DELIVERY_SOURCE_INVALID"}) from exc
        except (DeliveryConflict, F5AnchorBlocked) as exc:
            raise WorkflowBlocked({"code": str(exc)}) from exc
        except DatabaseError as exc:
            sqlstate = getattr(exc.__cause__, "sqlstate", None)
            if retry and sqlstate in {"40001", "40P01", "23505"}:
                if attempt < 2:
                    continue
                raise WorkflowBlocked({"code": "DELIVERY_CONCURRENT_UPDATE"}) from exc
            raise WorkflowUnavailable({"code": "DELIVERY_STORAGE_UNAVAILABLE"}) from exc


def _mutation(operation, **kwargs):
    payload, created = _call(operation, retry=True, **kwargs)
    return Response(payload, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class DeliveryReviewIndexView(F2ManagerView):
    def get(self, request):
        inputs = HistoryFilter(data=request.query_params)
        inputs.is_valid(raise_exception=True)
        return Response(_call(review_index, actor=request.user, **inputs.validated_data))


class DeliveryReviewView(F2ManagerView):
    def get(self, request, run_code, group_code):
        return Response(_call(workbench, actor=request.user, run_code=run_code, group_code=group_code))

    def post(self, request, run_code, group_code):
        inputs = DecisionRequest(data=request.data)
        inputs.is_valid(raise_exception=True)
        return _mutation(record_decision, actor=request.user, run_code=run_code, group_code=group_code,
                         **inputs.validated_data)


class FinalPlanView(F2ManagerView):
    def get(self, request, code):
        return Response(_call(read_manager_plan, actor=request.user, code=code))


class FinalPlanListView(F2ManagerView):
    def get(self, request):
        return Response(_call(read_manager_plans, actor=request.user))


class DecisionTimelineView(F2ManagerView):
    def get(self, request, decision_id):
        return Response(_call(decision_timeline, actor=request.user, decision_id=decision_id))


class SendFinalPlanView(F2ManagerView):
    def post(self, request, code):
        if request.data:
            raise ValidationError({"detail": "The approved plan version determines the handover payload."})
        return _mutation(send_plan, actor=request.user, code=code)


class ProviderHandoverView(ProviderScopeMixin, APIView):
    allow_capstone_writes = True

    def get(self, request, code=None):
        return Response(_call(read_provider_plans, actor=request.user, provider_id=self.get_provider_id(), code=code))


class ProviderHandoverResponseView(ProviderScopeMixin, APIView):
    allow_capstone_writes = True

    def post(self, request, code):
        inputs = CarrierRequest(data=request.data)
        inputs.is_valid(raise_exception=True)
        return _mutation(respond_to_plan, actor=request.user, provider_id=self.get_provider_id(), code=code,
                         **inputs.validated_data)

