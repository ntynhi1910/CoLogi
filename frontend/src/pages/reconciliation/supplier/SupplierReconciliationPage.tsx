
import { useCallback, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { useAuth } from '../../../contexts/useAuth'
import { apiRequest, getToken } from '../../../services/api/client'
import { useDssQuery } from '../../../services/dss/useDssQuery'
import { deliveryDate, runTime } from '../../../components/dss/f1Display'

import ReconciliationWorkspace from '../../ReconciliationWorkspace'

import {
  ReconciliationFilters,
  ReconciliationPlanList,
} from '../components/ReconciliationOverviewSections'


import './SupplierReconciliationPage.css'

/* ==========================================
   TYPES
   ========================================== */

type Quantity = number | string | null

type Entity = {
  id: number
  code: string | null
  name: string | null
}

type Cost = {
  baseline_vnd: Quantity
  planned_vnd: Quantity
  actual_vnd: Quantity
  variance_vnd: Quantity
  planned_saving_vnd: Quantity
  actual_saving_vnd: Quantity
  status: string
  claim: RecordRow | null
  review: RecordRow | null
  planned_allocations: Allocation[]
  actual_allocations: Allocation[] | null
  planned_components: {
    component_type: string
    scope: string
    amount: Quantity
    source_reference: string
  }[]
}

type RecordRow = {
  id: number
  action: string
  actor: string
  reason: string
  at: string
  mode: string
  evidence: Record<string, string>
}

type Allocation = {
  outlet_id: number
  outlet_code: string
  baseline_cost: Quantity
  allocated_cost: Quantity
  participant_saving: Quantity
}

type PlanSummary = {
  code: string
  version: number
  date: string
  status: string
  current: boolean
  template: string
  mode: string

  source: {
    classification: string
    time_source?: string
    price_source?: string
  }

  provider: Entity
  hub: Entity | null
  cost: Cost | null

  demands: number
  planned_kg: Quantity
  received_kg: Quantity
}

type Overview = {
  mode: string
  generated_at: string
  plans: PlanSummary[]
  kpis: Record<string, Quantity>

  trends: (
    Record<string, Quantity> & {
      date: string
    }
  )[]

  templates: Record<string, Record<string, Quantity>>
  facets: Record<string, Entity[]>

  breakdown: Record<
    string,
    ({ entity: Entity } & Record<string, Quantity | Entity>)[]
  >
}

type Tab = 'performance' | 'reconciliation' | 'reports'

type IconName =
  | 'history'
  | 'activity'
  | 'clipboard'
  | 'report'
  | 'calendar'
  | 'filter'
  | 'reset'
  | 'package'
  | 'truck'
  | 'clock'
  | 'warning'
  | 'chevron'
  | 'arrow'
  | 'chart'
  | 'download'
  | 'print'
  | 'check'

/* ==========================================
   ICONS
   Không cần cài thêm thư viện
   ========================================== */

function Icon({
  name,
  size = 20,
}: {
  name: IconName
  size?: number
}) {
  const paths: Record<IconName, React.ReactNode> = {
    history: (
      <>
        <path d="M3 12a9 9 0 1 1 9 9" />
        <path d="M3 3v9h9M12 7v5l3 2" />
      </>
    ),

    activity: (
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    ),

    clipboard: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <rect x="9" y="2" width="6" height="4" rx="1" />
        <path d="m9 13 2 2 4-4" />
      </>
    ),

    report: (
      <>
        <path d="M14 2H5v20h14V7zM14 2v5h5" />
        <path d="M8 17v-3m4 3v-7m4 7v-5" />
      </>
    ),

    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 2v6M17 2v6M3 10h18" />
      </>
    ),

    filter: (
      <>
        <path d="M4 7h16M4 12h16M4 17h16" />
        <circle cx="8" cy="7" r="2" fill="white" />
        <circle cx="16" cy="12" r="2" fill="white" />
        <circle cx="10" cy="17" r="2" fill="white" />
      </>
    ),

    reset: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 3v7h7" />
      </>
    ),

    package: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="M3 8v9l9 5 9-5V8M12 13v9M7 5.8l9 5" />
      </>
    ),

    truck: (
      <>
        <path d="M2 5h12v12H2zM14 9h4l4 4v4h-8" />
        <circle cx="6" cy="18" r="2" fill="white" />
        <circle cx="18" cy="18" r="2" fill="white" />
      </>
    ),

    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),

    warning: (
      <>
        <path d="M12 3 2 21h20L12 3Z" />
        <path d="M12 9v5M12 17h.01" />
      </>
    ),

    chevron: <path d="m6 9 6 6 6-6" />,

    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,

    chart: (
      <>
        <path d="M3 3v18h18M7 15l5-5 4 3 5-8" />
      </>
    ),

    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),

    print: (
      <>
        <path d="M7 8V3h10v5M7 17H3V9h18v8h-4" />
        <path d="M7 14h10v7H7zM17 11h.01" />
      </>
    ),

    check: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

