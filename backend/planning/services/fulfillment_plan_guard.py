"""Read finalized Plan membership from the CP08 PostgreSQL snapshot."""

from django.db import DatabaseError, connection, transaction
from django.utils import timezone

from planning.models import FulfillmentPlan, FulfillmentPlanStatus
from planning.services.plan_guard import CONFLICT, PASS, _authoritative_reference


def _finalized_membership():
    # A left join is intentional. A FINALIZED plan or wave without allocation
    # is incomplete evidence, even if no row matches the selected scope.
    return list(
        FulfillmentPlan.objects.filter(status=FulfillmentPlanStatus.FINALIZED)
        .order_by("pk", "waves__pk", "waves__allocations__demand_id")
        .values_list("pk", "supersedes_plan_id", "waves__pk", "waves__allocations__demand_id")
    )


def capture_fulfillment_plan_guard(demand_ids):
    """Return scope evidence inside an existing REPEATABLE READ transaction."""
    if connection.vendor != "postgresql" or not connection.in_atomic_block:
        return {}
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SHOW transaction_isolation")
                if cursor.fetchone()[0] != "repeatable read":
                    return {}
            rows = _finalized_membership()
    except DatabaseError:
        # The savepoint restores Transaction A after a missing or unavailable table.
        return {}

    revisions_by_demand = {demand_id: set() for demand_id in demand_ids}
    parent_by_plan = {}
    for plan_id, parent_id, wave_id, demand_id in rows:
        if (
            any(type(pk) is not int or pk <= 0 for pk in (plan_id, wave_id, demand_id))
            or (parent_id is not None and (type(parent_id) is not int or parent_id <= 0 or parent_id == plan_id))
            or parent_by_plan.setdefault(plan_id, parent_id) != parent_id
        ):
            return {}
        if demand_id in revisions_by_demand:
            revisions_by_demand[demand_id].add((plan_id, parent_id))

    evaluated_at = timezone.now().isoformat().replace("+00:00", "Z")
    return {
        demand_id: {
            "status": CONFLICT if revisions else PASS,
            "source_system": "FULFILLMENT_PLAN",
            "evaluated_at": evaluated_at,
            "evidence_reference": _authoritative_reference(demand_id, revisions),
        }
        for demand_id, revisions in revisions_by_demand.items()
    }
