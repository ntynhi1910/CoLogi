import type { F1Run } from '../../types/f1'
import type { DeliveryDemand } from '../../types/demand'
import type { F4Evaluation, F4Status, F4Stop } from '../../types/f4'

export const statuses: Record<F4Status, string> = {
  PASS: 'Đạt kiểm tra thời gian',
  HARD_CONFLICT: 'Xung đột bắt buộc',
  SOFT_CONFLICT: 'Xung đột cần xác nhận',
  NOT_EVALUATED: 'Chưa đủ bằng chứng',
}
export const roles = {
  SUPPLIER_PICKUP: 'Lấy hàng tại nhà cung cấp',
  OUTLET_DELIVERY: 'Giao hàng tại Outlet',
  HUB_RECEIVE: 'Nhận và xử lý hàng tại Hub',
  HUB_DISPATCH: 'Bàn giao hàng từ Hub',
}
export const issues: Record<string, string> = {
  SAVED_F3_ELIGIBLE_REQUIRED: 'Cần kết quả F3 đã lưu đủ điều kiện trên bản nháp F2 này.',
  F4_RULES_REQUIRED: 'RuleSet đã chốt thiếu quy tắc F4.',
  F4_RULES_UNSUPPORTED: 'Định nghĩa quy tắc F4 chưa được hỗ trợ.',
  TIMEZONE_INCONSISTENT: 'Nguồn múi giờ không nhất quán.',
  OPERATING_HOURS_REQUIRED: 'Thiếu giờ hoạt động của offer xe.',
  VEHICLE_AVAILABILITY_REQUIRED: 'Thiếu lịch xe cho ngày vận chuyển.',
  SERVICE_DURATION_REQUIRED: 'Thiếu thời lượng xử lý có bằng chứng tại điểm.',
  PICKUP_DATE_MISMATCH: 'Ngày sẵn sàng của nhà cung cấp khác ngày vận chuyển.',
  RECEIVING_WINDOWS_REQUIRED: 'Thiếu khung giờ nhận hàng đã xác minh.',
  RECEIVING_SLOTS_REQUIRED: 'Thiếu nguồn xác minh lịch chặn và giữ chỗ nhận hàng.',
  HUB_HOURS_REQUIRED: 'Thiếu khung giờ hoạt động của Hub.',
  TRAVEL_EVIDENCE_REQUIRED: 'Thiếu thời gian và khoảng cách có bằng chứng cho chặng.',
  RECEIVING_RESERVED: 'Khoảng nhận hàng trùng chỗ đang giữ. Cần xác nhận.',
  RECEIVING_BLOCKED: 'Khoảng nhận hàng bị chặn.',
  RECEIVING_BLOCK_AVOIDED: 'Đã dời giờ bắt đầu xử lý để tránh khoảng nhận bị chặn.',
  DELIVERY_WINDOW_CONFLICT: 'Khoảng giao không nằm trọn trong giờ Demand yêu cầu và khung giờ Outlet nhận.',
  PICKUP_WINDOW_CONFLICT: 'Khoảng lấy hàng vượt khung giờ nhà cung cấp xác nhận.',
  HUB_WINDOW_CONFLICT: 'Khoảng xử lý hoặc bàn giao vượt giờ hoạt động của Hub.',
  VEHICLE_OPERATING_HOURS_CONFLICT: 'Wave vượt giờ hoạt động của xe.',
  VEHICLE_PERIOD_UNVERIFIED: 'Một phần lịch wave thiếu bằng chứng khả dụng của xe.',
  VEHICLE_FLEET_CONFLICT: 'Số xe khả dụng không đủ cho các wave chồng giờ.',
  PREVIOUS_STOP_UNAVAILABLE: 'Điểm trước chưa thể hoàn thành.',
  HUB_INBOUND_NOT_READY: 'Chưa xác nhận thời điểm hoàn thành inbound cho toàn bộ hàng của wave này.',
  F4_SEQUENCE_NOT_EXHAUSTIVE: 'Trình tự đã xét có xung đột. Chưa đủ căn cứ kết luận mọi lịch đều không khả thi.',
  F4_OPTION_OUTSIDE_SCENARIO: 'Phương án này nằm ngoài phạm vi kịch bản đang chọn.',
}

export const noValue = '—'
const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 })
export const duration = (value: number | null | undefined) => value == null ? noValue : `${number.format(value)} phút`
export const kilometres = (value: string | null | undefined) => value == null ? noValue : `${number.format(Number(value))} km`

export function localTime(value: string | null | undefined, timezone: string) {
  return value ? new Intl.DateTimeFormat('vi-VN', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value)) : noValue
}

