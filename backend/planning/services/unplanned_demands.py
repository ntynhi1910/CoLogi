"""Close a failed planning cycle and publish scoped, append-only notices."""

from collections import defaultdict
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
from django.utils import timezone
from rest_framework.exceptions import NotFound

from accounts.capstone import actor_scenario
from accounts.models import AuditLog, ExternalActorType, RoleCode
from accounts.permissions import get_active_external_access, get_active_user_outlet_accesses
from demands.models import DeliveryDemand, DemandStatus, SupplierConfirmation, SupplierRequest
from masterdata.models import Hub
from planning.models import (CollaborationGroup, DecisionOutcome, EconomicEvaluation, F3Evaluation, F4Evaluation,
                             FulfillmentPlan, MatchingStatus, PlanDecision, PlanningRunDemand, PlanningRunStatus)
from planning.models_execution import InventoryTransaction, StockReservation
from planning.services.f1_selection import plan_blockers
from planning.services.inventory import ExecutionBlocked, release_ended_commitments, require_execution_enabled
from planning.services.run_results import scoped_f1_runs
from planning.services.run_scope import require_f1_outlet_ids


ACTION = "UNPLANNED_DEMAND_CLOSED"
SUPPLIER_MESSAGE = ("Hủy yêu cầu cung ứng. Hệ thống chưa tìm được phương án vận chuyển khả thi cho nhu cầu này. "
                    "Do đó, yêu cầu cung ứng tương ứng đã được hủy. Nhà cung cấp không cần chuẩn bị hoặc bàn giao hàng hóa. "
                    "Tồn kho thực tế được giữ nguyên và số lượng đã giữ chỗ được giải phóng.")
PURCHASING_MESSAGE = ("Hệ thống chưa tìm được phương án đáp ứng các điều kiện giao hàng. Vui lòng kiểm tra khung giờ nhận "
                      "hoặc phối hợp với Manager để điều chỉnh nhu cầu hoặc lập kế hoạch lại.")
ERRORS = {
    "SUPPLY_CANCELLATION_MIGRATION_REQUIRED": "Chưa kích hoạt trạng thái hủy cam kết CP06 trên database.",
    "UNPLANNED_LIVE_PLAN": "Nhu cầu còn FinalPlan hiệu lực hoặc nghĩa vụ giao nhận. Hãy xử lý ngoại lệ CP12.",
    "UNPLANNED_CUSTODY_EXISTS": "Đã có xuất kho hoặc bàn giao. Hãy xử lý ngoại lệ CP12.",
    "UNPLANNED_SUPPLY_NOT_CURRENT": "Nhu cầu chưa gửi hoặc không có yêu cầu cung ứng hiện hành.",
    "UNPLANNED_REQUEST_CHANGED": "Yêu cầu cung ứng đã thay đổi. Chọn lại nhu cầu trước khi xác nhận.",
    "UNPLANNED_RUN_NOT_FINAL": "Cần kết quả F1 đã hoàn tất cho lần gửi cung ứng hiện hành.",
    "UNPLANNED_RECALCULATION_OPEN": "Nhu cầu đang được tính lại hoặc có lần chạy mới hơn chưa hoàn tất.",
    "UNPLANNED_ALTERNATIVE_NOT_CLOSED": "Còn phương án khả thi hoặc chưa đánh giá đầy đủ các phương án Direct/Hub.",
    "UNPLANNED_RESERVATION_CONTEXT": "Phát hiện giữ chỗ ngoài phạm vi của nhu cầu. Cần đối soát tồn kho.",
}


def _close_enabled():
    return MigrationRecorder(connection).migration_qs.filter(app="demands", name="0006_cp12_cancelled_supply").exists()


def _scoped_demand(actor, demand_id):
    return DeliveryDemand.objects.filter(pk=demand_id, outlet_id__in=require_f1_outlet_ids(actor),
                                         capstone_scenario=actor_scenario(actor))


def current_request(actor, demand_id):
    row = SupplierRequest.objects.filter(demand__in=_scoped_demand(actor, demand_id)).order_by("-attempt_no", "-pk").first()
    if row is None:
        raise NotFound()
    return {"supplier_request_id": row.pk, "request_code": row.request_code, "status": row.request_status}


