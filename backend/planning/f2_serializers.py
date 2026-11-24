"""Versioned F2 preview and Plan request and response shapes."""

from rest_framework import serializers

from planning.f2_structure import TEMPLATES
from planning.serializers import StrictInputMixin


class F2OptionsQuerySerializer(StrictInputMixin, serializers.Serializer):
    hub_id = serializers.IntegerField(required=False, min_value=1, max_value=9223372036854775807)


class F2HubSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    code = serializers.CharField()
    name = serializers.CharField()
    address = serializers.CharField()


class F2DiagnosticSerializer(serializers.Serializer):
    code = serializers.CharField()
    demand_id = serializers.IntegerField(required=False)
    hub_id = serializers.IntegerField(required=False, allow_null=True)


class F2AssignedLoadSerializer(serializers.Serializer):
    demand_ids = serializers.ListField(child=serializers.IntegerField())
    load_kg = serializers.CharField(allow_null=True)


class F2StopSerializer(F2AssignedLoadSerializer):
    key = serializers.CharField()
    kind = serializers.ChoiceField(choices=["SUPPLIER", "HUB", "OUTLET"])
    entity_id = serializers.IntegerField()
    code = serializers.CharField(allow_null=True, allow_blank=True)
    address = serializers.CharField(allow_null=True)


class F2LegSerializer(F2AssignedLoadSerializer):
    phase = serializers.ChoiceField(choices=["DIRECT", "INBOUND", "OUTBOUND"])
    from_stop = serializers.CharField()
    to_stop = serializers.CharField()


class F2DemandItemSerializer(serializers.Serializer):
    item_id = serializers.IntegerField()
    required_weight_kg = serializers.CharField()
    confirmed_weight_kg = serializers.CharField(allow_null=True)


class F2DemandSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    code = serializers.CharField()
    supplier_id = serializers.IntegerField()
    outlet_id = serializers.IntegerField()
    outlet_code = serializers.CharField(allow_blank=True)
    cargo_category_id = serializers.IntegerField()
    cargo_category_code = serializers.CharField(allow_blank=True)
    requested_date = serializers.CharField()
    requested_start_time = serializers.CharField(allow_null=True)
    requested_end_time = serializers.CharField(allow_null=True)
    required_weight_kg = serializers.CharField()
    items = F2DemandItemSerializer(many=True)
    pickup_address = serializers.CharField(allow_null=True)
    pickup_ready_date = serializers.CharField(allow_null=True)
    pickup_ready_start_time = serializers.CharField(allow_null=True)
    pickup_ready_end_time = serializers.CharField(allow_null=True)
    supplier_request_id = serializers.IntegerField(allow_null=True)
    supplier_confirmation_id = serializers.IntegerField(allow_null=True)
    snapshot_captured_at = serializers.CharField()
    snapshot_version = serializers.CharField()


class F2CandidateBasisSerializer(serializers.Serializer):
    demand_ids = serializers.ListField(child=serializers.IntegerField())
    requested_date = serializers.CharField()
    common_start_time = serializers.CharField()
    common_end_time = serializers.CharField()
    cargo_category_ids = serializers.ListField(child=serializers.IntegerField())
    outlet_count = serializers.IntegerField(allow_null=True)
    total_required_weight_kg = serializers.CharField(allow_null=True)
    demands = F2DemandSerializer(many=True)


class F2LineageSerializer(serializers.Serializer):
    run_code = serializers.UUIDField()
    group_code = serializers.CharField()
    run_status = serializers.CharField()
    candidate_status = serializers.CharField()
    rule_set_id = serializers.IntegerField()
    rule_set_code = serializers.CharField(allow_null=True)
    rule_set_version = serializers.IntegerField(allow_null=True)
    configuration_captured_at = serializers.CharField(allow_null=True)
    configuration_fingerprint = serializers.CharField(allow_null=True)
    max_group_size = serializers.IntegerField(allow_null=True)
    max_candidates_per_run = serializers.IntegerField(allow_null=True)
    cargo_matrix_source = serializers.CharField(allow_null=True)
    cargo_matrix_sheet = serializers.CharField(allow_null=True)
    f1_rule_codes = serializers.ListField(child=serializers.CharField())


class F2OptionSerializer(serializers.Serializer):
    option_key = serializers.CharField()
    template_type = serializers.ChoiceField(choices=TEMPLATES)
    status = serializers.ChoiceField(choices=["DRAFT"])
    structural_status = serializers.ChoiceField(choices=["COMPLETE", "INCOMPLETE"])
    ready_for_f3 = serializers.BooleanField()
    demand_ids = serializers.ListField(child=serializers.IntegerField())
    total_required_weight_kg = serializers.CharField(allow_null=True)
    hub = F2HubSerializer(allow_null=True)
    stops = F2StopSerializer(many=True)
    legs = F2LegSerializer(many=True)
    diagnostics = F2DiagnosticSerializer(many=True)


class F2PlanSaveSerializer(StrictInputMixin, serializers.Serializer):
    template_type = serializers.ChoiceField(choices=TEMPLATES)
    option_key = serializers.RegexField(r"\A[0-9a-f]{64}\Z")
    hub_id = serializers.IntegerField(required=False, min_value=1, max_value=9223372036854775807)
    supersedes_plan_code = serializers.RegexField(r"\A[0-9a-f]{32}\Z", required=False)

    def validate(self, attrs):
        if ("hub_id" in attrs) != (attrs["template_type"] == "HUB_BASED"):
            raise serializers.ValidationError({"hub_id": "Supply the selected Hub for a Hub-based draft only."})
        return attrs


class F2PlanSummarySerializer(serializers.Serializer):
    plan_code = serializers.CharField()
    supersedes_plan_code = serializers.CharField(allow_null=True)
    revision = serializers.IntegerField()
    status = serializers.ChoiceField(choices=["DRAFT"])
    template_type = serializers.ChoiceField(choices=TEMPLATES)
    hub_id = serializers.IntegerField(allow_null=True)
    hub = F2HubSerializer(allow_null=True)
    option_key = serializers.CharField()
    created_at = serializers.DateTimeField()


class F2PlanStructureSerializer(serializers.Serializer):
    schema_version = serializers.IntegerField()
    lineage = F2LineageSerializer()
    basis = F2CandidateBasisSerializer()
    option = F2OptionSerializer()


class F2PlanDetailSerializer(F2PlanSummarySerializer):
    f2_structure = F2PlanStructureSerializer()


class F2OptionsSerializer(serializers.Serializer):
    contract_version = serializers.CharField()
    lineage = F2LineageSerializer()
    basis = F2CandidateBasisSerializer()
    persistence = serializers.ChoiceField(choices=["AVAILABLE", "MIGRATION_REQUIRED"])
    saved_plans = F2PlanSummarySerializer(many=True)
    options = F2OptionSerializer(many=True)
