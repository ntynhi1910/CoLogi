from django.conf import settings
from django.urls import path
from planning.execution_views import (ExecutionAvailabilityView, ExecutionCancelView, InventoryView, PlanExecutionView,
                                      ReconcileStockView, SimulationApprovalView)

from planning.delivery_views import (
    DecisionTimelineView, DeliveryReviewIndexView, DeliveryReviewView, FinalPlanListView, FinalPlanView, SendFinalPlanView,
)
from planning.f2_views import F2CandidateOptionsView, F2CandidatePlansView, F2HubListView, F2PlanDetailView
from planning.f3_views import (
    F3AllocationView, F3EvaluationHistoryView, F3EvaluationsView, F3ManagerAcceptanceView, F3ReadinessView,
)
from planning.f4_views import F4EvaluationsView, F4HistoryView, F4PreviewView, F4ReadinessView
from planning.f5_views import F5EvaluationsView, F5HistoryView, F5PreviewView
from planning.operational_views import CalendarView, CostProfileView, EvidenceView
from planning.publication_views import PurchasingPublicationView, SupplierPublicationView
from planning.reconciliation_views import ReconciliationAvailabilityView, ReconciliationView
from planning.unplanned_views import CloseUnplannedView, UnplannedNoticesView
from planning.views import (
    F1RuleSetListView, F1RunCreateView, F1RunDetailView, F1RunPreviewView, F1ScopeView, F1SelectableDemandsView,
)


cp12_patterns = [
    path("f1/selectable-demands/", F1SelectableDemandsView.as_view()),
    path("f1/demands/<int:demand_id>/close-unplanned/", CloseUnplannedView.as_view()),
    *[path(f"publication/{role}/unplanned/", UnplannedNoticesView.as_view(audience=role))
      for role in ("manager", "supplier", "purchasing")],
    path("reconciliation/availability/", ReconciliationAvailabilityView.as_view()),
    *[entry for audience in ("manager", "supplier", "purchasing", "provider") for entry in (
        path(f"reconciliation/{audience}/", ReconciliationView.as_view(audience=audience)),
        path(f"reconciliation/{audience}/<uuid:code>/", ReconciliationView.as_view(audience=audience)),
    )],
]

