export interface InternalPlanningApproval {
  approval_id: number
  version: string
  provenance: string
  file_sha256: string
  valid_from: string
  valid_to: string
  first_fleet_date: string
}

export interface F1Scope {
  unplanned_closure_enabled?: boolean
  outlet_ids: number[]
  environment?: 'UAT' | 'CAPSTONE'
  scenario?: string
  excluded_demo_demand_ids?: number[]
  internal_planning?: InternalPlanningApproval
}

export interface F1RuleSet {
  id: number
  rule_set_code: string
  rule_set_name: string
  version_no: number
  effective_from: string | null
  max_group_size: number | null
  max_candidates_per_run: number | null
}

export interface F1Input {
  demand_ids: number[]
  rule_set_id: number
}

export interface F1Diagnostic {
  code: string
  stage?: string
  severity?: string
  message?: string
  demand_ids?: number[]
  conflict_demand_ids?: number[]
  matching_outcome?: string
  item_id?: number
}

export interface F1SnapshotItem {
  demand_item_id: string
  item_id: string | null
  item_code: string | null
  item_name: string | null
  required_weight_kg: string | null
}

export interface F1DemandEvidence {
  demand_code: string | null
  outlet_id: string | null
  outlet_code: string | null
  outlet_name: string | null
  supplier_code: string | null
  supplier_name: string | null
  cargo_category_code: string | null
  status: string | null
  quantity_kg: string | null
  requested_date: string | null
  requested_start_time: string | null
  requested_end_time: string | null
  captured_at: string | null
  snapshot_version: string | null
  items: F1SnapshotItem[] | null
  promise_shortfalls: {
    demand_item_id: string
    required_weight_kg: string
    confirmed_weight_kg: string
    shortfall_weight_kg: string
  }[] | null
}

export interface F1DemandResult<Diagnostic = F1Diagnostic> {
  demand_id: number
  eligibility_status: string
  primary_reason_code: string | null
  plan_guard_status: string
  matching_status: string
  diagnostics: Diagnostic[]
  evidence: F1DemandEvidence | null
}

export interface F1MasterdataLabel {
  code: string
  name: string
}

export interface F1DemandDisplayLabels {
  source: 'CURRENT_MASTERDATA'
  supplier: F1MasterdataLabel | null
  outlet: F1MasterdataLabel | null
  items: Record<string, F1MasterdataLabel>
}

export type F1DisplayLabels = Record<string, F1DemandDisplayLabels>

export interface F1PreviewDemand extends F1DemandResult<string> {
  blockers: string[]
  reason_codes: string[]
  warnings: string[]
  detail: string
  capacity_results: { item_id: number; status: string }[]
}

export interface F1CandidateWindow {
  demand_ids: number[]
  requested_date: string
  cargo_category_ids: number[]
  common_start_time: string
  common_end_time: string
}

export interface F1CandidateGroup {
  group_code: string
  status: string
  memberships: { demand_id: number; eligibility_status: string }[]
  matching_reason: F1CandidateWindow | null
}

export interface F1Preview {
  captured_at: string
  rule_set_id: number
  rule_set_code: string
  rule_set_version: number
  business_rule_codes: string[]
  demand_results: F1PreviewDemand[]
  display_labels?: F1DisplayLabels
  candidate_groups: F1CandidateWindow[]
  business_rules_execution: string
  plan_guard_status: string
  matching_status: string
  ready_to_finalize: boolean
  all_demands_eligible: boolean
}

export interface F1RunSummary {
  run_code: string
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
  source_mode: string
  started_at: string
  completed_at: string | null
  rule_set_id: number
  rule_set_version: number | null
  rule_set_code: string | null
  configuration_captured_at: string | null
  cargo_matrix_source: string | null
  cargo_matrix_sheet: string | null
  max_group_size: number | null
  max_candidates_per_run: number | null
  demand_count: number
  evaluated_count: number
  eligible_count: number
  excluded_count: number
  matched_count: number
  unmatched_count: number
  candidate_count: number
  matching_outcome: 'MATCHED' | 'NO_CANDIDATE' | 'MATCHING_INCOMPLETE' | null
}

export interface F1Run extends F1RunSummary {
  failure_diagnostics: F1Diagnostic[]
  demand_results: F1DemandResult[]
  display_labels?: F1DisplayLabels
  candidate_groups: F1CandidateGroup[]
}

export interface F1History {
  count: number
  next: string | null
  previous: string | null
  results: F1RunSummary[]
}
