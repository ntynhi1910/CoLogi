"""Persist a draft revision and its explicitly allocated Demand membership."""

from uuid import uuid4

from django.db import transaction

from planning.models import DeliveryWave, FulfillmentPlan, WaveDemand


@transaction.atomic
def create_draft_plan(
    *, group, actor, template_type, hub=None, hub_id=None, supersedes=None, waves=(), f2_structure=None, plan_code=None,
):
    """Create a revision. Wave inputs contain wave fields and an allocations iterable."""
    plan = FulfillmentPlan(
        plan_code=plan_code or uuid4().hex,
        group=group,
        created_by=actor,
        template_type=template_type,
        hub_id=hub.pk if hub is not None else hub_id,
        supersedes_plan=supersedes,
        f2_structure=f2_structure,
    )
    plan.full_clean()
    plan.save()
    for wave_fields in waves:
        fields = dict(wave_fields)
        allocations = fields.pop("allocations")
        wave = DeliveryWave(plan=plan, **fields)
        wave.full_clean()
        wave.save()
        for demand_id, quantity in allocations:
            allocation = WaveDemand(wave=wave, demand_id=demand_id, allocated_quantity_kg=quantity)
            allocation.full_clean()
            allocation.save()
    return plan
