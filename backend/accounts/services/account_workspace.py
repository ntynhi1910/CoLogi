"""Manager account administration constrained to established business scopes."""

from django.conf import settings
from django.db import transaction
from django.db.models import Prefetch
from django.contrib.auth.password_validation import validate_password
from rest_framework.authtoken.models import Token
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from accounts.models import AuditLog, ExternalUserAccess, RoleCode, User, UserOutletAccess, UserRole
from accounts.permissions import get_active_user_outlet_accesses
from accounts.services.role_management import _apply_scope, _deactivate_scopes, _get_role, _validate_scope, assign_role
from demands.models import DeliveryDemand
from masterdata.models import Outlet, Supplier, TransportProvider
from planning.models import FinalPlan
from planning.services.run_results import scoped_f1_runs

BUSINESS_ROLES = (RoleCode.PURCHASING_STAFF, RoleCode.SUPPLIER, RoleCode.TRANSPORT_PROVIDER)
EVENTS = ("ACCOUNT_CREATED", "ACCOUNT_EDITED", "ACCOUNT_PASSWORD_RESET", "ACCOUNT_ACTIVATED", "ACCOUNT_DEACTIVATED",
          "ASSIGN_ROLE", "CHANGE_ROLE", "REVOKE_ROLE", "ASSIGN_OUTLET_ACCESS", "REVOKE_OUTLET_ACCESS")
AUDIT_FIELDS = ("full_name", "email", "role", "scope", "scopes", "outlet_ids", "external_accesses", "is_active",
                "sessions_revoked", "active_outlet_ids", "reason", "credential_changed")


def manager_outlets(actor):
    if actor.capstone_scenario:
        raise PermissionDenied("Không quản trị tài khoản vận hành từ phiên Capstone.")
    outlets = set(get_active_user_outlet_accesses(actor, role_codes=(RoleCode.MANAGER,)).values_list("outlet_id", flat=True))
    if not outlets:
        raise PermissionDenied("Quản lý cần được cấp phạm vi Outlet.")
    return outlets


def _users(actor):
    return User.objects.filter(
        capstone_scenario="", is_staff=False, is_superuser=False, groups__isnull=True, user_permissions__isnull=True,
        user_roles__is_active=True, user_roles__role__is_active=True, user_roles__role__code__in=BUSINESS_ROLES,
    ).exclude(pk=actor.pk).exclude(user_roles__role__code=RoleCode.MANAGER).defer("password")


def _users_with_scopes(qs):
    return qs.prefetch_related(
        Prefetch("user_roles", queryset=UserRole.objects.filter(is_active=True, role__is_active=True).select_related("role"),
                 to_attr="workspace_roles"),
        Prefetch("outlet_accesses", queryset=UserOutletAccess.objects.filter(is_active=True).select_related("outlet"),
                 to_attr="workspace_outlets"),
        Prefetch("external_accesses", queryset=ExternalUserAccess.objects.filter(is_active=True).select_related("supplier", "provider"),
                 to_attr="workspace_external"),
    )


def _managed_inactive_outlets(actor):
    return set(UserOutletAccess.objects.filter(user=actor, is_active=True, outlet__is_active=False)
               .values_list("outlet_id", flat=True))


def _scopes(actor, user, outlets, inactive_outlets):
    if len(user.workspace_roles) != 1:
        return []
    assignment, = user.workspace_roles
    if assignment.role.code == RoleCode.PURCHASING_STAFF:
        selected = {access.outlet_id for access in user.workspace_outlets}
        if not selected.intersection(outlets) or not selected.issubset(outlets | inactive_outlets) or user.workspace_external:
            return []
        return [{"id": item.outlet_id, "code": item.outlet.outlet_code, "name": item.outlet.outlet_name}
                for item in user.workspace_outlets if item.outlet_id in outlets]
    if assignment.assigned_by_id != actor.pk or user.workspace_outlets or len(user.workspace_external) != 1:
        return []
    access = user.workspace_external[0]
    if access.actor_type != assignment.role.code:
        return []
    if access.supplier:
        return [{"id": access.supplier_id, "code": access.supplier.supplier_code, "name": access.supplier.supplier_name}]
    return [{"id": access.provider_id, "code": access.provider.provider_code, "name": access.provider.provider_name}]


def _present(user, scopes):
    assignment, = user.workspace_roles
    return {"id": user.pk, "full_name": user.full_name, "email": user.email,
            "role": assignment.role.code, "scopes": scopes, "is_active": user.is_active}


