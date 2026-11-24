import type { InternalPlanningApproval } from '../../types/f1'
import { deliveryDate } from './f1Display'

export default function InternalPlanningNotice({ source }: { source?: InternalPlanningApproval }) {
  if (!source) return null
  return <p className="dssf-notice">
    Giả định lập kế hoạch nội bộ đã duyệt · {source.version} · {deliveryDate(source.valid_from)} đến {deliveryDate(source.valid_to)}.
    {' '}Nguồn gốc mô phỏng · đối chiếu lịch và giá với bên cung cấp trước khi vận hành.
  </p>
}