urlpatterns = (cp12_patterns if settings.COLOGI_CP12_ENABLED else []) + [
    path("execution/availability/", ExecutionAvailabilityView.as_view()),
    path("inventory/", InventoryView.as_view()),
    path("inventory/commitments/<int:request_id>/", ReconcileStockView.as_view()),
    path("execution/manager/", PlanExecutionView.as_view(audience="manager")),
    path("execution/provider/", PlanExecutionView.as_view(audience="provider")),
    path("execution/manager/<uuid:code>/", PlanExecutionView.as_view(audience="manager")),
    path("execution/manager/<uuid:code>/cancel/", ExecutionCancelView.as_view()),
    path("execution/manager/<uuid:code>/simulation/", SimulationApprovalView.as_view()),
    path("execution/provider/<uuid:code>/", PlanExecutionView.as_view(audience="provider")),
    path("execution/supplier/<uuid:code>/", PlanExecutionView.as_view(audience="supplier")),
    path("execution/purchasing/<uuid:code>/", PlanExecutionView.as_view(audience="purchasing")),
    path("publication/supplier/", SupplierPublicationView.as_view(), name="supplier-plan-publications"),
    path("publication/supplier/<uuid:code>/", SupplierPublicationView.as_view(), name="supplier-plan-publication"),
    path("publication/purchasing/", PurchasingPublicationView.as_view(), name="purchasing-plan-publications"),
    path("publication/purchasing/<uuid:code>/", PurchasingPublicationView.as_view(), name="purchasing-plan-publication"),
    path("decisions/", DeliveryReviewIndexView.as_view(), name="planning-decision-index"),
    path("decisions/<int:decision_id>/timeline/", DecisionTimelineView.as_view(), name="planning-decision-timeline"),
    path("decisions/runs/<uuid:run_code>/groups/<str:group_code>/", DeliveryReviewView.as_view(),
         name="planning-decision-workbench"),
    path("final-plans/", FinalPlanListView.as_view(), name="planning-final-plan-list"),
    path("final-plans/<uuid:code>/", FinalPlanView.as_view(), name="planning-final-plan"),
    path("final-plans/<uuid:code>/handover/", SendFinalPlanView.as_view(), name="planning-final-plan-handover"),
    path("operational/evidence/", EvidenceView.as_view(), name="operational-evidence"),
    path("operational/windows/", CalendarView.as_view(kind="windows"), name="operational-windows"),
    path("operational/windows/<int:pk>/", CalendarView.as_view(kind="windows"), name="operational-window"),
    path("operational/slots/", CalendarView.as_view(kind="slots"), name="operational-slots"),
    path("operational/slots/<int:pk>/", CalendarView.as_view(kind="slots"), name="operational-slot"),
    path("operational/profiles/", CostProfileView.as_view(), name="operational-profiles"),
    path("operational/profiles/<int:pk>/", CostProfileView.as_view(), name="operational-profile"),
    path("f5/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/<uuid:evaluation_code>/preview/",
         F5PreviewView.as_view(), name="planning-f5-preview"),
    path("f5/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/",
         F5EvaluationsView.as_view(), name="planning-f5-evaluations"),
    path("f5/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/<uuid:evaluation_code>/",
         F5HistoryView.as_view(), name="planning-f5-evaluation-detail"),
    path("f4/runs/<uuid:run_code>/groups/<str:group_code>/preview/",
         F4PreviewView.as_view(), name="planning-f4-preview"),
    path("f4/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/<uuid:evaluation_code>/preview/",
         F4PreviewView.as_view(), name="planning-f4-evaluation-preview"),
    path("f4/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/",
         F4EvaluationsView.as_view(), name="planning-f4-evaluations"),
    path("f4/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/<uuid:evaluation_code>/",
         F4HistoryView.as_view(), name="planning-f4-evaluation-detail"),
    path("f4/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/<uuid:evaluation_code>/f5-readiness/",
         F4ReadinessView.as_view(), name="planning-f4-f5-readiness"),
    path("f3/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/",
         F3EvaluationsView.as_view(), name="planning-f3-evaluations"),
    path("f3/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/<uuid:evaluation_code>/",
         F3EvaluationHistoryView.as_view(), name="planning-f3-evaluation-detail"),
    path("f3/runs/<uuid:run_code>/groups/<str:group_code>/evaluations/<uuid:evaluation_code>/f4-readiness/",
         F3ReadinessView.as_view(), name="planning-f3-f4-readiness"),
    path("f3/runs/<uuid:run_code>/groups/<str:group_code>/plans/<str:plan_code>/evaluations/",
         F3EvaluationHistoryView.as_view(), name="planning-f3-plan-history"),
    path(
        "f3/runs/<uuid:run_code>/groups/<str:group_code>/allocations/",
        F3AllocationView.as_view(), name="planning-f3-allocations",
    ),
    path(
        "f3/runs/<uuid:run_code>/groups/<str:group_code>/plans/<str:plan_code>/allocation/",
        F3AllocationView.as_view(), name="planning-f3-plan-allocation",
    ),
    path(
        "f3/runs/<uuid:run_code>/groups/<str:group_code>/plans/<str:plan_code>/acceptance-preview/",
        F3ManagerAcceptanceView.as_view(), name="planning-f3-acceptance-preview",
    ),
    path("f1/scope/", F1ScopeView.as_view(), name="planning-f1-scope"),
    path("f1/rule-sets/", F1RuleSetListView.as_view(), name="planning-f1-rule-sets"),
    path(
        "f1/preview/",
        F1RunPreviewView.as_view(),
        name="planning-f1-preview",
    ),
    path("f1/runs/", F1RunCreateView.as_view(), name="planning-f1-run-create"),
    path("f1/runs/<uuid:run_code>/", F1RunDetailView.as_view(), name="planning-f1-run-detail"),
    path("f2/hubs/", F2HubListView.as_view(), name="planning-f2-hubs"),
    path(
        "f2/runs/<uuid:run_code>/groups/<str:group_code>/options/",
        F2CandidateOptionsView.as_view(),
        name="planning-f2-candidate-options",
    ),
    path(
        "f2/runs/<uuid:run_code>/groups/<str:group_code>/plans/",
        F2CandidatePlansView.as_view(),
        name="planning-f2-candidate-plans",
    ),
    path(
        "f2/runs/<uuid:run_code>/groups/<str:group_code>/plans/<str:plan_code>/",
        F2PlanDetailView.as_view(),
        name="planning-f2-plan-detail",
    ),
]
