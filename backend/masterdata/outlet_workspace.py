"""Outlet administration over existing scoped grants and receiving tables."""

from uuid import uuid4
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from rest_framework.exceptions import APIException, NotFound, PermissionDenied, ValidationError

from accounts.capstone import actor_scenario
from accounts.models import AuditLog, RoleCode, User, UserOutletAccess
from demands.models import DeliveryDemand, DemandStatus
from masterdata.models import Outlet
from planning.models import FinalPlanDemand, FulfillmentPlanStatus, ReceivingSlot, ReceivingSource, ReceivingWindow, WaveDemand

OUTLET_FIELDS = ("outlet_name", "address", "contact_name", "phone")
CALENDAR_SOURCE = "PURCHASING_OUTLET_WORKSPACE"


class OutletConflict(APIException):
    status_code = 409
    default_code = "outlet_in_use"


def today():
    return timezone.localdate(timezone=ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE))


def writes_enabled():
    return getattr(settings, "COLOGI_OUTLET_WORKSPACE_WRITES", False)


def _grants(role):
    return UserOutletAccess.objects.filter(
        is_active=True, user__is_active=True, user__capstone_scenario="",
        user__user_roles__is_active=True, user__user_roles__role__is_active=True,
        user__user_roles__role__code=role,
    )


def scoped_outlets(actor):
    if actor_scenario(actor) or actor.capstone_scenario:
        raise PermissionDenied("Không truy cập dữ liệu điểm nhận vận hành từ phiên Capstone.")
    return Outlet.objects.filter(pk__in=_grants(RoleCode.PURCHASING_STAFF).filter(user=actor).values("outlet_id"))


def _outlet(actor, outlet_id, *, locked=False):
    results = scoped_outlets(actor)
    if locked:
        results = results.select_for_update()
    outlet = results.filter(pk=outlet_id).first()
    if outlet is None:
        raise NotFound("Không tìm thấy điểm giao nhận trong phạm vi được cấp.")
    return outlet


def _manager(actor, outlet=None):
    staff = _grants(RoleCode.PURCHASING_STAFF)
    if outlet is None:
        grants = list(staff.filter(user=actor, outlet__is_active=True).values_list("outlet_id", "assigned_by_id"))
    else:
        all_grants = staff.filter(outlet=outlet)
        if not all_grants.filter(user=actor).exists():
            return None
        grants = list(all_grants.values_list("outlet_id", "assigned_by_id"))
    manager_ids = {assigner for _, assigner in grants}
    if len(manager_ids) != 1 or None in manager_ids:
        return None
    manager_id, = manager_ids
    required = {pk for pk, _ in grants}
    authorized = set(_grants(RoleCode.MANAGER).filter(
        user_id=manager_id, outlet_id__in=required,
    ).values_list("outlet_id", flat=True))
    return manager_id if authorized == required else None


def _authorize_write(actor, outlet=None):
    if not writes_enabled():
        raise PermissionDenied("Chức năng ghi điểm giao nhận chưa được phê duyệt triển khai.")
    scoped_outlets(actor)
    User.objects.select_for_update().get(pk=actor.pk)
    manager_id = _manager(actor, outlet)
    if manager_id is None:
        raise PermissionDenied("Chưa xác định được một Manager phụ trách hợp lệ cho phạm vi này.")
    return manager_id


def _present(outlet):
    return {"id": outlet.pk, "outlet_code": outlet.outlet_code, "is_active": outlet.is_active,
            **{field: getattr(outlet, field) for field in OUTLET_FIELDS}}


def list_outlets(actor):
    rows = list(scoped_outlets(actor))
    active = sum(row.is_active for row in rows)
    return {
        "outlets": [_present(row) for row in rows],
        "summary": {"total": len(rows), "active": active, "inactive": len(rows) - active},
        "writes_enabled": writes_enabled(), "can_create": writes_enabled() and _manager(actor) is not None,
    }


def _calendar_row(row, fields):
    return {"id": row.pk, "source": row.source, "source_reference": row.source_reference,
            **{name: value.isoformat() if hasattr(value, "isoformat") else value
               for name in fields for value in [getattr(row, name)]}}