/* ==========================================
   FORMATTERS
   ========================================== */

const numberFormat = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 3,
})

function numeric(input: unknown): number | null {
  if (
    input === null ||
    input === undefined ||
    input === ''
  ) {
    return null
  }

  if (
    typeof input !== 'string' &&
    typeof input !== 'number'
  ) {
    return null
  }

  const result = Number(input)

  return Number.isFinite(result) ? result : null
}

function formatValue(
  input: unknown,
  suffix = '',
) {
  const n = numeric(input)

  return n === null
    ? '—'
    : numberFormat.format(n) + suffix
}

const statusLabels: Record<string, string> = {
  AWAITING_EXECUTION: 'Chờ thực hiện',
  IN_PROGRESS: 'Đang thực hiện',
  PENDING_RECONCILIATION: 'Chờ đối soát',
  EXCEPTION: 'Có ngoại lệ',
  RECONCILED: 'Đã đối soát',
  COMPLETED: 'Hoàn thành',
  OPEN: 'Chờ xử lý',
  EVIDENCE_REQUESTED: 'Chờ bổ sung bằng chứng',
  RESOLVED: 'Đã xử lý',
  UNAVAILABLE: 'Chưa đối soát',
}

function methodName(template: string) {
  if (template === 'DIRECT') {
    return 'Giao trực tiếp'
  }

  if (template === 'HUB') {
    return 'Giao qua Hub'
  }

  return template
}

function modeName(mode: string) {
  if (mode === 'SIMULATION') return 'Mô phỏng'
  if (mode === 'CAPSTONE') return 'Capstone'

  return 'Vận hành'
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className="sr-status"
      data-status={status}
    >
      <span className="sr-status-dot" />
      {statusLabels[status] ?? status}
    </span>
  )
}

/* ==========================================
   KPI CARD
   ========================================== */

function KpiCard({
  label,
  value,
  suffix = '',
  description,
  icon,
  tone = 'green',
  percentage = false,
}: {
  label: string
  value: Quantity | undefined
  suffix?: string
  description: string
  icon: IconName
  tone?: 'green' | 'amber'
  percentage?: boolean
}) {
  const n = numeric(value)

  const ring =
    n === null
      ? 0
      : Math.max(0, Math.min(100, n))

  return (
    <article
      className="sr-kpi-card"
      data-tone={tone}
    >
      <div className="sr-kpi-icon">
        <Icon name={icon} size={21} />
      </div>

      <span className="sr-kpi-label">
        {label}
      </span>

      <div className="sr-kpi-main">
        <strong className="sr-kpi-value">
          {formatValue(value, suffix)}
        </strong>

        {percentage && (
          <svg
            className="sr-kpi-ring"
            viewBox="0 0 60 60"
            aria-label={
              n === null
                ? 'Chưa đủ dữ liệu'
                : formatValue(n, '%')
            }
            role="img"
          >
            <circle
              cx="30"
              cy="30"
              r="23"
              fill="none"
              stroke="#e4ece6"
              strokeWidth="6"
            />

            {n !== null && (
              <circle
                cx="30"
                cy="30"
                r="23"
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={
                  `${ring * 1.445} 144.5`
                }
                transform="rotate(-90 30 30)"
              />
            )}

            <text
              x="30"
              y="33"
              textAnchor="middle"
              fill="currentColor"
              fontSize="9"
            >
              {n === null ? 'N/A' : `${n}%`}
            </text>
          </svg>
        )}
      </div>

      <small className="sr-kpi-description">
        {n === null
          ? 'Chưa đủ dữ liệu thực hiện'
          : description}
      </small>
    </article>
  )
}

/* ==========================================
   DIRECT / HUB CHART
   ========================================== */

