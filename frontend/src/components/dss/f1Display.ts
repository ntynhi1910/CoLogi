import type { F1CandidateGroup, F1CandidateWindow, F1DemandDisplayLabels, F1DemandEvidence, F1DemandResult, F1DisplayLabels, F1MasterdataLabel, F1PreviewDemand } from '../../types/f1'

export const missing = 'Chưa có dữ liệu'

const labels: Record<string, string> = {
  IN_PROGRESS: 'Đang xử lý',
  COMPLETED: 'Hoàn thành',
  FAILED: 'Thất bại',
  MATCHED: 'Có nhóm ứng viên',
  NO_CANDIDATE: 'Không có nhóm ứng viên',
  MATCHING_INCOMPLETE: 'Chưa hoàn tất ghép nhóm',
  ELIGIBLE: 'Đủ điều kiện',
  EXCLUDED: 'Không đủ điều kiện',
  NOT_EVALUATED: 'Chưa đánh giá',
  UNMATCHED: 'Đủ điều kiện nhưng chưa tìm được nhóm',
  INCLUDED: 'Được ghép nhóm',
  MULTIPLE_CANDIDATES: 'Có mặt trong nhiều nhóm',
  CANDIDATE: 'Ứng viên',
  ACCEPTED: 'Đã chấp nhận',
  MODIFIED: 'Đã điều chỉnh',
  REJECTED: 'Đã từ chối',
  PASS: 'Đạt kiểm tra',
  CONFLICT: 'Xung đột với kế hoạch',
  VERIFIED: 'Đã xác minh',
  UNVERIFIED: 'Chưa xác minh',
  EXCEEDED: 'Vượt năng lực cung ứng',
  INVALID_INPUT: 'Dữ liệu không hợp lệ',
  DRAFT: 'Bản nháp',
  SUBMITTED: 'Đã gửi',
  PLANNING: 'Đang lập kế hoạch',
  PLANNED: 'Đã lập kế hoạch',
  CANCELLED: 'Đã hủy',
  BLOCKER: 'Điều kiện chặn',
  WARNING: 'Cảnh báo',
  INFO: 'Thông tin',
  ELIGIBILITY: 'Kiểm tra điều kiện',
  CAPACITY: 'Năng lực cung ứng',
  PLAN_GUARD: 'Kiểm tra kế hoạch',
  CAPTURE: 'Ghi nhận đầu vào',
  RESULT: 'Đánh giá và lưu kết quả',
  API: 'Qua API',
  MANUAL: 'Thủ công',
  BATCH: 'Theo lô',
  SYNTHETIC: 'Dữ liệu kiểm thử',
  DEMAND_NOT_SUBMITTED: 'Nhu cầu chưa được gửi.',
  DEMAND_VALIDATION_FAILED: 'Dữ liệu nhu cầu không hợp lệ.',
  DEMAND_DATA_INVALID: 'Dữ liệu nhu cầu không hợp lệ.',
  SUPPLIER_INACTIVE: 'Nhà cung cấp đã ngừng hoạt động.',
  CARGO_CATEGORY_INACTIVE: 'Nhóm hàng đã ngừng hoạt động.',
  SUPPLIER_OFFER_INACTIVE: 'Mặt hàng cung ứng đã ngừng hoạt động hoặc chưa được khai báo.',
  SUPPLIER_ITEM_INVALID: 'Mặt hàng của nhà cung cấp không hợp lệ.',
  INVALID_SOURCE_ITEM: 'Nguồn cung ứng đã chọn không hợp lệ.',
  SUPPLIER_CONFIRMATION_FAILED: 'Không đạt điều kiện xác nhận cung ứng.',
  CAPACITY_RESULT_MISSING: 'Thiếu kết quả kiểm tra năng lực cung ứng.',
  CAPACITY_UNVERIFIED: 'Chưa xác minh được năng lực cung ứng.',
  CAPACITY_EXCEEDED: 'Vượt năng lực cung ứng.',
  CAPACITY_INVALID: 'Dữ liệu năng lực cung ứng không hợp lệ.',
  INPUT_INCONSISTENT: 'Dữ liệu đầu vào không nhất quán.',
  LATEST_REQUEST_MISSING: 'Chưa có yêu cầu gửi nhà cung cấp.',
  LATEST_REQUEST_NOT_RESPONDED: 'Nhà cung cấp chưa phản hồi yêu cầu mới nhất.',
  LATEST_CONFIRMATION_MISSING: 'Yêu cầu mới nhất thiếu xác nhận của nhà cung cấp.',
  CONFIRMATION_LINK_MISMATCH: 'Thông tin xác nhận không khớp với yêu cầu cung ứng.',
  INVALID_CONFIRMATION_LINK: 'Liên kết xác nhận cung ứng không hợp lệ.',
  CONFIRMATION_STATUS_INCONSISTENT: 'Trạng thái xác nhận chưa nhất quán với các dòng hàng.',
  PROMISE_DUPLICATE: 'Có xác nhận trùng cho một dòng hàng.',
  PROMISE_LINK_MISMATCH: 'Xác nhận mặt hàng không khớp với nhu cầu.',
  PROMISE_MISSING: 'Thiếu xác nhận cho một hoặc nhiều dòng hàng.',
  PROMISE_INSUFFICIENT: 'Khối lượng xác nhận chưa đủ.',
  PROMISE_LINE_NOT_CONFIRMED: 'Có dòng mặt hàng chưa được xác nhận đầy đủ.',
  DEMAND_IN_FINALIZED_PLAN: 'Nhu cầu đã có trong kế hoạch chốt.',
  PLAN_GUARD_NOT_EVALUATED: 'Chưa xác minh được xung đột với kế hoạch chốt.',
  CANDIDATE_LIMIT_EXCEEDED: 'Số nhóm vượt giới hạn của lần chạy.',
  RUN_CAPTURE_FAILED: 'Không thể ghi nhận đầu vào lần chạy.',
  RUN_RESULT_FAILED: 'Không thể lưu kết quả lần chạy.',
  RUN_NOT_IN_PROGRESS: 'Lần chạy không còn ở trạng thái đang xử lý.',
  RUN_CAPTURE_SCOPE_CHANGED: 'Phạm vi nhu cầu thay đổi khi ghi nhận đầu vào.',
  RUN_SCOPE_ALREADY_CAPTURED: 'Phạm vi nhu cầu đã được ghi nhận.',
  RUN_CAPTURE_SNAPSHOT_SET_MISMATCH: 'Tập snapshot không khớp với phạm vi nhu cầu.',
  RUN_CAPTURE_SNAPSHOT_IDENTITY_INVALID: 'Snapshot ghi nhận không đúng nhu cầu.',
  F1_COMPLETED_EVALUATION_REQUIRED: 'Thiếu kết quả đánh giá F1 đã hoàn thành.',
  RUN_RESULT_REQUIRES_ACTIVE_TRANSACTION: 'Không thể lưu kết quả trong phiên xử lý hiện tại.',
  RUN_RESULT_SCOPE_MISMATCH: 'Kết quả đánh giá không khớp với phạm vi nhu cầu.',
  RUN_RESULT_ELIGIBILITY_NOT_EVALUATED: 'Chưa có kết quả kiểm tra điều kiện đầy đủ.',
  RUN_RESULT_EXCLUSION_DIAGNOSTICS_REQUIRED: 'Thiếu thông tin giải thích nhu cầu bị loại.',
  RUN_RESULT_UNEXPECTED_PRIMARY_REASON: 'Lý do chính không nhất quán với trạng thái đủ điều kiện.',
  RUN_RESULT_CANDIDATE_INVALID: 'Dữ liệu nhóm ứng viên không hợp lệ.',
  RUN_RESULT_CANDIDATE_GATE_BLOCKED: 'Có nhu cầu trong nhóm chưa vượt qua điều kiện F1.',
  RUN_RESULT_ALREADY_EXISTS: 'Kết quả lần chạy đã tồn tại.',
}

