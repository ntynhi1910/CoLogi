from uuid import uuid4

from django.db.models import F, Func, Value, Q
from django.db.models.lookups import Exact
from django.db.models.fields.json import KeyTextTransform

from .json_validators import (
    validate_diagnostics_array,
    validate_json_object,
    validate_demand_snapshot,
)
from django.conf import settings
from django.db import models
from django.core.exceptions import ValidationError
from django.db import connections, router, transaction
from .fields import Char3Field
from .f2_structure import SCHEMA_VERSION, validate_f2_structure
from .f3_contract import evaluation_contract_version, validate_saved_document
from .f4_contract import VERSION as F4_CONTRACT_VERSION, validate_document as validate_f4_document
from .services.f3_hub_coverage import uat_hub_coverage_enabled


class RuleSetStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    ACTIVE = "ACTIVE", "Active"
    RETIRED = "RETIRED", "Retired"


class DecisionOutcome(models.TextChoices):
    APPROVE = "APPROVE", "Approve"
    REJECT = "REJECT", "Reject"
    REQUEST_RECALCULATION = "REQUEST_RECALCULATION", "Request recalculation"


class CarrierOutcome(models.TextChoices):
    CONFIRM = "CONFIRM", "Confirm"
    DECLINE = "DECLINE", "Decline"


class PlanningModuleCode(models.TextChoices):
    F1 = "F1", "F1"
    F2 = "F2", "F2"
    F3 = "F3", "F3"
    F4 = "F4", "F4"
    F5 = "F5", "F5"


class PlanningRunStatus(models.TextChoices):
    IN_PROGRESS = "IN_PROGRESS", "In progress"
    COMPLETED = "COMPLETED", "Completed"
    FAILED = "FAILED", "Failed"


class PlanningRunSourceMode(models.TextChoices):
    SYNTHETIC = "SYNTHETIC", "Synthetic"
    MANUAL = "MANUAL", "Manual"
    BATCH = "BATCH", "Batch"
    API = "API", "API"


class EligibilityStatus(models.TextChoices):
    NOT_EVALUATED = "NOT_EVALUATED", "Not evaluated"
    ELIGIBLE = "ELIGIBLE", "Eligible"
    EXCLUDED = "EXCLUDED", "Excluded"


class PlanGuardStatus(models.TextChoices):
    PASS = "PASS", "Pass"
    CONFLICT = "CONFLICT", "Conflict"
    NOT_EVALUATED = "NOT_EVALUATED", "Not evaluated"


class MatchingStatus(models.TextChoices):
    NOT_EVALUATED = "NOT_EVALUATED", "Not evaluated"
    UNMATCHED = "UNMATCHED", "Unmatched"
    INCLUDED = "INCLUDED", "Included"
    MULTIPLE_CANDIDATES = "MULTIPLE_CANDIDATES", "Multiple candidates"


class CollaborationGroupStatus(models.TextChoices):
    CANDIDATE = "CANDIDATE", "Candidate"
    ACCEPTED = "ACCEPTED", "Accepted"
    MODIFIED = "MODIFIED", "Modified"
    REJECTED = "REJECTED", "Rejected"


class GroupDemandEligibilityStatus(models.TextChoices):
    INCLUDED = "INCLUDED", "Included"
    EXCLUDED = "EXCLUDED", "Excluded"


class _ProtectedPlanningQuerySet(models.QuerySet):
    """Guard writes that would skip instance-level planning invariants."""

    def update(self, **kwargs):
        raise ValidationError("Use instance saves for protected planning records.")

    def delete(self):
        raise ValidationError("Use instance deletion for protected planning records.")

    def bulk_create(self, *args, **kwargs):
        raise ValidationError("Use instance creation for protected planning records.")

    def bulk_update(self, *args, **kwargs):
        raise ValidationError("Use instance saves for protected planning records.")


class _ProtectedPlanningWrites(models.Model):
    objects = _ProtectedPlanningQuerySet.as_manager()

    class Meta:
        abstract = True

    def save_base(self, raw=False, force_insert=False, force_update=False, using=None, update_fields=None):
        if raw:
            raise ValidationError("Protected planning records require validated writes.")
        if self._state.adding:
            if force_update or update_fields is not None:
                raise ValidationError("Load the protected planning record before updating it.")
            force_insert = True
        using = using or router.db_for_write(type(self), instance=self)
        with transaction.atomic(using=using):
            self._validate_write(using, update_fields)
            super().save_base(
                raw=raw, force_insert=force_insert, force_update=force_update,
                using=using, update_fields=update_fields,
            )


def _require_read_committed(using):
    # In REPEATABLE READ a writer could miss a Run committed while it waited on the RuleSet.
    with connections[using].cursor() as cursor:
        cursor.execute("SHOW transaction_isolation")
        if cursor.fetchone()[0] != "read committed":
            raise ValidationError("RuleSet configuration writes require READ COMMITTED.")


class PlanningRuleSet(_ProtectedPlanningWrites):
    rule_set_code = models.CharField(max_length=40, unique=True)
    rule_set_name = models.CharField(max_length=150)
    version_no = models.PositiveIntegerField()
    status = models.CharField(
        max_length=20,
        choices=RuleSetStatus.choices,
    )
    effective_from = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_planning_rule_sets",
    )

    class Meta:
        db_table = "rule_sets"
        base_manager_name = "objects"
        constraints = [
            models.CheckConstraint(
                condition=Q(version_no__gt=0),
                name="ck_rule_sets_version_positive",
            ),
            models.CheckConstraint(
                condition=Q(status__in=RuleSetStatus.values),
                name="ck_rule_sets_status_valid",
            ),
        ]

    def __str__(self):
        return f"{self.rule_set_code} v{self.version_no}"

    def _validate_write(self, using, update_fields):
        _require_read_committed(using)
        if self.pk is None:
            return
        rule_set = type(self).objects.using(using).select_for_update().filter(pk=self.pk).first()
        if rule_set is None or not PlanningRun.objects.using(using).filter(rule_set=rule_set).exists():
            return
        allowed_status = self.status in (rule_set.status, RuleSetStatus.RETIRED)
        if update_fields is not None:
            allowed = set(update_fields) <= {"status"}
        else:
            allowed = all(
                getattr(self, field.attname) == getattr(rule_set, field.attname)
                for field in self._meta.concrete_fields if field.name != "status"
            )
        if not allowed or not allowed_status:
            raise ValidationError("A RuleSet used by a PlanningRun requires a new version.")

    def delete(self, using=None, keep_parents=False):
        using = using or router.db_for_write(type(self), instance=self)
        with transaction.atomic(using=using):
            _lock_unused_rule_set(self.pk, using)
            return super().delete(using=using, keep_parents=keep_parents)


