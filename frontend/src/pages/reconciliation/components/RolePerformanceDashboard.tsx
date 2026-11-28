
import { Link } from 'react-router-dom'
import { deliveryDate } from '../../../components/dss/f1Display'
import './RolePerformanceDashboard.css'

type Audience = 'supplier' | 'provider' | 'purchasing'
type Quantity = number | string | null

type Party = {
  id: number
  code: string | null
  name: string | null
}

type Plan = {
  code: string
  version: number
  date: string
  status: string
  current: boolean
  template: string
  provider: Party
  hub: Party | null
  demands: number
  planned_kg: Quantity
  received_kg: Quantity
}

type Overview = {
  kpis: Record<string, Quantity>
  trends: (Record<string, Quantity> & { date: string })[]
  templates: Record<string, Record<string, Quantity>>
  plans: Plan[]
}

type Props = {
  audience: Audience
  overview: Overview
  mode: string
}

type Metric = {
  key: string
  label: string
  suffix: string
  description: string
  percent?: boolean
}

const metrics: Record<Audience, Metric[]> = {
  supplier: [
    {
      key: 'final_plans',
      label: 'Kế hoạch cung ứng',
      suffix: '',
      description: 'FinalPlan hiện hành trong phạm vi cung ứng',
    },
    {
      key: 'demands',
      label: 'Nhu cầu cung ứng',
      suffix: '',
      description: 'Số Demand thuộc phạm vi được cấp quyền',
    },
    {
      key: 'shipped_kg',
      label: 'Khối lượng đã xuất',
      suffix: ' kg',
      description: 'Khối lượng pickup đã được xác nhận',
    },
    {
      key: 'on_time_pickup_pct',
      label: 'Lấy hàng đúng hạn',
      suffix: '%',
      description: 'Theo dữ liệu xác nhận lấy hàng',
      percent: true,
    },
    {
      key: 'exception_pct',
      label: 'Tỷ lệ ngoại lệ',
      suffix: '%',
      description: 'Theo ngoại lệ thực tế được ghi nhận',
      percent: true,
    },
  ],
  provider: [
    {
      key: 'final_plans',
      label: 'FinalPlan hiện hành',
      suffix: '',
      description: 'Các kế hoạch trong phạm vi vận chuyển',
    },
    {
      key: 'on_time_delivery_pct',
      label: 'Giao đúng hạn',
      suffix: '%',
      description: 'Theo thời điểm giao nhận thực tế',
      percent: true,
    },
    {
      key: 'otif_pct',
      label: 'Giao đủ và đúng hạn',
      suffix: '%',
      description: 'Kết hợp khối lượng và thời gian giao',
      percent: true,
    },
    {
      key: 'load_factor_pct',
      label: 'Sử dụng tải trọng',
      suffix: '%',
      description: 'Theo tải trọng thực tế của các wave',
      percent: true,
    },
    {
      key: 'received_kg',
      label: 'Khối lượng đã nhận',
      suffix: ' kg',
      description: 'Khối lượng Outlet đã chấp nhận',
    },
    {
      key: 'exception_pct',
      label: 'Tỷ lệ ngoại lệ',
      suffix: '%',
      description: 'Theo ngoại lệ thực tế được ghi nhận',
      percent: true,
    },
  ],
  purchasing: [
    {
      key: 'demands',
      label: 'Nhu cầu nhận hàng',
      suffix: '',
      description: 'Số Demand trong phạm vi mua hàng',
    },
    {
      key: 'received_kg',
      label: 'Khối lượng đã nhận',
      suffix: ' kg',
      description: 'Lượng hàng Outlet chấp nhận',
    },
    {
      key: 'fill_pct',
      label: 'Tỷ lệ đáp ứng',
      suffix: '%',
      description: 'Theo lượng đã kiểm nhận ở cấp SKU',
      percent: true,
    },
    {
      key: 'on_time_delivery_pct',
      label: 'Giao đúng hạn',
      suffix: '%',
      description: 'Theo thời điểm kiểm nhận thực tế',
      percent: true,
    },
    {
      key: 'otif_pct',
      label: 'Giao đủ và đúng hạn',
      suffix: '%',
      description: 'Theo số lượng và thời gian nhận',
      percent: true,
    },
    {
      key: 'exception_pct',
      label: 'Tỷ lệ ngoại lệ',
      suffix: '%',
      description: 'Theo ngoại lệ giao nhận được ghi nhận',
      percent: true,
    },
  ],
}