def _stop_blockers(outlet):
    return {
        "open_demands": DeliveryDemand.objects.filter(outlet=outlet).exclude(status=DemandStatus.CANCELLED).count(),
        "active_final_plans": FinalPlanDemand.objects.filter(demand__outlet=outlet).values("plan_id").distinct().count(),
        "reserved_plans": WaveDemand.objects.filter(
            demand__outlet=outlet,
            wave__plan__status__in=(FulfillmentPlanStatus.VALIDATING, FulfillmentPlanStatus.PENDING_APPROVAL,
                                  FulfillmentPlanStatus.APPROVED, FulfillmentPlanStatus.FINALIZED),
        ).values("wave__plan_id").distinct().count(),
    }


WINDOW_FIELDS = ("day_of_week", "start_time", "end_time", "is_active")
SLOT_FIELDS = ("slot_date", "start_time", "end_time", "slot_type", "status", "reason")
CALENDAR = {"windows": (ReceivingWindow, WINDOW_FIELDS), "slots": (ReceivingSlot, SLOT_FIELDS)}


def outlet_detail(actor, outlet_id, day):
    from masterdata.outlet_readiness import planning_readiness
    outlet = _outlet(actor, outlet_id)
    history = AuditLog.objects.filter(entity_type="OUTLET_WORKSPACE", entity_id=str(outlet.pk)).select_related("actor_user")[:100]
    windows = ReceivingWindow.objects.filter(outlet=outlet, source_mode=ReceivingSource.OPERATIONAL)
    slots = ReceivingSlot.objects.filter(outlet=outlet, source_mode=ReceivingSource.OPERATIONAL, slot_date=day)
    return {
        **_present(outlet), "can_edit": writes_enabled() and _manager(actor, outlet) is not None,
        "windows": [_calendar_row(row, WINDOW_FIELDS) for row in windows.order_by("day_of_week", "start_time", "pk")],
        "slots": [_calendar_row(row, SLOT_FIELDS) for row in slots.order_by("start_time", "pk")],
        "planning": planning_readiness(outlet, day),
        "deactivation_blockers": _stop_blockers(outlet) if outlet.is_active else {},
        "history": [{"action": row.action, "at": row.created_at, "before": row.old_values, "after": row.new_values,
                     "actor": row.actor_user.full_name if row.actor_user else None} for row in history],
    }


def _audit(actor, outlet, action, before=None, after=None):
    AuditLog.objects.create(actor_user=actor, entity_type="OUTLET_WORKSPACE", entity_id=str(outlet.pk),
                            action=action, old_values=before, new_values=after)


def _new_code():
    return "OUT-" + uuid4().hex[:20].upper()


@transaction.atomic
def create_outlet(actor, fields):
    manager_id = _authorize_write(actor)
    for _ in range(4):
        code = _new_code()
        try:
            with transaction.atomic():
                outlet = Outlet.objects.create(outlet_code=code, **fields)
            break
        except IntegrityError:
            if not Outlet.objects.filter(outlet_code=code).exists():
                raise
    else:
        raise OutletConflict("Không cấp được mã điểm nhận duy nhất. Vui lòng thử lại.")
    UserOutletAccess.objects.create(user=actor, outlet=outlet, assigned_by_id=manager_id)
    UserOutletAccess.objects.create(user_id=manager_id, outlet=outlet)
    data = _present(outlet)
    _audit(actor, outlet, "OUTLET_CREATED", after={**data, "staff_id": actor.pk, "manager_id": manager_id})
    return data


@transaction.atomic
def update_outlet(actor, outlet_id, fields):
    outlet = _outlet(actor, outlet_id)
    _authorize_write(actor, outlet)
    outlet = _outlet(actor, outlet_id, locked=True)
    before = _present(outlet)
    fields = {key: value for key, value in fields.items() if getattr(outlet, key) != value}
    if fields:
        for key, value in fields.items():
            setattr(outlet, key, value)
        outlet.save(update_fields=(*fields.keys(), "updated_at"))
        _audit(actor, outlet, "OUTLET_UPDATED", before, _present(outlet))
    return _present(outlet)