def _lock_unused_rule_set(rule_set_id, using):
    _require_read_committed(using)
    PlanningRuleSet.objects.using(using).select_for_update().get(pk=rule_set_id)
    if PlanningRun.objects.using(using).filter(rule_set_id=rule_set_id).exists():
        raise ValidationError("A RuleSet used by a PlanningRun requires a new version.")


class PlanningBusinessRule(_ProtectedPlanningWrites):
    rule_set = models.ForeignKey(
        PlanningRuleSet,
        on_delete=models.PROTECT,
        related_name="business_rules",
        db_index=False,
    )
    rule_code = models.CharField(max_length=50)
    module_code = models.CharField(
        max_length=5,
        choices=PlanningModuleCode.choices,
    )
    rule_name = models.CharField(max_length=150)
    description = models.TextField(null=True, blank=True)
    rule_definition = models.JSONField()
    priority = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "business_rules"
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=("rule_set", "rule_code"),
                name="uq_business_rules_set_code",
            ),
            models.CheckConstraint(
                condition=Q(module_code__in=PlanningModuleCode.values),
                name="ck_business_rules_module_valid",
            ),
            models.CheckConstraint(
                condition=Q(priority__gte=0),
                name="ck_business_rules_priority_nonnegative",
            ),
        ]

    def __str__(self):
        return f"{self.rule_set.rule_set_code}:{self.rule_code}"

    def _validate_write(self, using, update_fields):
        if self.pk is not None:
            current_rule_set_id = (
                type(self).objects.using(using).filter(pk=self.pk)
                .values_list("rule_set_id", flat=True).first()
            )
            if current_rule_set_id is not None and current_rule_set_id != self.rule_set_id:
                raise ValidationError("Create a new BusinessRule in the target RuleSet.")
        _lock_unused_rule_set(self.rule_set_id, using)

    def delete(self, using=None, keep_parents=False):
        using = using or router.db_for_write(type(self), instance=self)
        with transaction.atomic(using=using):
            rule_set_id = type(self).objects.using(using).values_list("rule_set_id", flat=True).get(pk=self.pk)
            _lock_unused_rule_set(rule_set_id, using)
            return super().delete(using=using, keep_parents=keep_parents)


class PlanningParameters(models.Model):
    parameter_key = models.CharField(max_length=100, unique=True)
    parameter_value = models.JSONField()
    data_type = models.CharField(max_length=20)
    description = models.TextField(null=True, blank=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_planning_parameters",
        null=True,
        blank=True,
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "planning_parameters"

    def __str__(self):
        return self.parameter_key


class CostProfile(models.Model):
    profile_code = models.CharField(max_length=40, unique=True)
    profile_name = models.CharField(max_length=150)
    currency_code = Char3Field(max_length=3)
    fixed_transport_cost = models.DecimalField(
        max_digits=14, decimal_places=2
    )
    cost_per_km = models.DecimalField(
        max_digits=14,
        decimal_places=2,
        null=True,
        blank=True,
    )
    additional_handling_cost = models.DecimalField(
        max_digits=14, decimal_places=2
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "cost_profiles"
        constraints = [
            models.CheckConstraint(
                condition=Q(fixed_transport_cost__gte=0),
                name="ck_cost_profiles_fixed_nonnegative",
            ),
            models.CheckConstraint(
                condition=(
                    Q(cost_per_km__isnull=True)
                    | Q(cost_per_km__gte=0)
                ),
                name="ck_cost_profiles_per_km_nonnegative",
            ),
            models.CheckConstraint(
                condition=Q(additional_handling_cost__gte=0),
                name="ck_cost_profiles_handling_nonnegative",
            ),
            models.CheckConstraint(
                condition=Q(currency_code="VND"),
                name="ck_cost_profiles_currency_vnd",
            ),
        ]

    def __str__(self):
        return f"{self.profile_code} - {self.profile_name}"


class PlanningRun(models.Model):
    run_code = models.UUIDField(unique=True)
    rule_set = models.ForeignKey(
        PlanningRuleSet,
        on_delete=models.PROTECT,
        related_name="planning_runs",
    )
    cost_profile = models.ForeignKey(
        CostProfile,
        on_delete=models.PROTECT,
        related_name="planning_runs",
        null=True,
        blank=True,
    )
    initiated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="initiated_planning_runs",
        db_index=False,
    )
    started_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=PlanningRunStatus.choices,
    )
    source_mode = models.CharField(
        max_length=30,
        choices=PlanningRunSourceMode.choices,
    )
    scenario_tag = models.CharField(
        max_length=50,
        null=True,
        blank=True,
    )
    source_reference = models.CharField(
        max_length=255,
        null=True,
        blank=True,
    )
    parameters_snapshot = models.JSONField(
        validators=[validate_json_object],
    )
    failure_diagnostics = models.JSONField(
        default=list,
        validators=[validate_diagnostics_array],
    )


    class Meta:
        db_table = "planning_runs"
        indexes = [
            models.Index(
                fields=("status", "started_at"),
                name="ix_planning_runs_status_time",
            ),
            models.Index(
                fields=("initiated_by", "started_at"),
                name="ix_planning_runs_actor_time",
            ),
        ]
        constraints = [
            # PlanningRun.Meta.constraints
            models.CheckConstraint(
                condition=Exact(
                    Func(F("parameters_snapshot"), function="jsonb_typeof"),
                    Value("object"),
                ),
                name="ck_planning_runs_snapshot_object",
            ),
            models.CheckConstraint(
                condition=Exact(
                    Func(F("failure_diagnostics"), function="jsonb_typeof"),
                    Value("array"),
                ),
                name="ck_planning_runs_failure_diag_array",
            ),
            models.CheckConstraint(
                condition=Q(status__in=PlanningRunStatus.values),
                name="ck_planning_runs_status_valid",
            ),
            models.CheckConstraint(
                condition=Q(source_mode__in=PlanningRunSourceMode.values),
                name="ck_planning_runs_source_valid",
            ),
            models.CheckConstraint(
                condition=(
                    Q(status=PlanningRunStatus.IN_PROGRESS,
                      completed_at__isnull=True)
                    | Q(
                        status__in=[
                            PlanningRunStatus.COMPLETED,
                            PlanningRunStatus.FAILED,
                        ],
                        completed_at__isnull=False,
                    )
                ),
                name="ck_planning_runs_completion_time",
            ),
        ]

    def __str__(self):
        return str(self.run_code)


