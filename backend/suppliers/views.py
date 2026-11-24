from decimal import Decimal

from django.db import DatabaseError, IntegrityError, transaction
from django.db.models import Prefetch, Sum
from rest_framework import generics, serializers, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from accounts.permissions import (
    HasExternalActorScope,
    get_active_external_access,
)
from demands.models import SupplierItemPromise, SupplierRequest
from masterdata.models import CargoCategory, Item, SupplierItem
from masterdata.serializers import SupplierItemReadSerializer
from planning.services.inventory import open_catalog_stock

from .serializers import (
    SupplierAvailableItemSerializer,
    SupplierCargoCategorySerializer,
    SupplierCatalogCreateSerializer,
    SupplierCatalogUpdateSerializer,
    SupplierRequestReadSerializer,
    SupplierRequestResponseInputSerializer,
)
from .services import respond_to_supplier_request


class SupplierRequestScopeMixin:
    permission_classes = [IsAuthenticated, HasExternalActorScope]
    required_actor_type = "SUPPLIER"
    external_scope_field = "supplier_id"

    def get_supplier_access(self):
        access = get_active_external_access(
            self.request.user,
            self.required_actor_type,
        )
        if access is None or access.supplier_id is None:
            raise PermissionDenied("Active supplier access is required.")
        return access

    def get_queryset(self):
        from accounts.capstone import actor_scenario

        access = self.get_supplier_access()
        return (
            SupplierRequest.objects
            .filter(supplier_id=access.supplier_id, demand__capstone_scenario=actor_scenario(self.request.user))
            .select_related(
                "demand",
                "demand__outlet",
                "supplier_confirmation",
            )
            .prefetch_related(
                Prefetch(
                    "item_promises",
                    queryset=SupplierItemPromise.objects.select_related(
                        "demand_item",
                        "demand_item__item",
                    ).order_by("id"),
                )
            )
        )


class SupplierRequestListView(
    SupplierRequestScopeMixin,
    generics.ListAPIView,
):
    serializer_class = SupplierRequestReadSerializer


class SupplierCatalogListView(
    SupplierRequestScopeMixin,
    generics.ListAPIView,
):
    """Read-only catalogue belonging to the authenticated supplier."""

    serializer_class = SupplierItemReadSerializer

    def get_queryset(self):
        access = self.get_supplier_access()
        return (
            SupplierItem.objects
            .filter(supplier_id=access.supplier_id)
            .select_related("supplier", "item")
            .order_by("item__item_code")
        )



class SupplierAvailableItemListView(
    SupplierRequestScopeMixin,
    generics.ListAPIView,
):
    serializer_class = SupplierAvailableItemSerializer

    def get_queryset(self):
        self.get_supplier_access()
        return (
            Item.objects.filter(
                is_active=True,
                cargo_category__is_active=True,
            )
            .select_related("cargo_category")
            .order_by("item_code")
        )


class SupplierCargoCategoryListView(
    SupplierRequestScopeMixin,
    generics.ListAPIView,
):
    serializer_class = SupplierCargoCategorySerializer

    def get_queryset(self):
        self.get_supplier_access()
        return CargoCategory.objects.filter(
            is_active=True,
        ).order_by("category_code")


