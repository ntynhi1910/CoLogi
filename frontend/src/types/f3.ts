import type { F2PlanSummary, F2Stop } from './f2'
import type { InternalPlanningApproval } from './f1'

export interface F3Diagnostic {
  code: string
  phase?: string
  demand_id?: number
  wave_no?: number
  supplier_id?: number | null
  outlet_id?: number | null
  reason?: string
  values?: string[]
}

export type F3GateStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNVERIFIED'

export interface F3OfferEvidence {
  offer_id: number
  vehicle_code: string
  vehicle_name: string
  capacity_kg: string
  offer_vehicle_count: number
  available_vehicle_count: number
  status: string
  cargo_compatibility: { cargo_category_id: number; is_supported: boolean | null; source: string | null }[]
  windows: {
    id: number
    service_date: string
    start_time: string
    end_time: string
    count: number
    status: string
    source: string
  }[]
}

export interface F3Wave {
  wave_no: number
  phase: 'DIRECT' | 'INBOUND' | 'OUTBOUND'
  vehicle: F3OfferEvidence
  allocated_weight_kg: string
  utilization_pct: string
  cargo_compatibility: { cargo_category_id: number; is_supported: boolean; source: string | null }[]
  supplier_coverage: { supplier_id: number; coverage_status: string; can_pickup: boolean }[]
  allocations: { demand_id: number; demand_code: string; weight_kg: string; from_stop: string; to_stop: string }[]
}

export interface F3HubCoverage {
  context: 'OPERATIONAL' | 'UAT' | 'CAPSTONE' | 'INTERNAL_PLANNING'
  service_date: string
  status: 'VERIFIED' | 'UNVERIFIED'
  uses_synthetic: boolean
  routes: {
    phase: 'INBOUND' | 'OUTBOUND'
    supplier_id: number | null
    outlet_id: number | null
    endpoint_code: string | null
    status: 'VERIFIED' | 'UNVERIFIED'
    reason: 'NO_EFFECTIVE_EVIDENCE' | 'NOT_CONFIRMED' | null
    evidence: {
      source: 'PROVIDER_CONFIRMED_IMPORT' | 'PROVIDER_PORTAL' | 'SYNTHETIC/UAT' | 'SYNTHETIC/CAPSTONE'
      source_reference: string
      confirmation_status: 'CONFIRMED' | 'PENDING' | 'REVOKED'
      valid_from: string
      valid_through: string
    } | null
  }[]
}

export interface F3Presentation {
  fleet: {
    sources: (F3OfferEvidence & { vehicles_required: number })[]
    available_count: number
    available_capacity_kg: string
    assigned_capacity_kg: string
    remaining_assigned_capacity_kg: string
  } | null
  rule_checks: { check: 'RULE-13' | 'RULE-14' | 'RULE-15'; status: string }[]
  parameters: {
    key: 'TIMEZONE' | 'WEIGHT_UNIT' | 'UTILIZATION_WARNING_PCT'
    configured: boolean
    invalid: boolean
    value: unknown
  }[]
}

export interface ValidF3Evaluation {
  internal_planning?: InternalPlanningApproval
  plan: F2PlanSummary
  status: 'ALLOCATION_VERIFIED' | 'EVIDENCE_INCOMPLETE' | 'NOT_ALLOCATED'
  gate_status: F3GateStatus
  hard_constraints: { check: string; status: string }[]
  demand_ids: number[]
  total_required_weight_kg: string
  provider: { id: number; provider_code: string; provider_name: string; service_region: string } | null
  vehicles_required: number | null
  utilization_pct: string | null
  offers: F3OfferEvidence[]
  waves: F3Wave[]
  stops: F2Stop[]
  diagnostics: F3Diagnostic[]
  f4_pending: string[]
  availability_envelope: { date: string; start_time: string; end_time: string }
  search: 'BOUNDED' | 'EXHAUSTIVE_WITHIN_ENVELOPE' | 'NOT_RUN'
  configuration: { configured_rule_codes: string[]; missing_parameter_keys: string[] }
  hub_coverage?: F3HubCoverage
  presentation?: F3Presentation
  contract_version?: number
  input_fingerprint?: string
  configuration_fingerprint?: string
}

export type F3Evaluation = ValidF3Evaluation | {
  plan: F2PlanSummary
  status: 'INVALID_PLAN'
  gate_status: 'NOT_ELIGIBLE'
  diagnostics: F3Diagnostic[]
}

export interface F3Preview {
  evaluations: F3Evaluation[]
  persistence_available: boolean
  acceptance_preview_plan_code?: string
}

export interface F3ManagerAcceptancePreview {
  evaluation_context: 'MANAGER_ACCEPTANCE'
  preview_only: true
  persistence_available: false
  ready_for_f4: false
  decision_reference: string
  manifest_sha256: string
  classification: 'MANAGER_ACCEPTED_FOR_OPERATIONAL_TESTING'
  provider_independently_verified: false
  admitted_sources: {
    legacy_id: number
    offer_id: number
    vehicle_type: string
    workbook_sha256: string
    sheet: string
    range: string
    original_provenance: string
    stored_source_mode: string
    audit_log_id: number
  }[]
  selected_legacy_ids: number[]
  evaluation: ValidF3Evaluation
}

export interface SavedF3Summary {
  internal_planning?: InternalPlanningApproval
  evaluation_code: string
  plan: F2PlanSummary
  evaluated_at: string
  evaluated_by_id: number
  gate_status: F3GateStatus
  ready_for_f4: boolean
  contract_version: number
  input_fingerprint: string
  configuration_fingerprint: string
}

export interface SavedF3Detail extends SavedF3Summary {
  f3_structure: { result: ValidF3Evaluation }
  presentation: F3Presentation
}
