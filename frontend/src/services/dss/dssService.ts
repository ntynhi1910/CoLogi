import { apiRequest, ApiError } from '../api/client'
import { listDemands } from '../api/demands'
import type { DeliveryDemand } from '../../types/demand'
import type { F1History, F1Input, F1Preview, F1RuleSet, F1Run, F1Scope } from '../../types/f1'

const f1 = '/planning/f1'

export const dssService = {
  getScope: () => apiRequest<F1Scope>(`${f1}/scope/`),
  listRuleSets: () => apiRequest<F1RuleSet[]>(`${f1}/rule-sets/`),
  selectableDemands: () => apiRequest<{ demands: DeliveryDemand[]; evaluated_at: string; next_expiry_at: string | null; counts: {
    eligible: number; excluded: number; final_plan: number; past_due: number
  } }>(`${f1}/selectable-demands/`),
  getUnplannedRequest: (id: string) => apiRequest<{ supplier_request_id: number; request_code: string; status: string }>(
    `${f1}/demands/${id}/close-unplanned/`),
  closeUnplanned: (id: number, requestId: number, runCode: string | undefined, reason: string) =>
    apiRequest(`${f1}/demands/${id}/close-unplanned/`, {
      method: 'POST', body: JSON.stringify({ run_code: runCode, supplier_request_id: requestId, reason, confirm_finished: true }),
    }),
  async listDemands(scope: F1Scope) {
    const allowed = new Set(scope.outlet_ids)
    return (await listDemands()).filter((demand) => allowed.has(demand.outlet_id))
  },
  preview: (input: F1Input) => apiRequest<F1Preview>(`${f1}/preview/`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  execute: (input: F1Input) => apiRequest<F1Run>(`${f1}/runs/`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  getRun: (code: string) => apiRequest<F1Run>(`${f1}/runs/${encodeURIComponent(code)}/`),
  listRuns: (page: number) => apiRequest<F1History>(`${f1}/runs/?page=${page}`),
}

function validationMessages(data: unknown, field = ''): string[] {
  if (typeof data === 'string') return [field ? `${field} — ${data}` : data]
  if (Array.isArray(data)) return data.flatMap((item) => validationMessages(item, field))
  if (data !== null && typeof data === 'object') {
    return Object.entries(data).flatMap(([key, value]) =>
      validationMessages(value, key === 'non_field_errors' || key === 'detail' ? field : key),
    )
  }
  return []
}

export function dssErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Không thể kết nối API DSS. Vui lòng thử lại.'
  switch (error.status) {
    case 400: {
      const details = typeof error.data === 'object' ? validationMessages(error.data).join(' · ') : ''
      if (details.includes('OPERATIONAL_DEMAND_PROVENANCE_REQUIRED')) {
        return 'Nhu cầu mô phỏng V7 không được dùng cho lần đánh giá vận hành. Hãy chọn nhu cầu vận hành đã xác minh hoặc dùng tài khoản Capstone.'
      }
      return details ? `400 · ${details}` : '400 · Yêu cầu F1 không hợp lệ.'
    }
    case 401: return '401 · Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
    case 403: return '403 · Bạn chưa được cấp quyền DSS F1 cho phạm vi Outlet này.'
    case 404: return '404 · Không tìm thấy kết quả trong phạm vi truy cập.'
    default: return `${error.status} · Không thể tải dữ liệu DSS. Vui lòng thử lại.`
  }
}
