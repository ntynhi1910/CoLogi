
import { Link } from 'react-router-dom'
import { deliveryDate, runTime } from '../../../components/dss/f1Display'
import './ReconciliationOverviewSections.css'

export type ReconciliationAudience =
  | 'manager'
  | 'supplier'
  | 'provider'
  | 'purchasing'

type Quantity = number | string | null

type Party = {
  id: number
  code: string | null
  name: string | null
}

export type ReconciliationPlanRow = {
  code: string
  version: number
  date: string
  status: string
  current: boolean
  template: string
  mode: string
  provider: Party
  hub: Party | null
  demands: number
  planned_kg: Quantity
  received_kg: Quantity
  cost: {
    status: string
    actual_vnd: Quantity
  } | null
}

export type ReconciliationOverviewData = {
  generated_at: string
  kpis: Record<string, Quantity>
  plans: ReconciliationPlanRow[]
  facets: Record<string, Party[]>
}

const paths: Record<ReconciliationAudience, string> = {
  manager: '/dss/reconciliation',
  supplier: '/supplier/reconciliation',
  provider: '/provider/reconciliation',
  purchasing: '/purchasing/reconciliation',
}

const stateLabels: Record<string, string> = {
  AWAITING_EXECUTION: 'Chờ thực hiện',
  IN_PROGRESS: 'Đang thực hiện',
  PENDING_RECONCILIATION: 'Chờ đối soát',
  EXCEPTION: 'Có ngoại lệ',
  RECONCILED: 'Đã đối soát',
  COMPLETED: 'Hoàn thành',
  UNAVAILABLE: 'Chưa đối soát',
  SUBMITTED: 'Chờ xác nhận chi phí',
  APPROVED: 'Đã xác nhận chi phí',
  RETURNED: 'Yêu cầu bổ sung',
}

const displayStatus = (status: string) =>
  stateLabels[status] ?? status

const displayNumber = (
  input: Quantity | undefined,
  suffix = ''
) => {
  if (input === null || input === undefined || input === '') {
    return '—'
  }

  const n = Number(input)

  return Number.isFinite(n)
    ? new Intl.NumberFormat('vi-VN', {
        maximumFractionDigits: 3,
      }).format(n) + suffix
    : '—'
}

const planTitle = (plan: ReconciliationPlanRow) =>
  plan.template === 'DIRECT'
    ? 'Giao trực tiếp'
    : plan.hub?.name || plan.hub?.code || 'Qua Hub'

const roles = {
  manager: 'Quản lý',
  supplier: 'Nhà cung cấp',
  provider: 'Đơn vị vận chuyển',
  purchasing: 'Nhân viên mua hàng',
}

type FilterProps = {
  audience: ReconciliationAudience
  params: URLSearchParams
  facets: Record<string, Party[]>
  onFilter: (key: string, value: string) => void
  onReset: () => void
}

export function ReconciliationFilters({
  audience,
  params,
  facets,
  onFilter,
  onReset,
}: FilterProps) {
  const parties = [
    ...(audience !== 'supplier'
      ? [{ key: 'supplier', label: 'Nhà cung cấp' }]
      : []),
    ...(audience !== 'purchasing'
      ? [{ key: 'outlet', label: 'Outlet' }]
      : []),
  ]

  return (
    <section
      className="rco-panel rco-filters"
      aria-label="Bộ lọc logistics"
    >
      <div className="rco-section-heading">
        <div>
          <h2>Bộ lọc dữ liệu</h2>
          <p>
            Lọc các kế hoạch và kết quả giao nhận
            trong phạm vi được cấp quyền.
          </p>
        </div>

        <button
          type="button"
          className="rco-button rco-button-secondary"
          onClick={onReset}
        >
          Đặt lại bộ lọc
        </button>
      </div>

      <div className="rco-filter-grid">
        <label>
          Từ ngày
          <input
            type="date"
            value={params.get('from_date') ?? ''}
            onChange={event =>
              onFilter('from_date', event.target.value)
            }
          />
        </label>

        <label>
          Đến ngày
          <input
            type="date"
            min={params.get('from_date') || undefined}
            value={params.get('to_date') ?? ''}
            onChange={event =>
              onFilter('to_date', event.target.value)
            }
          />
        </label>

        <label>
          Phương án
          <select
            value={params.get('template') ?? ''}
            onChange={event =>
              onFilter('template', event.target.value)
            }
          >
            <option value="">Tất cả phương án</option>
            <option value="DIRECT">Giao trực tiếp</option>
            <option value="HUB">Qua Hub</option>
          </select>
        </label>

        <label>
          FinalPlan
          <input
            key={params.get('plan') ?? ''}
            type="search"
            placeholder="Tìm mã FinalPlan"
            defaultValue={params.get('plan') ?? ''}
            onBlur={event =>
              onFilter('plan', event.target.value.trim())
            }
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
          />
        </label>

        <label>
          Trạng thái
          <select
            value={params.get('status') ?? ''}
            onChange={event =>
              onFilter('status', event.target.value)
            }
          >
            <option value="">Tất cả trạng thái</option>
            {[
              'AWAITING_EXECUTION',
              'IN_PROGRESS',
              'PENDING_RECONCILIATION',
              'EXCEPTION',
              'RECONCILED',
              'COMPLETED',
            ].map(key => (
              <option value={key} key={key}>
                {displayStatus(key)}
              </option>
            ))}
          </select>
        </label>

        {parties.map(({ key, label }) => {
          const available = facets[key] ?? []
          const selected = params.get(key) ?? ''

          return (
            <label key={key}>
              {label}
              <select
                value={selected}
                onChange={event =>
                  onFilter(key, event.target.value)
                }
              >
                <option value="">Tất cả</option>

                {selected &&
                  !available.some(
                    party => String(party.id) === selected
                  ) && (
                    <option value={selected}>
                      Phạm vi đã chọn
                    </option>
                  )}

                {available.map(party => (
                  <option
                    key={party.id}
                    value={String(party.id)}
                  >
                    {[party.code, party.name]
                      .filter(Boolean)
                      .join(' · ')}
                  </option>
                ))}
              </select>
            </label>
          )
        })}
      </div>
    </section>
  )
}

