from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import RoleCode
from accounts.permissions import HasCoLogiRole
from accounts.role_serializers import RoleAssignmentSerializer
from accounts.services.account_workspace import (
    BUSINESS_ROLES, account_details, change_account, create_account, edit_account, list_accounts,
)
from accounts.services.role_management import RoleManagementError


class StrictInput:
    def to_internal_value(self, data):
        if hasattr(data, "keys") and set(data) - set(self.fields):
            raise serializers.ValidationError({"non_field_errors": ["Yêu cầu chứa trường không được hỗ trợ."]})
        return super().to_internal_value(data)


class AccountAssignmentInput(StrictInput, RoleAssignmentSerializer):
    role_code = serializers.ChoiceField(choices=BUSINESS_ROLES)
    is_active = serializers.BooleanField(default=True)


class NewProviderInput(StrictInput, serializers.Serializer):
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


class CreateAccountInput(AccountAssignmentInput):
    email = serializers.EmailField(max_length=254)
    full_name = serializers.CharField(max_length=255)
    password = serializers.CharField(write_only=True, trim_whitespace=False, min_length=12, max_length=128)
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


class ConfirmedWrite:
    def validate(self, attrs):
        if not attrs["confirm"]:
            raise serializers.ValidationError({"confirm": ["Cần xác nhận thao tác."]})
        return super().validate(attrs)


class EditAccountInput(ConfirmedWrite, AccountAssignmentInput):
    email = serializers.EmailField(max_length=254, required=False)
    full_name = serializers.CharField(max_length=255, required=False)
    is_active = serializers.BooleanField()
    reason = serializers.CharField(max_length=1000, required=False)
    confirm = serializers.BooleanField()

    def validate_email(self, value):
        return value.lower()


class ChangeAccountInput(ConfirmedWrite, StrictInput, serializers.Serializer):
    operation = serializers.ChoiceField(choices=("RESET_PASSWORD", "ACTIVATE", "DEACTIVATE"))
    confirm = serializers.BooleanField()
    password = serializers.CharField(write_only=True, trim_whitespace=False, min_length=12, max_length=128, required=False)
    reason = serializers.CharField(max_length=1000, required=False)

    def validate(self, attrs):
        operation = attrs["operation"]
        if ("password" in attrs) != (operation == "RESET_PASSWORD"):
            raise serializers.ValidationError({"password": ["Chỉ cung cấp mật khẩu mới khi đặt lại mật khẩu."]})
        if ("reason" in attrs) != (operation == "DEACTIVATE"):
            raise serializers.ValidationError({"reason": ["Nhập lý do khi vô hiệu hóa tài khoản."]})
        return super().validate(attrs)


class AccountManagerView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    required_roles = (RoleCode.MANAGER,)

    @staticmethod
    def require_writes():
        if not getattr(settings, "COLOGI_ACCOUNT_ADMIN_WRITES", False):
            raise PermissionDenied("Quản trị tài khoản đang ở chế độ chỉ đọc.")

    @staticmethod
    def mutate(callback, **kwargs):
        try:
            return callback(**kwargs)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({"password": exc.messages}) from exc
        except RoleManagementError as exc:
            raise serializers.ValidationError("Vai trò hoặc phạm vi nghiệp vụ không hợp lệ.") from exc
        except IntegrityError as exc:
            raise serializers.ValidationError("Tài khoản hoặc phân quyền đã tồn tại hoặc vừa thay đổi.") from exc


class AccountListView(AccountManagerView):
    def get(self, request):
        return Response({
            **list_accounts(request.user), "writes_enabled": getattr(settings, "COLOGI_ACCOUNT_ADMIN_WRITES", False),
            "profile_writes_enabled": getattr(settings, "COLOGI_ACCOUNT_PROFILE_WRITES", False),
            "external_scope_writes_enabled": getattr(settings, "COLOGI_ACCOUNT_EXTERNAL_SCOPE_WRITES", False),
            "unit_registration_enabled": getattr(settings, "COLOGI_ACCOUNT_ADMIN_WRITES", False),
        })

    def post(self, request):
        self.require_writes()
        data = CreateAccountInput(data=request.data)
        data.is_valid(raise_exception=True)
        return Response(self.mutate(
            create_account, actor=request.user, scope=data.get_scope(),
            **{key: value for key, value in data.validated_data.items()
               if key in ("email", "full_name", "role_code", "password", "is_active", "new_provider", "new_supplier", "new_outlet")},
        ), status=status.HTTP_201_CREATED)


class AccountDetailView(AccountManagerView):
    def get(self, request, user_id):
        return Response(account_details(request.user, user_id))

    def post(self, request, user_id):
        self.require_writes()
        data = ChangeAccountInput(data=request.data)
        data.is_valid(raise_exception=True)
        return Response(self.mutate(change_account, actor=request.user, user_id=user_id,
                                    **{key: val for key, val in data.validated_data.items() if key != "confirm"}))

    def patch(self, request, user_id):
        self.require_writes()
        data = EditAccountInput(data=request.data)
        data.is_valid(raise_exception=True)
        return Response(self.mutate(
            edit_account, actor=request.user, user_id=user_id, scope=data.get_scope(),
            **{key: val for key, val in data.validated_data.items()
               if key in ("email", "full_name", "role_code", "is_active", "reason")},
        ))
