"""Role-scoped CP12 API and exports."""

import csv
from io import BytesIO, StringIO

from django.db import connection, transaction
from django.http import HttpResponse
from django.utils import timezone
from openpyxl import Workbook
from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.capstone import actor_scenario
from accounts.models import RoleCode
from accounts.permissions import HasCoLogiRole
from planning.delivery_views import _call
from planning.serializers import StrictInputMixin
from planning.services import reconciliation as service
from planning.services.final_delivery import begin_snapshot
from planning.services.inventory import require_execution_enabled
from planning.services.reconciliation_metrics import kpis


STATUSES = ("AWAITING_EXECUTION", "IN_PROGRESS", "PENDING_RECONCILIATION", "EXCEPTION", "RECONCILED", "COMPLETED")
ROLES = {"manager": RoleCode.MANAGER, "provider": RoleCode.TRANSPORT_PROVIDER,
         "supplier": RoleCode.SUPPLIER, "purchasing": RoleCode.PURCHASING_STAFF}


class Filters(StrictInputMixin, serializers.Serializer):
    mode = serializers.ChoiceField(choices=service.Mode.values, required=False)
    from_date = serializers.DateField(required=False)
    to_date = serializers.DateField(required=False)
    plan = serializers.UUIDField(required=False)
    template = serializers.ChoiceField(choices=("DIRECT", "HUB"), required=False)
    supplier = serializers.IntegerField(min_value=1, required=False)
    outlet = serializers.IntegerField(min_value=1, required=False)
    status = serializers.ChoiceField(choices=STATUSES, required=False)
    export = serializers.ChoiceField(choices=("csv", "xlsx"), required=False)

    def validate(self, attrs):
        if attrs.get("from_date") and attrs.get("to_date") and attrs["from_date"] > attrs["to_date"]:
            raise ValidationError({"to_date": "Ngày kết thúc phải từ ngày bắt đầu trở đi."})
        return attrs


def quantity(places=3, *, required=False):
    return serializers.DecimalField(max_digits=14, decimal_places=places, min_value=0, required=required,
                                    coerce_to_string=True)


class Cost(StrictInputMixin, serializers.Serializer):
    transport = quantity(2, required=True)
    hub = quantity(2, required=True)
    additional = quantity(2, required=True)
    reference = serializers.CharField(max_length=240)
    distances = serializers.DictField(child=quantity(), required=False, default=dict)


class Target(StrictInputMixin, serializers.Serializer):
    target = serializers.CharField(max_length=140)


class IssueRequest(Target):
    issue_fingerprint = serializers.RegexField(r"^[0-9a-f]{64}$")
    audience = serializers.ChoiceField(choices=("supplier", "provider", "purchasing"))


class IssueEvidence(Target):
    reference = serializers.CharField(max_length=240)


class IssueReport(IssueEvidence):
    target = None
    demand_id = serializers.IntegerField(min_value=1)
    issue_type = serializers.ChoiceField(choices=service.ISSUE_TYPES)
    sku_code = serializers.CharField(max_length=40, required=False)
    reported_kg = quantity()


class IssueResolve(Target):
    issue_fingerprint = serializers.RegexField(r"^[0-9a-f]{64}$")
    reference = serializers.CharField(max_length=240)
    disposition = serializers.ChoiceField(choices=service.DISPOSITIONS)
    quantity_kg = quantity()
    supplemental_plan = serializers.UUIDField(required=False)
    supplemental_demand = serializers.IntegerField(min_value=1, required=False)


class Closure(StrictInputMixin, serializers.Serializer):
    seal = serializers.RegexField(r"^[0-9a-f]{64}$")


class Mutation(StrictInputMixin, serializers.Serializer):
    action = serializers.ChoiceField(choices=service.Action.values)
    request_id = serializers.UUIDField()
    reason = serializers.CharField(max_length=500)
    data = serializers.DictField()

    def validate(self, attrs):
        action = attrs["action"]
        body_type = {service.Action.COST_SUBMIT: Cost, service.Action.COST_RETURN: Target,
                     service.Action.COST_APPROVE: Target, service.Action.ISSUE_REQUEST: IssueRequest,
                     service.Action.ISSUE_EVIDENCE: IssueEvidence, service.Action.ISSUE_REPORT: IssueReport,
                     service.Action.ISSUE_RESOLVE: IssueResolve,
                     service.Action.CLOSE: Closure}[action]
        body = body_type(data=attrs["data"])
        body.is_valid(raise_exception=True)
        attrs["data"] = body.data
        return attrs


def _safe(value):
    return "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "@", "+", "-", "\t", "\r")) else value


