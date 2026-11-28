#!/usr/bin/env python3
"""CP16: scoped business unit registration. Run from CoLogi root. Dry-run by default."""
import argparse
from pathlib import Path
import shutil
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
changes, originals = {}, {}

def edit(path, old, new):
    p = Path(path)
    if p not in originals:
        originals[p] = p.read_text(encoding='utf-8')
    s = changes.get(p, originals[p])
    if s.count(old) != 1:
        raise SystemExit(f'STOP: expected one anchor in {p}: {old[:120]!r}; no files modified')
    changes[p] = s.replace(old, new, 1)

W = 'backend/accounts/services/account_workspace.py'
R = 'backend/accounts/services/role_management.py'
V = 'backend/accounts/account_views.py'
A = 'database/runtime_acl.sql'
T = Path('backend/accounts/test_cp16_all_units.py')

edit(W, 'from django.db import transaction\nfrom django.db.models import Prefetch', '''import re

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import connection, transaction
from django.db.models import Prefetch, Q''')
edit(W, 'def _units(outlets, actor):', '''# Registration ownership is recorded in the existing append-only audit trail.
# New outlet scope is explicitly granted to the registering manager.
REGISTRATION_SPECS = {
    "new_provider": (RoleCode.TRANSPORT_PROVIDER, TransportProvider, "TP", "provider_code", "provider_id", "TRANSPORT_PROVIDER"),
    "new_supplier": (RoleCode.SUPPLIER, Supplier, "SUP", "supplier_code", "supplier_id", "SUPPLIER"),
    "new_outlet": (RoleCode.PURCHASING_STAFF, Outlet, "OUT", "outlet_code", "outlet_ids", "OUTLET"),
}
REGISTRATION_EVENT = "BUSINESS_UNIT_REGISTERED"


def _registration_records(entity, actor=None):
    rows = AuditLog.objects.filter(action=REGISTRATION_EVENT, entity_type=entity)
    if actor is not None:
        rows = rows.filter(actor_user=actor)
    return rows


def _registered_unit_filter(entity, code_field, actor):
    # Match both PK and code; do not grant access by name or code alone.
    query = Q(pk__in=[])
    for pk, data in _registration_records(entity, actor).values_list("entity_id", "new_values"):
        code = data.get("code") if isinstance(data, dict) else None
        if isinstance(pk, str) and pk.isascii() and pk.isdecimal() and isinstance(code, str):
            query |= Q(pk=int(pk), **{code_field: code})
    return query


def _next_unit_code(prefix, codes):
    pattern = re.compile(re.escape(prefix) + r"([0-9]+)")
    numbers = [int(m.group(1)) for code in codes if isinstance(code, str) and (m := pattern.fullmatch(code))]
    code = f"{prefix}{max(numbers, default=0) + 1:03d}"
    if len(code) > 30:
        raise ValidationError("Không thể cấp thêm mã đơn vị.")
    return code


def _register_unit(actor, kind, data):
    manager_outlets(actor)
    if not getattr(settings, "COLOGI_ACCOUNT_ADMIN_WRITES", False):
        raise PermissionDenied("Quản trị tài khoản đang ở chế độ chỉ đọc.")
    if kind not in REGISTRATION_SPECS:
        raise ValidationError("Loại đơn vị không hợp lệ.")
    role, model, prefix, code_field, scope_field, entity = REGISTRATION_SPECS[kind]
    allowed = {
        "new_provider": {"provider_name", "provider_type", "service_region", "contact_email"},
        "new_supplier": {"supplier_name", "address", "contact_name", "phone", "email"},
        "new_outlet": {"outlet_name", "address", "contact_name", "phone"},
    }[kind]
    required = {
        "new_provider": {"provider_name", "provider_type", "service_region", "contact_email"},
        "new_supplier": {"supplier_name", "address"},
        "new_outlet": {"outlet_name", "address"},
    }[kind]
    if (not isinstance(data, dict) or not required <= set(data) <= allowed
            or any(not isinstance(data[k], str) or not data[k].strip() for k in required)
            or (kind == "new_provider" and data["provider_type"] != "EXTERNAL")):
        raise ValidationError({kind: "Thông tin đơn vị không hợp lệ."})
    if connection.vendor != "postgresql" or not connection.in_atomic_block:
        raise RuntimeError("Registration requires a PostgreSQL transaction.")
    with connection.cursor() as cursor:
        cursor.execute("SHOW transaction_isolation")
        if cursor.fetchone()[0] != "read committed":
            raise ValidationError("Đăng ký đơn vị cần transaction READ COMMITTED.")
        cursor.execute("SELECT pg_advisory_xact_lock(%s, %s)", [16016, {"TP": 1, "SUP": 2, "OUT": 3}[prefix]])
    codes = set(model.objects.values_list(code_field, flat=True))
    for values in _registration_records(entity).values_list("new_values", flat=True):
        if isinstance(values, dict) and isinstance(values.get("code"), str):
            codes.add(values["code"])
    # Preserve numeric codes from the earlier provider-only CP16 event, if any.
    if kind == "new_provider":
        for values in AuditLog.objects.filter(action="TRANSPORT_PROVIDER_REGISTERED", entity_type=entity).values_list("new_values", flat=True):
            if isinstance(values, dict) and isinstance(values.get("provider_code"), str):
                codes.add(values["provider_code"])
    code = _next_unit_code(prefix, codes)
    unit = model(**{**data, code_field: code, "is_active": True})
    try:
        unit.full_clean()
    except DjangoValidationError as exc:
        raise ValidationError({kind: exc.message_dict}) from exc
    unit.save(force_insert=True)
    if kind == "new_outlet":
        UserOutletAccess.objects.create(user=actor, outlet=unit, assigned_by=actor)
    AuditLog.objects.create(actor_user=actor, action=REGISTRATION_EVENT, entity_type=entity,
                            entity_id=str(unit.pk), new_values={"code": code, "role": role})
    return {scope_field: [unit.pk] if kind == "new_outlet" else unit.pk}


def _units(outlets, actor):''')
edit(W, '''        "suppliers": list(Supplier.objects.filter(is_active=True, pk__in=supplier_ids).values("id", "supplier_code", "supplier_name")),
        "providers": list(TransportProvider.objects.filter(
            is_active=True, provider_code="TP001", pk__in=provider_ids,
        ).values("id", "provider_code", "provider_name")),''', '''        "suppliers": list(Supplier.objects.filter(is_active=True).filter(
            Q(pk__in=supplier_ids) | _registered_unit_filter("SUPPLIER", "supplier_code", actor)
        ).values("id", "supplier_code", "supplier_name")),
        "providers": list(TransportProvider.objects.filter(is_active=True).filter(
            Q(provider_code="TP001", pk__in=provider_ids)
            | _registered_unit_filter("TRANSPORT_PROVIDER", "provider_code", actor)
        ).values("id", "provider_code", "provider_name")),''')
