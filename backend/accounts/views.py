from django.conf import settings
from django.contrib.auth import authenticate
from django.db import InternalError, transaction
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from drf_spectacular.utils import OpenApiResponse, extend_schema

from .models import ExternalUserAccess, User, UserRole
from .serializers import (
    CurrentUserSerializer,
    LoginResponseSerializer,
    LoginSerializer,
)


class LoginView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    @extend_schema(
        operation_id="auth_login",
        tags=["Authentication"],
        request=LoginSerializer,
        responses={
            200: LoginResponseSerializer,
            400: OpenApiResponse(description="Request validation failed."),
            401: OpenApiResponse(description="Invalid email or password."),
            503: OpenApiResponse(description="The review database cannot issue a token."),
        },
    )
    @transaction.atomic
    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        email = serializer.validated_data["email"].strip().lower()
        password = serializer.validated_data["password"]

        if getattr(settings, "COLOGI_ACCOUNT_ADMIN_WRITES", False):
            # Serialize credential checks and token issuance with account edits and resets.
            User.objects.select_for_update().filter(email=email).only("pk").first()
        user = authenticate(
            request,
            email=email,
            password=password,
        )

        if user is None or not user.is_active:
            return Response(
                {"detail": "Invalid email or password."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        try:
            token, _ = Token.objects.get_or_create(user=user)
        except InternalError as exc:
            if getattr(exc.__cause__, "sqlstate", None) != "25006":
                raise
            return Response(
                {"detail": "The review database is read-only. A session cannot be issued."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(
            {
                "token": token.key,
                "user": {
                    "id": user.pk,
                    "email": user.email,
                    "full_name": user.full_name,
                },
            },
            status=status.HTTP_200_OK,
        )


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="auth_logout",
        tags=["Authentication"],
        request=None,
        responses={
            204: OpenApiResponse(description="Token revoked; no response body."),
            401: OpenApiResponse(description="Authentication required."),
        },
    )
    def post(self, request):
        request.auth.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class CurrentUserView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="auth_current_user",
        tags=["Authentication"],
        responses={
            200: CurrentUserSerializer,
            401: OpenApiResponse(description="Authentication required."),
        },
    )
    def get(self, request):
        user = request.user

        roles = list(
            UserRole.objects.filter(
                user=user,
                is_active=True,
                role__is_active=True,
            )
            .order_by("role__code")
            .values_list("role__code", flat=True)
        )

        external_accesses = list(
            ExternalUserAccess.objects.filter(
                user=user,
                is_active=True,
            )
            .order_by("actor_type")
            .values(
                "actor_type",
                "supplier_id",
                "provider_id",
            )
        )

        return Response(
            {
                "id": user.pk,
                "email": user.email,
                "full_name": user.full_name,
                "roles": roles,
                "external_accesses": external_accesses,
                **({"capstone_scenario": user.capstone_scenario} if user.capstone_scenario else {}),
            }
        )
