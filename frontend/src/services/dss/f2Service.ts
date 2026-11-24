import { ApiError, apiRequest } from '../api/client'
import type { F2Hub, F2Option, F2Options, F2Plan } from '../../types/f2'
import { dssErrorMessage } from './dssService'

const f2 = '/planning/f2'
const groupPath = (runCode: string, groupCode: string) =>
  `${f2}/runs/${encodeURIComponent(runCode)}/groups/${encodeURIComponent(groupCode)}`

export const f2Service = {
  listHubs: () => apiRequest<F2Hub[]>(`${f2}/hubs/`),
  getOptions(runCode: string, groupCode: string, hubId: string) {
    const query = hubId ? '?' + new URLSearchParams({ hub_id: hubId }) : ''
    return apiRequest<F2Options>(`${groupPath(runCode, groupCode)}/options/${query}`)
  },
  savePlan(runCode: string, groupCode: string, option: F2Option, predecessor?: string) {
    return apiRequest<F2Plan>(`${groupPath(runCode, groupCode)}/plans/`, {
      method: 'POST',
      body: JSON.stringify({
        template_type: option.template_type,
        option_key: option.option_key,
        hub_id: option.hub?.id,
        supersedes_plan_code: predecessor,
      }),
    })
  },
  getPlan(runCode: string, groupCode: string, planCode: string) {
    return apiRequest<F2Plan>(`${groupPath(runCode, groupCode)}/plans/${encodeURIComponent(planCode)}/`)
  },
}

export function f2ErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.data && typeof error.data === 'object' && 'code' in error.data) {
    switch (error.data.code) {
      case 'F2_REVISION_CONFLICT': return 'Đã có phiên bản mới. Hãy tải lại phương án trước khi lưu.'
      case 'F2_PREVIEW_STALE': return 'Dữ liệu xem trước đã thay đổi. Hãy tải lại phương án trước khi lưu.'
      case 'F2_MIGRATION_REQUIRED': return 'Môi trường này cần migration lưu phương án F2.'
      case 'OPERATIONAL_DEMAND_PROVENANCE_REQUIRED':
        return 'Ứng viên lịch sử dùng dữ liệu mô phỏng V7. Để lưu phương án, hãy tạo Run từ nhu cầu vận hành đã xác minh hoặc dùng tài khoản Capstone.'
      case 'HUB_NOT_FOUND':
      case 'HUB_INACTIVE':
      case 'HUB_ADDRESS_MISSING': return 'Hub đã chọn không còn dùng được. Hãy tải lại danh sách Hub.'
      case 'F2_STRUCTURE_INVALID': return 'Cấu trúc phương án không hợp lệ để lưu.'
    }
  }
  if (error instanceof ApiError && error.status === 409) return 'Nhóm hoặc phương án F2 không đủ điều kiện.'
  if (error instanceof ApiError && error.status === 503) return 'Nguồn dữ liệu F2 tạm thời chưa khả dụng. Vui lòng thử lại.'
  return dssErrorMessage(error)
}
