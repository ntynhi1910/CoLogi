"""Resolve and freeze configuration for a CP08 PlanningRun."""

import json
from datetime import datetime
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from planning.models import (
    CostProfile,
    PlanningBusinessRule,
    PlanningParameters,
    PlanningRuleSet,
    PlanningModuleCode,
    RuleSetStatus,
)
from planning.f1.cargo_compatibility import (
    dataset_v7_cargo_compatibility_rows,
    normalize_cargo_compatibility_matrix,
)

# CoLogi_Dataset_v7, 12_Business_Rules, active MVP RuleSet.
# These definitions identify implemented Python rules and are never evaluated as expressions.
_F1_RULE_DEFINITIONS = {
    "RULE-01": ("status == SUBMITTED", "B"),
    "RULE-02": ("supplier/outlet/date/weight required", "B"),
    "RULE-03": ("candidate_count >= 2", "B"),
    "RULE-04": ("distinct_outlets >= 2", "B"),
    "RULE-05": ("not finalized_elsewhere", "B"),
    "RULE-06": ("cargo_compatibility == TRUE", "B"),
    "RULE-07": ("use configured matrix", "B"),
    "RULE-08": ("date/time compatibility", "B/R"),
    "RULE-09": ("no auto final approval", "B"),
    "RULE-26": ("override_reason required", "B"),
}
_F1_MANDATORY_RULES = _F1_RULE_DEFINITIONS.keys() - {"RULE-09", "RULE-26"}


def validate_pinned_f1_business_rules(rules):
    """Require the reviewed V7 F1 definitions before evaluating a Run."""
    configured_codes = set()
    for rule in rules:
        code = rule["rule_code"]
        definition = _F1_RULE_DEFINITIONS.get(code)
        if definition is None:
            raise ValidationError(f"F1 BusinessRule has no supported definition: {code}")
        expression, rule_type = definition
        if rule["rule_definition"] != {"expression": expression, "rule_type": rule_type}:
            raise ValidationError(f"F1 BusinessRule definition is invalid: {code}")
        configured_codes.add(code)

    missing = _F1_MANDATORY_RULES - configured_codes
    if missing:
        raise ValidationError(f"Mandatory F1 BusinessRules are missing: {', '.join(sorted(missing))}")


@transaction.atomic
def create_rule_set_version(*, source_rule_set_id, rule_set_code, actor):
    """Copy a locked RuleSet into a new editable DRAFT version."""
    source = PlanningRuleSet.objects.select_for_update().get(pk=source_rule_set_id)
    revision = PlanningRuleSet.objects.create(
        rule_set_code=rule_set_code, rule_set_name=source.rule_set_name,
        version_no=source.version_no + 1, status=RuleSetStatus.DRAFT, created_by=actor,
    )
    for rule in PlanningBusinessRule.objects.filter(rule_set=source).order_by("pk"):
        PlanningBusinessRule.objects.create(
            rule_set=revision, rule_code=rule.rule_code, module_code=rule.module_code,
            rule_name=rule.rule_name, description=rule.description,
            rule_definition=rule.rule_definition, priority=rule.priority, is_active=rule.is_active,
        )
    return revision


def _json_safe(value, context):
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
        )
        return json.loads(encoded)
    except (TypeError, ValueError, OverflowError):
        raise ValidationError(
            f"{context} must contain valid JSON data."
        )


def _decimal_string(value):
    if value is None:
        return None
    return str(Decimal(value))



