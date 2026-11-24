from django.test import override_settings
from django.urls import reverse
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from accounts.models import AuditLog, ExternalUserAccess, Role, RoleCode, User, UserOutletAccess, UserRole
from masterdata.models import Outlet, Supplier


class AccountWorkspaceTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.roles = {code: Role.objects.create(code=code, name=code.label) for code in RoleCode}
        cls.inside = Outlet.objects.create(outlet_code="ADMIN-A", outlet_name="Scoped", address="Test")
        cls.outside = Outlet.objects.create(outlet_code="ADMIN-B", outlet_name="Outside", address="Test")
        cls.manager = cls.user("manager", RoleCode.MANAGER)
        cls.capstone = cls.user("capstone", RoleCode.MANAGER, capstone_scenario="test")
        cls.inside_buyer = cls.user("buyer", RoleCode.PURCHASING_STAFF)
        cls.outside_buyer = cls.user("outside", RoleCode.PURCHASING_STAFF)
        cls.supplier = cls.user("supplier", RoleCode.SUPPLIER)
        cls.provider = cls.user("provider", RoleCode.TRANSPORT_PROVIDER)
        for account, outlet in ((cls.manager, cls.inside), (cls.capstone, cls.inside),
                                (cls.inside_buyer, cls.inside), (cls.outside_buyer, cls.outside)):
            UserOutletAccess.objects.create(user=account, outlet=outlet)

    @classmethod
    def user(cls, name, role, **fields):
        user = User.objects.create_user(email=f"{name}@example.test", full_name=name, **fields)
        UserRole.objects.create(user=user, role=cls.roles[role])
        return user

    def setUp(self):
        self.url = reverse("account-workspace-list")
        self.client.force_authenticate(self.manager)

    def detail(self, user_id):
        return reverse("account-workspace-detail", kwargs={"user_id": user_id})

    def payload(self, **values):
        return {"full_name": "New operator", "email": "new@example.test", "password": "kG7!bndL9-run24",
                "role_code": RoleCode.PURCHASING_STAFF, "outlet_ids": [self.inside.pk], **values}

    def test_manager_reads_only_authorized_account_fields(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["writes_enabled"])
        self.assertEqual({user["id"] for user in response.data["users"]}, {self.inside_buyer.pk})
        self.assertNotIn("password", response.data["users"][0])
        self.assertEqual(self.client.get(self.detail(self.inside_buyer.pk)).status_code, 200)
        self.assertEqual(self.client.get(self.detail(self.outside_buyer.pk)).status_code, 404)

    def test_buyer_with_shared_inactive_outlet_keeps_active_scope_visible(self):
        retired = Outlet.objects.create(outlet_code="ADMIN-OLD", outlet_name="Inactive", address="Test", is_active=False)
        UserOutletAccess.objects.create(user=self.manager, outlet=retired)
        UserOutletAccess.objects.create(user=self.inside_buyer, outlet=retired)
        self.assertEqual(self.client.get(self.url).data["users"][0]["id"], self.inside_buyer.pk)
        visible = self.client.get(self.detail(self.inside_buyer.pk))
        self.assertEqual(visible.status_code, 200)
        self.assertEqual([row["id"] for row in visible.data["scopes"]], [self.inside.pk])
        self.assertEqual(self.client.get(self.detail(self.outside_buyer.pk)).status_code, 404)
        UserOutletAccess.objects.filter(user=self.manager, outlet=retired).update(is_active=False)
        self.assertEqual(self.client.get(self.detail(self.inside_buyer.pk)).status_code, 404)

    def test_role_and_context_guards(self):
        for actor in (self.inside_buyer, self.supplier, self.provider, self.capstone):
            with self.subTest(actor=actor.pk):
                self.client.force_authenticate(actor)
                self.assertEqual(self.client.get(self.url).status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(self.url).status_code, 401)

    def test_external_access_requires_assignment_by_manager(self):
        supplier = Supplier.objects.create(supplier_code="ADMIN-S", supplier_name="Test")
        ExternalUserAccess.objects.create(user=self.supplier, actor_type=RoleCode.SUPPLIER, supplier=supplier)
        self.assertEqual(self.client.get(self.detail(self.supplier.pk)).status_code, 404)
        UserRole.objects.filter(user=self.supplier).update(assigned_by=self.manager)
        self.assertEqual(self.client.get(self.detail(self.supplier.pk)).data["scopes"][0]["code"], supplier.supplier_code)

    def test_write_feature_defaults_to_off(self):
        self.assertEqual(self.client.post(self.url, self.payload(), format="json").status_code, 403)
        self.assertEqual(self.client.post(self.detail(self.inside_buyer.pk),
                         {"operation": "DEACTIVATE", "confirm": True}, format="json").status_code, 403)
        self.assertEqual(self.client.patch(self.detail(self.inside_buyer.pk), {}, format="json").status_code, 403)

    @override_settings(COLOGI_LEGACY_ROLE_WRITES=False, COLOGI_ACCOUNT_ADMIN_WRITES=True)
    def test_legacy_routes_cannot_bypass_runtime_account_scoping(self):
        change = reverse("role-management-change", kwargs={"user_id": self.inside_buyer.pk})
        detail = reverse("role-management-user-detail", kwargs={"user_id": self.outside_buyer.pk})
        self.assertEqual(self.client.post(change, {"role_code": RoleCode.MANAGER}, format="json").status_code, 403)
        self.assertEqual(self.client.get(detail).status_code, 404)

    @override_settings(COLOGI_ACCOUNT_ADMIN_WRITES=True)
    def test_create_scoped_assignment_and_audit(self):
        payload = self.payload()
        response = self.client.post(self.url, payload, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        user = User.objects.get(pk=response.data["id"])
        self.assertTrue(user.check_password(payload["password"]))
        self.assertTrue(user.outlet_accesses.filter(outlet=self.inside, is_active=True).exists())
        self.assertNotIn("password", response.data)
        self.assertNotIn(payload["password"], str(list(AuditLog.objects.values("old_values", "new_values"))))

    @override_settings(COLOGI_ACCOUNT_ADMIN_WRITES=True)
    def test_rejects_elevation_cross_scope_and_weak_password(self):
        for payload, status in (
            (self.payload(is_superuser=True), 400),
            (self.payload(role_code=RoleCode.MANAGER), 400),
            (self.payload(outlet_ids=[self.inside.pk, self.outside.pk]), 403),
            (self.payload(password="123456789012"), 400),
        ):
            with self.subTest(status=status):
                self.assertEqual(self.client.post(self.url, payload, format="json").status_code, status)
        self.assertFalse(User.objects.filter(email="new@example.test").exists())

    @override_settings(COLOGI_ACCOUNT_ADMIN_WRITES=True)
    def test_reset_requires_confirmation_and_revokes_token(self):
        user = self.inside_buyer
        Token.objects.create(user=user)
        payload = {"operation": "RESET_PASSWORD", "password": "zV4!9833-violet", "confirm": False}
        self.assertEqual(self.client.post(self.detail(user.pk), payload, format="json").status_code, 400)
        self.assertTrue(Token.objects.filter(user=user).exists())
        payload["confirm"] = True
        self.assertEqual(self.client.post(self.detail(user.pk), payload, format="json").status_code, 200)
        user.refresh_from_db()
        self.assertTrue(user.check_password(payload["password"]))
        self.assertFalse(Token.objects.filter(user=user).exists())
        self.assertTrue(AuditLog.objects.filter(action="ACCOUNT_PASSWORD_RESET", entity_id=str(user.pk)).exists())

    @override_settings(COLOGI_ACCOUNT_ADMIN_WRITES=True)
    def test_activation_is_audited_idempotently_and_manager_protected(self):
        user = self.inside_buyer
        Token.objects.create(user=user)
        missing = {"operation": "DEACTIVATE", "confirm": True}
        self.assertEqual(self.client.post(self.detail(user.pk), missing, format="json").status_code, 400)
        payload = {**missing, "reason": "Tài khoản không còn nhiệm vụ mua hàng"}
        self.assertEqual(self.client.post(self.detail(self.manager.pk), payload, format="json").status_code, 404)
        self.assertEqual(self.client.post(self.detail(self.outside_buyer.pk), payload, format="json").status_code, 404)
        for _ in range(2):
            self.assertEqual(self.client.post(self.detail(user.pk), payload, format="json").status_code, 200)
        user.refresh_from_db()
        self.assertFalse(user.is_active)
        self.assertFalse(Token.objects.filter(user=user).exists())
        self.assertEqual(AuditLog.objects.filter(action="ACCOUNT_DEACTIVATED", entity_id=str(user.pk)).count(), 1)
        payload["operation"] = "ACTIVATE"
        payload.pop("reason")
        self.assertEqual(self.client.post(self.detail(user.pk), payload, format="json").status_code, 200)
        user.refresh_from_db()
        self.assertTrue(user.is_active)
        self.assertEqual(self.client.delete(self.detail(user.pk)).status_code, 405)

    @override_settings(COLOGI_ACCOUNT_ADMIN_WRITES=True)
    def test_edit_outlets_reuses_assignment_and_audits_before_after(self):
        outlet = Outlet.objects.create(outlet_code="ADMIN-C", outlet_name="Extra", address="Test")
        UserOutletAccess.objects.create(user=self.manager, outlet=outlet)
        historical = UserOutletAccess.objects.create(user=self.inside_buyer, outlet=outlet, is_active=False)
        token = Token.objects.create(user=self.inside_buyer)
        payload = {"role_code": RoleCode.PURCHASING_STAFF, "outlet_ids": [outlet.pk], "is_active": True, "confirm": True}
        endpoint = self.detail(self.inside_buyer.pk)
        self.assertEqual(self.client.patch(endpoint, {**payload, "confirm": False}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(endpoint, {**payload, "outlet_ids": [self.outside.pk]}, format="json").status_code, 403)
        self.assertEqual(self.client.patch(endpoint, {**payload, "role_code": RoleCode.MANAGER}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(endpoint, {**payload, "is_staff": True}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(endpoint, {**payload, "email": "new-login@example.test"}, format="json").status_code, 403)
        response = self.client.patch(endpoint, payload, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["scopes"][0]["id"], outlet.pk)
        historical.refresh_from_db()
        self.assertTrue(historical.is_active)
        self.assertFalse(UserOutletAccess.objects.get(user=self.inside_buyer, outlet=self.inside).is_active)
        self.assertFalse(Token.objects.filter(key=token.key).exists())
        audit = AuditLog.objects.get(action="ACCOUNT_EDITED", entity_id=str(self.inside_buyer.pk))
        self.assertEqual(audit.actor_user_id, self.manager.pk)
        self.assertEqual(audit.old_values["scopes"], [self.inside.pk])
        self.assertEqual(audit.new_values["scopes"], [outlet.pk])
        self.assertEqual(response.data["history"][0]["after"]["scopes"], [outlet.pk])

    @override_settings(COLOGI_ACCOUNT_ADMIN_WRITES=True, COLOGI_ACCOUNT_PROFILE_WRITES=True)
    def test_profile_edit_validates_unique_normalized_email(self):
        endpoint = self.detail(self.inside_buyer.pk)
        base = {"role_code": RoleCode.PURCHASING_STAFF, "outlet_ids": [self.inside.pk], "is_active": True, "confirm": True}
        duplicate = self.client.patch(endpoint, {**base, "email": self.outside_buyer.email.upper()}, format="json")
        self.assertEqual(duplicate.status_code, 400)
        result = self.client.patch(endpoint, {**base, "email": "NEW-BUYER@EXAMPLE.TEST", "full_name": "Updated Name"}, format="json")
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["email"], "new-buyer@example.test")
        self.assertEqual(result.data["full_name"], "Updated Name")

    @override_settings(COLOGI_ACCOUNT_ADMIN_WRITES=True)
    def test_create_inactive_and_auth_token_revocation_through_api(self):
        created = self.client.post(self.url, self.payload(is_active=False), format="json")
        self.assertEqual(created.status_code, 201, created.data)
        endpoint = self.detail(created.data["id"])
        self.assertFalse(created.data["is_active"])
        login = reverse("login")
        credentials = {key: self.payload()[key] for key in ("email", "password")}
        from rest_framework.test import APIClient
        buyer = APIClient()
        self.assertEqual(buyer.post(login, credentials, format="json").status_code, 401)
        self.assertEqual(self.client.post(endpoint, {"operation": "ACTIVATE", "confirm": True}, format="json").status_code, 200)
        first = buyer.post(login, credentials, format="json")
        self.assertEqual(first.status_code, 200)
        buyer.credentials(HTTP_AUTHORIZATION="Token " + first.data["token"])
        identity = reverse("current-user")
        self.assertEqual(buyer.get(identity).status_code, 200)
        new_password = "uQ2!4z5z7-opaque"
        reset = self.client.post(endpoint, {"operation": "RESET_PASSWORD", "password": new_password, "confirm": True}, format="json")
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(buyer.get(identity).status_code, 401)
        self.assertEqual(buyer.post(login, credentials, format="json").status_code, 401)
        second = buyer.post(login, {**credentials, "password": new_password}, format="json")
        self.assertEqual(second.status_code, 200)
        buyer.credentials(HTTP_AUTHORIZATION="Token " + second.data["token"])
        self.assertEqual(self.client.post(endpoint, {"operation": "DEACTIVATE", "confirm": True, "reason": "Nghỉ việc"}, format="json").status_code, 200)
        self.assertEqual(buyer.get(identity).status_code, 401)
        self.assertEqual(buyer.post(login, {**credentials, "password": new_password}, format="json").status_code, 401)
        self.assertEqual(self.client.post(endpoint, {"operation": "ACTIVATE", "confirm": True}, format="json").status_code, 200)
        self.assertEqual(buyer.get(identity).status_code, 401)