function MethodChart({
  templates,
}: {
  templates: Overview['templates']
}) {
  const direct = templates.DIRECT
  const hub = templates.HUB

  const directCount = numeric(direct?.final_plans)
  const hubCount = numeric(hub?.final_plans)

  const total =
    directCount !== null && hubCount !== null
      ? directCount + hubCount
      : null

  const directPct =
    total !== null &&
    total > 0 &&
    directCount !== null
      ? directCount / total * 100
      : null

  const hubPct =
    directPct === null ? null : 100 - directPct

  return (
    <section className="sr-panel">
      <div className="sr-panel-heading">
        <div>
          <h2>Phương án vận chuyển</h2>
          <p>Phân bổ kế hoạch cung ứng hiện hành.</p>
        </div>
      </div>

      <div className="sr-method-chart">
        <svg
          className="sr-donut"
          viewBox="0 0 160 160"
          role="img"
          aria-label="Phân bổ giao trực tiếp và giao qua Hub"
        >
          <circle
            cx="80"
            cy="80"
            r="61"
            fill="none"
            stroke="#e6eee8"
            strokeWidth="17"
          />

          {directPct !== null && (
            <>
              <circle
                cx="80"
                cy="80"
                r="61"
                fill="none"
                stroke="#b8d6c1"
                strokeWidth="17"
              />

              <circle
                cx="80"
                cy="80"
                r="61"
                fill="none"
                stroke="#32865b"
                strokeWidth="17"
                strokeDasharray={
                  `${directPct * 3.8327} 383.27`
                }
                transform="rotate(-90 80 80)"
              />
            </>
          )}

          <text
            x="80"
            y="80"
            textAnchor="middle"
            fontSize="30"
            fontWeight="750"
            fill="#183b29"
          >
            {formatValue(total)}
          </text>

          <text
            x="80"
            y="99"
            textAnchor="middle"
            fontSize="11"
            fill="#718378"
          >
            Kế hoạch
          </text>
        </svg>

        <div className="sr-chart-legend">
          <div className="sr-legend-item">
            <span>
              <i data-method="direct" />
              Giao trực tiếp
            </span>

            <strong>
              {formatValue(directCount)}

              <small>
                {formatValue(directPct, '%')}
              </small>
            </strong>
          </div>

          <div className="sr-legend-item">
            <span>
              <i data-method="hub" />
              Giao qua Hub
            </span>

            <strong>
              {formatValue(hubCount)}

              <small>
                {formatValue(hubPct, '%')}
              </small>
            </strong>
          </div>
        </div>
      </div>

      <div className="sr-method-table">
        <table>
          <thead>
            <tr>
              <th>Chỉ số</th>
              <th>Trực tiếp</th>
              <th>Qua Hub</th>
            </tr>
          </thead>

          <tbody>
            <tr>
              <td>Đã xuất</td>
              <td>{formatValue(direct?.shipped_kg, ' kg')}</td>
              <td>{formatValue(hub?.shipped_kg, ' kg')}</td>
            </tr>

            <tr>
              <td>Lấy đúng hạn</td>
              <td>{formatValue(direct?.on_time_pickup_pct, '%')}</td>
              <td>{formatValue(hub?.on_time_pickup_pct, '%')}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

/* ==========================================
   SHIPMENT TREND
   ========================================== */

function ShipmentTrend({
  trends,
}: {
  trends: Overview['trends']
}) {
  const rows = [...trends]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-7)

  const hasData = rows.some(
    row => numeric(row.shipped_kg) !== null,
  )

  const maxWeight = Math.max(
    1,
    ...rows.map(row => numeric(row.shipped_kg) ?? 0),
  )

  return (
    <section className="sr-panel">
      <div className="sr-panel-heading">
        <div>
          <h2>Xu hướng xuất hàng</h2>
          <p>Khối lượng xuất hàng theo ngày (kg).</p>
        </div>

        <span className="sr-subtle-label">
          Tối đa 7 ngày
        </span>
      </div>

      {!hasData ? (
        <div className="sr-chart-empty">
          <div className="sr-empty-icon">
            <Icon name="chart" size={29} />
          </div>

          <strong>Chưa có dữ liệu xuất hàng</strong>

          <p>
            Biểu đồ sẽ được cập nhật khi phát sinh
            kết quả xuất hàng hợp lệ.
          </p>
        </div>
      ) : (
        <div className="sr-trend-chart">
          <div className="sr-chart-axis">
            {[1, .75, .5, .25, 0].map(ratio => (
              <span key={ratio}>
                {formatValue(
                  Math.round(maxWeight * ratio),
                )}
              </span>
            ))}
          </div>

          <div className="sr-chart-plot">
            <div className="sr-chart-grid-lines">
              {[0, 1, 2, 3, 4].map(index => (
                <span key={index} />
              ))}
            </div>

            <div className="sr-chart-columns">
              {rows.map(row => {
                const amount = numeric(row.shipped_kg)

                return (
                  <div
                    className="sr-chart-column"
                    key={row.date}
                  >
                    <div className="sr-chart-column-track">
                      {amount !== null ? (
                        <div
                          className="sr-chart-bar"
                          style={{
                            height:
                              `${Math.max(0, amount) / maxWeight * 100}%`,
                          }}
                          title={
                            `${deliveryDate(row.date)}: ${formatValue(amount, ' kg')}`
                          }
                        >
                          <span>
                            {formatValue(amount)}
                          </span>
                        </div>
                      ) : (
                        <span className="sr-chart-no-data">
                          —
                        </span>
                      )}
                    </div>

                    <small>
                      {deliveryDate(row.date).slice(0, 5)}
                    </small>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      <div className="sr-chart-footer">
        <span className="sr-chart-key">
          <i />
          Khối lượng đã xuất
        </span>

        <span>Đơn vị: kg</span>
      </div>
    </section>
  )
}

/* ==========================================
   PLAN TABLE
   ========================================== */

function PlanTable({
  plans,
  mode,
  report = false,
}: {
  plans: PlanSummary[]
  mode: string
  report?: boolean
}) {
  return (
    <section className="sr-panel">
      <div className="sr-panel-heading">
        <div>
          <h2>
            {report
              ? 'Chi tiết theo kế hoạch'
              : 'Kế hoạch đang theo dõi'}
          </h2>

          <p>
            {report
              ? 'Số liệu tổng hợp theo bộ lọc hiện tại.'
              : 'Theo dõi tiến độ và kết quả cung ứng.'}
          </p>
        </div>

        <span className="sr-subtle-label">
          {plans.length} kế hoạch
        </span>
      </div>

      <div className="sr-table-scroll">
        <table className="sr-table">
          <thead>
            <tr>
              <th>Kế hoạch</th>
              <th>Ngày giao</th>
              <th>Nhu cầu</th>
              <th>Kế hoạch (kg)</th>
              <th>Đã nhận (kg)</th>

              {report && <th>Chi phí thực tế</th>}

              <th>Trạng thái</th>

              {!report && <th>Chi tiết</th>}
            </tr>
          </thead>

          <tbody>
            {plans.map(plan => (
              <tr key={plan.code}>
                <td>
                  <strong className="sr-plan-name">
                    {methodName(plan.template)}
                  </strong>

                  <span
                    className="sr-plan-code"
                    title={plan.code}
                  >
                    {plan.code.slice(0, 8)}… · v{plan.version}
                  </span>
                </td>

                <td>{deliveryDate(plan.date)}</td>
                <td>{plan.demands}</td>
                <td>{formatValue(plan.planned_kg)}</td>
                <td>{formatValue(plan.received_kg)}</td>

                {report && (
                  <td>
                    {formatValue(plan.cost?.actual_vnd, ' đ')}
                  </td>
                )}

                <td>
                  <StatusBadge status={plan.status} />
                </td>

                {!report && (
                  <td>
                    <Link
                      className="sr-plan-detail"
                      to={
                        `/supplier/reconciliation/${encodeURIComponent(plan.code)}?mode=${encodeURIComponent(mode)}`
                      }
                    >
                      Xem chi tiết
                      <Icon name="arrow" size={15} />
                    </Link>
                  </td>
                )}
              </tr>
            ))}

            {!plans.length && (
              <tr>
                <td colSpan={7}>
                  <div className="sr-table-empty">
                    <Icon name="clipboard" size={28} />

                    <strong>Chưa có kế hoạch phù hợp</strong>

                    <span>
                      Thử thay đổi hoặc đặt lại bộ lọc.
                    </span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="sr-table-footer">
        Hiển thị {plans.length} kế hoạch
      </div>
    </section>
  )
}

/* ==========================================
   SUPPLIER - PLAN EXECUTION PROGRESS
   ========================================== */

function PlanExecutionProgress({
  plans,
}: {
  plans: PlanSummary[]
}) {
  const [params] = useSearchParams()

  const currentPlans = plans.filter(
    plan => plan.current,
  )

  const groups: {
    key: string
    label: string
    icon: IconName
    statuses: string[]
  }[] = [
    {
      key: 'pending',
      label: 'Chờ thực hiện',
      icon: 'clock',
      statuses: ['AWAITING_EXECUTION'],
    },
    {
      key: 'progress',
      label: 'Đang thực hiện',
      icon: 'truck',
      statuses: [
        'IN_PROGRESS',
        'PENDING_RECONCILIATION',
        'RECONCILED',
      ],
    },
    {
      key: 'completed',
      label: 'Hoàn thành',
      icon: 'check',
      statuses: ['COMPLETED'],
    },
    {
      key: 'exception',
      label: 'Có ngoại lệ',
      icon: 'warning',
      statuses: ['EXCEPTION'],
    },
  ]

  const total = currentPlans.length

  const items = groups.map(group => ({
    ...group,
    count: currentPlans.filter(plan =>
      group.statuses.includes(plan.status),
    ).length,
  }))

  const completed =
    items.find(item => item.key === 'completed')
      ?.count ?? 0

  const classified = items.reduce(
    (sum, item) => sum + item.count,
    0,
  )

  const other = Math.max(0, total - classified)

  const completedPct =
    total > 0
      ? completed / total * 100
      : 0

  const nextParams = new URLSearchParams(params)

  nextParams.set('tab', 'reconciliation')

  return (
    <section className="sr-panel sr-execution-progress">
      {/* HEADER */}

      <div className="sr-execution-heading">
        <div>
          <h2>Tiến độ thực hiện kế hoạch</h2>

          <p>
            Trạng thái các kế hoạch cung ứng hiện hành.
          </p>
        </div>

        <Link
          className="sr-execution-link"
          to={
            '/supplier/reconciliation?' +
            nextParams.toString()
          }
        >
          Xem đối soát

          <Icon name="arrow" size={17} />
        </Link>
      </div>

      {/* STATUS CARDS */}

      <div className="sr-execution-grid">
        {items.map(item => (
          <article
            key={item.key}
            className="sr-execution-card"
            data-tone={item.key}
          >
            <div className="sr-execution-icon">
              <Icon name={item.icon} size={23} />
            </div>

            <strong>
              {formatValue(item.count)}
            </strong>

            <span>{item.label}</span>
          </article>
        ))}
      </div>

      {/* PROGRESS SUMMARY */}

      {total > 0 ? (
        <div className="sr-execution-summary">
          <div className="sr-execution-summary-head">
            <span>Tiến độ hoàn thành</span>

            <strong>
              {formatValue(
                Math.round(completedPct * 10) / 10,
                '%',
              )}
            </strong>
          </div>

          <div
            className="sr-execution-bar"
            role="img"
            aria-label={
              items
                .map(item =>
                  `${item.label}: ${item.count}`,
                )
                .join(', ') +
              (other > 0
                ? `, Trạng thái khác: ${other}`
                : '')
            }
          >
            {items.map(item =>
              item.count > 0 ? (
                <div
                  key={item.key}
                  className="sr-execution-segment"
                  data-tone={item.key}
                  style={{
                    width:
                      `${item.count / total * 100}%`,
                  }}
                  title={
                    `${item.label}: ${item.count} kế hoạch`
                  }
                />
              ) : null,
            )}

            {other > 0 && (
              <div
                className="sr-execution-segment"
                data-tone="other"
                style={{
                  width: `${other / total * 100}%`,
                }}
                title={`Trạng thái khác: ${other}`}
              />
            )}
          </div>

          <div className="sr-execution-footer">
            <span>
              Tổng số: <b>{total}</b> kế hoạch
            </span>

            <span>
              {completed}/{total} kế hoạch hoàn thành
            </span>
          </div>

          {other > 0 && (
            <p className="sr-execution-other">
              {other} kế hoạch thuộc trạng thái khác.
            </p>
          )}
        </div>
      ) : (
        <div className="sr-execution-empty">
          <Icon name="clipboard" size={20} />

          <span>
            Chưa có kế hoạch hiện hành
            trong phạm vi bộ lọc.
          </span>
        </div>
      )}
    </section>
  )
}

/* ==========================================
   SUPPLIER PERFORMANCE
   ========================================== */

function SupplierPerformance({
  overview,
  mode,
}: {
  overview: Overview
  mode: string
}) {
  const kpis = overview.kpis
  return (
    <div className="sr-performance">
      <div className="sr-section-heading">
        <h2>Tổng quan hiệu suất</h2>

        <span className="sr-mode">
          {modeName(mode)}
        </span>
      </div>

      <div className="sr-kpi-grid">
        <KpiCard
          label="Kế hoạch cung ứng"
          value={kpis.final_plans}
          description="Kế hoạch hiện hành"
          icon="calendar"
        />

        <KpiCard
          label="Nhu cầu cung ứng"
          value={kpis.demands}
          description="Trong phạm vi cung ứng"
          icon="package"
        />

        <KpiCard
          label="Khối lượng đã xuất"
          value={kpis.shipped_kg}
          suffix=" kg"
          description="Pickup đã được xác nhận"
          icon="truck"
        />

        <KpiCard
          label="Lấy hàng đúng hạn"
          value={kpis.on_time_pickup_pct}
          suffix="%"
          description="Theo khung giờ lấy hàng"
          icon="clock"
          percentage
        />

        <KpiCard
          label="Tỷ lệ ngoại lệ"
          value={kpis.exception_pct}
          suffix="%"
          description="Nhu cầu có ngoại lệ ghi nhận"
          icon="warning"
          tone="amber"
          percentage
        />
      </div>

      <div className="sr-analytics-grid">
        <ShipmentTrend trends={overview.trends} />

        <MethodChart templates={overview.templates} />
      </div>

      <PlanExecutionProgress
        plans={overview.plans}
      />

    </div>
  )
}

/* ==========================================
   SUPPLIER REPORT
   ========================================== */

function SupplierReport({
  overview,
  mode,
  from,
  to,
  onDownload,
  exportError,
  exporting,
}: {
  overview: Overview
  mode: string
  from: string
  to: string
  onDownload: (kind: string) => void
  exportError: string
  exporting: boolean
}) {
  return (
    <div className="sr-report">
      <section className="sr-panel">
        <div className="sr-report-header">
          <div className="sr-report-title">
            <div className="sr-kpi-icon">
              <Icon name="report" size={23} />
            </div>

            <div>
              <h2>Báo cáo logistics</h2>

              <p>
                Tổng hợp kết quả cung ứng
                trong phạm vi được cấp quyền.
              </p>
            </div>
          </div>

          <div className="sr-report-actions">
            <button
              type="button"
              className="sr-button"
              disabled={exporting}
              onClick={() => onDownload('csv')}
            >
              <Icon name="download" size={16} />
              Xuất CSV
            </button>

            <button
              type="button"
              className="sr-button sr-button-primary"
              disabled={exporting}
              onClick={() => onDownload('xlsx')}
            >
              <Icon name="report" size={16} />
              Xuất Excel
            </button>

            <button
              type="button"
              className="sr-button"
              onClick={() => window.print()}
            >
              <Icon name="print" size={16} />
              In / lưu PDF
            </button>
          </div>
        </div>

        <div className="sr-report-meta">
          <div>
            <Icon name="calendar" size={18} />

            <span>
              <small>Kỳ báo cáo</small>

              <strong>
                {!from && !to
                  ? 'Toàn bộ thời gian'
                  : `${from ? deliveryDate(from) : 'Đầu kỳ'} – ${to ? deliveryDate(to) : 'Cuối kỳ'}`}
              </strong>
            </span>
          </div>

          <div>
            <Icon name="clock" size={18} />

            <span>
              <small>Cập nhật lần cuối</small>
              <strong>{runTime(overview.generated_at)}</strong>
            </span>
          </div>

          <span className="sr-mode">
            {modeName(mode)}
          </span>
        </div>

        {exportError && (
          <p className="sr-error" role="alert">
            {exportError}
          </p>
        )}
      </section>

      <div className="sr-report-kpis">
        <KpiCard
          label="FinalPlan hiện hành"
          value={overview.kpis.final_plans}
          description="Kế hoạch vận chuyển"
          icon="clipboard"
        />

        <KpiCard
          label="Số nhu cầu"
          value={overview.kpis.demands}
          description="Trong phạm vi cung ứng"
          icon="package"
        />

        <KpiCard
          label="Khối lượng đã xuất"
          value={overview.kpis.shipped_kg}
          suffix=" kg"
          description="Kết quả xuất hàng"
          icon="truck"
        />

        <KpiCard
          label="Tỷ lệ ngoại lệ"
          value={overview.kpis.exception_pct}
          suffix="%"
          description="Nhu cầu có ngoại lệ"
          icon="warning"
          tone="amber"
        />
      </div>

      <PlanTable
        plans={overview.plans}
        mode={mode}
        report
      />

      <p className="sr-report-note">
        Dấu (—) thể hiện chưa có dữ liệu thực hiện,
        không đồng nghĩa với giá trị bằng 0.
      </p>
    </div>
  )
}

/* ==========================================
   OVERVIEW PAGE
   ========================================== */

function SupplierOverview() {
  const { user } = useAuth()

  const [params, setParams] = useSearchParams()

  const [filterOpen, setFilterOpen] = useState(false)
  const [exportError, setExportError] = useState('')
  const [exporting, setExporting] = useState(false)

  const rawTab = params.get('tab')

  const tab: Tab =
    rawTab === 'reports'
      ? 'reports'
      : rawTab && rawTab !== 'performance'
        ? 'reconciliation'
        : 'performance'

  const mode = user?.capstone_scenario
    ? 'CAPSTONE'
    : params.get('mode') === 'SIMULATION'
      ? 'SIMULATION'
      : 'COMMERCIAL_EXECUTION'

  const queryParams = new URLSearchParams(params)

  queryParams.delete('tab')
  queryParams.set('mode', mode)

  const endpoint =
    '/planning/reconciliation/supplier/?' +
    queryParams.toString()

  const query = useDssQuery(
    useCallback(
      () => apiRequest<Overview>(endpoint),
      [endpoint],
    ),
  )

  const overview = query.data

  const tabs: {
    key: Tab
    label: string
    icon: IconName
  }[] = [
    {
      key: 'performance',
      label: 'Hiệu suất cung ứng',
      icon: 'activity',
    },
    {
      key: 'reconciliation',
      label: 'Đối soát giao nhận',
      icon: 'clipboard',
    },
    {
      key: 'reports',
      label: 'Báo cáo logistics',
      icon: 'report',
    },
  ]

  function filter(field: string, next: string) {
    const updated = new URLSearchParams(params)

    if (next) {
      updated.set(field, next)
    } else {
      updated.delete(field)
    }

    setParams(updated)
  }

  function resetFilters() {
    const updated = new URLSearchParams()

    updated.set('tab', tab)
    updated.set('mode', mode)

    setParams(updated)
  }

  function selectPeriod(period: string) {
    const updated = new URLSearchParams(params)

    if (period === 'all') {
      updated.delete('from_date')
      updated.delete('to_date')
    } else if (period === 'custom') {
      setFilterOpen(true)
      return
    } else {
      const days = Number(period)

      if (!Number.isFinite(days) || days < 1) return

      const now = new Date()

      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now)

      const part = (type: string) =>
        today.find(item => item.type === type)?.value ?? ''

      const end =
        `${part('year')}-${part('month')}-${part('day')}`

      const start = new Date(end + 'T00:00:00Z')

      start.setUTCDate(
        start.getUTCDate() - days + 1,
      )

      updated.set(
        'from_date',
        start.toISOString().slice(0, 10),
      )

      updated.set('to_date', end)
    }

    setParams(updated)
  }

  async function download(kind: string) {
    setExportError('')
    setExporting(true)

    try {
      const response = await fetch(
        '/api' + endpoint + '&export=' + kind,
        {
          headers: {
            Authorization: 'Token ' + getToken(),
          },
        },
      )

      if (!response.ok) {
        throw new Error('Export failed')
      }

      const url = URL.createObjectURL(
        await response.blob(),
      )

      const link = document.createElement('a')

      link.href = url
      link.download = 'cologi-logistics.' + kind
      link.click()

      setTimeout(() => {
        URL.revokeObjectURL(url)
      }, 1000)
    } catch {
      setExportError(
        'Không xuất được báo cáo. Vui lòng thử lại.',
      )
    } finally {
      setExporting(false)
    }
  }

  const fromDate = params.get('from_date') ?? ''
  const toDate = params.get('to_date') ?? ''

  const activeFilterCount = Array.from(
    params.keys(),
  ).filter(key => key !== 'tab' && key !== 'mode').length

  return (
    <main className="supplier-reconciliation">
      <header className="sr-page-header">
        <div>
          <h1>Hiệu suất cung ứng</h1>

          <p>
            Theo dõi kết quả và chất lượng
            thực hiện cung ứng.
          </p>
        </div>

        <Link
          to="/supplier/inventory"
          className="sr-button"
        >
          <Icon name="history" size={18} />
          Lịch sử tồn kho
        </Link>
      </header>

      {/* TABS */}

      <nav
        className="sr-tabs"
        aria-label="Chức năng hiệu suất cung ứng"
      >
        {tabs.map(item => (
          <button
            key={item.key}
            type="button"
            className="sr-tab"
            aria-pressed={tab === item.key}
            onClick={() => filter('tab', item.key)}
          >
            <Icon name={item.icon} size={19} />

            {item.label}
          </button>
        ))}
      </nav>

      {/* FILTERS */}

      <section className="sr-filter-panel">
        <div className="sr-filter-toolbar">
          <div className="sr-filter-period">
            <Icon name="calendar" size={19} />

            <select
              aria-label="Khoảng thời gian"
              value={
                fromDate || toDate
                  ? 'custom'
                  : 'all'
              }
              onChange={event =>
                selectPeriod(event.target.value)
              }
            >
              <option value="all">
                Tất cả thời gian
              </option>

              <option value="7">
                7 ngày gần nhất
              </option>

              <option value="30">
                30 ngày gần nhất
              </option>

              <option value="custom">
                Khoảng thời gian tùy chỉnh
              </option>
            </select>
          </div>

          {(fromDate || toDate) && (
            <span className="sr-filter-date">
              {fromDate
                ? deliveryDate(fromDate)
                : 'Đầu kỳ'}

              {' – '}

              {toDate
                ? deliveryDate(toDate)
                : 'Cuối kỳ'}
            </span>
          )}

          <div className="sr-filter-actions">
            <button
              type="button"
              className="sr-button"
              aria-expanded={filterOpen}
              aria-controls="sr-advanced-filters"
              onClick={() =>
                setFilterOpen(current => !current)
              }
            >
              <Icon name="filter" size={17} />

              Bộ lọc

              {activeFilterCount > 0 && (
                <span className="sr-filter-count">
                  {activeFilterCount}
                </span>
              )}

              <span
                className="sr-filter-chevron"
                data-open={filterOpen}
              >
                <Icon name="chevron" size={15} />
              </span>
            </button>

            <button
              type="button"
              className="sr-button sr-icon-button"
              aria-label="Đặt lại bộ lọc"
              title="Đặt lại bộ lọc"
              onClick={resetFilters}
            >
              <Icon name="reset" size={18} />
            </button>
          </div>
        </div>

        {overview && (
          <div
            id="sr-advanced-filters"
            className="sr-advanced-filters"
            hidden={!filterOpen}
          >
            <ReconciliationFilters
              audience="supplier"
              params={params}
              facets={overview.facets}
              onFilter={filter}
              onReset={resetFilters}
            />
          </div>
        )}
      </section>

      {/* API STATE */}

      {query.loading && (
        <div className="sr-loading" role="status">
          Đang tải dữ liệu cung ứng…
        </div>
      )}

      {query.error != null && (
        <div className="sr-error" role="alert">
          <span>
            Không tải được dữ liệu.
            Vui lòng thử lại.
          </span>

          <button
            type="button"
            className="sr-button"
            onClick={query.reload}
          >
            Tải lại
          </button>
        </div>
      )}

      {/* CONTENT */}

      {overview && (
        <>
          {tab === 'performance' && (
            <SupplierPerformance
              overview={overview}
              mode={mode}
            />
          )}

          {tab === 'reconciliation' && (
            <div className="sr-reconciliation-content">
              <ReconciliationPlanList
                audience="supplier"
                tab={rawTab ?? 'reconciliation'}
                mode={mode}
                plans={overview.plans}
              />
            </div>
          )}

          {tab === 'reports' && (
            <SupplierReport
              overview={overview}
              mode={mode}
              from={fromDate}
              to={toDate}
              onDownload={kind => {
                void download(kind)
              }}
              exportError={exportError}
              exporting={exporting}
            />
          )}
        </>
      )}
    </main>
  )
}

/* ==========================================
   PAGE ENTRY
   ========================================== */

export default function SupplierReconciliationPage() {
  const { code } = useParams()

  // Giữ nguyên toàn bộ nghiệp vụ của trang
  // đối soát chi tiết FinalPlan.
  if (code) {
    return (
      <ReconciliationWorkspace audience="supplier" />
    )
  }

  // Trang tổng quan Supplier độc lập.
  return <SupplierOverview />
}
