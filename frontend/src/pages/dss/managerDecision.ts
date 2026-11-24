export const decisionActions = {
  APPROVE: 'Phê duyệt',
  REJECT: 'Từ chối phương án',
  REQUEST_RECALCULATION: 'Yêu cầu tính lại',
} as const

export type DecisionOutcome = keyof typeof decisionActions
export const otherReason = 'Khác'
export const reasonLimit = 2000

export const decisionReasons = {
  APPROVE: [
    'Chi phí thấp nhất trong các phương án hợp lệ',
    'Đáp ứng tốt thời gian giao nhận',
    'Phù hợp năng lực vận chuyển',
    'Cân bằng chi phí và hiệu quả vận hành',
    otherReason,
  ],
  REJECT: [
    'Chi phí phương án quá cao',
    'Không phù hợp ưu tiên vận hành',
    'Không phù hợp phương án vận chuyển mong muốn',
    'Cần lựa chọn phương án khác',
    otherReason,
  ],
  REQUEST_RECALCULATION: [
    'Cần cập nhật lịch lấy hoặc giao hàng',
    'Cần cập nhật năng lực phương tiện',
    'Cần cập nhật báo giá hoặc chi phí',
    'Có thay đổi về Demand hoặc Supplier',
    'Cần đánh giá lại tuyến Direct/Hub',
    otherReason,
  ],
} satisfies Record<DecisionOutcome, string[]>

export function decisionReason(action: DecisionOutcome | '', preset: string, note: string) {
  if (!action || !decisionReasons[action].includes(preset)) return ''
  const detail = note.trim()
  return preset === otherReason ? detail : detail ? `${preset}\nGhi chú · ${detail}` : preset
}

export function canReviewDecision(action: DecisionOutcome | '', reason: string, approvalAllowed: boolean) {
  return Boolean(action && reason && reason.length <= reasonLimit && (action !== 'APPROVE' || approvalAllowed))
}

export function decisionPayload(evaluation: string, action: DecisionOutcome, reason: string, replaces: string | null) {
  return { evaluation_code: evaluation, outcome: action, reason,
    ...(action === 'APPROVE' && replaces ? { replaces } : {}) }
}

type DecisionOption = { approval: { allowed: boolean; code?: string | null }; collaborative_cost: string | number }

export function isComparableOption(option: DecisionOption) {
  return option.approval.allowed || option.approval.code === 'EVALUATION_ALREADY_APPROVED'
}

export function sortDecisionOptions<T extends DecisionOption>(options: T[]) {
  return [...options].sort((left, right) => Number(isComparableOption(right)) - Number(isComparableOption(left))
    || Number(left.collaborative_cost) - Number(right.collaborative_cost))
}
