export const publicationLabels = {
  UNPLANNED: 'Chưa lập kế hoạch', OPTION_READY: 'Đã có phương án', APPROVED: 'Đã phê duyệt, chưa công bố',
  PUBLISHED: 'Đã công bố', AWAITING_TRANSPORT: 'Đã công bố · Chờ vận chuyển xác nhận',
  CONFIRMED: 'Vận chuyển đã xác nhận', DECLINED: 'Vận chuyển từ chối',
  SUPERSEDED: 'Phiên bản đã thay thế', NEEDS_ADJUSTMENT: 'Cần điều chỉnh kế hoạch',
} as const

export type LogisticsStatus = keyof typeof publicationLabels

export const effectivePlanStatuses: LogisticsStatus[] = ['APPROVED', 'AWAITING_TRANSPORT', 'CONFIRMED']

export function hasEffectiveFinalPlan(status?: LogisticsStatus) {
  return status !== undefined && effectivePlanStatuses.includes(status)
}

export function receiptLink(code: string, demandId: number) {
  return `/purchasing/receipts/${code}?demand=${demandId}`
}

export type PublicationAudience = 'supplier' | 'purchasing'
export const publicationPaths = { supplier: '/supplier/shipments', purchasing: '/purchasing/receipts' }
export type PublicationEvent = { id: string; kind: LogisticsStatus; at: string; code: string; version: number }
export type PublicationEntity = { id: number; name: string | null; code: string | null }
export type PublicationItem = PublicationEntity & { unit: string | null; weight_kg: string }
export type PublicationDemand = { id: number; code: string; supplier: PublicationEntity; outlet: PublicationEntity; weight_kg: string; items: PublicationItem[] }
export type PublicationStop = {
  sequence: number; role: 'SUPPLIER_PICKUP' | 'OUTLET_DELIVERY' | 'HUB_RECEIVE' | 'HUB_DISPATCH'
  code: string | null; address: string | null
  arrival: string | null; start: string | null; end: string | null; departure: string | null; weight_kg: string
  wait_minutes?: number | null
  loads: { demand_id: number; weight_kg: string; items: PublicationItem[] | null }[]
}
export type PublishedPlan = {
  code: string; version: number; status: LogisticsStatus; service_date: string; timezone: string
  published_at: string | null; responded_at: string | null
  provider: PublicationEntity; hub: PublicationEntity | null; demands: PublicationDemand[]
  provenance: { classification: string; provider_independently_verified: boolean; time_source: string; price_source: string }
  waves: { number: number; phase: string; vehicle: { name: string; code: string }; weight_kg: string | null;
    stops: PublicationStop[]; in_transit_kg?: string }[]
  events: PublicationEvent[]
}
export type PublicationRecipient = PublicationEntity & {
  account_count: number; view_access: 'AVAILABLE' | 'AWAITING_PUBLICATION' | 'NO_ACTIVE_SCOPE' | 'HISTORY_ONLY'
}
export type PublicationRecipients = {
  status: LogisticsStatus; suppliers: PublicationRecipient[]
  outlets: (PublicationRecipient & { purchasing_staff: string[] })[]
  provider: PublicationRecipient; events: PublicationEvent[]
}
export type PublicationIndex = {
  plans: PublishedPlan[]
  summary: { upcoming: number; upcoming_weight_kg: string; awaiting: number; confirmed: number; active_demand_count?: number }
  events: PublicationEvent[]
}