class SupplierCatalogListView(
    SupplierRequestScopeMixin,
    generics.ListCreateAPIView,
):
    """List and register offers owned by the authenticated supplier."""

    serializer_class = SupplierItemReadSerializer

    def get_queryset(self):
        access = self.get_supplier_access()
        return (
            SupplierItem.objects
            .filter(supplier_id=access.supplier_id)
            .select_related("supplier", "item")
            .order_by("item__item_code")
        )

    def get_serializer_class(self):
        if self.request.method == "POST":
            return SupplierCatalogCreateSerializer
        return SupplierItemReadSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        access = self.get_supplier_access()

        try:
            with transaction.atomic():
                if data.get("item_id") is not None:
                    item = Item.objects.get(
                        pk=data["item_id"],
                        is_active=True,
                        cargo_category__is_active=True,
                    )
                else:
                    item = None
                    item_fields = {
                        "item_name": data["item_name"],
                        "cargo_category_id": data["cargo_category_id"],
                        "weight_unit": data["weight_unit"],
                        "item_description": data.get("item_description"),
                        "is_active": True,
                    }

                    # Sequential ITM codes; the unique DB constraint is
                    # the final concurrency guard.
                    for _ in range(10):
                        existing_codes = Item.objects.filter(
                            item_code__startswith="ITM",
                        ).values_list("item_code", flat=True)

                        max_number = 0
                        for code in existing_codes:
                            suffix = code[3:]
                            if suffix.isdigit():
                                max_number = max(max_number, int(suffix))

                        candidate = f"ITM{max_number + 1:03d}"
                        try:
                            with transaction.atomic():
                                item = Item.objects.create(
                                    item_code=candidate,
                                    **item_fields,
                                )
                            break
                        except IntegrityError:
                            if Item.objects.filter(
                                item_code=candidate,
                            ).exists():
                                continue
                            raise
                        except DatabaseError as error:
                            if getattr(error.__cause__, "sqlstate", None) != "42501":
                                raise
                            return Response({"item_name": "Tạo SKU mới chưa được bật. "
                                             "Bạn vẫn có thể chọn mặt hàng có sẵn."},
                                            status=status.HTTP_503_SERVICE_UNAVAILABLE)

                    if item is None:
                        raise serializers.ValidationError({
                            "item_name": (
                                "Không thể sinh mã Item duy nhất. "
                                "Vui lòng thử lại."
                            )
                        })

                if SupplierItem.objects.filter(
                    supplier_id=access.supplier_id,
                    item_id=item.pk,
                ).exists():
                    raise serializers.ValidationError({
                        "item_id": (
                            "Supplier đã đăng ký điều kiện cung ứng "
                            "cho mặt hàng này."
                        )
                    })

                offer = SupplierItem.objects.create(
                    supplier_id=access.supplier_id,
                    item=item,
                    unit_price_vnd_per_kg=data["unit_price_vnd_per_kg"],
                    max_daily_supply_kg=data.get("max_daily_supply_kg"),
                    lead_time_hours=data.get("lead_time_hours"),
                    minimum_order_kg=data.get("minimum_order_kg"),
                    offer_status=data.get(
                        "offer_status",
                        SupplierItem.OfferStatus.ACTIVE,
                    ),
                )
                if "opening_stock_kg" in data:
                    open_catalog_stock(actor=request.user, catalog=offer, amount=data["opening_stock_kg"])
        except Item.DoesNotExist:
            raise serializers.ValidationError({
                "item_id": "Item không tồn tại hoặc đã ngừng hoạt động."
            })
        except IntegrityError:
            raise serializers.ValidationError({
                "item_id": (
                    "Offer đã tồn tại hoặc dữ liệu bị trùng. "
                    "Vui lòng tải lại danh mục."
                )
            })

        output = SupplierItemReadSerializer(
            offer,
            context=self.get_serializer_context(),
        )
        return Response(output.data, status=status.HTTP_201_CREATED)


class SupplierCatalogUpdateView(
    SupplierRequestScopeMixin,
    generics.GenericAPIView,
):
    serializer_class = SupplierCatalogUpdateSerializer

    def get_queryset(self):
        access = self.get_supplier_access()
        return (
            SupplierItem.objects
            .filter(supplier_id=access.supplier_id)
            .select_related("supplier", "item")
        )

    def patch(self, request, *args, **kwargs):
        offer = self.get_object()
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        for field, value in serializer.validated_data.items():
            setattr(offer, field, value)

        offer.save()
        return Response(
            SupplierItemReadSerializer(
                offer,
                context=self.get_serializer_context(),
            ).data,
            status=status.HTTP_200_OK,
        )


class SupplierRequestConfirmView(
    SupplierRequestScopeMixin,
    generics.GenericAPIView,
):
    allow_capstone_writes = True
    serializer_class = SupplierRequestResponseInputSerializer

    def post(self, request, *args, **kwargs):
        supplier_request = self.get_object()
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        access = self.get_supplier_access()
        updated_request = respond_to_supplier_request(
            request_id=supplier_request.pk,
            supplier_id=access.supplier_id,
            actor=request.user,
            response_data=serializer.validated_data,
            ip_address=request.META.get("REMOTE_ADDR"),
        )

        updated_request = self.get_queryset().get(pk=updated_request.pk)
        totals = updated_request.item_promises.aggregate(
            promised=Sum("promised_weight_kg"),
            confirmed=Sum("confirmed_weight_kg"),
        )
        promised = totals["promised"] or Decimal("0")
        confirmed = totals["confirmed"] or Decimal("0")

        return Response(
            {
                "confirmation_status": (
                    updated_request.supplier_confirmation.confirmation_status
                ),
                "missing_qty": str(promised - confirmed),
                "request": SupplierRequestReadSerializer(updated_request).data,
            },
            status=status.HTTP_200_OK,
        )
