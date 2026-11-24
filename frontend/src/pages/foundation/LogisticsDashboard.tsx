import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { deliveryDate, runTime } from '../../components/dss/f1Display'
import { apiRequest } from '../../services/api/client'
import { dssService } from '../../services/dss/dssService'
import { useDssQuery } from '../../services/dss/useDssQuery'

type Audience = 'manager' | 'supplier' | 'purchasing' | 'provider'
type Summary = { kpis: Record<string, string | number | null>; pending: { plans: number; costs: number; issues: number } }
type Notice = { id: number; title: string; message: string; demand_code: string; supplier: string; outlet: string;
  requested_date: string; at: string; state: string; reason_code: string; link: string; items: { sku: string; kg: string }[] }

const roots = { manager: '/dss', supplier: '/supplier', purchasing: '/purchasing', provider: '/provider' }
const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 })

export default function LogisticsDashboard({ audience, planned, unplanned, overdue }: {
  audience: Audience; planned: number | null; unplanned: number | null; overdue: number | null
}) {
  const loadSummary = useCallback(() => apiRequest<Summary>(`/planning/reconciliation/${audience}/`), [audience])
  const loadNotices = useCallback(() => audience === 'provider' ? Promise.resolve([]) :
    apiRequest<Notice[]>(`/planning/publication/${audience}/unplanned/`), [audience])
  const loadF1 = useCallback(() => audience === 'manager' ? dssService.selectableDemands() : Promise.resolve(null), [audience])
  const summary = useDssQuery(loadSummary)
  const notices = useDssQuery(loadNotices)
  const f1 = useDssQuery(loadF1)
  const open = notices.data?.filter(row => row.state === 'OPEN')
  const noPlan = open ? new Set(open.map(row => row.demand_code)).size : null
  const metrics: [string, string | number | null | undefined, string?][] = audience === 'manager'
    ? [['Đủ điều kiện F1', f1.data?.counts.eligible], ['Bị loại khỏi F1', f1.data?.counts.excluded],
      ['Nhu cầu cần lập kế hoạch lại', noPlan], ['Ngoại lệ chưa xử lý', summary.data?.pending.issues], ['OTIF', summary.data?.kpis.otif_pct, '%']]
    : audience === 'purchasing' ? [['Chưa lập kế hoạch', unplanned], ['Đã lập kế hoạch', planned],
      ['Không có phương án khả thi', noPlan], ['Quá hạn chưa có kế hoạch', overdue], ['Nhận đủ và đúng hạn', summary.data?.kpis.otif_pct, '%']]
      : audience === 'supplier' ? [['Nhu cầu cần điều chỉnh cung ứng', noPlan], ['Xuất hàng đúng hạn', summary.data?.kpis.on_time_pickup_pct, '%']]
        : [['Chuyến cần đối soát', summary.data?.pending.plans], ['Chi phí chờ xác nhận', summary.data?.pending.costs],
          ['Sử dụng tải trọng', summary.data?.kpis.load_factor_pct, '%']]

  return <>
    <section className="clh-panel"><h3>Đối soát và hiệu suất logistics</h3>
      <dl className="clh-metrics">{metrics.map(([label, value, unit]) => <div key={label} className="clh-metric">
        <dt>{label}</dt><dd>{value == null ? '—' : number.format(Number(value)) + (unit ?? '')}</dd>
      </div>)}</dl>
      {summary.data && <Link className="clh-panel-link" to={`${roots[audience]}/reconciliation`}>Mở đối soát và hiệu suất</Link>}
      {summary.error != null && <p role="status">Chưa tải được dữ liệu đối soát.</p>}
    </section>
    {audience !== 'provider' && <section className="clh-panel" aria-label="Thông báo kết quả lập kế hoạch"><h3>Thông báo kết quả lập kế hoạch</h3>
      {notices.loading ? <p role="status">Đang tải thông báo…</p> : notices.error != null ? <p role="alert">Không tải được thông báo.</p>
        : !notices.data?.length ? <p>Chưa có thông báo trong phạm vi của bạn.</p> : notices.data.map(row =>
          <details key={row.id} className="clh-task-row"><summary>{row.title} · {row.demand_code} · {row.state === 'RESOLVED'
            ? 'Đã lập kế hoạch lại' : audience === 'supplier' ? 'Đã hủy cung ứng' : 'Cần lập kế hoạch lại'}</summary>
            <p>{row.message}</p><p>{row.supplier} → {row.outlet} · Ngày giao {deliveryDate(row.requested_date)} · {runTime(row.at)}</p>
            <p>{row.reason_code === 'DEMAND_EXPIRED_UNPLANNED' ? 'Đã quá hạn giao yêu cầu' : 'Không có phương án vận chuyển khả thi'} · {row.reason_code}</p>
            <ul>{row.items.map(item => <li key={item.sku}>{item.sku} · {number.format(Number(item.kg))} kg</li>)}</ul>
            <Link className="clh-panel-link" to={row.link}>{audience === 'supplier' ? 'Xem chi tiết yêu cầu cung ứng' : 'Xem chi tiết nhu cầu'}</Link>
          </details>)}
    </section>}
  </>
}
