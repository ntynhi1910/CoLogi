export const dash = '—'
const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 2 })
const signedCurrency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 2, signDisplay: 'exceptZero' })
export const decimal = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 4 })
const dashboardRate = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function number(value: string | number | null | undefined) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

export function money(value: string | number | null | undefined, signed = false) {
  const amount = number(value)
  return amount === null ? dash : (signed ? signedCurrency : currency).format(amount)
}

export function percent(value: string | null | undefined, compact = false) {
  const amount = number(value)
  return amount === null ? dash : (compact ? dashboardRate : decimal).format(amount) + '%'
}

export const syntheticNotice = 'SYNTHETIC/UAT · Lịch trình, giá vận chuyển, phí Hub và chi phí giao độc lập là bằng chứng mô phỏng phục vụ nghiệm thu. Các giá trị này không phải báo giá vận hành.'

export const diagnostic: Record<string, string> = {
  APPROVED_PRICE_CONFIGURATION_REQUIRED: 'Thiếu cấu hình giá, quy tắc làm tròn và phương pháp phân bổ đã duyệt.',
  INDEPENDENT_BASELINE_REQUIRED: 'Thiếu chi phí giao độc lập có thể đối chiếu với cùng yêu cầu dịch vụ.',
  WAVE_QUOTE_REQUIRED: 'Thiếu báo giá có cơ sở tính, phạm vi và thời hạn hiệu lực.',
  HUB_PRICE_REQUIRED: 'Thiếu phí Hub đã xác nhận, hoặc xác nhận báo giá gộp đã bao gồm phí.',
  F4_HARD_GATE_REQUIRED: 'Bản F4 chưa vượt qua các điều kiện bắt buộc.',
  F4_REFERENCE_REQUIRED: 'Thiếu bản F4 đã lưu thuộc cùng ngữ cảnh.',
  F4_SEQUENCE_NOT_EXHAUSTIVE: 'Lịch thử F4 có xung đột. Chưa đủ bằng chứng kết luận tính khả thi.',
  F4_OPTION_PRICE_REQUIRED: 'Chưa có giá được duyệt cho đúng bản F4 này.',
  F4_OPTION_PRICE_FINGERPRINT_MISMATCH: 'Báo giá không khớp fingerprint của bản F4 đã lưu.',
  PRICE_COMPONENTS_OVERLAP: 'Các khoản giá áp dụng trùng phạm vi.',
  PRICE_OUTSIDE_EFFECTIVE_DATE: 'Báo giá nằm ngoài thời hạn áp dụng.',
  INDEPENDENT_DISTANCE_REQUIRED: 'Thiếu quãng đường giao độc lập có nguồn xác nhận.',
  NEGATIVE_PARTICIPANT_SAVING: 'Outlet có mức tiết kiệm âm.',
  COMPARABLE_PRICE_BASIS_MISMATCH: 'Nguồn giá không khớp tập Demand và ngày dịch vụ.',
  DEPOT_DISTANCE_REQUIRED: 'Thiếu bằng chứng quãng đường đến điểm lấy đầu hoặc trở về depot.',
  F5_PREVIEW_STALE: 'Nguồn giá hoặc cấu hình đã đổi. Tải lại bản xem trước.',
  F5_INCOMPLETE: 'Phương án chưa đủ dữ liệu để lưu.',
  F5_STORAGE_ERROR: 'Giao dịch lưu phương án gặp lỗi. Có thể thử lại.',
  F4_SCENARIO_MISMATCH: 'Bản F4 không thuộc kịch bản đang xem.',
  F5_SOURCE_INVALID: 'Không xác minh được nguồn đánh giá.',
  F5_SOURCE_UNAVAILABLE: 'Bản F4 không còn trong phạm vi truy cập.',
}

