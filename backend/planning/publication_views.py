from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import RoleCode
from accounts.permissions import HasCoLogiRole
from planning.delivery_views import _call
from planning.services.plan_publication import read_publications
from suppliers.views import SupplierRequestScopeMixin


class SupplierPublicationView(SupplierRequestScopeMixin, APIView):
    def get(self, request, code=None):
        return Response(_call(read_publications, actor=request.user, audience="supplier",
                              supplier_id=self.get_supplier_access().supplier_id, code=code))


class PurchasingPublicationView(APIView):
    permission_classes = [IsAuthenticated, HasCoLogiRole]
    required_roles = (RoleCode.PURCHASING_STAFF,)

    def get(self, request, code=None):
        return Response(_call(read_publications, actor=request.user, audience="purchasing", code=code))
