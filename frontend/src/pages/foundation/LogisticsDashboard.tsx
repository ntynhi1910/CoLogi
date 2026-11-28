import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { deliveryDate, runTime } from '../../components/dss/f1Display'
import { apiRequest } from '../../services/api/client'
import { dssService } from '../../services/dss/dssService'
import { useDssQuery } from '../../services/dss/useDssQuery'

type Audience = 'manager' | 'supplier' | 'purchasing' | 'provider'
type Summary = {
  kpis: Record<string, string | number | null>
  pending: { plans: number; costs: number; issues: number }
  plans?: {
    code: string
    version: number
    date: string
    status: string
    current: boolean
    template: string
    demands: number
    planned_kg: string | number | null
    provider?: { code?: string | null; name?: string | null } | null
    hub?: { code?: string | null; name?: string | null } | null
  }[]
}
type Notice = {
  id: number
  title: string
  message: string
  demand_code: string
  supplier: string
  outlet: string
  requested_date: string
  at: string
  state: string
  reason_code: string
  link: string
  items: { sku: string; kg: string }[]
}

const roots = {
  manager: '/dss',
  supplier: '/supplier',
  purchasing: '/purchasing',
  provider: '/provider',
}

const planRootByAudience: Record<Audience, string> = {
  manager: '/dss/final-plans',
  supplier: '/supplier/inbox',
  purchasing: '/purchasing/demands',
  provider: '/provider/execution',
}

const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 })