def _units(outlets, actor):
    supplier_ids = DeliveryDemand.objects.filter(outlet_id__in=outlets, capstone_scenario="").values("supplier_id")
    provider_ids = FinalPlan.objects.filter(
        decision__actor=actor, scenario="", decision__group__run_code__in=scoped_f1_runs(actor).values("run_code"),
    ).values("provider_id")
    return {
        "outlets": list(Outlet.objects.filter(is_active=True, pk__in=outlets).values("id", "outlet_code", "outlet_name")),
        "suppliers": list(Supplier.objects.filter(is_active=True, pk__in=supplier_ids).values("id", "supplier_code", "supplier_name")),
        "providers": list(TransportProvider.objects.filter(
            is_active=True, provider_code="TP001", pk__in=provider_ids,
        ).values("id", "provider_code", "provider_name")),
    }


def list_accounts(actor):
    outlets = manager_outlets(actor)
    inactive_outlets = _managed_inactive_outlets(actor)
    rows = []
    for user in _users_with_scopes(_users(actor)):
        if scopes := _scopes(actor, user, outlets, inactive_outlets):
            rows.append(_present(user, scopes))
    return {"users": rows, "units": _units(outlets, actor)}


def _lookup(actor, user_id, *, lock=False):
    outlets = manager_outlets(actor)
    users = _users(actor).filter(pk=user_id)
    if lock:
        users = users.select_for_update(of=("self",))
    user = _users_with_scopes(users).first()
    if not user or not (scopes := _scopes(actor, user, outlets, _managed_inactive_outlets(actor))):
        raise NotFound()
    return user, scopes


def account_details(actor, user_id):
    user, scopes = _lookup(actor, user_id)
    records = AuditLog.objects.filter(action__in=EVENTS, entity_type__in=("USER_ROLE", "USER_ACCOUNT", "USER_OUTLET_ACCESS"),
                                      entity_id=str(user.pk)).select_related("actor_user")[:100]
    return {
        **_present(user, scopes),
        "history": [{"action": record.action, "at": record.created_at,
                     "actor": record.actor_user.full_name if record.actor_user else None,
                     "target_id": user.pk,
                     "before": _audit_summary(record.old_values),
                     "after": _audit_summary(record.new_values)}
                    for record in records],
    }


def _audit_summary(values):
    return {key: values[key] for key in AUDIT_FIELDS if isinstance(values, dict) and key in values}


def _audit(actor, user, action, *, before=None, after=None):
    AuditLog.objects.create(actor_user=actor, action=action, entity_type="USER_ACCOUNT",
                            entity_id=str(user.pk), old_values=before, new_values=after)


def _state(user, role, scope_ids):
    return {"email": user.email, "full_name": user.full_name, "is_active": user.is_active,
            "role": role, "scopes": sorted(scope_ids)}


def _scope_ids(role_code, scope):
    if role_code == RoleCode.PURCHASING_STAFF:
        return set(scope["outlet_ids"])
    field = "supplier_id" if role_code == RoleCode.SUPPLIER else "provider_id"
    return {scope[field]}


def _check_scope(actor, role_code, scope):
    outlets = manager_outlets(actor)
    if role_code not in BUSINESS_ROLES:
        raise PermissionDenied("Vai trò nằm ngoài phạm vi quản trị.")
    valid = _validate_scope(role_code, scope)
    if role_code == RoleCode.PURCHASING_STAFF:
        permitted = outlets
    else:
        key = "suppliers" if role_code == RoleCode.SUPPLIER else "providers"
        permitted = {row["id"] for row in _units(outlets, actor)[key]}
    if not _scope_ids(role_code, scope) <= permitted:
        raise PermissionDenied("Đơn vị nằm ngoài phạm vi quản trị.")
    return valid


def _check_external_reassignment(user, role_code, scope):
    if role_code == RoleCode.PURCHASING_STAFF:
        return
    field = "supplier_id" if role_code == RoleCode.SUPPLIER else "provider_id"
    previous = ExternalUserAccess.objects.filter(user=user, actor_type=role_code).values_list(field, flat=True).first()
    if previous is not None and previous != scope[field] and not getattr(settings, "COLOGI_ACCOUNT_EXTERNAL_SCOPE_WRITES", False):
        raise PermissionDenied("Đổi đơn vị bên ngoài cần cấp thêm quyền triển khai.")