type TabsProps = {
  audience: ReconciliationAudience
  active: string
  onChange: (tab: string) => void
}

export function ReconciliationTabs({
  audience,
  active,
  onChange,
}: TabsProps) {
  const tabs = [
    {
      key: 'performance',
      label:
        audience === 'supplier'
          ? 'Hiệu suất cung ứng'
          : 'Hiệu suất logistics',
    },
    { key: 'goods', label: 'Đối soát giao nhận' },
    ...(
      audience === 'manager' || audience === 'provider'
        ? [{ key: 'costs', label: 'Đối soát chi phí' }]
        : []
    ),
    ...(
      audience === 'manager'
        ? [{ key: 'exceptions', label: 'Quản lý ngoại lệ' }]
        : []
    ),
    { key: 'reports', label: 'Báo cáo logistics' },
  ]

  return (
    <nav
      className="rco-tabs"
      aria-label="Chức năng đối soát logistics"
    >
      {tabs.map(item => (
        <button
          key={item.key}
          type="button"
          aria-pressed={active === item.key}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}

type PlansProps = {
  audience: ReconciliationAudience
  tab: string
  mode: string
  plans: ReconciliationPlanRow[]
}

export function ReconciliationPlanList({
  audience,
  tab,
  mode,
  plans,
}: PlansProps) {
  const filtered = plans.filter(
    plan => tab !== 'exceptions' ||
      plan.status === 'EXCEPTION'
  )

  const title =
    tab === 'costs'
      ? 'Danh sách đối soát chi phí'
      : tab === 'exceptions'
        ? 'Phương án có ngoại lệ'
        : 'Danh sách đối soát giao nhận'

  return (
    <section className="rco-panel">
      <div className="rco-section-heading">
        <div>
          <h2>{title}</h2>
          <p>
            Chọn FinalPlan để xem dữ liệu thực hiện,
            kiểm nhận và bằng chứng đối soát.
          </p>
        </div>

        <span className="rco-count">
          {filtered.length} phương án
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rco-empty">
          Không có FinalPlan phù hợp trong phạm vi lọc.
        </div>
      ) : (
        <div className="rco-table-scroll">
          <table className="rco-table">
            <thead>
              <tr>
                <th scope="col">Phương án</th>
                <th scope="col">Ngày</th>
                <th scope="col">Vận chuyển</th>
                <th scope="col">Nhu cầu</th>
                <th scope="col">Kế hoạch</th>
                <th scope="col">Đã nhận</th>
                <th scope="col">Trạng thái</th>
                <th scope="col">Thao tác</th>
              </tr>
            </thead>

            <tbody>
              {filtered.map(plan => {
                const currentStatus =
                  !plan.current
                    ? 'Phiên bản lịch sử'
                    : tab === 'costs'
                      ? displayStatus(
                          plan.cost?.status ?? 'UNAVAILABLE'
                        )
                      : displayStatus(plan.status)

                return (
                  <tr key={plan.code}>
                    <td>
                      <strong>{planTitle(plan)}</strong>
                      <small>{plan.code}</small>
                    </td>

                    <td>{deliveryDate(plan.date)}</td>

                    <td>
                      {plan.provider.name ||
                        plan.provider.code ||
                        '—'}
                    </td>

                    <td>{displayNumber(plan.demands)}</td>

                    <td>
                      {displayNumber(plan.planned_kg, ' kg')}
                    </td>

                    <td>
                      {displayNumber(plan.received_kg, ' kg')}
                    </td>

                    <td>
                      <span
                        className="rco-status"
                        data-status={
                          plan.current
                            ? (
                                tab === 'costs'
                                  ? plan.cost?.status
                                  : plan.status
                              ) ?? 'UNAVAILABLE'
                            : 'HISTORY'
                        }
                      >
                        {currentStatus}
                      </span>
                    </td>

                    <td>
                      <Link
                        className="rco-detail-link"
                        to={
                          `${paths[audience]}/${plan.code}` +
                          `?mode=${encodeURIComponent(mode)}`
                        }
                      >
                        Chi tiết →
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

type ReportsProps = {
  audience: ReconciliationAudience
  overview: ReconciliationOverviewData
  mode: string
  from: string
  to: string
  exportError: string
  onDownload: (kind: 'csv' | 'xlsx') => void
}

export function LogisticsReports({
  audience,
  overview,
  mode,
  from,
  to,
  exportError,
  onDownload,
}: ReportsProps) {
  const plans = overview.plans

  const cards = [
    {
      label: 'FinalPlan hiện hành',
      field: 'final_plans',
      suffix: '',
    },
    {
      label: 'Số nhu cầu',
      field: 'demands',
      suffix: '',
    },
    {
      label: audience === 'supplier'
        ? 'Khối lượng đã xuất'
        : 'Khối lượng đã nhận',
      field:
        audience === 'supplier'
          ? 'shipped_kg'
          : 'received_kg',
      suffix: ' kg',
    },
    {
      label: 'Tỷ lệ ngoại lệ',
      field: 'exception_pct',
      suffix: '%',
    },
  ]

  return (
    <div className="rco-reports">
      <section className="rco-panel">
        <div className="rco-section-heading">
          <div>
            <h2>Báo cáo logistics</h2>
            <p>
              Dữ liệu báo cáo trong phạm vi quyền
              {` ${roles[audience]}`}.
            </p>
          </div>

          <div className="rco-export-actions">
            <button
              type="button"
              className="rco-button"
              onClick={() => onDownload('csv')}
            >
              Xuất CSV
            </button>

            <button
              type="button"
              className="rco-button"
              onClick={() => onDownload('xlsx')}
            >
              Xuất Excel
            </button>

            <button
              type="button"
              className="rco-button rco-button-secondary"
              onClick={() => window.print()}
            >
              In / lưu PDF
            </button>
          </div>
        </div>

        {exportError && (
          <p className="rco-error" role="alert">
            {exportError}
          </p>
        )}

        <div className="rco-report-meta">
          <span>
            Kỳ báo cáo:{' '}
            {from ? deliveryDate(from) : 'Từ đầu kỳ'}
            {' – '}
            {to ? deliveryDate(to) : 'Đến cuối kỳ'}
          </span>

          <span>
            Cập nhật: {runTime(overview.generated_at)}
          </span>

          <span>
            Chế độ: {
              mode === 'CAPSTONE'
                ? 'Capstone'
                : mode === 'SIMULATION'
                  ? 'Mô phỏng'
                  : 'Vận hành'
            }
          </span>
        </div>

        <div className="rco-report-kpis">
          {cards.map(card => (
            <article key={card.field}>
              <span>{card.label}</span>
              <strong>
                {displayNumber(
                  overview.kpis[card.field],
                  card.suffix
                )}
              </strong>
            </article>
          ))}
        </div>
      </section>

      <section className="rco-panel">
        <div className="rco-section-heading">
          <div>
            <h2>Chi tiết theo FinalPlan</h2>
            <p>
              Số liệu lấy từ các kế hoạch thuộc
              bộ lọc hiện tại.
            </p>
          </div>

          <span className="rco-count">
            {plans.length} phương án
          </span>
        </div>

        {plans.length === 0 ? (
          <div className="rco-empty">
            Chưa có dữ liệu báo cáo phù hợp.
          </div>
        ) : (
          <div className="rco-table-scroll">
            <table className="rco-table">
              <thead>
                <tr>
                  <th scope="col">FinalPlan</th>
                  <th scope="col">Ngày</th>
                  <th scope="col">Nhu cầu</th>
                  <th scope="col">Kế hoạch (kg)</th>
                  <th scope="col">Đã nhận (kg)</th>
                  <th scope="col">Chi phí thực tế</th>
                  <th scope="col">Trạng thái</th>
                </tr>
              </thead>

              <tbody>
                {plans.map(plan => (
                  <tr key={plan.code}>
                    <td>
                      <Link
                        to={
                          `${paths[audience]}/${plan.code}` +
                          `?mode=${encodeURIComponent(mode)}`
                        }
                      >
                        {planTitle(plan)}
                      </Link>
                      <small>{plan.code}</small>
                    </td>

                    <td>{deliveryDate(plan.date)}</td>
                    <td>{plan.demands}</td>
                    <td>
                      {displayNumber(plan.planned_kg)}
                    </td>
                    <td>
                      {displayNumber(plan.received_kg)}
                    </td>
                    <td>
                      {displayNumber(
                        plan.cost?.actual_vnd,
                        ' đ'
                      )}
                    </td>
                    <td>
                      {displayStatus(plan.status)}
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