def export_report(plans, mode, filters, kind):
    date_range = [filters.get(key) for key in ("from_date", "to_date")]
    rows = [["Chế độ", mode, "Xuất lúc", timezone.now().isoformat()],
            ["Ngày kế hoạch từ", str(date_range[0] or ""), "Đến", str(date_range[1] or "")],
            ["FinalPlan", "Phiên bản", "Ngày vận chuyển", "Nguồn kế hoạch", "Nguồn giao nhận", "Trạng thái",
             "Demand", "Supplier", "Outlet", "SKU", "Kế hoạch kg", "Xuất kg", "Vận chuyển nhận kg",
             "Qua Hub kg", "Đến Outlet kg", "Chấp nhận kg", "Thiếu kg", "Hỏng kg", "Từ chối kg", "Trả kg", "Chưa đối soát kg"]]
    for plan in plans:
        for line in plan["lines"]:
            rows.append([plan["code"], plan["version"], plan["date"], plan["source"]["classification"],
                         plan["execution_provenance"], plan["status"], line["demand_code"], line["supplier"]["code"],
                         line["outlet"]["code"], line["code"], *[line[key + "_kg"] for key in (
                             "planned", "shipped", "carrier_pickup", "hub_received", "delivered", "received", "shortage",
                             "damaged", "refused", "returned", "unreconciled")]])
    rows.append([])
    rows.append(["FinalPlan", "Baseline VND", "Kế hoạch VND", "Thực tế VND", "Tiết kiệm dự kiến VND", "Tiết kiệm thực tế VND"])
    for plan in plans:
        if cost := plan["cost"]:
            rows.append([plan["code"], *[cost[key + "_vnd"] for key in (
                "baseline", "planned", "actual", "planned_saving", "actual_saving")]])
    if kind == "xlsx":
        book = Workbook(write_only=True)
        sheet = book.create_sheet("Đối soát")
        for row in rows:
            sheet.append([_safe(cell) for cell in row])
        buffer = BytesIO()
        book.save(buffer)
        response = HttpResponse(buffer.getvalue(), content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    else:
        buffer = StringIO()
        csv.writer(buffer).writerows([_safe(cell) for cell in row] for row in rows)
        response = HttpResponse("\ufeff" + buffer.getvalue(), content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="cologi-logistics.{kind}"'
    return response


class ReconciliationView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    audience = None

    @property
    def required_roles(self):
        return (ROLES[self.audience],)

    def options_for(self, request):
        data = Filters(data=request.query_params)
        data.is_valid(raise_exception=True)
        filters = dict(data.validated_data)
        mode = filters.pop("mode", service.Mode.CAPSTONE if actor_scenario(request.user) else service.Mode.COMMERCIAL)
        service.execution_mode(request.user, mode)
        return mode, filters

    @transaction.atomic
    def get(self, request, code=None):
        require_execution_enabled()
        if len(connection.atomic_blocks) == 1:
            begin_snapshot()
        service.ensure_storage()
        mode, filters = self.options_for(request)
        kind = filters.pop("export", None)
        if code:
            _, row = _call(service.detail, actor=request.user, audience=self.audience, code=code, mode=mode,
                           supplier=filters.get("supplier"), outlet=filters.get("outlet"))
            return export_report([row], mode, filters, kind) if kind else Response(row)
        plans, metrics = _call(service.overview, actor=request.user, audience=self.audience, mode=mode, filters=filters)
        if kind:
            return export_report(plans, mode, filters, kind)
        current = [plan for plan in plans if plan["current"]]
        facets = {key: sorted({row[key]["id"]: row[key] for plan in plans for row in plan["demands"]}.values(),
                              key=lambda entity: entity["code"] or "")
                  for key in ("supplier", "outlet")}
        breakdown = {}
        for key, entities in facets.items():
            breakdown[key] = []
            for entity in entities:
                subset = [{**plan, "cost": None, "waves": [],
                           "demands": [row for row in plan["demands"] if row[key]["id"] == entity["id"]],
                           "issues": [issue for issue in plan["issues"] if any(
                               row["id"] == issue["demand_id"] and row[key]["id"] == entity["id"] for row in plan["demands"]
                           )],
                           "lines": [row for row in plan["lines"] if row[key]["id"] == entity["id"]]} for plan in current]
                breakdown[key].append({"entity": entity, **kpis([plan for plan in subset if plan["demands"]])})
        breakdown["provider"] = [{"entity": provider, **kpis([plan for plan in current if plan["provider"] == provider])}
                                 for provider in {plan["provider"]["id"]: plan["provider"] for plan in current}.values()]
        summaries = [{key: plan[key] for key in (
            "code", "version", "date", "mode", "source", "template", "status", "current", "provider", "hub", "cost")}
            | {"demands": len(plan["demands"]), "planned_kg": sum(row["planned_kg"] for row in plan["demands"]),
               "received_kg": kpis([plan])["received_kg"]}
            for plan in plans]
        return Response({"mode": mode, "plans": summaries, "kpis": metrics, "generated_at": timezone.now(),
                         "pending": {"plans": sum(plan["status"] in ("PENDING_RECONCILIATION", "EXCEPTION") for plan in current),
                                     "costs": sum(bool(plan["cost"] and plan["cost"]["status"] == "SUBMITTED") for plan in current),
                                     "issues": sum(issue["status"] != "RESOLVED" for plan in current for issue in plan["issues"])},
                         "facets": facets, "breakdown": breakdown,
                         "trends": [{"date": day, **kpis([plan for plan in current if plan["date"] == day])}
                                    for day in sorted({plan["date"] for plan in current})],
                         "templates": {key: kpis([plan for plan in current if plan["template"] == key])
                                       for key in ("DIRECT", "HUB")}})

    def post(self, request, code=None):
        require_execution_enabled()
        service.ensure_storage()
        if not code:
            raise NotFound()
        mode, _ = self.options_for(request)
        data = Mutation(data=request.data)
        data.is_valid(raise_exception=True)
        row, created = _call(service.write, retry=True, actor=request.user, audience=self.audience, code=code,
                             mode=mode, **data.validated_data)
        return Response(row, status=201 if created else 200)


class ReconciliationAvailabilityView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            require_execution_enabled()
            service.ensure_storage()
        except NotFound:
            return Response({"enabled": False})
        return Response({"enabled": True})
