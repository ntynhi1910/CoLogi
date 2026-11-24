import type { F2PlanSummary } from './f2'
import type { F4Status } from './f4'
import type { InternalPlanningApproval } from './f1'

export type F5Status = 'BLOCKED' | 'NOT_EVALUATED' | 'EVALUATED'

export interface F5Issue {
  code: string
  wave_no?: number
  outlet_id?: number
  demand_codes?: string[]
  scope?: string
  reference?: string
}

export interface F5Component {
  component_type: 'TRANSPORT' | 'HUB_HANDLING' | 'HANDLING' | 'OTHER'
  wave_no: number | null
  scope: string
  pricing_basis: string
  covers: string[]
  quantity: string
  unit_code: string
  unit_rate: string
  raw_amount: string
  amount: string
  source_type: string
  source_reference: string
  valid_from: string
  valid_to: string
  formula: string
  distance_evidence?: Record<string, unknown>
}

export interface F5Allocation {
  outlet_id: number
  outlet_code: string
  weight_kg: string
  order_count: number
  share_pct: string
  baseline_cost: string
  allocated_cost: string
  participant_saving: string
}

export interface F5Configuration {
  version: string
  allocation_method: 'WEIGHT' | 'ORDER_COUNT'
  currency_code?: string
  rounding_unit_vnd?: number
  rounding_mode?: string
  allocation_residual?: string
  distance_basis?: string
  service_basis?: string
}

export interface F5Option {
  plan: F2PlanSummary
  lineage: Record<string, unknown> & { f4_evaluation_code: string; f3_evaluation_code: string; f2_revision: number } | null
  status: F5Status
  f4_status: F4Status | null
  f4_diagnostics: string[]
  rank: number | null
  ranking_reason?: string
  collaborative_cost: string | null
  cost_saving: string | null
  saving_rate_pct: string | null
  waves: { wave_no: number; phase: 'DIRECT' | 'INBOUND' | 'OUTBOUND'; offer_id: number; distance_km: string; cost: string | null }[]
  components: F5Component[]
  allocations: F5Allocation[]
  diagnostics: F5Issue[]
  input_fingerprint: string | null
}

export interface F5Preview {
  contract_version: number
  run_code: string
  group_code: string
  scenario: string | null
  evaluation_context: 'UAT' | 'OPERATIONAL' | 'CAPSTONE'
  service_date: string
  total_weight_kg: string
  demand_basis_fingerprint: string
  demands: { id: number; code: string; outlet_id: number; outlet_code: string; required_weight_kg: string }[]
  selected_f4_evaluation_code: string
  options: F5Option[]
  baseline_cost: string | null
  baseline_inputs: {
    demand_id: number; demand_code: string; amount: string; components: F5Component[]
    distance_evidence: Record<string, unknown> | null
  }[]
  recommendation: { status: 'NOT_EVALUATED' | 'TIE' | 'SINGLE_EVALUATED' | 'RECOMMENDED'; plan_codes: string[]; reason: string }
  configuration: F5Configuration | null
  rule_catalog_v7: Record<string, { expression: string; rule_type: string }>
  audit: {
    cost_profile_count: number; run_cost_profile_id: number | null; active_pinned_f5_rules: string[]
    database_parameters: Record<string, unknown>
    offers: { id: number; provider_id: number; fixed_quote_vnd: string | null; estimated_cost_per_km_vnd: string | null }[]
  }
  price_evidence: { approval_reference: string; source_mode: string; internal_planning?: InternalPlanningApproval } | null
  diagnostics: F5Issue[]
  fingerprint: string
  configuration_fingerprint: string | null
  persistence_available: boolean
}

export interface F5SaveReference {
  f4_evaluation_code: string
  input_fingerprint: string
  configuration_fingerprint: string
}

export interface F5Saved extends F5SaveReference {
  internal_planning?: InternalPlanningApproval
  evaluation_code: string
  plan: F2PlanSummary
  contract_version: number
  calculated_at: string
  comparison_fingerprint: string
  configuration_version: string
  scenario: string | null
  evaluation_context: 'UAT' | 'OPERATIONAL' | 'CAPSTONE'
  baseline_cost: string
  collaborative_cost: string
  cost_saving: string
  saving_rate_pct: string | null
}

export interface F5SavedDetail extends F5Saved {
  snapshot: {
    run_code: string
    group_code: string
    scenario: string | null
    lineage: NonNullable<F5Option['lineage']>
    configuration: NonNullable<F5Preview['configuration']>
    price_inputs: Record<string, unknown>
    comparison: {
      fingerprint: string
      recommendation: F5Preview['recommendation']
      options: Pick<F5Option, 'plan' | 'status' | 'collaborative_cost' | 'rank'>[]
    }
    result: Pick<F5Preview, 'baseline_cost' | 'baseline_inputs' | 'demands' | 'service_date' | 'total_weight_kg'> & { option: F5Option }
  }
}

export type F5SaveResult =
  | { f4_evaluation_code: string; outcome: 'CREATED' | 'EXISTS'; evaluation: F5Saved }
  | { f4_evaluation_code: string; outcome: 'REJECTED'; code: string }

export interface F5SaveResponse {
  results: F5SaveResult[]
  created_count: number
}
