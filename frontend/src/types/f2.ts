export interface F2Hub {
  id: number
  code: string
  name: string
  address: string
}

export interface F2Diagnostic {
  code: string
  demand_id?: number
  hub_id?: number | null
}

export interface F2DemandItem {
  item_id: number
  required_weight_kg: string
  confirmed_weight_kg: string | null
}

export interface F2Demand {
  id: number
  code: string
  supplier_id: number
  outlet_id: number
  outlet_code: string
  cargo_category_id: number
  cargo_category_code: string
  requested_date: string
  requested_start_time: string | null
  requested_end_time: string | null
  required_weight_kg: string
  items: F2DemandItem[]
  pickup_address: string | null
  pickup_ready_date: string | null
  pickup_ready_start_time: string | null
  pickup_ready_end_time: string | null
  supplier_request_id: number | null
  supplier_confirmation_id: number | null
  snapshot_captured_at: string
  snapshot_version: string
}

interface AssignedLoad {
  demand_ids: number[]
  load_kg: string | null
}

export interface F2Stop extends AssignedLoad {
  key: string
  kind: 'SUPPLIER' | 'HUB' | 'OUTLET'
  entity_id: number
  code: string | null
  address: string | null
}

export interface F2Leg extends AssignedLoad {
  phase: 'DIRECT' | 'INBOUND' | 'OUTBOUND'
  from_stop: string
  to_stop: string
}

export interface F2Option {
  option_key: string
  template_type: 'DIRECT_CONSOLIDATED' | 'HUB_BASED'
  status: 'DRAFT'
  structural_status: 'COMPLETE' | 'INCOMPLETE'
  ready_for_f3: boolean
  demand_ids: number[]
  total_required_weight_kg: string | null
  hub: F2Hub | null
  stops: F2Stop[]
  legs: F2Leg[]
  diagnostics: F2Diagnostic[]
}

export interface F2Options {
  contract_version: string
  persistence: 'AVAILABLE' | 'MIGRATION_REQUIRED'
  saved_plans: F2PlanSummary[]
  lineage: {
    run_code: string
    group_code: string
    run_status: string
    candidate_status: string
    rule_set_id: number
    rule_set_code: string | null
    rule_set_version: number | null
    configuration_captured_at: string | null
    configuration_fingerprint: string | null
    max_group_size: number | null
    max_candidates_per_run: number | null
    cargo_matrix_source: string | null
    cargo_matrix_sheet: string | null
    f1_rule_codes: string[]
  }
  basis: {
    demand_ids: number[]
    requested_date: string
    common_start_time: string
    common_end_time: string
    cargo_category_ids: number[]
    outlet_count: number | null
    total_required_weight_kg: string | null
    demands: F2Demand[]
  }
  options: F2Option[]
}

export interface F2PlanSummary {
  plan_code: string
  supersedes_plan_code: string | null
  revision: number
  template_type: F2Option['template_type']
  hub_id: number | null
  hub: F2Hub | null
  status: 'DRAFT'
  option_key: string
  created_at: string
}

export interface F2Plan extends F2PlanSummary {
  f2_structure: {
    schema_version: number
    lineage: F2Options['lineage']
    basis: F2Options['basis']
    option: F2Option
  }
}