def lock_demand_scope(outlet_id):
    """Serialize CP04 draft creation with deactivation when this workspace is enabled."""
    if writes_enabled() and connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(%s)", [-(410000000000 + outlet_id)])


@transaction.atomic
def set_active(actor, outlet_id, is_active, reason):
    outlet = _outlet(actor, outlet_id)
    _authorize_write(actor, outlet)
    lock_demand_scope(outlet_id)
    outlet = _outlet(actor, outlet_id, locked=True)
    if outlet.is_active == is_active:
        return _present(outlet)
    if not is_active:
        blockers = _stop_blockers(outlet)
        if any(blockers.values()):
            raise OutletConflict({"detail": "Điểm nhận còn nhu cầu hoặc kế hoạch đang xử lý.", "blockers": blockers})
    before = _present(outlet)
    outlet.is_active = is_active
    outlet.save(update_fields=("is_active", "updated_at"))
    data = _present(outlet)
    _audit(actor, outlet, "OUTLET_ACTIVATED" if is_active else "OUTLET_DEACTIVATED", before, {**data, "reason": reason})
    return data


@transaction.atomic
def save_calendar(actor, outlet_id, kind, fields, row_id=None):
    outlet = _outlet(actor, outlet_id)
    _authorize_write(actor, outlet)
    model, output_fields = CALENDAR[kind]
    rows = model.objects.filter(outlet=outlet, source_mode=ReceivingSource.OPERATIONAL)
    row = rows.select_for_update().filter(pk=row_id, source=CALENDAR_SOURCE).first() if row_id is not None else None
    if row_id is not None and row is None:
        raise NotFound("Mục lịch này không chỉnh sửa được trong workspace.")
    outlet = _outlet(actor, outlet_id, locked=True)
    if not outlet.is_active:
        raise OutletConflict("Kích hoạt lại điểm nhận trước khi cập nhật lịch.")
    start, end = fields["start_time"], fields["end_time"]
    if start >= end:
        raise ValidationError({"end_time": ["Giờ kết thúc phải sau giờ bắt đầu."]})
    if kind == "windows":
        same_day = rows.filter(day_of_week=fields["day_of_week"])
        occupied = same_day.filter(is_active=True)
        will_occupy = fields["is_active"]
    else:
        if fields["slot_date"] < today() or (row and row.slot_date < today()):
            raise ValidationError({"slot_date": ["Chỉ sửa lịch cho ngày hiện tại hoặc tương lai."]})
        if row and row.status not in (ReceivingSlot.Status.OPEN, ReceivingSlot.Status.CANCELLED):
            raise OutletConflict("Mục lịch đã được đặt hoặc xác nhận.")
        same_day = rows.filter(slot_date=fields["slot_date"], slot_type=fields["slot_type"])
        occupied = same_day.exclude(status__in=(ReceivingSlot.Status.CANCELLED, ReceivingSlot.Status.REJECTED))
        will_occupy = fields["status"] == ReceivingSlot.Status.OPEN
    exclude = {"pk": row_id}
    if same_day.exclude(**exclude).filter(start_time=start, end_time=end).exists():
        raise OutletConflict("Đã có mục lịch cùng mốc giờ tại điểm nhận.")
    if will_occupy and occupied.exclude(**exclude).filter(start_time__lt=end, end_time__gt=start).exists():
        raise OutletConflict("Mục lịch chồng giờ với lịch hiện có.")
    before = _calendar_row(row, output_fields) if row else None
    if row is None:
        row = model.objects.create(outlet=outlet, source=CALENDAR_SOURCE, source_mode=ReceivingSource.OPERATIONAL,
                                   source_reference=f"{outlet.outlet_code}/{uuid4().hex}", **fields)
    else:
        for field, value in fields.items():
            setattr(row, field, value)
        row.save(update_fields=tuple(fields))
    result = _calendar_row(row, output_fields)
    if before != result:
        action = "OUTLET_RECEIVING_WINDOW" if kind == "windows" else "OUTLET_RECEIVING_SLOT"
        _audit(actor, outlet, action, before, result)
    return result
