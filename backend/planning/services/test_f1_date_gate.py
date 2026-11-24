from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from accounts.models import UserRole
from accounts.permissions import HasCoLogiRole
from planning.f1.adapter import build_confirmation_result
from planning.models import PlanningRun
from planning.services import f1_date_gate, run_execution, run_orchestration
from planning.views import F1RunCreateView, F1RunPreviewView


MIDNIGHT = datetime(2026, 11, 24, 17, tzinfo=timezone.utc)
SERVICE_DAY = date(2026, 11, 25)


def demand(number=1, day=SERVICE_DAY, *, supplier=8, end=time(23, 59, 59, 999999)):
    return SimpleNamespace(
        pk=number, requested_date=day, requested_end_time=end, supplier_id=supplier,
        supplier=SimpleNamespace(supplier_code=f"SUP{supplier:03}"),
    )


def attempt(number=1, *, day=SERVICE_DAY, status="RESPONDED", supplier=8,
            confirmation_status="CONFIRMED", confirmation_supplier=8, demand_id=1):
    return SimpleNamespace(
        pk=number, demand_id=demand_id, attempt_no=number,
        supplier_id=supplier, request_status=status,
        supplier_confirmation=SimpleNamespace(
            ready_date=day, confirmation_status=confirmation_status,
            demand_id=demand_id, supplier_id=confirmation_supplier,
        ),
    )