class PlanningRunDemand(models.Model):
    planning_run = models.ForeignKey(
        PlanningRun,
        on_delete=models.PROTECT,
        related_name="run_demands",
        db_index=False,
    )
    demand = models.ForeignKey(
        "demands.DeliveryDemand",
        on_delete=models.PROTECT,
        related_name="planning_run_records",
    )
    demand_snapshot = models.JSONField(
        validators=[validate_demand_snapshot],
    )
    eligibility_status = models.CharField(
        max_length=20,
        choices=EligibilityStatus.choices,
        default=EligibilityStatus.NOT_EVALUATED,
    )
    primary_reason_code = models.CharField(
        max_length=100,
        null=True,
        blank=True,
    )
    plan_guard_status = models.CharField(
        max_length=20,
        choices=PlanGuardStatus.choices,
        default=PlanGuardStatus.NOT_EVALUATED,
    )
    matching_status = models.CharField(
        max_length=30,
        choices=MatchingStatus.choices,
        default=MatchingStatus.NOT_EVALUATED,
    )
    diagnostics = models.JSONField(
        default=list,
        validators=[validate_diagnostics_array],
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "planning_run_demands"
        constraints = [
            # PlanningRunDemand.Meta.constraints
            models.CheckConstraint(
                condition=Exact(
                    Func(F("diagnostics"), function="jsonb_typeof"),
                    Value("array"),
                ),
                name="ck_run_demands_diagnostics_array",
            ),
            models.UniqueConstraint(
                fields=("planning_run", "demand"),
                name="uq_planning_run_demands_run_demand",
            ),
            models.CheckConstraint(
                condition=Q(
                    eligibility_status__in=EligibilityStatus.values
                ),
                name="ck_planning_run_demands_eligibility",
            ),
            models.CheckConstraint(
                condition=Q(
                    plan_guard_status__in=PlanGuardStatus.values
                ),
                name="ck_planning_run_demands_plan_guard",
            ),
            models.CheckConstraint(
                condition=Q(matching_status__in=MatchingStatus.values),
                name="ck_planning_run_demands_matching",
            ),
        ]
        indexes = [
            models.Index(
                fields=("planning_run", "eligibility_status"),
                name="ix_run_demands_eligibility",
            ),
            models.Index(
                fields=("planning_run", "matching_status"),
                name="ix_run_demands_matching",
            ),
        ]


class CollaborationGroup(models.Model):
    group_code = models.CharField(max_length=40, unique=True)
    run_code = models.UUIDField()
    status = models.CharField(
        max_length=20,
        choices=CollaborationGroupStatus.choices,
    )
    matching_reason = models.JSONField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_collaboration_groups",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "collaboration_groups"
        indexes = [
            models.Index(
                fields=("run_code", "status"),
                name="ix_collab_groups_run_status",
            ),
        ]
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=CollaborationGroupStatus.values),
                name="ck_collaboration_groups_status",
            ),
        ]

    def __str__(self):
        return self.group_code



class GroupDemand(models.Model):
    pk = models.CompositePrimaryKey("group_id", "demand_id")

    group = models.ForeignKey(
        CollaborationGroup,
        on_delete=models.PROTECT,
        related_name="group_demands",
        db_index=False,
    )
    demand = models.ForeignKey(
        "demands.DeliveryDemand",
        on_delete=models.PROTECT,
        related_name="collaboration_group_links",
    )
    eligibility_status = models.CharField(
        max_length=20,
        choices=GroupDemandEligibilityStatus.choices,
    )
    matching_reason = models.JSONField(null=True, blank=True)

    class Meta:
        db_table = "group_demands"
        constraints = [
            models.CheckConstraint(
                condition=Q(
                    eligibility_status__in=GroupDemandEligibilityStatus.values
                ),
                name="ck_group_demands_eligibility",
            ),
        ]


class FulfillmentPlanStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    VALIDATING = "VALIDATING", "Validating"
    PENDING_APPROVAL = "PENDING_APPROVAL", "Pending approval"
    APPROVED = "APPROVED", "Approved"
    REJECTED = "REJECTED", "Rejected"
    FINALIZED = "FINALIZED", "Finalized"


class PlanTemplateType(models.TextChoices):
    DIRECT_CONSOLIDATED = "DIRECT_CONSOLIDATED", "Direct consolidated"
    HUB_BASED = "HUB_BASED", "Hub based"


class _PlanRevisionRecord(_ProtectedPlanningWrites):
    class Meta:
        abstract = True

    def save_base(self, raw=False, force_insert=False, force_update=False, using=None, update_fields=None):
        if not self._state.adding or force_update or update_fields is not None:
            raise ValidationError("Plan structure changes require a new revision.")
        return super().save_base(raw=raw, force_insert=True, using=using)

    def delete(self, using=None, keep_parents=False):
        raise ValidationError("Plan revisions and their allocations are retained.")