def _all_options_failed(group_ids):
    required = {None, *Hub.objects.filter(is_active=True).values_list("id", flat=True)}
    options = defaultdict(dict)
    for plan in FulfillmentPlan.objects.filter(group_id__in=group_ids, f2_structure__isnull=False).order_by("-pk"):
        options[plan.group_id].setdefault(plan.hub_id, plan.pk)
    plan_ids = {pk for variants in options.values() for pk in variants.values()}
    if EconomicEvaluation.objects.filter(plan_id__in=plan_ids, sealed=True).exists():
        return False
    f3_by_plan = {}
    for row in F3Evaluation.objects.filter(plan_id__in=plan_ids).order_by("-pk"):
        f3_by_plan.setdefault(row.plan_id, row)
    f4_by_f3 = {}
    for row in F4Evaluation.objects.filter(f3_evaluation_id__in=[row.pk for row in f3_by_plan.values()]).order_by("-pk"):
        f4_by_f3.setdefault(row.f3_evaluation_id, row)
    for group in group_ids:
        if not required.issubset(options[group]):
            return False
        for hub in required:
            f3 = f3_by_plan.get(options[group][hub])
            if f3 and f3.f3_structure["result"]["gate_status"] == "NOT_ELIGIBLE":
                continue
            f4 = f4_by_f3.get(f3.pk) if f3 else None
            if not f4 or f4.f4_structure["result"]["status"] != "HARD_CONFLICT":
                return False
    return True


@transaction.atomic
def close_unplanned(*, actor, demand_id, supplier_request_id, run_code, reason):
    require_execution_enabled()
    scenario = actor_scenario(actor)
    scoped = _scoped_demand(actor, demand_id)
    if not scoped.exists():
        raise NotFound()
    if not _close_enabled():
        raise ExecutionBlocked("SUPPLY_CANCELLATION_MIGRATION_REQUIRED")

    # F2–F5 saves and CP09 acquire the candidate lock before acquiring Demand locks.
    groups = list(CollaborationGroup.objects.select_for_update(of=("self",)).filter(
        group_demands__demand_id=demand_id).order_by("pk"))
    demand = scoped.select_for_update().get(pk=demand_id)
    request = (SupplierRequest.objects.select_for_update().filter(demand=demand).order_by("-attempt_no", "-pk").first())
    if demand.status != DemandStatus.SUBMITTED or not request:
        raise ExecutionBlocked("UNPLANNED_SUPPLY_NOT_CURRENT")
    previous = AuditLog.objects.filter(action=ACTION, entity_type="DEMAND", entity_id=str(demand.id),
                                      new_values__request_id=supplier_request_id, new_values__scenario=scenario).first()
    if previous:
        return {"id": previous.pk, "request_id": supplier_request_id, "created": False}
    if supplier_request_id != request.pk:
        raise ExecutionBlocked("UNPLANNED_REQUEST_CHANGED")
    if request.supplier_id != demand.supplier_id or request.request_status == "CANCELLED":
        raise ExecutionBlocked("UNPLANNED_SUPPLY_NOT_CURRENT")
    if plan_blockers(actor, [demand_id]):
        raise ExecutionBlocked("UNPLANNED_LIVE_PLAN")

    locked_group_ids = {group.pk for group in groups}
    if CollaborationGroup.objects.filter(group_demands__demand_id=demand_id).exclude(pk__in=locked_group_ids).exists():
        raise ExecutionBlocked("UNPLANNED_RECALCULATION_OPEN")
    confirmation = SupplierConfirmation.objects.select_for_update().get(pk=request.supplier_confirmation_id)
    cycle_start = confirmation.recorded_at or request.sent_at
    attempts = PlanningRunDemand.objects.filter(demand_id=demand_id, planning_run__started_at__gte=cycle_start)
    if scenario:
        attempts = attempts.filter(planning_run__scenario_tag=scenario)
    else:
        attempts = attempts.filter(planning_run__scenario_tag__isnull=True)
    if attempts.filter(planning_run__status=PlanningRunStatus.IN_PROGRESS).exists():
        raise ExecutionBlocked("UNPLANNED_RECALCULATION_OPEN")
    latest = attempts.select_related("planning_run").order_by("-planning_run__started_at", "-planning_run_id").first()
    expired = demand.requested_date < timezone.localdate(timezone=ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE))
    if not expired and (not latest or latest.planning_run.run_code != run_code
                       or latest.planning_run.status != PlanningRunStatus.COMPLETED
                       or not scoped_f1_runs(actor).filter(pk=latest.planning_run_id).exists()
                       or latest.matching_status == MatchingStatus.NOT_EVALUATED):
        raise ExecutionBlocked("UNPLANNED_RUN_NOT_FINAL")

    group_ids = [group.pk for group in groups if attempts.filter(planning_run__run_code=group.run_code).exists()]
    if not expired:
        if PlanDecision.objects.filter(group_id__in=group_ids, outcome=DecisionOutcome.REQUEST_RECALCULATION,
                                       recorded_at__gte=latest.planning_run.started_at).exists():
            raise ExecutionBlocked("UNPLANNED_RECALCULATION_OPEN")
        if (latest.matching_status in (MatchingStatus.INCLUDED, MatchingStatus.MULTIPLE_CANDIDATES) and not group_ids
                or not _all_options_failed(group_ids)):
            raise ExecutionBlocked("UNPLANNED_ALTERNATIVE_NOT_CLOSED")

    reservations = StockReservation.objects.filter(promise__supplier_request__demand=demand, balance__scenario=scenario)
    if InventoryTransaction.objects.filter(reservation__in=reservations, kind="PICKUP").exists():
        raise ExecutionBlocked("UNPLANNED_CUSTODY_EXISTS")
    if (reservations.filter(remaining_kg__gt=0).exclude(promise__supplier_request=request).exists()
            or reservations.filter(remaining_kg__gt=0).exists()
            and confirmation.confirmation_status not in ("CONFIRMED", "PARTIAL")):
        # Unexpected live reservations on older attempts require deliberate reconciliation.
        raise ExecutionBlocked("UNPLANNED_RESERVATION_CONTEXT")
    if StockReservation.objects.filter(promise__supplier_request=request, remaining_kg__gt=0).exclude(
        balance__scenario=scenario, balance__supplier_item__supplier_id=request.supplier_id,
    ).exclude(balance__scenario__startswith="cp11-sim:").exists():
        raise ExecutionBlocked("UNPLANNED_RESERVATION_CONTEXT")

    old_status = request.request_status
    if confirmation.confirmation_status in ("CONFIRMED", "PARTIAL") and not confirmation.commitment_released_at:
        confirmation.commitment_released_at = timezone.now()
        confirmation.commitment_released_by = actor
        confirmation.commitment_release_note = reason
        confirmation.save(update_fields=["commitment_released_at", "commitment_released_by", "commitment_release_note", "updated_at"])
    request.request_status = SupplierRequest.RequestStatus.CANCELLED
    request.clean()
    request.save(update_fields=["request_status", "updated_at"])
    release_ended_commitments(demand=demand, actor=actor, request=request, scenario=scenario,
                              reason="Hủy cam kết cung ứng sau khi kết thúc lập kế hoạch.")
    notice = AuditLog.objects.create(actor_user=actor, action=ACTION, entity_type="DEMAND", entity_id=str(demand.id),
        old_values={"request_status": old_status}, new_values={
            "request_id": request.pk, "supplier_id": request.supplier_id, "outlet_id": demand.outlet_id,
            "supplier": demand.supplier.supplier_code, "outlet": demand.outlet.outlet_code, "demand_code": demand.demand_code,
            "scenario": scenario, "source_mode": confirmation.source_mode,
            "requested_date": demand.requested_date.isoformat(), "reason": reason,
            "reason_code": "DEMAND_EXPIRED_UNPLANNED" if expired else "NO_FEASIBLE_PLAN",
            "run_code": str(run_code) if latest and latest.planning_run.run_code == run_code else None,
            "items": [{"sku": line.demand_item.item.item_code,
                "kg": str(line.promised_weight_kg)} for line in request.item_promises.select_related("demand_item__item")],
        })
    return {"id": notice.pk, "request_id": request.pk, "created": True}


