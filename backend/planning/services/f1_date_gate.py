"""Validate newly requested F1 runs against the CoLogi business calendar."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone

from demands.models import SupplierConfirmation, SupplierRequest
from planning.f1.adapter import latest_request_by_demand


class F1DateGateError(Exception):
    def __init__(self, diagnostics):
        super().__init__("F1 date preflight failed.")
        self.diagnostics = diagnostics


def requested_delivery_deadline(demand, business_timezone):
    if demand.requested_end_time is None:
        return None
    return datetime.combine(demand.requested_date, demand.requested_end_time, tzinfo=business_timezone)


def validate_f1_dates(demands, requests, *, at):
    business_timezone = ZoneInfo(settings.COLOGI_BUSINESS_TIME_ZONE)
    f1_date = timezone.localdate(at, timezone=business_timezone)
    latest_requests = latest_request_by_demand(requests)
    diagnostics = []

    for demand in demands:
        request = latest_requests.get(demand.pk)
        ready_date = None
        codes = []
        if demand.requested_date < f1_date:
            codes.append("F1_DEMAND_DATE_IN_PAST")
        else:
            deadline = requested_delivery_deadline(demand, business_timezone)
            if deadline is None:
                codes.append("F1_DELIVERY_END_MISSING")
            elif deadline <= at:
                codes.append("F1_DELIVERY_WINDOW_EXPIRED")

        # Waiting/expired attempts remain subject to the existing CP6
        # eligibility gate. A responded attempt must use its own evidence.
        if request and request.request_status == SupplierRequest.RequestStatus.RESPONDED:
            confirmation = request.supplier_confirmation
            if (confirmation is None or request.supplier_id != demand.supplier_id
                    or confirmation.demand_id != demand.pk or confirmation.supplier_id != demand.supplier_id):
                codes.append("F1_SUPPLIER_READY_DATE_MISSING")
            else:
                value = confirmation.ready_date
                if type(value) is date:
                    ready_date = value
                    if ready_date < f1_date:
                        codes.append("F1_SUPPLIER_READY_DATE_IN_PAST")
                    if ready_date > demand.requested_date:
                        codes.append("F1_DATE_SEQUENCE_INVALID")
                elif confirmation.confirmation_status in (
                    SupplierConfirmation.ConfirmationStatus.CONFIRMED,
                    SupplierConfirmation.ConfirmationStatus.PARTIAL,
                ):
                    codes.append("F1_SUPPLIER_READY_DATE_MISSING")

        for code in codes:
            diagnostics.append({
                "code": code,
                "demand_id": demand.pk,
                "supplier_id": demand.supplier_id,
                "supplier_code": demand.supplier.supplier_code,
                "supplier_request_id": request.pk if request is not None else None,
                "f1_date": f1_date.isoformat(),
                "requested_date": demand.requested_date.isoformat(),
                "ready_date": ready_date.isoformat() if ready_date is not None else None,
            })

    if diagnostics:
        raise F1DateGateError(diagnostics)


def preflight_f1_dates(demands, *, at):
    requests = SupplierRequest.objects.filter(
        demand_id__in=[demand.pk for demand in demands],
    ).select_related("supplier_confirmation").only(
        "id", "demand_id", "supplier_id", "attempt_no", "request_status",
        "supplier_confirmation__demand_id", "supplier_confirmation__supplier_id",
        "supplier_confirmation__confirmation_status", "supplier_confirmation__ready_date",
    )
    validate_f1_dates(demands, requests, at=at)