class FulfillmentPlan(_PlanRevisionRecord):
    plan_code = models.CharField(max_length=40, unique=True)
    group = models.ForeignKey(CollaborationGroup, on_delete=models.PROTECT, related_name="plans")
    template_type = models.CharField(max_length=30, choices=PlanTemplateType.choices)
    hub = models.ForeignKey("masterdata.Hub", on_delete=models.PROTECT, null=True, blank=True)
    status = models.CharField(max_length=25, choices=FulfillmentPlanStatus.choices, default=FulfillmentPlanStatus.DRAFT)
    recommendation_reason = models.JSONField(null=True, blank=True)
    override_reason = models.TextField(null=True, blank=True)
    f2_structure = models.JSONField(null=True, blank=True, validators=[validate_f2_structure])
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    supersedes_plan = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="revisions",
    )

    class Meta:
        db_table = "fulfillment_plans"
        base_manager_name = "objects"
        indexes = [models.Index(fields=("status",), name="ix_fulfillment_plans_status")]
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=FulfillmentPlanStatus.values), name="ck_fulfillment_plan_status",
            ),
            models.CheckConstraint(
                condition=Q(template_type__in=PlanTemplateType.values), name="ck_fulfillment_plan_template",
            ),
            models.CheckConstraint(
                condition=~Q(supersedes_plan_id=F("id")), name="ck_fulfillment_plan_not_self",
            ),
            models.CheckConstraint(
                condition=Q(f2_structure__isnull=True) | (
                    Exact(Func(F("f2_structure"), function="jsonb_typeof"), "object")
                    & Q(f2_structure__has_keys=["schema_version", "lineage", "basis", "option"])
                    & Q(f2_structure__schema_version=SCHEMA_VERSION)
                    & Q(f2_structure__option__has_keys=["template_type", "structural_status", "hub"])
                    & Q(f2_structure__option__structural_status="COMPLETE")
                    & Exact(KeyTextTransform.from_lookup("f2_structure__option__template_type"), F("template_type"))
                    & (
                        Q(template_type=PlanTemplateType.DIRECT_CONSOLIDATED, hub__isnull=True, f2_structure__option__hub=None)
                        | Q(template_type=PlanTemplateType.HUB_BASED, hub__isnull=False, f2_structure__option__hub__has_key="id")
                    )
                ),
                name="ck_fulfillment_plan_f2_structure",
            ),
            models.UniqueConstraint(
                fields=("group", "template_type", "hub"),
                condition=Q(f2_structure__isnull=False, supersedes_plan__isnull=True),
                nulls_distinct=False,
                name="uq_fulfillment_plan_f2_identity_root",
            ),
            models.UniqueConstraint(
                fields=("supersedes_plan", "template_type", "hub"),
                condition=Q(f2_structure__isnull=False, supersedes_plan__isnull=False),
                nulls_distinct=False,
                name="uq_fulfillment_plan_f2_identity_successor",
            ),
        ]

    def _validate_write(self, using, update_fields):
        if self.status != FulfillmentPlanStatus.DRAFT:
            raise ValidationError("CP08 creates DRAFT Plan revisions.")
        predecessor = None
        if self.supersedes_plan_id is not None:
            predecessor = type(self).objects.using(using).get(pk=self.supersedes_plan_id)
        if self.f2_structure is not None:
            validate_f2_structure(self.f2_structure)
            lineage, option = self.f2_structure["lineage"], self.f2_structure["option"]
            group = CollaborationGroup.objects.using(using).select_for_update().get(pk=self.group_id)
            member_ids = list(group.group_demands.using(using).filter(
                eligibility_status=GroupDemandEligibilityStatus.INCLUDED,
            ).order_by("demand_id").values_list("demand_id", flat=True))
            if (
                option["template_type"] != self.template_type
                or (option["hub"]["id"] if option["hub"] else None) != self.hub_id
                or str(group.run_code) != lineage["run_code"] or group.group_code != lineage["group_code"]
                or group.created_by_id != self.created_by_id or group.status != CollaborationGroupStatus.CANDIDATE
                or member_ids != option["demand_ids"]
                or not PlanningRun.objects.using(using).filter(
                    run_code=group.run_code, initiated_by_id=self.created_by_id,
                    status=PlanningRunStatus.COMPLETED, rule_set_id=lineage["rule_set_id"],
                ).exists()
            ):
                raise ValidationError("F2 Plan fields must match the captured Candidate, owner and option.")
            if predecessor is not None and (
                predecessor.f2_structure is None or predecessor.group_id != self.group_id
                or predecessor.created_by_id != self.created_by_id or predecessor.template_type != self.template_type
                or predecessor.hub_id != self.hub_id
                or predecessor.f2_structure["option"]["option_key"] == option["option_key"]
            ):
                raise ValidationError("An F2 revision must materially change a predecessor of the same Candidate, template and Hub.")
            latest_id = type(self).objects.using(using).filter(
                group_id=self.group_id, template_type=self.template_type, hub_id=self.hub_id,
                f2_structure__isnull=False,
            ).order_by("-pk").values_list("pk", flat=True).first()
            if self.supersedes_plan_id != latest_id:
                raise ValidationError("An F2 Plan must continue its latest saved option, including legacy revisions.")
        elif predecessor is not None and predecessor.f2_structure is not None:
            raise ValidationError("An F2 revision requires a valid structure.")


def _lock_draft_plan(plan_id, using):
    plan = FulfillmentPlan.objects.using(using).select_for_update().get(pk=plan_id)
    if plan.status != FulfillmentPlanStatus.DRAFT:
        raise ValidationError("Plan structure changes require a new revision.")
    return plan