const titles: Record<Audience, string> = {
  supplier: 'Hiệu suất cung ứng',
  provider: 'Hiệu suất vận chuyển',
  purchasing: 'Hiệu suất nhận hàng',
}

const paths: Record<Audience, string> = {
  supplier: '/supplier/reconciliation',
  provider: '/provider/reconciliation',
  purchasing: '/purchasing/reconciliation',
}

const statusLabels: Record<string, string> = {
  AWAITING_EXECUTION: 'Chờ thực hiện',
  IN_PROGRESS: 'Đang thực hiện',
  PENDING_RECONCILIATION: 'Chờ đối soát',
  EXCEPTION: 'Có ngoại lệ',
  RECONCILED: 'Đã đối soát',
  COMPLETED: 'Hoàn thành',
}

function numeric(input: unknown): number | null {
  if (input === null || input === undefined || input === '') {
    return null
  }

  const result = Number(input)
  return Number.isFinite(result) ? result : null
}

function display(input: unknown, suffix = '') {
  const n = numeric(input)

  if (n === null) return '—'

  return (
    new Intl.NumberFormat('vi-VN', {
      maximumFractionDigits: 3,
    }).format(n) + suffix
  )
}

function modeName(mode: string) {
  if (mode === 'CAPSTONE') return 'Capstone'
  if (mode === 'SIMULATION') return 'Mô phỏng'
  return 'Vận hành'
}