@transaction.atomic
def create_account(actor, *, email, full_name, role_code, scope, password, is_active=True):
    _check_scope(actor, role_code, scope)
    normalized = User.objects.normalize_email_address(email)
    user = User(email=normalized, full_name=full_name)
    validate_password(password, user)
    user.set_password(password)
    user.save(force_insert=True)
    assign_role(actor, user.pk, role_code, scope)
    if not is_active:
        user.is_active = False
        user.save(update_fields=("is_active", "updated_at"))
    _audit(actor, user, "ACCOUNT_CREATED", after=_state(user, role_code, _scope_ids(role_code, scope)))
    return account_details(actor, user.pk)


def _validate_activation(user, role):
    if role == RoleCode.PURCHASING_STAFF:
        valid = all(item.outlet.is_active for item in user.workspace_outlets)
    else:
        access = user.workspace_external[0]
        unit = access.supplier or access.provider
        valid = unit.is_active
    if not valid:
        raise ValidationError("Đơn vị hiện tại đã ngừng hoạt động. Cập nhật phạm vi trước khi kích hoạt.")


@transaction.atomic
def edit_account(actor, *, user_id, role_code, scope, is_active, email=None, full_name=None, reason=None):
    user, scopes = _lookup(actor, user_id, lock=True)
    current_role, = user.workspace_roles
    before = _state(user, current_role.role.code, (row["id"] for row in scopes))
    new_ids = _scope_ids(role_code, scope)
    changed_role = role_code != before["role"]
    changed_scope = changed_role or new_ids != set(before["scopes"])
    fields = []
    for field, value in (("email", email), ("full_name", full_name)):
        if value is not None and value != getattr(user, field):
            if not getattr(settings, "COLOGI_ACCOUNT_PROFILE_WRITES", False):
                raise PermissionDenied("Đổi họ tên hoặc email cần cấp thêm quyền triển khai.")
            setattr(user, field, value)
            fields.append(field)
    if user.is_active != is_active:
        if not is_active and not reason:
            raise ValidationError({"reason": ["Nhập lý do vô hiệu hóa."]})
        if is_active and not changed_scope:
            _validate_activation(user, role_code)
        user.is_active = is_active
        fields.append("is_active")
    if changed_scope:
        validated = _check_scope(actor, role_code, scope)
        _check_external_reassignment(user, role_code, scope)
        if changed_role:
            new_role = _get_role(role_code)
            _deactivate_scopes(user)
            current_role.is_active = False
            current_role.save(update_fields=("is_active",))
            UserRole.objects.create(user=user, role=new_role, assigned_by=actor)
        elif role_code == RoleCode.PURCHASING_STAFF:
            UserOutletAccess.objects.filter(user=user, is_active=True).exclude(outlet_id__in=new_ids).update(is_active=False)
        _apply_scope(actor, user, role_code, validated, preserve_outlet_grant=True)
    if fields:
        user.save(update_fields=(*fields, "updated_at"))
    if fields or changed_scope:
        after = _state(user, role_code, new_ids)
        if changed_scope or "email" in fields or "is_active" in fields:
            Token.objects.filter(user=user).delete()
            after["sessions_revoked"] = True
        if reason and before["is_active"] and not is_active:
            after["reason"] = reason
        _audit(actor, user, "ACCOUNT_EDITED", before=before, after=after)
    return account_details(actor, user.pk)


@transaction.atomic
def change_account(actor, *, user_id, operation, password=None, reason=None):
    user, scopes = _lookup(actor, user_id, lock=True)
    role = user.workspace_roles[0].role.code
    before = _state(user, role, (row["id"] for row in scopes))
    if operation == "RESET_PASSWORD":
        if password is None:
            raise ValidationError("Cần cung cấp mật khẩu mới.")
        validate_password(password, user)
        user.set_password(password)
        user.save(update_fields=("password", "updated_at"))
        Token.objects.filter(user=user).delete()
        _audit(actor, user, "ACCOUNT_PASSWORD_RESET", before=before,
               after={**before, "credential_changed": True, "sessions_revoked": True})
    elif operation in ("ACTIVATE", "DEACTIVATE"):
        active = operation == "ACTIVATE"
        if not active and not reason:
            raise ValidationError({"reason": ["Nhập lý do vô hiệu hóa."]})
        if active:
            _validate_activation(user, role)
        if active != user.is_active:
            user.is_active = active
            user.save(update_fields=("is_active", "updated_at"))
            Token.objects.filter(user=user).delete()
            _audit(actor, user, "ACCOUNT_ACTIVATED" if active else "ACCOUNT_DEACTIVATED", before=before,
                   after={**before, "is_active": active, "sessions_revoked": True,
                          **({"reason": reason} if not active else {})})
    else:
        raise ValidationError("Thao tác không hợp lệ.")
    return account_details(actor, user.pk)
