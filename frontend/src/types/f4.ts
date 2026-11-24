import type { F2PlanSummary } from './f2'
import type { F3Wave } from './f3'
import type { InternalPlanningApproval } from './f1'

export type F4Status = 'PASS' | 'HARD_CONFLICT' | 'SOFT_CONFLICT' | 'NOT_EVALUATED'
export type F4Role = 'SUPPLIER_PICKUP' | 'OUTLET_DELIVERY' | 'HUB_RECEIVE' | 'HUB_DISPATCH'

export interface F4Diagnostic {
  code: string
  stop?: string
  from_stop?: string
  to_stop?: string
  offer_id?: number
  outlet_id?: number
  rules?: string[]
  role?: F4Role
  [key: string]: unknown
}

export interface F4ClockWindow {
  start_time: string
  end_time: string
  source?: string
  reference?: string
}

export interface F4ReceivingSlot extends F4ClockWindow {
  slot_type: 'BLOCKED' | 'AVAILABLE'
  status: 'OPEN' | 'RESERVED' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED'
}

export interface F4Stop {
  sequence: number
  stop: string
  role: F4Role
  entity_id: number
  code: string | null
  name?: string | null
  demand_codes: string[]
  demand_ids: number[]
  weight_kg: string
  status: F4Status
  conflict_type: 'NONE' | 'HARD_CONFLICT' | 'SOFT_CONFLICT' | null
  arrival: string | null
  service_start: string | null
  service_end: string | null
  departure: string | null
  wait_minutes: number | null
  requested_window?: F4ClockWindow | null
  receiving_windows?: F4ClockWindow[]
  alternate_slots?: {
    start: string
    end: string
    status: 'PROPOSED'
    duration_minutes: number
    within_requested_window: boolean
    requires_demand_window_change: boolean
  }[]
  travel_from_previous: {
    from_stop: string
    to_stop: string
    minutes: number
    distance_km: string
    source: string
    reference: string
  } | null
  diagnostics: F4Diagnostic[]
  evidence: Record<string, unknown> & {
    service?: { minutes: number }
    inbound_released_at?: Record<string, string>
    requested_windows?: { id: number; requested_start_time: string; requested_end_time: string }[]
    receiving_calendar?: {
      windows: F4ClockWindow[]
      slots: F4ReceivingSlot[] | null
      observed_slots?: F4ReceivingSlot[]
      source?: string
      reference?: string
      slot_calendar_confirmed?: boolean
    }
  }
}

export interface F4Wave {
  wave_no: number
  phase: F3Wave['phase']
  vehicle: F3Wave['vehicle']
  weight_kg: string
  demand_ids: number[]
  status: F4Status
  receiving_status: F4Status | 'NONE'
  start: string | null
  end: string | null
  stops: F4Stop[]
  diagnostics: F4Diagnostic[]
  fleet_evidence: unknown[]
  operating_hours: { start_time: string | null; end_time: string | null }
}

export interface F4Evaluation {
  plan: F2PlanSummary
  f3_evaluation_code: string | null
  f3_uses_synthetic?: boolean
  status: F4Status
  service_date?: string
  demand_weight_kg?: string
  input_fingerprint?: string
  configuration_fingerprint?: string
  contract_version?: number
  configuration?: F4Configuration
  source_mode?: string
  internal_planning?: InternalPlanningApproval
  scenario_id?: string | null
  f1_common_window?: { start_time: string; end_time: string; scope: 'F1_GROUP_ELIGIBILITY' }
  evaluation_context?: 'OPERATIONAL' | 'UAT' | 'CAPSTONE'
  complete: boolean
  diagnostics: F4Diagnostic[]
  waves: F4Wave[]
  metrics: {
    first_pickup_at: string | null
    completed_at: string | null
    travel_minutes: number | null
    distance_km: string | null
    wait_minutes: number | null
    hub_handling_minutes: number | null
    delivery_stop_count: number
    on_time_stops: number
    conflict_stops: number
    not_evaluated_stops: number
  } | null
}

export interface F4Preview {
  contract_version: number
  evaluations: F4Evaluation[]
  selected_evaluation_code: string | null
  history_available: boolean
  configuration_fingerprint: string
  configuration: F4Configuration
  active_scenario?: string | null
  scenarios?: {code: string; label: string}[]
}

export interface F4Configuration {
  timezone: string
  rule_set_id: number
  rules: Record<string, unknown>
  parameters: Record<string, { value: unknown; data_type: string }>
  diagnostics: F4Diagnostic[]
  scope: 'PINNED_F1_RULE_SET' | 'F4_STAGE'
  version: string
}

export interface F4SaveReference {
  f3_evaluation_code: string
  input_fingerprint: string
  configuration_fingerprint: string
}

export interface SavedF4Summary extends F4SaveReference {
  internal_planning?: InternalPlanningApproval
  evaluation_code: string
  evaluated_at: string
  contract_version: number
  plan: F2PlanSummary
  status: F4Status
  evaluation_context: 'OPERATIONAL' | 'UAT' | 'CAPSTONE'
  source_mode: string
  configuration_version: string
  scenario_id?: string | null
  ready_for_f5: boolean
}

export interface SavedF4Detail extends SavedF4Summary {
  configuration: F4Configuration
  lineage: { run_code: string; group_code: string; f2_revision: number; f3_evaluation_code: string }
  result: F4Evaluation
}