class DeliveryWave(_PlanRevisionRecord):
    plan = models.ForeignKey(FulfillmentPlan, on_delete=models.PROTECT, related_name="waves", db_index=False)
    wave_no = models.PositiveIntegerField()
    vehicle_type = models.ForeignKey("masterdata.VehicleType", on_delete=models.PROTECT)
    planned_date = models.DateField()
    start_time = models.TimeField(null=True, blank=True)
    end_time = models.TimeField(null=True, blank=True)
    total_load_kg = models.DecimalField(max_digits=12, decimal_places=3)
    utilization_pct = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)

    class Meta:
        db_table = "delivery_waves"
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(fields=("plan", "wave_no"), name="uq_delivery_wave_plan_number"),
            models.CheckConstraint(condition=Q(wave_no__gt=0), name="ck_delivery_wave_number"),
            models.CheckConstraint(condition=Q(total_load_kg__gte=0), name="ck_delivery_wave_load"),
            models.CheckConstraint(
                condition=Q(utilization_pct__isnull=True) | Q(utilization_pct__gte=0, utilization_pct__lte=100),
                name="ck_delivery_wave_utilization",
            ),
        ]

    def _validate_write(self, using, update_fields):
        _lock_draft_plan(self.plan_id, using)


class WaveDemand(_PlanRevisionRecord):
    pk = models.CompositePrimaryKey("wave_id", "demand_id")
    wave = models.ForeignKey(DeliveryWave, on_delete=models.PROTECT, related_name="allocations", db_index=False)
    demand = models.ForeignKey("demands.DeliveryDemand", on_delete=models.PROTECT, related_name="wave_allocations")
    allocated_quantity_kg = models.DecimalField(max_digits=12, decimal_places=3)

    class Meta:
        db_table = "wave_demands"
        base_manager_name = "objects"
        constraints = [
            models.CheckConstraint(condition=Q(allocated_quantity_kg__gt=0), name="ck_wave_demand_quantity"),
        ]

    def _validate_write(self, using, update_fields):
        plan_id = DeliveryWave.objects.using(using).values_list("plan_id", flat=True).get(pk=self.wave_id)
        plan = _lock_draft_plan(plan_id, using)
        if not GroupDemand.objects.using(using).filter(
            group_id=plan.group_id, demand_id=self.demand_id,
            eligibility_status=GroupDemandEligibilityStatus.INCLUDED,
        ).exists():
            raise ValidationError("The allocated Demand must be included in the Plan's Candidate Group.")


class F3Evaluation(_PlanRevisionRecord):
    evaluation_code = models.UUIDField(default=uuid4, unique=True, editable=False)
    plan = models.ForeignKey(FulfillmentPlan, on_delete=models.PROTECT, related_name="f3_evaluations", db_index=False)
    contract_version = models.PositiveSmallIntegerField()
    input_fingerprint = models.CharField(max_length=64)
    configuration_fingerprint = models.CharField(max_length=64)
    f3_structure = models.JSONField()
    evaluated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    evaluated_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "f3_evaluations"
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=("plan", "contract_version", "input_fingerprint", "configuration_fingerprint"),
                name="uq_f3_evaluation_fingerprint",
            ),
            models.CheckConstraint(condition=Q(contract_version__gte=1), name="ck_f3_evaluation_version"),
            models.CheckConstraint(
                condition=Q(input_fingerprint__regex=r"^[0-9a-f]{64}$",
                            configuration_fingerprint__regex=r"^[0-9a-f]{64}$"),
                name="ck_f3_evaluation_hashes",
            ),
            models.CheckConstraint(
                condition=Exact(Func(F("f3_structure"), function="jsonb_typeof"), "object")
                & Q(f3_structure__has_keys=["inputs", "configuration", "result"]),
                name="ck_f3_evaluation_document",
            ),
        ]

    def _validate_write(self, using, update_fields):
        plan = FulfillmentPlan.objects.using(using).get(pk=self.plan_id)
        if (self.contract_version != evaluation_contract_version(plan.hub_id) or plan.created_by_id != self.evaluated_by_id
            or plan.status != FulfillmentPlanStatus.DRAFT or not plan.f2_structure):
            raise ValidationError("F3 evaluation requires its owner's exact saved F2 draft and a supported contract.")
        validate_saved_document(
            plan.f2_structure, self.f3_structure, self.input_fingerprint, self.configuration_fingerprint,
            contract_version=self.contract_version,
        )
        coverage = self.f3_structure["inputs"]["cp7"]["hub_coverage"]
        if coverage.get("context") == "UAT" and not uat_hub_coverage_enabled(connections[using]):
            raise ValidationError("F3 UAT Hub evidence requires the server's UAT database context.")
        summary = self.f3_structure["result"].get("plan")
        if not isinstance(summary, dict) or any(summary.get(key) != getattr(plan, key) for key in (
            "plan_code", "template_type", "hub_id",
        )):
            raise ValidationError("F3 evaluation Plan identification does not match the pinned revision.")


class ReceivingSource(models.TextChoices):
    OPERATIONAL = "OPERATIONAL", "Operational"
    SYNTHETIC_UAT = "SYNTHETIC/UAT", "Synthetic UAT"
    SYNTHETIC_V7 = "SYNTHETIC_V7", "Historical V7 demonstration"


class OperationalEvidenceKind(models.TextChoices):
    CALENDAR = "CALENDAR", "Dated receiving confirmation"
    TRAVEL = "TRAVEL", "Directed route"
    SERVICE = "SERVICE", "Stop duration"
    HUB_HOURS = "HUB_HOURS", "Hub operating hours"
    HUB_COVERAGE = "HUB_COVERAGE", "Carrier hub coverage"
    QUOTE = "QUOTE", "Wave quote"
    HUB_FEE = "HUB_FEE", "Hub handling fee"
    BASELINE = "BASELINE", "Independent demand cost"
    POLICY = "POLICY", "Cost profile policy"
    LOCATION = "LOCATION", "Capstone service point"
    AVAILABILITY = "AVAILABILITY", "Capstone fleet availability"
    TARIFF = "TARIFF", "Capstone vehicle tariff"


