from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.exceptions import (
    PermissionDenied as DjangoPermissionDenied,
    ValidationError as DjangoValidationError,
)
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from rest_framework import status
from rest_framework.exceptions import (
    NotFound,
    PermissionDenied,
    ValidationError,
)
from rest_framework.permissions import IsAuthenticated
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from drf_spectacular.utils import OpenApiResponse, extend_schema

from accounts.models import RoleCode
from accounts.permissions import HasCoLogiRole
from demands.models import DeliveryDemand
from demands.serializers import DeliveryDemandReadSerializer
from planning.services.demand_provenance import known_demo_demands, requires_operational_provenance
from planning.services.internal_supplement import approval_for_day, display_approval
from planning.serializers import (
    F1PreviewRequestSerializer,
    F1PreviewResponseSerializer,
    F1RuleSetSerializer,
    F1RunDetailSerializer,
    F1RunHistorySerializer,
    F1RunSummarySerializer,
    F1ScopeSerializer,
)
from planning.models import PlanningRuleSet, PlanningRun, PlanningRunSourceMode, RuleSetStatus
from planning.services.f1_date_gate import F1DateGateError, requested_delivery_deadline
from planning.services.f1_selection import F1SelectionError, MESSAGES, selection_diagnostics
from planning.services.run_configuration import load_run_configuration
from planning.services.run_execution import execute_f1_run_for_actor
from planning.services.run_orchestration import (
    preview_f1_run_for_actor,
)
from planning.services.run_preview import require_f1_execution_configuration
from planning.services.run_results import get_f1_run_detail, list_f1_runs, summarize_f1_run
from planning.services.run_scope import require_f1_outlet_ids


def raise_api_validation_error(exc):
    if hasattr(exc, "message_dict"):
        detail = exc.message_dict
    else:
        detail = {"non_field_errors": exc.messages}

    raise ValidationError(detail)


def f1_date_error_response(exc):
    return Response(
        {"detail": "Kiểm tra điều kiện F1 không đạt.", "diagnostics": [
            {**row, "message": row.get("message", MESSAGES.get(row["code"], row["code"]))} for row in exc.diagnostics]},
        status=status.HTTP_400_BAD_REQUEST,
    )


class F1ManagerView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    required_roles = (RoleCode.MANAGER,)


class F1RunPreviewView(F1ManagerView):
    """
    Read-only F1 preview.

    No PlanningRun, PlanningRunDemand or CollaborationGroup
    records are created by this endpoint.
    """

    @extend_schema(
        operation_id="planning_f1_run_preview",
        tags=["Planning F1"],
        request=F1PreviewRequestSerializer,
        responses={
            200: F1PreviewResponseSerializer,
            400: OpenApiResponse(
                description="Invalid request or business validation failed."
            ),
            401: OpenApiResponse(
                description="Authentication required."
            ),
            403: OpenApiResponse(
                description="Active MANAGER role and Outlet access required."
            ),
        },
    )
    def post(self, request):
        request_serializer = F1PreviewRequestSerializer(
            data=request.data
        )
        request_serializer.is_valid(raise_exception=True)

        data = request_serializer.validated_data

        try:
            preview = preview_f1_run_for_actor(
                actor=request.user,
                demand_ids=data["demand_ids"],
                rule_set_id=data["rule_set_id"],
                cost_profile_id=data.get("cost_profile_id"),
            )
        except DjangoPermissionDenied as exc:
            raise PermissionDenied(str(exc))
        except (F1DateGateError, F1SelectionError) as exc:
            return f1_date_error_response(exc)
        except DjangoValidationError as exc:
            raise_api_validation_error(exc)

        response_serializer = F1PreviewResponseSerializer(preview)

        return Response(
            response_serializer.data,
            status=status.HTTP_200_OK,
        )


def _run_detail_response(actor, run_code, status_code):
    try:
        detail = get_f1_run_detail(actor=actor, run_code=run_code)
    except PlanningRun.DoesNotExist as exc:
        raise NotFound() from exc
    except DjangoValidationError as exc:
        raise_api_validation_error(exc)
    return Response(F1RunDetailSerializer(detail).data, status=status_code)


class F1RunCreateView(F1ManagerView):
    @extend_schema(responses=F1RunHistorySerializer)
    def get(self, request):
        require_f1_outlet_ids(request.user)
        paginator = F1HistoryPagination()
        page = paginator.paginate_queryset(list_f1_runs(request.user), request, view=self)
        summaries = [summarize_f1_run(run) for run in page]
        return paginator.get_paginated_response(F1RunSummarySerializer(summaries, many=True).data)

    @extend_schema(request=F1PreviewRequestSerializer, responses={201: F1RunDetailSerializer})
    def post(self, request):
        serializer = F1PreviewRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            run = execute_f1_run_for_actor(
                actor=request.user, source_mode=PlanningRunSourceMode.API, **serializer.validated_data,
            )
        except DjangoPermissionDenied as exc:
            raise PermissionDenied(str(exc)) from exc
        except (F1DateGateError, F1SelectionError) as exc:
            return f1_date_error_response(exc)
        except DjangoValidationError as exc:
            raise_api_validation_error(exc)
        return _run_detail_response(request.user, run.run_code, status.HTTP_201_CREATED)