export default function RolePerformanceDashboard({
  audience,
  overview,
  mode,
}: Props) {
  const roleMetrics = metrics[audience]
  const plans = overview.plans.filter(plan => plan.current)

  const trendMetric = audience === 'supplier'
    ? 'shipped_kg'
    : 'otif_pct'

  const trendSuffix = audience === 'supplier'
    ? ' kg'
    : '%'

  const trends = overview.trends.slice(-10)

  const maxTrend = audience === 'supplier'
    ? Math.max(
        1,
        ...trends.map(day => numeric(day[trendMetric]) ?? 0)
      )
    : 100

  return (
    <div className={`rpd-dashboard rpd--${audience}`}>
      <section className="rpd-panel">
        <div className="rpd-heading">
          <div>
            <h2>{titles[audience]}</h2>
            <p>
              Các chỉ số được tính từ dữ liệu thực hiện
              trong phạm vi bộ lọc hiện tại.
            </p>
          </div>

          <span className="rpd-mode">{modeName(mode)}</span>
        </div>

        <div className="rpd-kpi-grid">
          {roleMetrics.map(metric => {
            const raw = overview.kpis[metric.key]
            const n = numeric(raw)

            return (
              <article className="rpd-kpi" key={metric.key}>
                <span className="rpd-kpi-label">
                  {metric.label}
                </span>

                <strong className="rpd-kpi-value">
                  {display(raw, metric.suffix)}
                </strong>

                {metric.percent && n !== null && (
                  <progress
                    value={Math.max(0, Math.min(100, n))}
                    max={100}
                    aria-label={metric.label}
                  />
                )}

                <small>
                  {n === null
                    ? 'Chưa đủ dữ liệu thực hiện'
                    : metric.description}
                </small>
              </article>
            )
          })}
        </div>
      </section>

      <section className="rpd-panel">
        <div className="rpd-heading">
          <div>
            <h2>So sánh phương án vận chuyển</h2>
            <p>
              Đối chiếu Direct và Hub theo dữ liệu
              được backend tổng hợp.
            </p>
          </div>
        </div>

        <div className="rpd-template-grid">
          {(['DIRECT', 'HUB'] as const).map(type => {
            const data = overview.templates[type]

            return (
              <article className="rpd-template" key={type}>
                <h3>
                  {type === 'DIRECT'
                    ? 'Giao trực tiếp'
                    : 'Giao qua Hub'}
                </h3>

                <dl>
                  <div>
                    <dt>FinalPlan</dt>
                    <dd>{display(data?.final_plans)}</dd>
                  </div>

                  <div>
                    <dt>
                      {audience === 'supplier'
                        ? 'Đã xuất'
                        : 'Đã nhận'}
                    </dt>

                    <dd>
                      {display(
                        audience === 'supplier'
                          ? data?.shipped_kg
                          : data?.received_kg,
                        ' kg'
                      )}
                    </dd>
                  </div>

                  <div>
                    <dt>
                      {audience === 'supplier'
                        ? 'Lấy đúng hạn'
                        : 'OTIF'}
                    </dt>

                    <dd>
                      {display(
                        audience === 'supplier'
                          ? data?.on_time_pickup_pct
                          : data?.otif_pct,
                        '%'
                      )}
                    </dd>
                  </div>
                </dl>
              </article>
            )
          })}
        </div>
      </section>

      <section className="rpd-panel">
        <div className="rpd-heading">
          <div>
            <h2>
              {audience === 'supplier'
                ? 'Xu hướng xuất hàng'
                : 'Xu hướng giao đủ và đúng hạn'}
            </h2>
            <p>
              {audience === 'supplier'
                ? 'Khối lượng xuất hàng theo ngày.'
                : 'Chỉ số OTIF theo ngày có dữ liệu.'}
            </p>
          </div>
        </div>

        {trends.length === 0 ? (
          <p className="rpd-empty">
            Chưa có dữ liệu xu hướng trong khoảng thời gian đã chọn.
          </p>
        ) : (
          <div className="rpd-trends">
            {trends.map(day => {
              const raw = day[trendMetric]
              const n = numeric(raw)

              return (
                <div className="rpd-trend-row" key={day.date}>
                  <time dateTime={day.date}>
                    {deliveryDate(day.date)}
                  </time>

                  <div className="rpd-trend-bar">
                    {n === null ? (
                      <span className="rpd-trend-unavailable">
                        Chưa có dữ liệu
                      </span>
                    ) : (
                      <progress
                        max={maxTrend}
                        value={Math.max(
                          0,
                          Math.min(maxTrend, n)
                        )}
                        aria-label={
                          `Kết quả ngày ${deliveryDate(day.date)}`
                        }
                      />
                    )}
                  </div>

                  <strong>{display(raw, trendSuffix)}</strong>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="rpd-panel">
        <div className="rpd-heading">
          <div>
            <h2>Kế hoạch đang theo dõi</h2>
            <p>
              Chọn FinalPlan để xem chi tiết thực hiện
              và tình trạng đối soát.
            </p>
          </div>

          <span className="rpd-count">
            {plans.length} kế hoạch
          </span>
        </div>

        {plans.length === 0 ? (
          <p className="rpd-empty">
            Chưa có FinalPlan hiện hành trong phạm vi lọc.
          </p>
        ) : (
          <div className="rpd-table-scroll">
            <table className="rpd-table">
              <thead>
                <tr>
                  <th scope="col">FinalPlan</th>
                  <th scope="col">Ngày</th>
                  <th scope="col">Phương án</th>
                  <th scope="col">Nhu cầu</th>
                  <th scope="col">Kế hoạch</th>
                  <th scope="col">Đã nhận</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Chi tiết</th>
                </tr>
              </thead>

              <tbody>
                {plans.map(plan => (
                  <tr key={plan.code}>
                    <th scope="row">
                      <span className="rpd-plan-code">
                        {plan.code}
                      </span>
                    </th>

                    <td>{deliveryDate(plan.date)}</td>

                    <td>
                      {plan.template === 'DIRECT'
                        ? 'Trực tiếp'
                        : 'Qua Hub'}
                    </td>

                    <td>{display(plan.demands)}</td>

                    <td>{display(plan.planned_kg, ' kg')}</td>

                    <td>{display(plan.received_kg, ' kg')}</td>

                    <td>
                      <span
                        className="rpd-status"
                        data-status={plan.status}
                      >
                        {statusLabels[plan.status] ??
                          plan.status}
                      </span>
                    </td>

                    <td>
                      <Link
                        to={
                          `${paths[audience]}/${plan.code}` +
                          `?mode=${encodeURIComponent(mode)}`
                        }
                      >
                        Xem chi tiết
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