export function elapsedMinutes(start?: string | null, end?: string | null) {
  return start && end ? (Date.parse(end) - Date.parse(start)) / 60_000 : null
}

export function candidateInfo(run: F1Run | null, groupCode: string, evaluations: F4Evaluation[]) {
  const group = run?.candidate_groups.find(row => row.group_code === groupCode)
  const ids = new Set(group?.memberships.map(row => row.demand_id))
  const stops = evaluations.flatMap(row => row.waves.flatMap(wave => wave.stops))
  const names: StopNames = {}
  const outlets = new Set<string>()
  for (const row of run?.demand_results ?? []) {
    if (!ids.has(row.demand_id) || !row.evidence) continue
    const { outlet_id, outlet_code, outlet_name, supplier_code, supplier_name } = row.evidence
    if (outlet_id) outlets.add(outlet_id)
    if (outlet_code && outlet_name) names[`OUTLET_DELIVERY:${outlet_code}`] = { name: outlet_name }
    if (supplier_code && supplier_name) names[`SUPPLIER_PICKUP:${supplier_code}`] = { name: supplier_name }
  }
  const outletStops = new Set(stops.filter(stop => stop.role === 'OUTLET_DELIVERY').map(stop => stop.entity_id))
  const demandIds = ids.size ? [...ids] : [...new Set(stops.flatMap(stop => stop.demand_ids))]
  return {
    names,
    demandIds: demandIds.sort((a, b) => a - b),
    outletCount: outlets.size || outletStops.size || null,
    weight: evaluations.find(row => row.demand_weight_kg)?.demand_weight_kg,
    date: group?.matching_reason?.requested_date ?? evaluations.find(row => row.service_date)?.service_date,
  }
}

export type StopNames = Record<string, { name: string; code?: string }>

export function pointNames(rows: DeliveryDemand[]) {
  const names: StopNames = {}
  for (const row of rows) {
    names[`SUPPLIER_PICKUP:#${row.supplier_id}`] = { code: row.supplier_code, name: row.supplier_name }
    names[`OUTLET_DELIVERY:#${row.outlet_id}`] = { code: row.outlet_code, name: row.outlet_name }
  }
  return names
}

export function stopIdentity(stop: F4Stop, evaluation: F4Evaluation, names: StopNames) {
  const hub = stop.role === 'HUB_RECEIVE' || stop.role === 'HUB_DISPATCH' ? evaluation.plan.hub : null
  const catalog = names[`${stop.role}:#${stop.entity_id}`]
  const capturedCode = stop.code || hub?.code
  const capturedName = stop.name || hub?.name || (capturedCode ? names[`${stop.role}:${capturedCode}`]?.name : undefined)
  return {
    code: capturedCode || catalog?.code || (stop.role === 'SUPPLIER_PICKUP' ? `NCC #${stop.entity_id}` : stop.stop),
    name: capturedName || catalog?.name,
    fromCatalog: !capturedName && !!catalog?.name,
  }
}

export function stopLabel(stop: F4Stop, evaluation: F4Evaluation, names: StopNames) {
  const { code, name } = stopIdentity(stop, evaluation, names)
  if (code && name && code !== name) return `${code} · ${name}`
  return code
}

export function firstConflict(evaluation: F4Evaluation, timezone: string, names: StopNames) {
  const stop = evaluation.waves.flatMap(wave => wave.stops).find(row =>
    row.status === 'HARD_CONFLICT' || row.status === 'SOFT_CONFLICT',
  )
  if (!stop) return evaluation.diagnostics[0] ? issues[evaluation.diagnostics[0].code] ?? evaluation.diagnostics[0].code : null

  let reason = stop.diagnostics.map(row => issues[row.code] ?? row.code).join(' ')
  const arrival = stop.arrival
  const deadline = stop.requested_window?.end_time
  if (arrival && deadline && evaluation.service_date && stop.role === 'OUTLET_DELIVERY' &&
      stop.diagnostics.some(row => row.code === 'DELIVERY_WINDOW_CONFLICT')) {
    const local = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(arrival)).replace(' ', 'T')
    const late = elapsedMinutes(`${evaluation.service_date}T${deadline}Z`, `${local}Z`)
    if (late !== null && late > 0) {
      reason = `Đến ${localTime(arrival, timezone)} · Hạn giao của Demand ${deadline.slice(0, 5)} · Muộn ${duration(late)}.`
    }
  }
  const skipped = evaluation.metrics?.not_evaluated_stops
  return `${stopLabel(stop, evaluation, names)} · ${reason}${skipped ? ` ${skipped} điểm giao chưa được đánh giá.` : ''}`
}