@override_settings(TIME_ZONE="UTC", COLOGI_BUSINESS_TIME_ZONE="Asia/Ho_Chi_Minh")
class F1DateGateTests(SimpleTestCase):
    def test_past_current_and_future_at_vietnam_midnight(self):
        yesterday = SERVICE_DAY - timedelta(days=1)
        tomorrow = SERVICE_DAY + timedelta(days=1)
        f1_date_gate.validate_f1_dates(
            [demand(day=yesterday)], [attempt(day=yesterday)], at=MIDNIGHT - timedelta(seconds=1),
        )
        for day in (SERVICE_DAY, tomorrow):
            with self.subTest(day=day):
                f1_date_gate.validate_f1_dates([demand(day=day)], [attempt(day=day)], at=MIDNIGHT)
        with self.assertRaises(f1_date_gate.F1DateGateError) as error:
            f1_date_gate.validate_f1_dates([demand(day=yesterday)], [attempt(day=yesterday)], at=MIDNIGHT)
        self.assertEqual(error.exception.diagnostics, [
            {"code": code, "demand_id": 1, "supplier_id": 8, "supplier_code": "SUP008",
             "supplier_request_id": 1, "f1_date": "2026-11-25",
             "requested_date": "2026-11-24", "ready_date": "2026-11-24"}
            for code in ("F1_DEMAND_DATE_IN_PAST", "F1_SUPPLIER_READY_DATE_IN_PAST")
        ])

    def test_checks_dates_of_every_demand_in_batch(self):
        demands = [demand(), demand(2), demand(3)]
        requests = [
            attempt(), attempt(day=SERVICE_DAY + timedelta(days=1), demand_id=2),
            attempt(day=None, confirmation_status="PARTIAL", demand_id=3),
        ]
        with self.assertRaises(f1_date_gate.F1DateGateError) as error:
            f1_date_gate.validate_f1_dates(demands, requests, at=MIDNIGHT)
        self.assertEqual([(d["demand_id"], d["code"]) for d in error.exception.diagnostics], [
            (2, "F1_DATE_SEQUENCE_INVALID"), (3, "F1_SUPPLIER_READY_DATE_MISSING"),
        ])

    def test_deadline_uses_business_time_and_rejects_missing_hour(self):
        cutoff = MIDNIGHT + timedelta(hours=15, minutes=30)
        row = demand(end=time(15, 30))
        f1_date_gate.validate_f1_dates([row], [attempt()], at=cutoff - timedelta(microseconds=1))
        for now in (cutoff, cutoff + timedelta(microseconds=1)):
            with self.subTest(now=now), self.assertRaises(f1_date_gate.F1DateGateError) as result:
                f1_date_gate.validate_f1_dates([row], [attempt()], at=now)
            self.assertEqual(result.exception.diagnostics[0]["code"], "F1_DELIVERY_WINDOW_EXPIRED")
        with self.assertRaises(f1_date_gate.F1DateGateError) as result:
            f1_date_gate.validate_f1_dates([demand(end=None)], [attempt()], at=MIDNIGHT)
        self.assertEqual(result.exception.diagnostics[0]["code"], "F1_DELIVERY_END_MISSING")

    def test_sequence_error_identifies_the_supplier_and_request_in_a_batch(self):
        delivery_day = date(2026, 12, 3)
        demands = tuple(demand(44 + i, delivery_day, supplier=i) for i in (1, 2, 3))
        requests = [
            attempt(26 + i, day=delivery_day if i != 2 else date(2027, 1, 3),
                    supplier=i, confirmation_supplier=i, demand_id=44 + i)
            for i in (1, 2, 3)
        ]
        with self.assertRaises(f1_date_gate.F1DateGateError) as error:
            f1_date_gate.validate_f1_dates(demands, requests, at=MIDNIGHT)
        self.assertEqual(error.exception.diagnostics, [{
            "code": "F1_DATE_SEQUENCE_INVALID", "demand_id": 46, "supplier_id": 2,
            "supplier_code": "SUP002", "supplier_request_id": 28, "f1_date": "2026-11-25",
            "requested_date": "2026-12-03", "ready_date": "2027-01-03",
        }])

    def test_never_falls_back_to_older_attempt_or_different_supplier(self):
        for current in (
            attempt(2, day=None),
            attempt(2, supplier=9, confirmation_supplier=9),
            attempt(2, confirmation_supplier=9),
        ):
            with self.subTest(current=current):
                with self.assertRaises(f1_date_gate.F1DateGateError) as error:
                    f1_date_gate.validate_f1_dates([demand()], [current, attempt()], at=MIDNIGHT)
                self.assertEqual(error.exception.diagnostics[0]["code"], "F1_SUPPLIER_READY_DATE_MISSING")
                self.assertIsNone(error.exception.diagnostics[0]["ready_date"])

    def test_cp6_still_handles_unanswered_and_declined_requests(self):
        old = attempt(day=SERVICE_DAY - timedelta(days=1))
        for latest in (attempt(2, status="WAITING"), attempt(2, day=None, confirmation_status="DECLINED")):
            with self.subTest(latest=latest):
                f1_date_gate.validate_f1_dates([demand()], [old, latest], at=MIDNIGHT)
        latest = attempt(2, status="WAITING")
        self.assertEqual(build_confirmation_result(demand(), latest).reason_codes, ("LATEST_REQUEST_NOT_RESPONDED",))

    def test_direct_api_checks_manager_before_date_validation(self):
        for view in (F1RunPreviewView, F1RunCreateView):
            with self.subTest(view=view.__name__), patch.object(UserRole, "objects") as roles:
                roles.filter.return_value.exists.return_value = False
                factory = APIRequestFactory()
                body = {"rule_set_id": 2, "demand_ids": [1]}
                self.assertEqual(view.as_view()(factory.post("/", body, format="json")).status_code, 401)
                request = factory.post("/", body, format="json")
                force_authenticate(request, user=SimpleNamespace(is_authenticated=True))
                self.assertEqual(view.as_view()(request).status_code, 403)
                self.assertEqual(roles.filter.call_args.kwargs["role__code__in"], ("MANAGER",))

    @override_settings(COLOGI_CP11_ENABLED=False)
    def test_direct_api_rejects_entire_batch_at_delivery_deadline(self):
        cutoff = MIDNIGHT + timedelta(hours=15, minutes=30)
        demands = (demand(end=time(15, 30)), demand(2))
        requests = (attempt(), attempt(demand_id=2))
        f1_date_gate.validate_f1_dates(demands, requests, at=cutoff - timedelta(seconds=1))
        actor = SimpleNamespace(is_authenticated=True)
        for view, service, url in (
            (F1RunPreviewView, run_orchestration, "/api/planning/f1/preview/"),
            (F1RunCreateView, run_execution, "/api/planning/f1/runs/"),
        ):
            with (
                self.subTest(view=view.__name__),
                patch.object(HasCoLogiRole, "has_permission", return_value=True),
                patch.object(service, "connection", vendor="postgresql", in_atomic_block=False),
                patch.object(service.transaction, "atomic"),
                patch.object(service, "validate_run_scope", return_value=((1, 2), demands)),
                patch.object(service.timezone, "now", return_value=cutoff),
                patch.object(f1_date_gate.SupplierRequest, "objects") as requests_store,
                patch.object(PlanningRun, "objects") as runs,
                patch.object(service, "load_run_configuration") as configuration,
                patch.object(service, "load_f1_orm_data") as load_data,
            ):
                requests_store.filter.return_value.select_related.return_value.only.return_value = requests
                req = APIRequestFactory().post(url, {"rule_set_id": 2, "demand_ids": [1, 2]}, format="json")
                force_authenticate(req, user=actor)
                response = view.as_view()(req)
                self.assertEqual(response.status_code, 400)
                self.assertEqual({row["demand_id"] for row in response.data["diagnostics"]}, {1})
                self.assertEqual(response.data["diagnostics"][0]["code"], "F1_DELIVERY_WINDOW_EXPIRED")
                self.assertEqual(response.data["diagnostics"][0]["supplier_request_id"], 1)
                self.assertEqual(response.data["diagnostics"][0]["supplier_code"], "SUP008")
                self.assertEqual(response.data["diagnostics"][0]["f1_date"], SERVICE_DAY.isoformat())
                runs.create.assert_not_called()
                configuration.assert_not_called()
                load_data.assert_not_called()