class OperationalEvidence(_ProtectedPlanningWrites):
    """Published source revisions from which evaluation inputs are captured."""

    kind = models.CharField(max_length=20, choices=OperationalEvidenceKind.choices)
    business_key = models.CharField(max_length=64)
    version = models.PositiveIntegerField()
    valid_from = models.DateField()
    valid_to = models.DateField()
    approval = models.CharField(max_length=12, choices=(
        ("REFERENCE", "Reference"), ("APPROVED", "Approved"), ("REVOKED", "Revoked"),
    ))
    provenance = models.CharField(max_length=20, choices=(
        ("OPERATIONAL", "Operational"), ("SYNTHETIC/CAPSTONE", "Synthetic Capstone"),
    ))
    scenario = models.SlugField(max_length=50, blank=True)
    source_reference = models.CharField(max_length=95)
    scope = models.JSONField(validators=[validate_json_object])
    data = models.JSONField(blank=True, validators=[validate_json_object])
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "operational_evidence"
        constraints = [
            models.CheckConstraint(condition=Q(valid_from__lte=F("valid_to")), name="ck_ops_evidence_dates"),
            models.CheckConstraint(condition=Q(kind__in=OperationalEvidenceKind.values), name="ck_ops_evidence_kind"),
            models.CheckConstraint(condition=Q(approval__in=("REFERENCE", "APPROVED", "REVOKED")),
                                   name="ck_ops_evidence_approval"),
            models.CheckConstraint(condition=Q(provenance="OPERATIONAL", scenario="")
                                   | Q(provenance="SYNTHETIC/CAPSTONE", scenario__regex=r"\S"),
                                   name="ck_ops_evidence_provenance"),
            models.UniqueConstraint(fields=("kind", "business_key", "provenance", "scenario", "version"),
                                    name="uq_ops_evidence_revision"),
        ]

    def _validate_write(self, using, update_fields):
        if not self._state.adding:
            raise ValidationError("Operational evidence revisions are immutable.")
        self.full_clean()

    def delete(self, *args, **kwargs):
        raise ValidationError("Revoke an operational evidence revision instead of deleting it.")


class ReceivingWindow(models.Model):
    outlet = models.ForeignKey("masterdata.Outlet", on_delete=models.PROTECT)
    day_of_week = models.PositiveSmallIntegerField()
    start_time = models.TimeField()
    end_time = models.TimeField()
    is_active = models.BooleanField(default=True)
    source = models.CharField(max_length=120)
    source_reference = models.CharField(max_length=255)
    source_mode = models.CharField(max_length=15, choices=ReceivingSource.choices)

    class Meta:
        db_table = "receiving_windows"
        constraints = [
            models.CheckConstraint(condition=Q(day_of_week__in=range(7)), name="ck_receiving_window_weekday"),
            models.CheckConstraint(condition=Q(start_time__lt=F("end_time")), name="ck_receiving_window_times"),
            models.CheckConstraint(condition=Q(source_mode__in=ReceivingSource.values)
                                   & Q(source__regex=r"\S", source_reference__regex=r"\S"),
                                   name="ck_receiving_window_source"),
            models.UniqueConstraint(fields=("outlet", "day_of_week", "start_time", "end_time", "source_mode"),
                                    name="uq_receiving_window_interval"),
        ]


class ReceivingSlot(models.Model):
    class SlotType(models.TextChoices):
        BLOCKED = "BLOCKED", "Blocked"
        AVAILABLE = "AVAILABLE", "Available"

    class Status(models.TextChoices):
        OPEN = "OPEN", "Open"
        RESERVED = "RESERVED", "Reserved"
        CONFIRMED = "CONFIRMED", "Confirmed"
        REJECTED = "REJECTED", "Rejected"
        CANCELLED = "CANCELLED", "Cancelled"

    outlet = models.ForeignKey("masterdata.Outlet", on_delete=models.PROTECT)
    slot_date = models.DateField()
    start_time = models.TimeField()
    end_time = models.TimeField()
    slot_type = models.CharField(max_length=20, choices=SlotType.choices)
    status = models.CharField(max_length=20, choices=Status.choices)
    reason = models.TextField(null=True, blank=True)
    source = models.CharField(max_length=120)
    source_reference = models.CharField(max_length=255)
    source_mode = models.CharField(max_length=15, choices=ReceivingSource.choices)

    class Meta:
        db_table = "receiving_slots"
        constraints = [
            models.CheckConstraint(condition=Q(start_time__lt=F("end_time")), name="ck_receiving_slot_times"),
            models.CheckConstraint(condition=Q(slot_type__in=["BLOCKED", "AVAILABLE"]), name="ck_receiving_slot_type"),
            models.CheckConstraint(condition=Q(status__in=["OPEN", "RESERVED", "CONFIRMED", "REJECTED", "CANCELLED"]),
                                   name="ck_receiving_slot_status"),
            models.CheckConstraint(condition=Q(source_mode__in=ReceivingSource.values)
                                   & Q(source__regex=r"\S", source_reference__regex=r"\S"),
                                   name="ck_receiving_slot_source"),
            models.UniqueConstraint(fields=("outlet", "slot_date", "start_time", "end_time", "slot_type", "source_mode"),
                                    name="uq_receiving_slot_interval"),
        ]


