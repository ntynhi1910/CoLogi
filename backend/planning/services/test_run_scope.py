
from types import SimpleNamespace
from unittest.mock import patch

from django.core.exceptions import PermissionDenied, ValidationError
from django.test import SimpleTestCase

from planning.services.run_scope import (
    normalize_demand_ids,
    validate_run_scope,
)


class NormalizeDemandIdsTests(SimpleTestCase):
    def test_returns_sorted_ids(self):
        self.assertEqual(
            normalize_demand_ids([20, 10]),
            (10, 20),
        )

    def test_rejects_duplicate_ids(self):
        with self.assertRaises(ValidationError):
            normalize_demand_ids([10, 10])

    def test_rejects_invalid_ids(self):
        for values in ([0], [-1], ["abc"], [True], ["010"]):
            with self.subTest(values=values):
                with self.assertRaises(ValidationError):
                    normalize_demand_ids(values)

    def test_rejects_empty_input(self):
        with self.assertRaises(ValidationError):
            normalize_demand_ids([])


class ValidateRunScopeTests(SimpleTestCase):
    def setUp(self):
        self.actor = SimpleNamespace(is_authenticated=True)
        self.demands = [
            SimpleNamespace(
                pk=10,
                outlet_id=100,
                demand_code="D-010",
            ),
            SimpleNamespace(
                pk=20,
                outlet_id=200,
                demand_code="D-020",
            ),
        ]

    def configure_mocks(self, outlet_ids, demands=None):
        access = patch(
            "planning.services.run_scope.get_f1_outlet_ids"
        ).start()
        access.return_value = outlet_ids

        demand_model = patch(
            "planning.services.run_scope.DeliveryDemand"
        ).start()

        (
            demand_model.objects.filter.return_value
            .select_related.return_value
            .prefetch_related.return_value
            .order_by.return_value
        ) = self.demands if demands is None else demands

        self.addCleanup(patch.stopall)

    def test_allows_demands_in_authorized_outlets(self):
        self.configure_mocks([100], [self.demands[0]])

        ids, demands = validate_run_scope(
            self.actor,
            [10],
        )

        self.assertEqual(ids, (10,))
        self.assertEqual(demands, (self.demands[0],))

    def test_rejects_user_without_outlet_access(self):
        self.configure_mocks([])

        with self.assertRaises(PermissionDenied):
            validate_run_scope(self.actor, [10])

    def test_rejects_demand_from_unauthorized_outlet(self):
        self.configure_mocks([100])

        with self.assertRaises(PermissionDenied):
            validate_run_scope(self.actor, [10, 20])

    def test_rejects_unknown_demand_ids(self):
        self.configure_mocks([100], [])

        with self.assertRaises(ValidationError):
            validate_run_scope(self.actor, [999])

    def test_rejects_unauthenticated_user(self):
        actor = SimpleNamespace(is_authenticated=False)

        with self.assertRaises(PermissionDenied):
            validate_run_scope(actor, [10])
