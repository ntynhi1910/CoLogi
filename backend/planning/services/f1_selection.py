"""Eligibility for the live F1 picker and submitted IDs."""

from accounts.capstone import actor_scenario
from demands.models import DemandStatus, SupplierRequest
from planning.f1.adapter import build_confirmation_result, latest_request_by_demand
from planning.f1.supplier_confirmation import ConfirmationGateStatus
from planning.models import FinalPlanDemand, FulfillmentPlan, FulfillmentPlanStatus
from planning.models_execution import ExecutionEvent
from planning.services.f1_date_gate import F1DateGateError, validate_f1_dates


MESSAGES = {
    "F1_EFFECTIVE_FINAL_PLAN": "Nhu cầu đã có kế hoạch cuối cùng còn hiệu lực.",
    "F1_EXECUTION_OBLIGATION": "Nhu cầu còn nghĩa vụ giao nhận. Hãy xử lý trong CP12.",
    "F1_DEMAND_NOT_SUBMITTED": "Nhu cầu chưa gửi hoặc không còn ở trạng thái lập kế hoạch.",
    "F1_COMMITMENT_NOT_ACTIVE": "Cần một cam kết cung ứng hiện hành xác nhận đủ từng SKU.",
    "F1_DEMAND_DATE_IN_PAST": "Ngày giao yêu cầu đã qua.",
    "F1_DELIVERY_WINDOW_EXPIRED": "Khung giờ giao yêu cầu đã kết thúc.",
    "F1_DELIVERY_END_MISSING": "Thiếu giờ kết thúc giao yêu cầu.",
    "F1_SUPPLIER_READY_DATE_IN_PAST": "Ngày sẵn sàng lấy hàng đã qua.",
    "F1_DATE_SEQUENCE_INVALID": "Ngày sẵn sàng muộn hơn ngày giao yêu cầu.",
    "F1_SUPPLIER_READY_DATE_MISSING": "Thiếu ngày sẵn sàng lấy hàng hợp lệ.",
    "OPERATIONAL_SOURCE_REQUIRED": "Dữ liệu mô phỏng lịch sử chỉ dùng để tra cứu.",
}


class F1SelectionError(Exception):
    def __init__(self, diagnostics):
        super().__init__("Nhu cầu không đủ điều kiện đưa vào lần chạy F1.")
        self.diagnostics = diagnostics


def plan_blockers(actor, ids):
    # Inspect history for physical custody even if the active claim moved to a successor.
    provenance = "SYNTHETIC/CP11_CAPSTONE" if actor_scenario(actor) else "OPERATIONAL"
    events = ExecutionEvent.objects.filter(demand_id__in=ids, provenance=provenance)
    obligations = set(events.filter(action__in=("SUPPLIER_HANDOVER", "CARRIER_PICKUP", "PICKUP_COMPLETE",
        "HUB_RECEIVE", "HUB_DISPATCH", "DELIVER", "RECEIVE")).values_list("demand_id", flat=True))
    cancellations = set(events.filter(action="CANCELLED").values_list("plan_id", "demand_id"))
    claims = FinalPlanDemand.objects.filter(demand_id__in=ids).select_related("plan__successor", "plan__handover__reply")
    from planning.services.plan_publication import publication_state

    active = {claim.demand_id for claim in claims if (claim.plan_id, claim.demand_id) not in cancellations
              and publication_state(claim.plan) in ("APPROVED", "AWAITING_TRANSPORT", "CONFIRMED")}
    active.update(FulfillmentPlan.objects.filter(status=FulfillmentPlanStatus.FINALIZED,
        waves__allocations__demand_id__in=ids).values_list("waves__allocations__demand_id", flat=True))
    return {pk: "F1_EFFECTIVE_FINAL_PLAN" for pk in active} | {pk: "F1_EXECUTION_OBLIGATION" for pk in obligations}


def selection_diagnostics(actor, demands, *, at):
    ids = [item.pk for item in demands]
    requests = list(SupplierRequest.objects.filter(demand_id__in=ids).select_related("supplier_confirmation")
        .prefetch_related("item_promises__demand_item", "item_promises__supplier_item"))
    latest = latest_request_by_demand(requests)
    try:
        validate_f1_dates(demands, requests, at=at)
        diagnostics = []
    except F1DateGateError as exc:
        diagnostics = list(exc.diagnostics)
    blocks = plan_blockers(actor, ids)
    for demand in demands:
        code = blocks.get(demand.pk)
        request = latest.get(demand.pk)
        if not code and demand.status != DemandStatus.SUBMITTED:
            code = "F1_DEMAND_NOT_SUBMITTED"
        if not code and (not request or request.supplier_confirmation.commitment_released_at
                         or build_confirmation_result(demand, request).status != ConfirmationGateStatus.ELIGIBLE):
            code = "F1_COMMITMENT_NOT_ACTIVE"
        if code:
            diagnostics.append({"demand_id": demand.pk, "code": code})
    return [{**row, "message": MESSAGES[row["code"]]} for row in diagnostics]


def require_eligible(actor, demands, *, at):
    diagnostics = selection_diagnostics(actor, demands, at=at)
    if diagnostics:
        raise F1SelectionError(diagnostics)
