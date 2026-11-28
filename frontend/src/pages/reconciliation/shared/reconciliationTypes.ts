
export type Audience =
  | 'manager'
  | 'supplier'
  | 'provider'
  | 'purchasing'

export type Quantity = number | string | null

export type Entity = {
  id: number
  code: string | null
  name: string | null
}

export type RecordRow = {
  id: number
  action: string
  actor: string
  reason: string
  at: string
  mode: string
  evidence: Record<string, string>
}

export type Allocation = {
  outlet_id: number
  outlet_code: string
  baseline_cost: Quantity
  allocated_cost: Quantity
  participant_saving: Quantity
}

export type Cost = {
  baseline_vnd: Quantity
  planned_vnd: Quantity
  actual_vnd: Quantity
  variance_vnd: Quantity
  planned_saving_vnd: Quantity
  actual_saving_vnd: Quantity
  status: string
  claim: RecordRow | null
  review: RecordRow | null
  planned_allocations: Allocation[]
  actual_allocations: Allocation[] | null
  planned_components: {
    component_type: string
    scope: string
    amount: Quantity
    source_reference: string
  }[]
}

export type PlanSummary = {
  code: string
  version: number
  date: string
  status: string
  current: boolean
  template: string
  mode: string
  source: {
    classification: string
    time_source?: string
    price_source?: string
  }
  provider: Entity
  hub: Entity | null
  cost: Cost | null
  demands: number
  planned_kg: Quantity
  received_kg: Quantity
}

export type Overview = {
  mode: string
  generated_at: string
  plans: PlanSummary[]
  kpis: Record<string, Quantity>
  trends: (Record<string, Quantity> & {
    date: string
  })[]
  templates: Record<string, Record<string, Quantity>>
  facets: Record<string, Entity[]>
  breakdown: Record<
    string,
    ({ entity: Entity } & Record<string, Quantity | Entity>)[]
  >
}