export function f1Label(code: string | null | undefined) {
  return code ? labels[code] ?? 'Chưa có diễn giải cho mã này' : missing
}

export function deliveryDate(value: string | null | undefined) {
  return value?.slice(0, 10).split('-').reverse().join('/') || missing
}

const instantFormat = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

export function runTime(value: string | null | undefined) {
  if (!value) return missing
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? missing : instantFormat.format(date)
}

export function timeWindow(start: string | null | undefined, end: string | null | undefined) {
  return start && end ? `${start.slice(0, 5)} – ${end.slice(0, 5)}` : missing
}

export function weight(value: string | null | undefined) {
  if (!value || !/^\d+(\.\d+)?$/.test(value)) return missing
  const [whole, fraction] = value.split('.')
  const localized = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${localized}${fraction ? ',' + fraction : ''} kg`
}

function totalWeight(values: (string | null | undefined)[]) {
  if (!values.length || values.some((value) => !value || !/^\d+(\.\d+)?$/.test(value))) return null
  const parts = values.map((value) => value!.split('.'))
  const scale = Math.max(...parts.map(([, fraction]) => fraction?.length ?? 0))
  const total = parts.reduce((sum, [whole, fraction]) =>
    sum + BigInt(whole + (fraction ?? '').padEnd(scale, '0')), 0n)
  const digits = total.toString().padStart(scale + 1, '0')
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
}

export function clockSeconds(value: string) {
  const [hours, minutes, seconds = 0] = value.split(':').map(Number)
  return hours * 3600 + minutes * 60 + seconds
}

export function commonDuration(window: F1CandidateWindow | null) {
  if (!window) return missing
  const seconds = clockSeconds(window.common_end_time) - clockSeconds(window.common_start_time)
  if (!Number.isFinite(seconds) || seconds < 0) return missing
  return [Math.floor(seconds / 60) + ' phút', seconds % 60 ? seconds % 60 + ' giây' : ''].filter(Boolean).join(' ')
}

const dateKey = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })

export function f1BusinessDate(at = new Date()) {
  return dateKey.format(at)
}

export function deliveryWarning(value: string | null | undefined, at?: string) {
  if (!value) return ''
  if (at && value < f1BusinessDate(new Date(at))) return 'Ngày giao đã qua tại thời điểm F1.'
  return value < f1BusinessDate() ? 'Ngày giao hiện đã qua.' : ''
}

export type DemandResult = F1DemandResult | F1PreviewDemand

export function demandCode(result: DemandResult | undefined) {
  return result?.evidence?.demand_code ?? 'Chưa lưu mã nhu cầu'
}

export function masterdataLabel(
  code: string | null | undefined,
  name: string | null | undefined,
  current: F1MasterdataLabel | null | undefined,
  fallback: string,
) {
  const resolved = [...new Set([code || current?.code, name || current?.name].filter(Boolean))].join(' · ')
  if (!resolved) return fallback
  const usesCurrent = (!code && current?.code) || (!name && current?.name)
  return usesCurrent ? `${resolved} · Danh mục hiện tại` : resolved
}

export function outletName(evidence: F1DemandEvidence | null | undefined, current?: F1MasterdataLabel | null) {
  const fallback = evidence?.outlet_id ? `Outlet #${evidence.outlet_id}` : missing
  return masterdataLabel(evidence?.outlet_code, evidence?.outlet_name, current, fallback)
}

