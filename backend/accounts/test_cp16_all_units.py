from django.test import SimpleTestCase
from accounts.account_views import CreateAccountInput
from accounts.services.account_workspace import _next_unit_code


class CP16ContractTests(SimpleTestCase):
    def test_existing_and_new_modes(self):
        base = {"email": "test@example.test", "full_name": "Test user", "password": "test-password-123"}
        cases = [
            ("TRANSPORT_PROVIDER", {"provider_id": 1}, "new_provider", {"provider_name": "Test", "service_region": "Test", "contact_email": "test@example.test"}),
            ("SUPPLIER", {"supplier_id": 1}, "new_supplier", {"supplier_name": "Test", "address": "Test"}),
            ("PURCHASING_STAFF", {"outlet_ids": [1]}, "new_outlet", {"outlet_name": "Test", "address": "Test"}),
        ]
        for role, scope, field, unit in cases:
            for extra in (scope, {field: unit}):
                s = CreateAccountInput(data={**base, "role_code": role, **extra})
                self.assertTrue(s.is_valid(), s.errors)
                self.assertEqual(s.get_scope(), scope if extra == scope else {})
            for bad in ({**scope, field: unit}, {field: {**unit, "code": "BAD"}}, {}):
                s = CreateAccountInput(data={**base, "role_code": role, **bad})
                self.assertFalse(s.is_valid())
        self.assertFalse(CreateAccountInput(data={**base, "role_code": "SUPPLIER", "new_outlet": {"outlet_name": "X", "address": "Y"}}).is_valid())

    def test_codes(self):
        self.assertEqual(_next_unit_code("TP", ["TP001"]), "TP002")
        self.assertEqual(_next_unit_code("SUP", ["SUP001", "SUP010"]), "SUP011")
        self.assertEqual(_next_unit_code("OUT", ["OUT012", "OUT-ABC"]), "OUT013")
        self.assertEqual(_next_unit_code("TP", ["TP999"]), "TP1000")
