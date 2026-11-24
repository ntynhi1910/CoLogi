import { missing, weight } from './f1Display'
import type { F2PlanSummary } from '../../types/f2'
import type { ValidF3Evaluation } from '../../types/f3'
export const gateLabels = {
  ELIGIBLE: 'Đủ điều kiện F3',
  NOT_ELIGIBLE: 'Không đủ điều kiện F3',
  UNVERIFIED: 'Chưa được xác minh',
}

const labels: Record<string, string> = {
  F3_RULE_CONFIGURATION_MISSING: 'RuleSet đã chốt thiếu cấu hình quy tắc F3',
  F3_RULE_CONFIGURATION_UNSUPPORTED: 'Cấu hình quy tắc F3 chưa được hỗ trợ',
  F3_PARAMETER_INVALID: 'Tham số F3 không hợp lệ',
  HUB_SERVICE_SCOPE_UNVERIFIED: 'CP7 chưa có dữ liệu xác minh phạm vi phục vụ tại Hub',
  PICKUP_PERIOD_UNVERIFIED: 'Chưa xác minh được khoảng lấy hàng trong ngày của snapshot',
  PROVIDER_UNAVAILABLE: 'Không có nhà vận chuyển TP001 đang hoạt động',
  SUPPLIER_PICKUP_NOT_COVERED: 'Nhà vận chuyển thiếu quyền lấy hàng tại nhà cung cấp',
  NO_ACTIVE_OFFER: 'Không có đề nghị xe đang hoạt động với tải trọng hợp lệ',
  DEMAND_EXCEEDS_CAPACITY: 'Nhu cầu nguyên vẹn vượt tải trọng các loại xe',
  COMPATIBILITY_MISSING: 'Thiếu dữ liệu tương thích giữa xe và nhóm hàng',
  CARGO_UNSUPPORTED: 'Xe đủ tải không hỗ trợ nhóm hàng',
  AVAILABILITY_MISSING: 'Thiếu lịch xe xác nhận cho ngày yêu cầu',
  AVAILABILITY_OUTSIDE_WINDOW: 'Lịch xe nằm ngoài khoảng cần đối chiếu',
  AVAILABILITY_PARTIAL: 'Lịch xe chỉ có bằng chứng cho một phần khoảng cần đối chiếu',
  AVAILABILITY_UNAVAILABLE: 'Lịch đã xác nhận xe không khả dụng trong khoảng cần đối chiếu',
  OFFER_OUTSIDE_OPERATING_HOURS: 'Khoảng đối chiếu nằm ngoài giờ hoạt động của đề nghị xe',
  OFFER_UNUSABLE: 'Đề nghị xe hoặc loại xe chưa khả dụng',
  VERIFIED: 'Đã xác minh',
  FLEET_LIMIT: 'Số xe có bằng chứng không đủ cho các wave trong khoảng đối chiếu',
  SEARCH_LIMIT_REACHED: 'Đã đạt giới hạn tìm kiếm; kết quả chỉ phản ánh các cách phân bổ đã xét',
  LOW_UTILIZATION: 'Hiệu suất tải thấp theo ngưỡng đã cấu hình',
  INVALID_SAVED_F2: 'Cấu trúc hoặc lineage của bản nháp F2 không hợp lệ',
  TRAVEL_TIME: 'Thời gian di chuyển',
  PICKUP_SEQUENCE: 'Lịch lấy hàng và trình tự điểm dừng',
  HUB_HANDLING_IF_APPLICABLE: 'Thời gian xử lý và bàn giao tại Hub',
  RECEIVING_SCHEDULE: 'Lịch giao và tiếp nhận tại Outlet',
  PROVIDER_CONFIRMED_IMPORT: 'Dữ liệu đã được nhà vận chuyển xác nhận',
  PROVIDER_PORTAL: 'Nhà vận chuyển cập nhật trên cổng thông tin',
  'SYNTHETIC/UAT': 'Dữ liệu mô phỏng UAT',
  'SYNTHETIC/CAPSTONE': 'Dữ liệu mô phỏng Capstone',
  CONFIRMED: 'Đã xác nhận',
  PENDING: 'Chờ xác nhận',
  REVOKED: 'Đã thu hồi',
  NO_EFFECTIVE_EVIDENCE: 'Thiếu bằng chứng có hiệu lực vào ngày giao',
  NOT_CONFIRMED: 'Bằng chứng đang chờ xác nhận hoặc đã bị thu hồi',
  AVAILABLE: 'Khả dụng',
  UNAVAILABLE: 'Không khả dụng',
  VEHICLE_CARGO: 'Tương thích hàng–xe',
  SUPPLIER_PICKUP: 'Quyền lấy hàng tại nhà cung cấp',
  PROVIDER_OFFER: 'Nhà vận chuyển và đề nghị xe',
  FLEET_AVAILABILITY: 'Lịch và số lượng xe khả dụng',
  HUB_SCOPE: 'Phạm vi phục vụ Hub',
  RULE_CONFIGURATION: 'Cấu hình quy tắc F3',
  'RULE-13': 'Giới hạn tải trọng',
  'RULE-14': 'Phân bổ wave hoặc phương tiện',
  'RULE-15': 'Hiệu suất sử dụng tải trọng',
  FAIL: 'Không đạt',
  UNVERIFIED: 'Chưa xác minh',
  NOT_APPLICABLE: 'Không áp dụng',
  NOT_EVALUATED: 'Chưa đánh giá',
}
export const phases = { DIRECT: 'Trực tiếp', INBOUND: 'Vào Hub (Inbound)', OUTBOUND: 'Ra Hub (Outbound)' }
const percent = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 })

export const kg = (value?: string | null) => weight(value?.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'))
export const utilization = (value?: string | null) => value == null ? missing : `${percent.format(Number(value))}%`
export const planName = (plan: F2PlanSummary) => plan.hub ? `${plan.hub.code} · ${plan.hub.name}` : 'Direct Consolidated'
export const label = (code: string) => labels[code] ?? code


export function providerName(provider: ValidF3Evaluation['provider']) {
  return provider ? provider.provider_code + ' · ' + provider.provider_name : missing
}