class F4Evaluation(_PlanRevisionRecord):
    evaluation_code = models.UUIDField(default=uuid4, unique=True, editable=False)
    f3_evaluation = models.ForeignKey(F3Evaluation, on_delete=models.PROTECT, related_name="f4_evaluations", db_index=False)
    contract_version = models.PositiveSmallIntegerField()
    input_fingerprint = models.CharField(max_length=64)
    configuration_fingerprint = models.CharField(max_length=64)
    f4_structure = models.JSONField()
    evaluated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    evaluated_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "f4_evaluations"
        base_manager_name = "objects"
        constraints = [
            models.UniqueConstraint(
                fields=("f3_evaluation", "contract_version", "input_fingerprint", "configuration_fingerprint"),
                name="uq_f4_evaluation_fingerprint",
            ),
            models.CheckConstraint(condition=Q(contract_version__gte=1), name="ck_f4_evaluation_version"),
            models.CheckConstraint(
                condition=Q(input_fingerprint__regex=r"^[0-9a-f]{64}$", configuration_fingerprint__regex=r"^[0-9a-f]{64}$"),
                name="ck_f4_evaluation_hashes",
            ),
            models.CheckConstraint(
                condition=Exact(Func(F("f4_structure"), function="jsonb_typeof"), "object")
                & Q(f4_structure__has_keys=["inputs", "configuration", "result"])
                & Q(f4_structure__inputs__has_keys=["lineage", "f2", "f3", "time_evidence", "evaluation_context"])
                & Q(f4_structure__result__has_keys=["status", "complete", "waves", "metrics", "diagnostics"])
                & Q(f4_structure__result__status__in=["PASS", "HARD_CONFLICT", "SOFT_CONFLICT", "NOT_EVALUATED"]),
                name="ck_f4_evaluation_document",
            ),
        ]

    def _validate_write(self, using, update_fields):
        evaluation = F3Evaluation.objects.using(using).select_related("plan").get(pk=self.f3_evaluation_id)
        if (
            self.contract_version != F4_CONTRACT_VERSION or evaluation.evaluated_by_id != self.evaluated_by_id
            or evaluation.plan.created_by_id != self.evaluated_by_id or evaluation.plan.status != FulfillmentPlanStatus.DRAFT
            or evaluation.f3_structure["result"]["gate_status"] != "ELIGIBLE"
        ):
            raise ValidationError("F4 requires the owner's eligible F3 evaluation of the exact F2 draft.")
        validate_f4_document(evaluation, self.f4_structure, self.input_fingerprint, self.configuration_fingerprint)
        if self.f4_structure["inputs"]["evaluation_context"] == "UAT" and not uat_hub_coverage_enabled(connections[using]):
            raise ValidationError("Synthetic F4 evidence requires the server's UAT database context.")


class EconomicEvaluation(models.Model):
    evaluation_code = models.UUIDField(default=uuid4, unique=True, editable=False)
    plan = models.ForeignKey(FulfillmentPlan, on_delete=models.PROTECT)
    f4_evaluation = models.ForeignKey(F4Evaluation, on_delete=models.PROTECT, related_name="economic_evaluations")
    cost_profile = models.ForeignKey(CostProfile, null=True, blank=True, on_delete=models.PROTECT)
    baseline_cost = models.DecimalField(max_digits=14, decimal_places=2)
    collaborative_cost = models.DecimalField(max_digits=14, decimal_places=2)
    cost_saving = models.DecimalField(max_digits=14, decimal_places=2)
    saving_rate_pct = models.DecimalField(max_digits=9, decimal_places=4, null=True)
    allocation_method = models.CharField(max_length=20)
    calculated_at = models.DateTimeField(auto_now_add=True)
    calculated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    contract_version = models.PositiveSmallIntegerField()
    input_fingerprint = models.CharField(max_length=64)
    configuration_fingerprint = models.CharField(max_length=64)
    snapshot = models.JSONField()
    sealed = models.BooleanField(default=False, editable=False)

    class Meta:
        db_table = "economic_evaluations"
        indexes = [models.Index(fields=["plan", "-calculated_at"], name="f5_plan_calculated_idx")]
        constraints = [
            models.UniqueConstraint(
                fields=["f4_evaluation", "contract_version", "input_fingerprint", "configuration_fingerprint"],
                name="uq_f5_evaluation_fingerprint",
            ),
            models.CheckConstraint(condition=Q(baseline_cost__gte=0, collaborative_cost__gte=0)
                                   & Q(cost_saving=F("baseline_cost") - F("collaborative_cost")),
                                   name="ck_f5_evaluation_costs"),
            models.CheckConstraint(condition=Q(baseline_cost=0, saving_rate_pct__isnull=True)
                                   | Q(baseline_cost__gt=0, saving_rate_pct__isnull=False),
                                   name="ck_f5_evaluation_rate"),
            models.CheckConstraint(condition=Q(contract_version__gte=1, allocation_method__in=["WEIGHT", "ORDER_COUNT"],
                                               input_fingerprint__regex=r"^[0-9a-f]{64}$",
                                               configuration_fingerprint__regex=r"^[0-9a-f]{64}$"),
                                   name="ck_f5_evaluation_metadata"),
            models.CheckConstraint(condition=Exact(Func(F("snapshot"), function="jsonb_typeof"), "object")
                                   & Q(snapshot__has_keys=["lineage", "configuration", "price_inputs", "result", "comparison"]),
                                   name="ck_f5_evaluation_snapshot"),
        ]


class CostAllocation(models.Model):
    evaluation = models.ForeignKey(EconomicEvaluation, on_delete=models.PROTECT, related_name="allocations")
    outlet = models.ForeignKey("masterdata.Outlet", on_delete=models.PROTECT)
    baseline_cost = models.DecimalField(max_digits=14, decimal_places=2)
    allocation_weight = models.DecimalField(max_digits=14, decimal_places=3, null=True)
    order_count = models.PositiveIntegerField(null=True)
    allocated_cost = models.DecimalField(max_digits=14, decimal_places=2)
    participant_saving = models.DecimalField(max_digits=14, decimal_places=2)

    class Meta:
        db_table = "cost_allocations"
        constraints = [
            models.UniqueConstraint(fields=["evaluation", "outlet"], name="uq_f5_allocation_outlet"),
            models.CheckConstraint(condition=Q(baseline_cost__gte=0, allocated_cost__gte=0)
                                   & Q(participant_saving=F("baseline_cost") - F("allocated_cost")),
                                   name="ck_f5_allocation_costs"),
            models.CheckConstraint(condition=Q(allocation_weight__isnull=True) | Q(allocation_weight__gte=0),
                                   name="ck_f5_allocation_weight"),
        ]


