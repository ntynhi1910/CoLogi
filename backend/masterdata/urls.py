from django.urls import path
from .outlet_views import OutletWorkspaceCalendar, OutletWorkspaceDetail, OutletWorkspaceList, OutletWorkspaceState

from .views import (
    CargoCategoryListView,
    ItemListView,
    OutletListView,
    SupplierItemListView,
    SupplierListView,
)


urlpatterns = [
    path("outlet-workspace/", OutletWorkspaceList.as_view(), name="outlet-workspace-list"),
    path("outlet-workspace/<int:outlet_id>/", OutletWorkspaceDetail.as_view(), name="outlet-workspace-detail"),
    path("outlet-workspace/<int:outlet_id>/state/", OutletWorkspaceState.as_view(), name="outlet-workspace-state"),
    path("outlet-workspace/<int:outlet_id>/windows/", OutletWorkspaceCalendar.as_view(kind="windows"), name="outlet-workspace-windows"),
    path("outlet-workspace/<int:outlet_id>/windows/<int:row_id>/", OutletWorkspaceCalendar.as_view(kind="windows")),
    path("outlet-workspace/<int:outlet_id>/slots/", OutletWorkspaceCalendar.as_view(kind="slots"), name="outlet-workspace-slots"),
    path("outlet-workspace/<int:outlet_id>/slots/<int:row_id>/", OutletWorkspaceCalendar.as_view(kind="slots")),
    path(
        "suppliers/",
        SupplierListView.as_view(),
        name="masterdata-supplier-list",
    ),
    path(
        "outlets/",
        OutletListView.as_view(),
        name="masterdata-outlet-list",
    ),
    path(
        "cargo-categories/",
        CargoCategoryListView.as_view(),
        name="masterdata-cargo-category-list",
    ),
    path(
        "items/",
        ItemListView.as_view(),
        name="masterdata-item-list",
    ),
    path(
        "supplier-items/",
        SupplierItemListView.as_view(),
        name="masterdata-supplier-item-list",
    ),
]