def build_parameters_snapshot(
    *,
    rule_set,
    business_rules,
    parameters,
    cost_profile=None,
    captured_at=None,
):
    """Build an immutable-by-convention JSON-safe configuration snapshot."""

    captured_at = captured_at or timezone.now()

    if timezone.is_naive(captured_at):
        raise ValidationError("captured_at must be timezone-aware.")

    if rule_set.status != RuleSetStatus.ACTIVE:
        raise ValidationError("PLANNING_RULE_SET_NOT_ACTIVE")

    if (
        rule_set.effective_from is not None
        and rule_set.effective_from > captured_at
    ):
        raise ValidationError("PLANNING_RULE_SET_NOT_EFFECTIVE")

    active_f1_rules = [
        rule
        for rule in business_rules
        if (
            rule.module_code == PlanningModuleCode.F1
            and rule.is_active
        )
    ]

    if not active_f1_rules:
        raise ValidationError("F1_RULE_CONFIGURATION_MISSING")

    rules_snapshot = []

    for rule in sorted(
        active_f1_rules,
        key=lambda item: (item.priority, item.rule_code, item.pk),
    ):
        definition = rule.rule_definition
        if not isinstance(definition, dict):
            raise ValidationError("RUN_CONFIGURATION_RULE_DEFINITION_MUST_BE_OBJECT")
        rules_snapshot.append({
            "rule_id": rule.pk,
            "rule_code": rule.rule_code,
            "rule_name": rule.rule_name,
            "priority": rule.priority,
            "rule_definition": _json_safe(
                definition,
                f"Business rule {rule.rule_code}",
            ),
        })

    parameter_snapshot = {}

    for parameter in sorted(
        parameters,
        key=lambda item: item.parameter_key,
    ):
        if parameter.parameter_key in parameter_snapshot:
            raise ValidationError(
                "Duplicate Planning Parameter key detected."
            )

        parameter_snapshot[parameter.parameter_key] = {
            "value": _json_safe(
                parameter.parameter_value,
                f"Parameter {parameter.parameter_key}",
            ),
            "data_type": parameter.data_type,
            "updated_at": (
                parameter.updated_at.isoformat()
                if parameter.updated_at
                else None
            ),
        }

    cost_snapshot = None

    if cost_profile is not None:
        if not cost_profile.is_active:
            raise ValidationError("COST_PROFILE_NOT_ACTIVE")

        if cost_profile.currency_code != "VND":
            raise ValidationError("COST_PROFILE_CURRENCY_INVALID")

        cost_snapshot = {
            "id": cost_profile.pk,
            "profile_code": cost_profile.profile_code,
            "profile_name": cost_profile.profile_name,
            "currency_code": cost_profile.currency_code,
            "fixed_transport_cost": _decimal_string(
                cost_profile.fixed_transport_cost
            ),
            "cost_per_km": _decimal_string(
                cost_profile.cost_per_km
            ),
            "additional_handling_cost": _decimal_string(
                cost_profile.additional_handling_cost
            ),
        }


    cargo_compatibility_rows = (
        dataset_v7_cargo_compatibility_rows()
    )

    try:
        normalize_cargo_compatibility_matrix(
            cargo_compatibility_rows
        )
    except ValueError as exc:
        raise ValidationError(str(exc))
    
    return {
        "schema_version": "1.0",
        "captured_at": captured_at.isoformat(),
        "rule_set": {
            "id": rule_set.pk,
            "code": rule_set.rule_set_code,
            "name": rule_set.rule_set_name,
            "version_no": rule_set.version_no,
        },
        "business_rules": rules_snapshot,
        "parameters": parameter_snapshot,
        "cargo_compatibility_matrix": {
            "source": "CoLogi_Dataset_v7",
            "sheet": "08_Cargo_Compat",
            "rows": _json_safe(
                cargo_compatibility_rows,
                "Cargo compatibility matrix",
            ),
        },
        "cost_profile": cost_snapshot,
    }


def load_run_configuration(
    *,
    rule_set_id,
    cost_profile_id=None,
    captured_at=None,
    lock_rule_set=False,
):
    """Load and validate persisted configuration without modifying records."""

    captured_at = captured_at or timezone.now()

    if lock_rule_set and not connection.in_atomic_block:
        raise RuntimeError("RULE_SET_LOCK_REQUIRES_TRANSACTION")

    try:
        rule_sets = PlanningRuleSet.objects
        if lock_rule_set:
            rule_sets = rule_sets.select_for_update()
        rule_set = rule_sets.get(pk=rule_set_id)
    except PlanningRuleSet.DoesNotExist:
        raise ValidationError("PLANNING_RULE_SET_NOT_FOUND")

    if rule_set.status != RuleSetStatus.ACTIVE:
        raise ValidationError("PLANNING_RULE_SET_NOT_ACTIVE")

    if (
        rule_set.effective_from is not None
        and rule_set.effective_from > captured_at
    ):
        raise ValidationError("PLANNING_RULE_SET_NOT_EFFECTIVE")

    if lock_rule_set and not getattr(settings, "COLOGI_F1_MVCC_CONFIGURATION_PIN", False):
        # The parent row protects the RuleSet. Hold shared locks on both tables
        # so even direct ORM writes cannot change the configuration during the pin.
        tables = ", ".join(
            connection.ops.quote_name(model._meta.db_table)
            for model in (PlanningBusinessRule, PlanningParameters)
        )
        with connection.cursor() as cursor:
            cursor.execute(f"LOCK TABLE {tables} IN SHARE MODE")
    elif lock_rule_set:
        # The restricted service role takes a consistent PostgreSQL snapshot
        # instead of holding table locks that require write privileges.
        with connection.cursor() as cursor:
            cursor.execute("SHOW transaction_isolation")
            if cursor.fetchone()[0] not in ("repeatable read", "serializable"):
                raise RuntimeError("MVCC_CONFIGURATION_PIN_REQUIRES_A_STABLE_SNAPSHOT")

    business_rules = tuple(
        PlanningBusinessRule.objects.filter(
            rule_set=rule_set,
            module_code=PlanningModuleCode.F1,
            is_active=True,
        ).order_by("priority", "rule_code", "pk")
    )

    if not business_rules:
        raise ValidationError("F1_RULE_CONFIGURATION_MISSING")

    parameters = tuple(
        PlanningParameters.objects.all().order_by("parameter_key")
    )

    cost_profile = None

    if cost_profile_id is not None:
        try:
            cost_profile = CostProfile.objects.get(pk=cost_profile_id)
        except CostProfile.DoesNotExist:
            raise ValidationError("COST_PROFILE_NOT_FOUND")


    return build_parameters_snapshot(
        rule_set=rule_set,
        business_rules=business_rules,
        parameters=parameters,
        cost_profile=cost_profile,
        captured_at=captured_at,
    )