class F1RunDetailView(F1ManagerView):
    @extend_schema(responses=F1RunDetailSerializer)
    def get(self, request, run_code):
        return _run_detail_response(request.user, run_code, status.HTTP_200_OK)


class F1HistoryPagination(PageNumberPagination):
    page_size = 10


class F1ScopeView(F1ManagerView):
    @extend_schema(responses=F1ScopeSerializer)
    def get(self, request):
        from accounts.capstone import actor_scenario
        from planning.services.unplanned_demands import _close_enabled

        scope = {"outlet_ids": list(require_f1_outlet_ids(request.user))}
        if settings.COLOGI_CP11_ENABLED and settings.COLOGI_CP12_ENABLED and _close_enabled():
            scope["unplanned_closure_enabled"] = True
        scenario = actor_scenario(request.user)
        if scenario:
            return Response({**scope, "environment": "CAPSTONE", "scenario": scenario})
        if requires_operational_provenance(scenario):
            blocked = DeliveryDemand.objects.filter(
                capstone_scenario="", outlet_id__in=scope["outlet_ids"],
            ).filter(known_demo_demands()).order_by("id").values_list("id", flat=True).distinct()
            scope["excluded_demo_demand_ids"] = list(blocked)
        approval = approval_for_day()
        if approval:
            scope["internal_planning"] = display_approval(approval)
        uat_database = getattr(settings, "F1_UAT_DATABASE", None)
        if uat_database and connection.vendor == "postgresql" and connection.settings_dict["NAME"] == uat_database:
            with connection.cursor() as cursor:
                cursor.execute("SELECT current_database()")
                if cursor.fetchone()[0] == uat_database:
                    scope["environment"] = "UAT"
        return Response(scope)


class F1SelectableDemandsView(F1ManagerView):
    @transaction.atomic
    def get(self, request):
        from accounts.capstone import actor_scenario
        from planning.services.final_delivery import begin_snapshot

        if len(connection.atomic_blocks) == 1:
            begin_snapshot()
        outlets = require_f1_outlet_ids(request.user)
        scenario = actor_scenario(request.user)
        scoped = DeliveryDemand.objects.filter(capstone_scenario=scenario, outlet_id__in=outlets)
        if requires_operational_provenance(scenario):
            scoped = scoped.exclude(pk__in=scoped.filter(known_demo_demands()).values("pk"))
        demands = list(scoped.select_related("supplier", "outlet", "cargo_category")
                       .prefetch_related("items__item__cargo_category").order_by("-pk"))
        evaluated_at = timezone.now()
        issues = selection_diagnostics(request.user, demands, at=evaluated_at)
        blocked = {row["demand_id"] for row in issues}
        eligible = [row for row in demands if row.pk not in blocked]
        business_timezone = ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE)
        deadlines = (requested_delivery_deadline(row, business_timezone) for row in demands)
        next_expiry = min((deadline for deadline in deadlines if deadline and deadline > evaluated_at), default=None)
        return Response({"demands": DeliveryDemandReadSerializer(eligible, many=True).data,
                         "evaluated_at": evaluated_at, "next_expiry_at": next_expiry,
                         "counts": {"eligible": len(eligible), "excluded": len(blocked),
                                    "final_plan": sum(row["code"] in ("F1_EFFECTIVE_FINAL_PLAN", "F1_EXECUTION_OBLIGATION")
                                                      for row in issues),
                                    "past_due": sum(row["code"] in ("F1_DEMAND_DATE_IN_PAST", "F1_DELIVERY_WINDOW_EXPIRED")
                                                    for row in issues)}})


class F1RuleSetListView(F1ManagerView):
    @extend_schema(responses=F1RuleSetSerializer(many=True))
    @transaction.atomic
    def get(self, request):
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        require_f1_outlet_ids(request.user)
        captured_at = timezone.now()
        candidates = PlanningRuleSet.objects.filter(status=RuleSetStatus.ACTIVE).filter(
            Q(effective_from__isnull=True) | Q(effective_from__lte=captured_at),
        ).order_by("rule_set_name", "-version_no", "pk")
        valid = []
        for rule_set in candidates:
            try:
                snapshot = load_run_configuration(rule_set_id=rule_set.pk, captured_at=captured_at)
                rule_set.max_group_size, rule_set.max_candidates_per_run = require_f1_execution_configuration(snapshot)
            except DjangoValidationError:
                continue
            valid.append(rule_set)
        return Response(F1RuleSetSerializer(valid, many=True).data)
