import type { F4ClockWindow, F4ReceivingSlot, F4Stop } from '../../types/f4'

export const windowLabels = {
  requested: 'Khung Demand', receiving: 'Lịch nhận Outlet', valid: 'Khung giao hợp lệ',
  blocked: 'Slot bị chặn', reserved: 'Slot giữ chỗ (cần xác nhận)',
}

export type WindowBand = { kind: keyof typeof windowLabels; start: number; end: number; source: string }
type Clock = (value: string) => number
export type OutletWindows = { bands: WindowBand[]; deadline?: number; warning?: string }

export function snapshotClock(day: string | undefined, timezone: string): Clock {
  if (!day) return () => NaN
  const date = new Date(`${day}T12:00:00Z`)
  if (!Number.isFinite(date.getTime())) return () => NaN
  // F4 records a local service date in Asia/Ho_Chi_Minh and local calendar times.
  const offset = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(date).find(part => part.type === 'timeZoneName')?.value.slice(3)
  return value => Date.parse(`${day}T${value}${offset || 'Z'}`)
}

function band(window: F4ClockWindow, kind: WindowBand['kind'], clock: Clock, fallback: string): WindowBand | undefined {
  const start = clock(window.start_time)
  const end = clock(window.end_time)
  if (!(end > start)) return
  return { kind, start, end, source: [window.source, window.reference].filter(Boolean).join(' · ') || fallback }
}

function slotKind(slot: F4ReceivingSlot) {
  if (slot.status === 'CONFIRMED' || (slot.slot_type === 'BLOCKED' && slot.status === 'OPEN')) return 'blocked'
  if (slot.status === 'RESERVED') return 'reserved'
}

export function outletWindows(stop: F4Stop, clock: Clock): OutletWindows {
  if (stop.role !== 'OUTLET_DELIVERY') return { bands: [] }
  const captured = stop.evidence.requested_windows ?? []
  const demandBands = captured.flatMap(row => {
    const demand = stop.demand_codes[stop.demand_ids.indexOf(row.id)] || `#${row.id}`
    const interval = band({ start_time: row.requested_start_time, end_time: row.requested_end_time },
      'requested', clock, `Snapshot F4 · Demand ${demand}`)
    return interval ? [interval] : []
  })
  const common = stop.requested_window && band(stop.requested_window, 'requested', clock,
    'Snapshot F4 · khung giao đã đối chiếu tại điểm')
  const allDemandsCaptured = stop.demand_ids.length > 0 &&
    stop.demand_ids.every(id => captured.some(row => row.id === id && clock(row.requested_end_time) > clock(row.requested_start_time)))
  const constraints = [...(common ? [common] : []), ...(allDemandsCaptured ? demandBands : [])]
  const start = constraints.length ? Math.max(...constraints.map(item => item.start)) : NaN
  const end = constraints.length ? Math.min(...constraints.map(item => item.end)) : NaN
  const requested = end > start ? { kind: 'requested' as const, start, end, source: constraints.map(item => item.source).join(' · ') } : undefined

  const calendar = stop.evidence.receiving_calendar
  const calendarSource = [calendar?.source, calendar?.reference].filter(Boolean).join(' · ') || 'Snapshot F4 · Lịch nhận Outlet'
  const windows = calendar?.windows ?? stop.receiving_windows ?? []
  const receiving = windows.flatMap(window => {
    const interval = band(window, 'receiving', clock, calendarSource)
    return interval ? [interval] : []
  })
  const confirmed = calendar?.slot_calendar_confirmed !== false && Array.isArray(calendar?.slots)
  const rawSlots = calendar?.slots ?? calendar?.observed_slots ?? []
  const slots = rawSlots.flatMap(slot => {
    const kind = slotKind(slot)
    const interval = kind && band(slot, kind, clock, calendarSource)
    return interval ? [interval] : []
  })
  const blockersKnown = confirmed && slots.length === rawSlots.filter(slotKind).length
  const complete = !!requested && receiving.length > 0 && receiving.length === windows.length && blockersKnown
  const valid: WindowBand[] = (complete && requested ? receiving : []).flatMap(window => {
    const overlap = {
      kind: 'valid' as const, start: Math.max(start, window.start), end: Math.min(end, window.end),
      source: `${requested?.source} · ${window.source} · Slot: ${calendarSource}`,
    }
    if (overlap.start >= overlap.end) return []
    return slots.reduce<WindowBand[]>((available, slot) => available.flatMap(part => {
      if (slot.end <= part.start || slot.start >= part.end) return [part]
      const before = { ...part, end: slot.start }
      const after = { ...part, start: slot.end }
      return [before, after].filter(piece => piece.end > piece.start)
    }), [overlap])
  })
  return {
    bands: [...(requested ? [requested] : []), ...receiving, ...valid, ...slots],
    deadline: requested?.end ?? common?.end,
    warning: complete ? undefined : constraints.length && !requested
      ? 'Các Demand tại điểm không có khung giao chung trong snapshot.'
      : 'Snapshot thiếu khung Demand, lịch nhận hoặc xác nhận slot. Chưa xác định được khung giao hợp lệ.',
  }
}