edit(W, '    valid = _validate_scope(role_code, scope)\n    if role_code == RoleCode.PURCHASING_STAFF:', '''    valid = _validate_scope(role_code, scope, allow_registered_provider=True)
    if role_code == RoleCode.PURCHASING_STAFF:''')
edit(W, '''def create_account(actor, *, email, full_name, role_code, scope, password, is_active=True):
    _check_scope(actor, role_code, scope)
    normalized = User.objects.normalize_email_address(email)
    user = User(email=normalized, full_name=full_name)
    validate_password(password, user)
    user.set_password(password)
    user.save(force_insert=True)
    assign_role(actor, user.pk, role_code, scope)''', '''def create_account(actor, *, email, full_name, role_code, scope, password, is_active=True,
                   new_provider=None, new_supplier=None, new_outlet=None):
    manager_outlets(actor)
    new_units = {k: v for k, v in {"new_provider": new_provider, "new_supplier": new_supplier,
                                    "new_outlet": new_outlet}.items() if v is not None}
    if len(new_units) > 1 or (new_units and scope):
        raise ValidationError("Chọn đơn vị hiện có hoặc tạo đúng một đơn vị mới.")
    if new_units:
        kind, data = next(iter(new_units.items()))
        if role_code != REGISTRATION_SPECS[kind][0]:
            raise ValidationError("Đơn vị mới không phù hợp vai trò.")
    else:
        _check_scope(actor, role_code, scope)
    normalized = User.objects.normalize_email_address(email)
    user = User(email=normalized, full_name=full_name)
    validate_password(password, user)
    if new_units:
        scope = _register_unit(actor, kind, data)
        _check_scope(actor, role_code, scope)
    user.set_password(password)
    user.save(force_insert=True)
    assign_role(actor, user.pk, role_code, scope, allow_registered_provider=True)''')
edit(R, 'def _validate_scope(role_code, scope):', 'def _validate_scope(role_code, scope, *, allow_registered_provider=False):')
edit(R, '''            provider = TransportProvider.objects.get(
                pk=provider_id,
                provider_code="TP001",
                is_active=True,
            )
        except TransportProvider.DoesNotExist:
            raise RoleManagementError(
                "MVP only permits the active TP001 provider."
            )''', '''            providers = TransportProvider.objects.filter(pk=provider_id, is_active=True)
            if not allow_registered_provider:
                providers = providers.filter(provider_code="TP001")
            provider = providers.get()
        except TransportProvider.DoesNotExist:
            raise RoleManagementError(
                "Transport provider does not exist, is inactive or is not permitted."
                if allow_registered_provider else "MVP only permits the active TP001 provider."
            )''')