export function skuName(id: number | string | null | undefined, evidence?: F1DemandEvidence | null, labels?: F1DemandDisplayLabels) {
  const item = id == null ? undefined : evidence?.items?.find((line) => line.item_id === String(id))
  return masterdataLabel(item?.item_code, item?.item_name, id == null ? undefined : labels?.items[String(id)],
    id == null ? 'Chưa lưu mã mặt hàng' : `Mặt hàng #${id}`)
}

export function groupLabel(index: number) {
  return `Nhóm ứng viên ${String(index + 1).padStart(2, '0')}`
}

export function groupIds(group: F1CandidateGroup | F1CandidateWindow) {
  return 'memberships' in group ? group.memberships.map((item) => item.demand_id) : group.demand_ids
}

export function candidateFacts(group: F1CandidateGroup | F1CandidateWindow, results: Map<number, DemandResult>, labels?: F1DisplayLabels) {
  const window = 'matching_reason' in group ? group.matching_reason : group
  const ids = groupIds(group)
  const members = ids.map((id) => results.get(id))
  const evidence = members.map((item) => item?.evidence)
  const outletIds = evidence.map((item) => item?.outlet_id)
  return {
    window,
    ids,
    members,
    outletCount: outletIds.every(Boolean) ? new Set(outletIds).size : null,
    outletNames: [...new Set(ids.map((id, index) => outletName(evidence[index], labels?.[id]?.outlet)))],
    missingOutletNames: ids.some((id, index) => !evidence[index]?.outlet_name && !labels?.[id]?.outlet?.name),
    categoryCodes: [...new Set(evidence.map((item) => item?.cargo_category_code ?? missing))],
    totalKg: totalWeight(evidence.map((item) => item?.quantity_kg)),
  }
}

export function isMatched(result: DemandResult, previewMatchedIds?: Set<number>) {
  return previewMatchedIds ? previewMatchedIds.has(result.demand_id)
    : result.matching_status === 'INCLUDED' || result.matching_status === 'MULTIPLE_CANDIDATES'
}

