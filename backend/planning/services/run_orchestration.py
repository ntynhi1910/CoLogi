
"""Read-only end-to-end orchestration for a CP8 F1 run preview."""

from dataclasses import replace

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import connection, transaction
from django.utils import timezone

from planning.f1.orm_reader import load_f1_orm_data
from planning.services.f1_date_gate import preflight_f1_dates
from planning.services.f1_selection import require_eligible
from planning.services.fulfillment_plan_guard import capture_fulfillment_plan_guard
from planning.services.run_configuration import load_run_configuration
from planning.services.run_preview import preview_f1_run
from planning.services.result_presentation import resolve_demand_display_labels
from planning.services.run_scope import validate_run_scope
from planning.services.snapshot_builder import build_demand_snapshots


def preview_f1_run_for_actor(
    *,
    actor,
    demand_ids,
    rule_set_id,
    cost_profile_id=None,
):
    """Validate scope, capture inputs and return an F1 preview.

    All source reads run in one PostgreSQL REPEATABLE READ transaction.
    This function does not create or modify business records.
    """
    if connection.vendor != "postgresql":
        raise RuntimeError(
            "CP08_F1_PREVIEW_REQUIRES_POSTGRESQL"
        )

    if connection.in_atomic_block:
        raise RuntimeError(
            "CP08_F1_PREVIEW_CANNOT_RUN_INSIDE_EXISTING_TRANSACTION"
        )

    with transaction.atomic():
        # Must be the first SQL statement in this transaction.
        with connection.cursor() as cursor:
            cursor.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
            )

        normalized_ids, scoped_demands = validate_run_scope(
            actor,
            demand_ids,
        )

        scoped_ids = tuple(demand.pk for demand in scoped_demands)
        if scoped_ids != normalized_ids:
            raise ValidationError(
                "RUN_SCOPE_DEMAND_SET_INCONSISTENT"
            )

        captured_at = timezone.now()
        if settings.COLOGI_CP11_ENABLED and settings.COLOGI_CP12_ENABLED:
            require_eligible(actor, scoped_demands, at=captured_at)
        else:
            preflight_f1_dates(scoped_demands, at=captured_at)

        orm_data = load_f1_orm_data(normalized_ids)

        loaded_ids = tuple(
            demand.pk
            for demand in orm_data.selected_demands
        )
        if loaded_ids != normalized_ids:
            raise ValidationError(
                "RUN_SCOPE_CHANGED_DURING_PREVIEW"
            )

        configuration_snapshot = load_run_configuration(
            rule_set_id=rule_set_id,
            cost_profile_id=cost_profile_id,
            captured_at=captured_at,
        )

        snapshots_by_id = build_demand_snapshots(
            orm_data,
            captured_at=captured_at,
            plan_guard_evidence=capture_fulfillment_plan_guard(normalized_ids),
        )

        if set(snapshots_by_id) != set(normalized_ids):
            raise ValidationError(
                "RUN_PREVIEW_SNAPSHOT_DEMAND_SET_INCONSISTENT"
            )

        preview = preview_f1_run(
            snapshots=tuple(
                snapshots_by_id[demand_id]
                for demand_id in normalized_ids
            ),
            configuration_snapshot=configuration_snapshot,
        )
        return replace(preview, display_labels=resolve_demand_display_labels(
            snapshots_by_id, {demand.outlet_id for demand in scoped_demands},
        ))