edit(R, 'def assign_role(actor, target_user_id, role_code, scope=None, ip_address=None):', 'def assign_role(actor, target_user_id, role_code, scope=None, ip_address=None, *, allow_registered_provider=False):')
edit(R, '    role = _get_role(role_code)\n    validated_scope = _validate_scope(role.code, scope)', '    role = _get_role(role_code)\n    validated_scope = _validate_scope(role.code, scope, allow_registered_provider=allow_registered_provider)')
edit(V, 'class CreateAccountInput(AccountAssignmentInput):', '''class NewProviderInput(StrictInput, serializers.Serializer):
    provider_name = serializers.CharField(max_length=200)
    provider_type = serializers.ChoiceField(choices=("EXTERNAL",), default="EXTERNAL")
    service_region = serializers.CharField(max_length=1000)
    contact_email = serializers.EmailField(max_length=254)


class NewOutletInput(StrictInput, serializers.Serializer):
    outlet_name = serializers.CharField(max_length=200)
    address = serializers.CharField(max_length=2000)
    contact_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=30, required=False, allow_blank=True)


class NewSupplierInput(StrictInput, serializers.Serializer):
    supplier_name = serializers.CharField(max_length=200)
    address = serializers.CharField(max_length=2000)
    contact_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=30, required=False, allow_blank=True)
    email = serializers.EmailField(max_length=254, required=False, allow_blank=True)


class CreateAccountInput(AccountAssignmentInput):''')
edit(V, '''    password = serializers.CharField(write_only=True, trim_whitespace=False, min_length=12, max_length=128)


class ConfirmedWrite:''', '''    password = serializers.CharField(write_only=True, trim_whitespace=False, min_length=12, max_length=128)
    new_provider = NewProviderInput(required=False)
    new_supplier = NewSupplierInput(required=False)
    new_outlet = NewOutletInput(required=False)

    def validate(self, attrs):
        modes = {"new_provider": RoleCode.TRANSPORT_PROVIDER, "new_supplier": RoleCode.SUPPLIER,
                 "new_outlet": RoleCode.PURCHASING_STAFF}
        selected = [k for k in modes if k in attrs]
        if not selected:
            return super().validate(attrs)
        if len(selected) != 1 or attrs["role_code"] != modes[selected[0]] or any(
            k in attrs for k in ("provider_id", "supplier_id", "outlet_ids")
        ):
            raise serializers.ValidationError("Chọn đúng một đơn vị mới phù hợp vai trò, không gửi kèm phạm vi hiện có.")
        return attrs


class ConfirmedWrite:''')
edit(V, '''            **{key: data.validated_data[key] for key in ("email", "full_name", "role_code", "password", "is_active")},''', '''            **{key: value for key, value in data.validated_data.items()
               if key in ("email", "full_name", "role_code", "password", "is_active", "new_provider", "new_supplier", "new_outlet")},''')
edit(V, '''            "external_scope_writes_enabled": getattr(settings, "COLOGI_ACCOUNT_EXTERNAL_SCOPE_WRITES", False),''', '''            "external_scope_writes_enabled": getattr(settings, "COLOGI_ACCOUNT_EXTERNAL_SCOPE_WRITES", False),
            "unit_registration_enabled": getattr(settings, "COLOGI_ACCOUNT_ADMIN_WRITES", False),''')
# Future installs need only INSERT / sequence USAGE, no new UPDATE or DELETE rights.
# Outlet already has column-specific INSERT grants in the release ACL.
edit(A, 'GRANT SELECT ON TABLE "public"."transport_providers" TO cologi_cp08_runtime;', '''GRANT SELECT ON TABLE "public"."transport_providers" TO cologi_cp08_runtime;
-- CP16: account workspace registration (no UPDATE/DELETE expansion).
GRANT INSERT (provider_code, provider_name, provider_type, service_region, contact_email, is_active) ON TABLE "public"."transport_providers" TO cologi_cp08_runtime;
GRANT INSERT (supplier_code, supplier_name, contact_name, phone, email, address, is_active, created_at, updated_at) ON TABLE "public"."suppliers" TO cologi_cp08_runtime;
GRANT USAGE ON SEQUENCE "public"."transport_providers_id_seq", "public"."suppliers_id_seq" TO cologi_cp08_runtime;''')
if T.exists():
    raise SystemExit(f'STOP: {T} already exists; no files modified')
changes[T] = '''from django.test import SimpleTestCase
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
'''
for p, s in changes.items():
    if p.suffix == '.py':
        compile(s, str(p), 'exec')
print('PASS: source anchors and Python syntax')
for p in changes:
    print('CHANGE:', p)
if not args.apply:
    print('DRY RUN: no files modified. Re-run with --apply.')
    raise SystemExit(0)
backup = Path(tempfile.mkdtemp(prefix='cologi-cp16-all-'))
for p in originals:
    dest = backup / p
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, dest)
for p, s in changes.items():
    p.write_text(s, encoding='utf-8')
Path('/tmp/cologi-cp16-all-backup').write_text(str(backup), encoding='utf-8')
print('SUCCESS: CP16 all-unit backend source updated')
print('Backup:', backup)
print('No frontend or live database changes.')