export function PlanningResultNotices({
  audience,
  plans = [],
}: {
  audience: Audience
  plans?: Summary['plans']
}) {
  const loadNotices = useCallback(
    () =>
      audience === 'provider'
        ? Promise.resolve([])
        : apiRequest<Notice[]>(`/planning/publication/${audience}/unplanned/`),
    [audience]
  )
  const notices = useDssQuery(loadNotices)

  const activePlans = (plans ?? []).filter((p) => p.current)
  const noticeList = notices.data ?? []
  const totalNotifications = noticeList.length + activePlans.length

  if (audience === 'provider' && activePlans.length === 0) return null

  return (
    <section
      className="clh-panel clh-reconcil-panel"
      aria-label="Thông báo kết quả lập kế hoạch"
    >
      <div className="clh-panel-head-row">
        <div>
          <h3>Thông báo kết quả lập kế hoạch</h3>
          <p className="clh-panel-sub">
            Tổng hợp kết quả lập kế hoạch vận chuyển và các nhu cầu cần xử lý lại
          </p>
        </div>
        <span className="clh-count-pill">
          {notices.loading ? 'Đang tải…' : `${totalNotifications} thông báo`}
        </span>
      </div>

      {notices.loading ? (
        <p role="status">Đang tải thông báo…</p>
      ) : notices.error != null ? (
        <p role="alert" className="clh-alert-inline">
          Không tải được thông báo kết quả lập kế hoạch.
        </p>
      ) : totalNotifications === 0 ? (
        <div className="clh-empty-box">
          <strong>Chưa có thông báo phát sinh</strong>
          <p>Tất cả nhu cầu trong phạm vi hiện tại đã được đồng bộ kế hoạch.</p>
        </div>
      ) : (
        <div className="clh-notice-stack">
          {activePlans.map((plan) => (
            <div key={plan.code} className="clh-notice-card clh-notice-card--success">
              <div className="clh-notice-card-head">
                <span className="clh-notice-badge clh-notice-badge--success">
                  Đã lập kế hoạch · v{plan.version}
                </span>
                <strong>
                  {plan.template === 'DIRECT'
                    ? 'Direct Consolidated'
                    : plan.hub?.code
                    ? `Qua Hub ${plan.hub.code}`
                    : 'Qua Hub'}{' '}
                  ({plan.code})
                </strong>
                <span className="clh-notice-meta">
                  Ngày giao {deliveryDate(plan.date)} · {plan.demands} Demand ·{' '}
                  {plan.planned_kg != null
                    ? `${number.format(Number(plan.planned_kg))} kg`
                    : '—'}
                </span>
              </div>
              <Link
                className="clh-panel-link"
                to={
                  audience === 'manager'
                    ? `/dss/reconciliation/${plan.code}`
                    : planRootByAudience[audience]
                }
              >
                Xem chi tiết kế hoạch →
              </Link>
            </div>
          ))}

          {noticeList.map((row) => {
            const isResolved = row.state === 'RESOLVED'
            return (
              <details
                key={row.id}
                className={`clh-task-row clh-notice-card ${
                  isResolved ? 'clh-notice-card--resolved' : 'clh-notice-card--warning'
                }`}
              >
                <summary>
                  <span
                    className={`clh-notice-badge ${
                      isResolved
                        ? 'clh-notice-badge--resolved'
                        : 'clh-notice-badge--warning'
                    }`}
                  >
                    {isResolved
                      ? 'Đã lập kế hoạch lại'
                      : audience === 'supplier'
                      ? 'Đã hủy cung ứng'
                      : 'Cần lập kế hoạch lại'}
                  </span>
                  <strong>
                    {row.title} · {row.demand_code}
                  </strong>
                  <span className="clh-notice-meta">
                    {row.supplier} → {row.outlet} · Ngày giao{' '}
                    {deliveryDate(row.requested_date)}
                  </span>
                </summary>
                <div className="clh-notice-body">
                  <p>{row.message}</p>
                  <p>
                    Nguyên nhân:{' '}
                    <strong>
                      {row.reason_code === 'DEMAND_EXPIRED_UNPLANNED'
                        ? 'Đã quá hạn giao yêu cầu'
                        : 'Không có phương án vận chuyển khả thi'}
                    </strong>{' '}
                    ({row.reason_code}) · Cập nhật lúc {runTime(row.at)}
                  </p>
                  <ul>
                    {row.items.map((item) => (
                      <li key={item.sku}>
                        {item.sku} · {number.format(Number(item.kg))} kg
                      </li>
                    ))}
                  </ul>
                  <Link className="clh-panel-link" to={row.link}>
                    {audience === 'supplier'
                      ? 'Xem chi tiết yêu cầu cung ứng →'
                      : 'Xem chi tiết nhu cầu →'}
                  </Link>
                </div>
              </details>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default function LogisticsDashboard({
  audience,
  planned,
  unplanned,
  overdue,
}: {
  audience: Audience
  planned: number | null
  unplanned: number | null
  overdue: number | null
}) {
  const loadSummary = useCallback(
    () => apiRequest<Summary>(`/planning/reconciliation/${audience}/`),
    [audience]
  )
  const loadNotices = useCallback(
    () =>
      audience === 'provider'
        ? Promise.resolve([])
        : apiRequest<Notice[]>(`/planning/publication/${audience}/unplanned/`),
    [audience]
  )
  const loadF1 = useCallback(
    () => (audience === 'manager' ? dssService.selectableDemands() : Promise.resolve(null)),
    [audience]
  )
  const summary = useDssQuery(loadSummary)
  const notices = useDssQuery(loadNotices)
  const f1 = useDssQuery(loadF1)

  const open = notices.data?.filter((row) => row.state === 'OPEN')
  const noPlan = open ? new Set(open.map((row) => row.demand_code)).size : null

  const metrics: [string, string | number | null | undefined, string?][] =
    audience === 'manager'
      ? [
          ['Đủ điều kiện F1', f1.data?.counts.eligible],
          ['Bị loại khỏi F1', f1.data?.counts.excluded],
          ['Nhu cầu cần lập kế hoạch lại', noPlan],
          ['Ngoại lệ chưa xử lý', summary.data?.pending.issues],
          ['OTIF', summary.data?.kpis.otif_pct, '%'],
        ]
      : audience === 'purchasing'
      ? [
          ['Chưa lập kế hoạch', unplanned],
          ['Đã lập kế hoạch', planned],
          ['Không có phương án khả thi', noPlan],
          ['Quá hạn chưa có kế hoạch', overdue],
          ['Nhận đủ và đúng hạn', summary.data?.kpis.otif_pct, '%'],
        ]
      : audience === 'supplier'
      ? [
          ['Nhu cầu cần điều chỉnh cung ứng', noPlan],
          ['Xuất hàng đúng hạn', summary.data?.kpis.on_time_pickup_pct, '%'],
        ]
      : [
          ['Chuyến cần đối soát', summary.data?.pending.plans],
          ['Chi phí chờ xác nhận', summary.data?.pending.costs],
          ['Sử dụng tải trọng', summary.data?.kpis.load_factor_pct, '%'],
        ]

  return (
    <>
      <section className="clh-panel clh-reconcil-panel">
        <div className="clh-panel-head-row">
          <div>
            <h3>Đối soát và hiệu suất logistics</h3>
            <p className="clh-panel-sub">
              Chỉ số tổng hợp điều phối, tỷ lệ đáp ứng và tình trạng xử lý ngoại lệ
            </p>
          </div>
          <Link className="clh-panel-link clh-panel-cta" to={`${roots[audience]}/reconciliation`}>
            Mở đối soát và hiệu suất →
          </Link>
        </div>

        <dl className="clh-metrics clh-metrics--highlight">
          {metrics.map(([label, value, unit]) => (
            <div key={label} className="clh-metric">
              <dt>{label}</dt>
              <dd>
                {value == null ? '—' : number.format(Number(value)) + (unit ?? '')}
              </dd>
            </div>
          ))}
        </dl>

        {summary.error != null && (
          <p role="status" className="clh-alert-inline">
            Chưa tải được dữ liệu đối soát.
          </p>
        )}
      </section>

      <PlanningResultNotices audience={audience} plans={summary.data?.plans} />
    </>
  )
}