class DemandCostInput(models.Model):
    evaluation = models.ForeignKey(EconomicEvaluation, on_delete=models.PROTECT, related_name="demand_cost_inputs")
    demand = models.ForeignKey("demands.DeliveryDemand", on_delete=models.PROTECT)
    cost_profile = models.ForeignKey(CostProfile, null=True, blank=True, on_delete=models.PROTECT)
    independent_delivery_cost = models.DecimalField(max_digits=14, decimal_places=2)
    currency_code = Char3Field(max_length=3)
    source_type = models.CharField(max_length=30)
    effective_at = models.DateTimeField()
    notes = models.TextField(null=True, blank=True)

    class Meta:
        db_table = "demand_cost_inputs"
        constraints = [
            models.UniqueConstraint(fields=["evaluation", "demand"], name="uq_f5_cost_input_demand"),
            models.CheckConstraint(condition=Q(independent_delivery_cost__gte=0, currency_code="VND")
                                   & Q(source_type__regex=r"\S"), name="ck_f5_cost_input_source"),
        ]


class CostComponent(models.Model):
    evaluation = models.ForeignKey(EconomicEvaluation, on_delete=models.PROTECT, related_name="components")
    ordinal = models.PositiveIntegerField()
    delivery_wave = models.ForeignKey("planning.DeliveryWave", null=True, blank=True, on_delete=models.PROTECT)
    wave_no = models.PositiveIntegerField(null=True, blank=True)
    component_type = models.CharField(max_length=30)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    source_type = models.CharField(max_length=30)
    notes = models.TextField(null=True, blank=True)
    pricing_basis = models.CharField(max_length=20)
    quantity = models.DecimalField(max_digits=20, decimal_places=6, null=True)
    unit_code = models.CharField(max_length=20, null=True)
    unit_rate = models.DecimalField(max_digits=14, decimal_places=2, null=True)
    source_reference = models.CharField(max_length=180)
    calculation_details = models.JSONField()

    class Meta:
        db_table = "cost_components"
        constraints = [
            models.UniqueConstraint(fields=["evaluation", "ordinal"], name="uq_f5_component_ordinal"),
            models.CheckConstraint(condition=Q(ordinal__gte=1, amount__gte=0,
                                               component_type__in=["TRANSPORT", "HUB_HANDLING", "HANDLING", "OTHER"],
                                               pricing_basis__in=["FIXED", "PER_KM", "PER_KG", "PER_ORDER", "BUNDLED", "OTHER"]),
                                   name="ck_f5_component_domain"),
            models.CheckConstraint(condition=(Q(quantity__isnull=True) | Q(quantity__gte=0))
                                   & (Q(unit_rate__isnull=True) | Q(unit_rate__gte=0))
                                   & (Q(wave_no__isnull=True) | Q(wave_no__gte=1))
                                   & Q(source_type__regex=r"\S", source_reference__regex=r"\S"),
                                   name="ck_f5_component_trace"),
        ]


class _WorkflowRecord(_PlanRevisionRecord):
    class Meta:
        abstract = True

    def _validate_write(self, using, update_fields):
        # Cross-record transitions are validated and locked by the workflow service.
        pass


class PlanDecision(_WorkflowRecord):
    group = models.ForeignKey(CollaborationGroup, on_delete=models.PROTECT, related_name="decisions")
    evaluation = models.ForeignKey(EconomicEvaluation, on_delete=models.PROTECT)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.UUIDField()
    outcome = models.CharField(max_length=24, choices=DecisionOutcome.choices)
    reason = models.TextField()
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "plan_decisions"
        constraints = [
            models.UniqueConstraint(fields=("actor", "request_id"), name="uq_plan_decision_request"),
            models.CheckConstraint(condition=Q(outcome__in=DecisionOutcome.values, reason__regex=r"\S"),
                                   name="ck_plan_decision_outcome"),
        ]


class FinalPlan(_WorkflowRecord):
    code = models.UUIDField(default=uuid4, unique=True, editable=False)
    decision = models.OneToOneField(PlanDecision, on_delete=models.PROTECT, related_name="final_plan")
    provider = models.ForeignKey("masterdata.TransportProvider", on_delete=models.PROTECT)
    scope_key = models.CharField(max_length=64)
    version = models.PositiveIntegerField()
    supersedes = models.OneToOneField("self", null=True, blank=True, on_delete=models.PROTECT,
                                     related_name="successor")
    scenario = models.SlugField(max_length=50, blank=True, default="")
    snapshot = models.JSONField()
    snapshot_hash = models.CharField(max_length=64)

    class Meta:
        db_table = "final_plans"
        constraints = [
            models.UniqueConstraint(fields=("scope_key", "version"), name="uq_final_plan_scope_version"),
            models.CheckConstraint(
                condition=Q(version=1, supersedes__isnull=True) | Q(version__gt=1, supersedes__isnull=False),
                name="ck_final_plan_revision",
            ),
            models.CheckConstraint(
                condition=Q(scope_key__regex=r"^[0-9a-f]{64}$", snapshot_hash__regex=r"^[0-9a-f]{64}$")
                & Q(snapshot__has_keys=["schema_version", "f1", "f2", "f3", "f4", "f5", "provenance"]),
                name="ck_final_plan_snapshot",
            ),
        ]


class FinalPlanDemand(models.Model):
    """Current reservation of a demand, movable only when a new version is approved."""

    demand = models.OneToOneField("demands.DeliveryDemand", on_delete=models.PROTECT, primary_key=True)
    plan = models.ForeignKey(FinalPlan, on_delete=models.PROTECT, related_name="active_demands")

    class Meta:
        db_table = "final_plan_demands"


class TransportHandover(_WorkflowRecord):
    plan = models.OneToOneField(FinalPlan, on_delete=models.PROTECT, related_name="handover")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    sent_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "transport_handovers"


class TransportHandoverResponse(_WorkflowRecord):
    handover = models.OneToOneField(TransportHandover, on_delete=models.PROTECT, related_name="reply")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    outcome = models.CharField(max_length=8, choices=CarrierOutcome.choices)
    reason = models.TextField()
    responded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "transport_handover_responses"
        constraints = [
            models.CheckConstraint(condition=Q(outcome__in=CarrierOutcome.values, reason__regex=r"\S"),
                                   name="ck_transport_handover_reply"),
        ]


from .models_execution import ExecutionEvent, FleetHold, InventoryTransaction, StockBalance, StockReservation  # noqa: E402,F401
from .models_reconciliation import ReconciliationRecord  # noqa: E402,F401

