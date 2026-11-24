from collections.abc import Mapping

from rest_framework import serializers
from drf_spectacular.utils import extend_schema_field

from planning.services.result_presentation import describe_demand_snapshot


class StrictInputMixin:
    def to_internal_value(self, data):
        if isinstance(data, Mapping):
            unknown = set(data.keys()) - set(self.fields.keys())
            if unknown:
                raise serializers.ValidationError({
                    "non_field_errors": [
                        "Unsupported fields: "
                        + ", ".join(sorted(str(x) for x in unknown))
                    ]
                })
        return super().to_internal_value(data)


class F1PreviewRequestSerializer(
    StrictInputMixin,
    serializers.Serializer,
):
    demand_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1),
        allow_empty=False,
        min_length=1,
    )
    rule_set_id = serializers.IntegerField(min_value=1)
    cost_profile_id = serializers.IntegerField(
        min_value=1,
        required=False,
        allow_null=True,
    )

    def validate_demand_ids(self, value):
        if len(value) != len(set(value)):
            raise serializers.ValidationError(
                "Duplicate Demand IDs are not allowed."
            )
        return value


class F1CapacityResultSerializer(serializers.Serializer):
    item_id = serializers.IntegerField()
    status = serializers.CharField(source="status.value")


class DemandRunPreviewSerializer(serializers.Serializer):
    demand_id = serializers.IntegerField()
    eligibility_status = serializers.CharField()
    blockers = serializers.ListField(
        child=serializers.CharField()
    )
    diagnostics = serializers.ListField(
        child=serializers.CharField()
    )
    primary_reason_code = serializers.CharField(
        allow_null=True
    )
    plan_guard_status = serializers.CharField()
    matching_status = serializers.CharField()
    detail = serializers.CharField()
    capacity_results = F1CapacityResultSerializer(many=True)
    reason_codes = serializers.ListField(child=serializers.CharField())
    warnings = serializers.ListField(child=serializers.CharField())
    evidence = serializers.JSONField(allow_null=True)


class CandidateGroupPreviewSerializer(serializers.Serializer):
    demand_ids = serializers.ListField(
        child=serializers.IntegerField()
    )
    requested_date = serializers.DateField()
    cargo_category_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1),
        allow_empty=False,
    )
    common_start_time = serializers.TimeField()
    common_end_time = serializers.TimeField()


class F1MasterdataLabelSerializer(serializers.Serializer):
    code = serializers.CharField()
    name = serializers.CharField()


class F1DemandDisplayLabelsSerializer(serializers.Serializer):
    source = serializers.ChoiceField(choices=["CURRENT_MASTERDATA"])
    supplier = F1MasterdataLabelSerializer(allow_null=True)
    outlet = F1MasterdataLabelSerializer(allow_null=True)
    items = serializers.DictField(child=F1MasterdataLabelSerializer())


class F1PreviewResponseSerializer(serializers.Serializer):
    captured_at = serializers.CharField(
        help_text="ISO 8601 timestamp with timezone (date-time).",
    )
    rule_set_id = serializers.IntegerField()
    rule_set_code = serializers.CharField()
    rule_set_version = serializers.IntegerField()
    business_rule_codes = serializers.ListField(
        child=serializers.CharField()
    )
    demand_results = DemandRunPreviewSerializer(many=True)
    display_labels = serializers.DictField(child=F1DemandDisplayLabelsSerializer(), required=False)
    candidate_groups = CandidateGroupPreviewSerializer(many=True)
    business_rules_execution = serializers.CharField()
    plan_guard_status = serializers.CharField()
    matching_status = serializers.CharField()
    ready_to_finalize = serializers.BooleanField()
    all_demands_eligible = serializers.BooleanField(read_only=True)


class F1DemandResultSerializer(serializers.Serializer):
    demand_id = serializers.IntegerField()
    eligibility_status = serializers.CharField()
    primary_reason_code = serializers.CharField(allow_null=True)
    plan_guard_status = serializers.CharField()
    matching_status = serializers.CharField()
    diagnostics = serializers.JSONField()
    evidence = serializers.SerializerMethodField()

    @extend_schema_field(serializers.JSONField(allow_null=True))
    def get_evidence(self, row):
        return describe_demand_snapshot(
            row.demand_snapshot, row.demand_id,
            show_shortfall=row.primary_reason_code == "PROMISE_INSUFFICIENT" or any(
                item.get("code") == "PROMISE_INSUFFICIENT" for item in row.diagnostics if isinstance(item, dict)
            ),
        )


class F1GroupMembershipSerializer(serializers.Serializer):
    demand_id = serializers.IntegerField()
    eligibility_status = serializers.CharField()


class F1CandidateResultSerializer(serializers.Serializer):
    group_code = serializers.CharField()
    status = serializers.CharField()
    memberships = F1GroupMembershipSerializer(many=True)
    matching_reason = serializers.JSONField(allow_null=True)


class F1RunSummarySerializer(serializers.Serializer):
    run_code = serializers.UUIDField()
    status = serializers.CharField()
    source_mode = serializers.CharField()
    started_at = serializers.DateTimeField()
    completed_at = serializers.DateTimeField(allow_null=True)
    rule_set_id = serializers.IntegerField()
    rule_set_version = serializers.IntegerField(allow_null=True)
    matching_outcome = serializers.CharField(allow_null=True)
    rule_set_code = serializers.CharField(allow_null=True, required=False)
    configuration_captured_at = serializers.CharField(allow_null=True, required=False)
    max_group_size = serializers.IntegerField(allow_null=True, required=False)
    max_candidates_per_run = serializers.IntegerField(allow_null=True, required=False)
    cargo_matrix_source = serializers.CharField(allow_null=True, required=False)
    cargo_matrix_sheet = serializers.CharField(allow_null=True, required=False)
    demand_count = serializers.IntegerField(required=False)
    evaluated_count = serializers.IntegerField(required=False)
    eligible_count = serializers.IntegerField(required=False)
    excluded_count = serializers.IntegerField(required=False)
    matched_count = serializers.IntegerField(required=False)
    unmatched_count = serializers.IntegerField(required=False)
    candidate_count = serializers.IntegerField(required=False)


class F1RunDetailSerializer(F1RunSummarySerializer):
    failure_diagnostics = serializers.JSONField()
    demand_results = F1DemandResultSerializer(many=True)
    display_labels = serializers.DictField(child=F1DemandDisplayLabelsSerializer(), required=False)
    candidate_groups = F1CandidateResultSerializer(many=True)


class F1RunHistorySerializer(serializers.Serializer):
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = F1RunSummarySerializer(many=True)


class F1RuleSetSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    rule_set_code = serializers.CharField()
    rule_set_name = serializers.CharField()
    version_no = serializers.IntegerField()
    effective_from = serializers.DateTimeField(allow_null=True)
    max_group_size = serializers.IntegerField()
    max_candidates_per_run = serializers.IntegerField()


class F1ScopeSerializer(serializers.Serializer):
    outlet_ids = serializers.ListField(child=serializers.IntegerField())
    environment = serializers.CharField(required=False)
    scenario = serializers.SlugField(required=False)