def read_notices(*, actor, audience):
    from planning.services.plan_publication import demand_logistics

    scenario = actor_scenario(actor)
    demands = DeliveryDemand.objects.filter(capstone_scenario=scenario)
    rows = AuditLog.objects.filter(action=ACTION, entity_type="DEMAND", new_values__scenario=scenario)
    if audience == "supplier":
        access = get_active_external_access(actor, ExternalActorType.SUPPLIER)
        if access is None:
            raise NotFound()
        rows = rows.filter(new_values__supplier_id=access.supplier_id)
    else:
        role = RoleCode.MANAGER if audience == "manager" else RoleCode.PURCHASING_STAFF
        outlets = list(get_active_user_outlet_accesses(actor, role_codes=(role,)).values_list("outlet_id", flat=True))
        rows = rows.filter(new_values__outlet_id__in=outlets)
        demands = demands.filter(outlet_id__in=outlets)
        if audience == "purchasing":
            demands = demands.filter(created_by=actor)
    found = list(rows.order_by("-pk"))
    ids = set(demands.filter(pk__in=[int(row.entity_id) for row in found]).values_list("pk", flat=True))
    logistics = demand_logistics(ids, scenario, ())
    payload = []
    for row in found:
        pk = int(row.entity_id)
        if pk not in ids:
            continue
        snapshot = row.new_values
        status = logistics[pk]["logistics_status"]
        payload.append({"id": row.pk, "demand_id": pk, "at": row.created_at,
            "state": "RESOLVED" if status in ("APPROVED", "AWAITING_TRANSPORT", "CONFIRMED") else "OPEN",
            "title": "Hủy yêu cầu cung ứng" if audience == "supplier" else "Nhu cầu chưa có phương án vận chuyển khả thi",
            "message": SUPPLIER_MESSAGE if audience == "supplier" else PURCHASING_MESSAGE,
            "link": f"/supplier/requests/{snapshot['request_id']}" if audience == "supplier" else f"/demands/{pk}",
            **{key: snapshot[key] for key in ("demand_code", "supplier", "outlet", "requested_date", "items", "reason_code")}})
    return payload
