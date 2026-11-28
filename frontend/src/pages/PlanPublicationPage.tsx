import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  Link,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { deliveryDate, runTime } from '../components/dss/f1Display'
import { kg } from '../components/dss/f3Display'
import { ApiError } from '../services/api/client'
import { getPublication, listPublications } from '../services/api/planPublication'
import { useDssQuery } from '../services/dss/useDssQuery'
import { ExecutionPanel } from './ExecutionWorkspace'
import {
  hasEffectiveFinalPlan,
  publicationLabels,
  publicationPaths,
  type LogisticsStatus,
  type PublicationAudience as Audience,
  type PublicationEntity as Entity,
  type PublicationEvent,
  type PublicationIndex,
  type PublicationItem as Item,
  type PublicationRecipient,
  type PublicationRecipients,
  type PublishedPlan,
} from '../types/planPublication'
import './dss/DSSRunDetailPage.css'
import './dss/PlanDeliveryPage.css'
import './PlanPublicationPage.css'

export type { PublicationEvent, PublicationRecipients, PublishedPlan } from '../types/planPublication'

const stopLabels = {
  SUPPLIER_PICKUP: 'Lấy hàng',
  OUTLET_DELIVERY: 'Giao hàng',
  HUB_RECEIVE: 'Nhập hàng tại Hub',
  HUB_DISPATCH: 'Xuất hàng từ Hub',
}

const phaseLabels: Record<string, string> = {
  DIRECT: 'Giao trực tiếp',
  INBOUND: 'Supplier → Hub',
  OUTBOUND: 'Hub → Outlet',
}

const entity = (row: Entity) => [row.code, row.name].filter(Boolean).join(' · ') || '#' + row.id

function serviceTime(value: string | null, zone: string) {
  return value
    ? new Intl.DateTimeFormat('vi-VN', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : '—'
}

function scheduledWindow(start: string | null, end: string | null, timezone: string) {
  if (!start || !end) return 'Chưa có khung giờ'
  return `${serviceTime(start, timezone)}–${serviceTime(end, timezone)}`
}

function demandWindows(plan: PublishedPlan, demandId: number, audience: Audience) {
  const role = audience === 'supplier' ? 'SUPPLIER_PICKUP' : 'OUTLET_DELIVERY'
  return plan.waves.flatMap(wave =>
    wave.stops
      .filter(stop => stop.role === role && stop.loads.some(load => load.demand_id === demandId))
      .map(stop => ({
        key: `${wave.number}:${stop.sequence}`,
        time: scheduledWindow(stop.start, stop.end, plan.timezone),
      }))
  )
}

function statusTone(status: LogisticsStatus) {
  if (status === 'CONFIRMED') return 'green'
  if (status === 'DECLINED' || status === 'NEEDS_ADJUSTMENT') return 'red'
  return status === 'SUPERSEDED' ? 'neutral' : 'amber'
}

function eventDetailText(event: PublicationEvent): string {
  const raw = event as PublicationEvent & {
    note?: string | null
    reason?: string | null
    message?: string | null
    actor?: string | null
  }
  const extra = raw.reason || raw.note || raw.message
  const base = `${publicationLabels[event.kind]} cho kế hoạch ${event.code} (phiên bản ${event.version}) lúc ${runTime(event.at)}.`
  const actorPart = raw.actor ? ` · Thực hiện bởi: ${raw.actor}` : ''
  return extra ? `${base} ${extra}${actorPart}` : `${base}${actorPart}`
}


export function PublicationBadge({ status }: { status: LogisticsStatus }) {
  return (
    <span className="manager-badge" data-tone={statusTone(status)}>
      {publicationLabels[status]}
    </span>
  )
}

export function PublicationEvents({
  events,
  path,
  title = 'Thông báo kế hoạch',
}: {
  events: PublicationEvent[]
  path: string
  title?: string
}) {
  return (
    <section className="dssr-panel delivery-section publication-events" aria-label={title}>
      <div className="pub-events-header">
        <div>
          <h2>{title}</h2>
          <p className="pub-section-desc">
            Cập nhật trạng thái công bố, phản hồi vận chuyển và thay đổi phiên bản theo dữ liệu kế hoạch.
          </p>
        </div>
        <span className="supplier-dispatch-count">{events.length} thông báo</span>
      </div>

      {events.length ? (
        <ul className="pub-events-rich-list">
          {events.map(event => (
            <li key={event.id} className="pub-event-card" data-tone={statusTone(event.kind as LogisticsStatus)}>
              <div className="pub-event-card-top">
                <div className="pub-event-title-group">
                  <span className="supplier-dispatch-notice-dot" />
                  <strong className="pub-event-heading">{publicationLabels[event.kind]}</strong>
                  <span className="pub-event-code-tag">{event.code}</span>
                </div>
                <time className="pub-event-time" dateTime={event.at}>
                  {runTime(event.at)}
                </time>
              </div>

              <p className="pub-event-summary">{eventDetailText(event)}</p>

              <div className="pub-event-card-footer">
                <span className="pub-event-meta-text">Bản ghi #{event.id}</span>
                <Link className="pub-event-detail-link" to={path + '/' + event.code}>
                  Xem chi tiết kế hoạch →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pub-muted-note">Chưa có thông báo.</p>
      )}
    </section>
  )
}

function Items({ items }: { items: Item[] | null }) {
  if (items === null) return <p>Snapshot chưa ghi phân bổ SKU cho phần khối lượng này.</p>
  return (
    <div className="manager-table-scroll" tabIndex={0} aria-label="Bảng SKU">
      <table className="manager-table publication-items">
        <thead>
          <tr>
            <th scope="col">SKU</th>
            <th scope="col">Tên sản phẩm</th>
            <th scope="col">Khối lượng (kg)</th>
            <th scope="col">Đơn vị gốc</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id}>
              <th scope="row">{item.code ?? '#' + item.id}</th>
              <td>{item.name ?? '—'}</td>
              <td>{kg(item.weight_kg)}</td>
              <td>{item.unit ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PublicationSchedule({ plan, selected }: { plan: PublishedPlan; selected?: number }) {
  const demands = new Map(plan.demands.map(demand => [demand.id, demand]))
  const visibleWaves = plan.waves.filter(wave =>
    wave.stops.some(stop => !selected || stop.loads.some(row => row.demand_id === selected))
  )
  return (
    <div className="publication-schedule">
      {!visibleWaves.length && <p>Phiên bản này chưa có mốc lịch phù hợp.</p>}
      {visibleWaves.map(wave => (
        <section className="dssr-panel delivery-section pub-surface" key={wave.number}>
          <div className="pub-wave-head">
            <h3>
              Wave {wave.number} · {phaseLabels[wave.phase] ?? wave.phase}
            </h3>
            <span className="pub-wave-meta">
              {wave.vehicle.name} · {wave.vehicle.code}
              {wave.weight_kg && ' · ' + kg(wave.weight_kg)}
            </span>
          </div>
          <ol className="manager-timeline">
            {wave.stops.map(stop => {
              const loads = stop.loads.filter(row => !selected || row.demand_id === selected)
              if (!loads.length) return null
              const firstDemand = demands.get(loads[0].demand_id)
              const location =
                stop.role === 'SUPPLIER_PICKUP'
                  ? firstDemand?.supplier
                  : stop.role === 'OUTLET_DELIVERY'
                    ? firstDemand?.outlet
                    : plan.hub
              return (
                <li key={stop.sequence}>
                  <details open>
                    <summary>
                      {wave.weight_kg && `${stop.sequence}. `}
                      {stopLabels[stop.role]}
                      {location ? ' · ' + entity(location) : stop.code && ' · ' + stop.code}
                      <small>{scheduledWindow(stop.start, stop.end, plan.timezone)}</small>
                    </summary>
                    {stop.address && <p>{stop.address}</p>}
                    <dl className="publication-stop-times">
                      <div>
                        <dt>Giờ đến</dt>
                        <dd>{serviceTime(stop.arrival, plan.timezone)}</dd>
                      </div>
                      <div>
                        <dt>Thời gian chờ</dt>
                        <dd>
                          {stop.wait_minutes == null
                            ? '—'
                            : `${new Intl.NumberFormat('vi-VN').format(stop.wait_minutes)} phút`}
                        </dd>
                      </div>
                      <div>
                        <dt>Giờ phục vụ</dt>
                        <dd>{scheduledWindow(stop.start, stop.end, plan.timezone)}</dd>
                      </div>
                      <div>
                        <dt>Giờ rời điểm</dt>
                        <dd>{serviceTime(stop.departure, plan.timezone)}</dd>
                      </div>
                    </dl>
                    {loads.map(load => (
                      <div key={load.demand_id}>
                        <strong>
                          {demands.get(load.demand_id)?.code} · {kg(load.weight_kg)}
                        </strong>
                        <Items items={load.items} />
                      </div>
                    ))}
                  </details>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}

export function ManagerPublication({ publication }: { publication: PublicationRecipients }) {
  const accessLabels = {
    AVAILABLE: 'Có quyền xem bản công bố',
    AWAITING_PUBLICATION: 'Đủ quyền · Chờ công bố',
    NO_ACTIVE_SCOPE: 'Chưa có tài khoản đủ quyền',
    HISTORY_ONLY: 'Có quyền xem lịch sử',
  }
  const access = (party: PublicationRecipient) =>
    accessLabels[party.view_access] + (party.account_count ? ` · ${party.account_count} tài khoản` : '')
  return (
    <div className="publication-recipients">
      <h3>Công bố kế hoạch đa bên</h3>
      <PublicationBadge status={publication.status} />
      <p>CoLogi chưa theo dõi lượt đọc của từng tài khoản.</p>
      <dl className="manager-fields">
        <div>
          <dt>Đơn vị vận chuyển</dt>
          <dd>
            {entity(publication.provider)}
            <br />
            {access(publication.provider)}
          </dd>
        </div>
        {publication.suppliers.map(supplier => (
          <div key={supplier.id}>
            <dt>Nhà cung cấp</dt>
            <dd>
              {entity(supplier)}
              <br />
              {access(supplier)}
            </dd>
          </div>
        ))}
        {publication.outlets.map(outlet => (
          <div key={outlet.id}>
            <dt>Phạm vi mua hàng</dt>
            <dd>
              {entity(outlet)}
              <br />
              {access(outlet)}
              {outlet.purchasing_staff.length > 0 && (
                <>
                  <br />
                  {outlet.purchasing_staff.join(', ')}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <PublicationEvents events={publication.events} path="/dss/final-plans" title="Lịch sử công bố" />
    </div>
  )
}

function matches(value: string, search: string) {
  return value.toLocaleLowerCase('vi').includes(search.trim().toLocaleLowerCase('vi'))
}

export default function PlanPublicationPage({ audience }: { audience: Audience }) {
  const { code } = useParams()
  const [params] = useSearchParams()
  const [search, setSearch] = useState('')
  const [date, setDate] = useState('')
  const [state, setState] = useState('CURRENT')
  const [outlet, setOutlet] = useState('')
  const root = publicationPaths[audience]
  const title = audience === 'supplier' ? 'Lịch xuất hàng' : 'Lịch nhận hàng'
  const eyebrow =
    audience === 'supplier'
      ? 'SUPPLIER DISPATCH WORKSPACE'
      : audience === 'purchasing'
        ? 'PURCHASING RECEIPT WORKSPACE'
        : 'LOGISTICS SCHEDULE WORKSPACE'
  const subtitle =
    audience === 'supplier'
      ? 'Theo dõi lịch lấy hàng, khung giờ vận chuyển và trạng thái xác nhận từng nhu cầu.'
      : 'Theo dõi lịch giao nhận đã được công bố.'
  const loadIndex = useCallback(() => listPublications(audience), [audience])
  const loadDetail = useCallback(() => getPublication(audience, code ?? ''), [audience, code])

  return code ? (
    <PublicationDetail
      load={loadDetail}
      root={root}
      title={title}
      audience={audience}
      selected={Number(params.get('demand')) || undefined}
    />
  ) : (
    <main
      className={`dssr-page delivery-page manager-workspace plan-publication ${
        audience === 'purchasing'
          ? 'purchasing-receipt-page'
          : ''
      }`}
    >
      <header className="manager-heading publication-hero">
        <div>
          {audience === 'supplier' && (
            <p className="publication-eyebrow">{eyebrow}</p>
          )}
          <h1>{title}</h1>
          <p className="publication-subtitle">{subtitle}</p>
        </div>
      </header>

      <PublicationList
        load={loadIndex}
        root={root}
        audience={audience}
        search={search}
        date={date}
        state={state}
        outlet={outlet}
        setSearch={setSearch}
        setDate={setDate}
        setState={setState}
        setOutlet={setOutlet}
      />
    </main>
  )
}

function LoadError({ error, reload }: { error: unknown; reload: () => void }) {
  const status = error instanceof ApiError ? error.status : null
  return (
    <div className="dssr-alert" role="alert">
      {status === 404
        ? 'Không tìm thấy kế hoạch đã công bố trong phạm vi được cấp.'
        : status === 403
          ? 'Tài khoản chưa có quyền xem lịch này.'
          : status === 401
            ? 'Phiên đăng nhập đã hết hạn.'
            : 'Không tải được dữ liệu kế hoạch.'}
      <button type="button" className="dssr-secondary-button" onClick={reload}>
        Thử lại
      </button>
    </div>
  )
}

type ListProps = {
  load: () => Promise<PublicationIndex>
  audience: Audience
  root: string
  search: string
  date: string
  state: string
  outlet: string
  setSearch: (value: string) => void
  setDate: (value: string) => void
  setState: (value: string) => void
  setOutlet: (value: string) => void
}

function SummaryCards({
  upcoming,
  awaiting,
  confirmed,
  activeDemandCount,
  isSupplier,
}: {
  upcoming: number
  awaiting: number
  confirmed: number
  activeDemandCount: number
  isSupplier: boolean
}) {
  return (
    <section className="supplier-dispatch-summary" aria-label="Tổng quan lịch đã công bố">
      <div className="pub-kpi pub-kpi--primary">
        <div className="pub-kpi-head">
          <span>{isSupplier ? 'Lịch sắp tới' : 'FinalPlan sắp tới'}</span>
          <em>Sắp diễn ra</em>
        </div>
        <strong>{upcoming}</strong>
        <small>Kế hoạch trong kỳ sắp tới</small>
      </div>

      <div className="pub-kpi pub-kpi--amber">
        <div className="pub-kpi-head">
          <span>Chờ vận chuyển xác nhận</span>
          <em>Đang chờ</em>
        </div>
        <strong>{awaiting}</strong>
        <small>Chưa được vận chuyển xác nhận</small>
      </div>

      <div className="pub-kpi pub-kpi--teal">
        <div className="pub-kpi-head">
          <span>{isSupplier ? 'Đã xác nhận lịch' : 'FinalPlan đã xác nhận'}</span>
          <em>Hiệu lực</em>
        </div>
        <strong>{confirmed}</strong>
        <small>Đã được xác nhận lịch</small>
      </div>

      <div className="pub-kpi pub-kpi--blue">
        <div className="pub-kpi-head">
          <span>{isSupplier ? 'Nhu cầu có lịch hiệu lực' : 'Demand có FinalPlan hiệu lực'}</span>
          <em>Demand</em>
        </div>
        <strong>{activeDemandCount}</strong>
        <small>Nhu cầu thuộc kế hoạch hiệu lực</small>
      </div>
    </section>
  )
}

function SupplierPublicationContent({
  data,
  root,
  search,
  date,
  state,
  setSearch,
  setDate,
  setState,
  reload,
}: {
  data: PublicationIndex
  root: string
  search: string
  date: string
  state: string
  setSearch: (value: string) => void
  setDate: (value: string) => void
  setState: (value: string) => void
  reload: () => void
}) {
  const { plans, summary, events } = data

  const activeDemandCount =
    summary.active_demand_count ??
    new Set(
      plans
        .filter(plan => hasEffectiveFinalPlan(plan.status))
        .flatMap(plan => plan.demands.map(demand => demand.id))
    ).size

  const schedules = plans
    .filter(
      plan =>
        (!date || plan.service_date === date) &&
        (state === 'ALL' || (state === 'CURRENT' ? plan.status !== 'SUPERSEDED' : plan.status === state))
    )
    .flatMap(plan =>
      plan.demands
        .filter(demand =>
          matches(
            [plan.code, demand.code, entity(demand.supplier), entity(demand.outlet)].join(' '),
            search
          )
        )
        .map(demand => ({
          plan,
          demand,
          windows: demandWindows(plan, demand.id, 'supplier'),
        }))
    )
    .sort(
      (a, b) =>
        a.plan.service_date.localeCompare(b.plan.service_date) ||
        a.demand.code.localeCompare(b.demand.code, 'vi')
    )

  const hasFilters = Boolean(search || date || state !== 'CURRENT')

  return (
    <div className="supplier-dispatch">
      <SummaryCards
        upcoming={summary.upcoming}
        awaiting={summary.awaiting}
        confirmed={summary.confirmed}
        activeDemandCount={activeDemandCount}
        isSupplier
      />

      {events.length > 0 && (
        <PublicationEvents
          events={[...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)}
          path={root}
          title="Cập nhật kế hoạch gần đây"
        />
      )}

      <section className="dssr-panel supplier-dispatch-panel pub-surface">
        <div className="supplier-dispatch-section-head">
          <div>
            <h2>Danh sách lịch xuất hàng</h2>
            <p className="pub-section-desc">
              Theo dõi thời gian lấy hàng, Outlet nhận và trạng thái xác nhận lịch.
            </p>
          </div>

          <button type="button" className="dssr-secondary-button pub-refresh-btn" onClick={reload}>
            ↻ Làm mới
          </button>
        </div>

        <div className="supplier-dispatch-filters">
          <label>
            Tìm kiếm
            <input
              type="search"
              placeholder="Mã Demand, FinalPlan hoặc Outlet"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
          </label>

          <label>
            Ngày thực hiện
            <input type="date" value={date} onChange={event => setDate(event.target.value)} />
          </label>

          <label>
            Trạng thái lịch
            <select value={state} onChange={event => setState(event.target.value)}>
              <option value="CURRENT">Phiên bản hiện hành</option>
              <option value="ALL">Tất cả phiên bản</option>
              <option value="AWAITING_TRANSPORT">Chờ vận chuyển xác nhận</option>
              <option value="CONFIRMED">Đã xác nhận</option>
              <option value="DECLINED">Đã từ chối</option>
              <option value="SUPERSEDED">Phiên bản cũ</option>
            </select>
          </label>
        </div>

        <div className="supplier-dispatch-results">
          <span>
            Hiển thị <strong>{schedules.length}</strong> lịch theo bộ lọc
          </span>

          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setSearch('')
                setDate('')
                setState('CURRENT')
              }}
            >
              Xóa bộ lọc
            </button>
          )}
        </div>

        {schedules.length === 0 ? (
          <div className="supplier-dispatch-empty">
            <strong>Không có lịch xuất hàng phù hợp</strong>
            <p>
              {plans.length === 0
                ? 'Chưa có kế hoạch được công bố trong phạm vi tài khoản.'
                : 'Hãy thay đổi ngày, trạng thái hoặc từ khóa tìm kiếm.'}
            </p>
          </div>
        ) : (
          <div className="pub-schedule-table-list">
            {schedules.map(({ plan, demand, windows }) => (
              <div className="pub-schedule-row" key={`${plan.code}:${demand.id}`}>
                <div className="pub-schedule-col">
                  <Link className="pub-row-code" to={`${root}/${plan.code}?demand=${demand.id}`}>
                    {demand.code}
                  </Link>
                  <span className="pub-row-sub">Ngày lấy: {deliveryDate(plan.service_date)}</span>
                </div>

                <div className="pub-schedule-col">
                  <strong className="pub-row-primary">{entity(demand.outlet)}</strong>
                  <span className="pub-row-sub">Outlet nhận hàng</span>
                </div>

                <div className="pub-schedule-col">
                  <strong className="pub-row-weight">{kg(demand.weight_kg)}</strong>
                  <span className="pub-row-sub">
                    {windows.length ? `Khung giờ ${windows.map(w => w.time).join(', ')}` : 'Chưa có khung giờ'}
                  </span>
                </div>

                <div className="pub-schedule-col-status">
                  <PublicationBadge status={plan.status} />
                  <Link className="pub-row-action" to={`${root}/${plan.code}?demand=${demand.id}`}>
                    Chi tiết →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function PublicationList({
  load,
  audience,
  root,
  search,
  date,
  state,
  outlet,
  setSearch,
  setDate,
  setState,
  setOutlet,
}: ListProps) {
  const result = useDssQuery(load)

  const [selectedReceipt, setSelectedReceipt] =
    useState<{
      planCode: string
      demandId: number
    } | null>(null)

  const [page, setPage] = useState(1)
  const pageSize = 10
  if (result.loading) {
    return <p role="status">Đang tải lịch…</p>
  }

  if (result.error != null) {
    return (
      <LoadError
        error={result.error}
        reload={result.reload}
      />
    )
  }

  if (!result.data) return null

  // GIỮ NGUYÊN GIAO DIỆN SUPPLIER

  if (audience === 'supplier') {
    return (
      <SupplierPublicationContent
        data={result.data}
        root={root}
        search={search}
        date={date}
        state={state}
        setSearch={setSearch}
        setDate={setDate}
        setState={setState}
        reload={result.reload}
      />
    )
  }

  // PURCHASING - LỊCH NHẬN HÀNG

  const plans = result.data.plans.filter(
    plan =>
      plan.status === 'CONFIRMED' &&
      Boolean(plan.published_at)
  )

  const outlets = new Map(
    plans.flatMap(plan =>
      plan.demands.map(demand => [
        String(demand.outlet.id),
        demand.outlet,
      ] as const)
    )
  )

  const rows = plans
    .filter(plan =>
      !date || plan.service_date === date
    )
    .flatMap(plan =>
      plan.demands
        .filter(demand =>
          (!outlet ||
            String(demand.outlet.id) === outlet) &&
          matches(
            [
              plan.code,
              demand.code,
              entity(demand.supplier),
              entity(demand.outlet),
            ].join(' '),
            search
          )
        )
        .map(demand => ({
          plan,
          demand,
          windows: demandWindows(
            plan,
            demand.id,
            audience
          ),
        }))
    )
    .sort(
      (a, b) =>
        a.plan.service_date.localeCompare(
          b.plan.service_date
        ) ||
        a.demand.code.localeCompare(
          b.demand.code,
          'vi'
        )
    )

  // PHÂN TRANG

  const totalPages = Math.max(
    1,
    Math.ceil(rows.length / pageSize)
  )

  const currentPage = Math.min(page, totalPages)

  const startIndex =
    (currentPage - 1) * pageSize

  const visibleRows = rows.slice(
    startIndex,
    startIndex + pageSize
  )

  const hasFilters = Boolean(
    search || date || outlet
  )

  return (
    <div className="pr-receipt-workspace">

      <section className="pr-receipt-panel">

        {/* TIÊU ĐỀ DANH SÁCH */}

        <header className="pr-receipt-heading">

          <h2>Danh sách lịch nhận hàng</h2>

          <button
            type="button"
            className="pr-receipt-refresh"
            title="Làm mới danh sách"
            aria-label="Làm mới danh sách"
            onClick={() => {
              setPage(1)
              result.reload()
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 11a8 8 0 10-2 6" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>

        </header>

        {/* BỘ LỌC */}

        <div className="pr-receipt-filters">

          <label className="pr-receipt-search">

            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="M16 16l4 4" />
            </svg>

            <input
              type="search"
              aria-label="Tìm kiếm nhu cầu"
              placeholder="Tìm kiếm nhu cầu..."
              value={search}
              onChange={event => {
                setSearch(event.target.value)
                setPage(1)
              }}
            />

          </label>

          <label className="pr-receipt-date">

            {!date && (
              <span>Ngày nhận</span>
            )}

            <input
              type="date"
              aria-label="Ngày nhận hàng"
              value={date}
              data-empty={!date}
              onChange={event => {
                setDate(event.target.value)
                setPage(1)
              }}
            />

          </label>

          <label className="pr-receipt-outlet">

            <select
              aria-label="Điểm nhận hàng"
              value={outlet}
              onChange={event => {
                setOutlet(event.target.value)
                setPage(1)
              }}
            >
              <option value="">
                Điểm nhận
              </option>

              {[...outlets].map(([id, row]) => (
                <option key={id} value={id}>
                  {entity(row)}
                </option>
              ))}

            </select>

            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>

          </label>

        </div>

        {/* XÓA BỘ LỌC */}

        {hasFilters && (
          <div className="pr-receipt-clear-wrap">

            <button
              type="button"
              className="pr-receipt-clear"
              onClick={() => {
                setSearch('')
                setDate('')
                setOutlet('')
                setPage(1)
              }}
            >
              Xóa bộ lọc
            </button>

          </div>
        )}

        {/* BẢNG LỊCH NHẬN HÀNG */}

        <div className="pr-receipt-table-wrap">

          <table className="pr-receipt-table">

            <thead>
              <tr>
                <th scope="col">Mã nhu cầu</th>
                <th scope="col">Ngày nhận</th>
                <th scope="col">Nhà cung cấp</th>
                <th scope="col">Điểm nhận</th>
                <th scope="col">Khối lượng</th>
                <th scope="col">Khung giờ nhận</th>
              </tr>
            </thead>

            <tbody>

              {visibleRows.map(
                ({ plan, demand, windows }) => {

                  const openReceipt = () => {
                    setSelectedReceipt({
                      planCode: plan.code,
                      demandId: demand.id,
                    })
                  }

                  return (
                    <tr
                      key={`${plan.code}:${demand.id}`}
                      className="pr-receipt-row"
                      data-selected={
                        selectedReceipt?.planCode === plan.code &&
                        selectedReceipt?.demandId === demand.id
                      }
                      onClick={openReceipt}
                    >
                      <td>
                        <button
                          type="button"
                          className="pr-receipt-demand-code"
                          aria-haspopup="dialog"
                          aria-label={`Xem chi tiết ${demand.code}`}
                          onClick={event => {
                            event.stopPropagation()
                            openReceipt()
                          }}
                        >
                          {demand.code}
                        </button>
                      </td>

                      <td>
                        {deliveryDate(plan.service_date)}
                      </td>

                      <td
                        title={entity(demand.supplier)}
                      >
                        {demand.supplier.code ||
                          entity(demand.supplier)}
                      </td>

                      <td
                        title={entity(demand.outlet)}
                      >
                        {demand.outlet.code ||
                          entity(demand.outlet)}
                      </td>

                      <td className="pr-receipt-weight">
                        {kg(demand.weight_kg)}
                      </td>

                      <td className="pr-receipt-window">
                        {windows.length
                          ? windows
                              .map(window => window.time)
                              .join(', ')
                          : 'Chưa có khung giờ'}
                      </td>

                    </tr>
                  )
                }
              )}

              {!visibleRows.length && (

                <tr>
                  <td colSpan={6}>

                    <div className="pr-receipt-empty">

                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect
                          x="3"
                          y="5"
                          width="18"
                          height="16"
                          rx="2"
                        />
                        <path d="M16 3v4M8 3v4M3 10h18" />
                      </svg>

                      <strong>
                        {plans.length
                          ? 'Không tìm thấy lịch phù hợp'
                          : 'Chưa có lịch nhận hàng'}
                      </strong>

                      <p>
                        {plans.length
                          ? 'Hãy thay đổi bộ lọc hoặc từ khóa tìm kiếm.'
                          : 'Lịch nhận hàng sẽ hiển thị khi kế hoạch đã được bàn giao và vận chuyển xác nhận.'}
                      </p>

                    </div>

                  </td>
                </tr>

              )}

            </tbody>

          </table>

        </div>

        {/* PHÂN TRANG */}

        <footer className="pr-receipt-pagination">

          <span>
            {rows.length
              ? `Hiển thị ${startIndex + 1}–${Math.min(
                  startIndex + pageSize,
                  rows.length
                )} trong ${rows.length} lịch nhận hàng`
              : 'Hiển thị 0 lịch nhận hàng'}
          </span>

          <div className="pr-receipt-pagination-actions">

            <button
              type="button"
              aria-label="Trang trước"
              disabled={currentPage <= 1}
              onClick={() => {
                setPage(currentPage - 1)
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>

            <span className="pr-receipt-current-page">
              {currentPage}
            </span>

            <button
              type="button"
              aria-label="Trang sau"
              disabled={currentPage >= totalPages}
              onClick={() => {
                setPage(currentPage + 1)
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>

          </div>

        </footer>

      </section>

      {selectedReceipt && (
        <ReceiptDetailDrawer
          key={`${selectedReceipt.planCode}:${selectedReceipt.demandId}`}
          planCode={selectedReceipt.planCode}
          demandId={selectedReceipt.demandId}
          onClose={() => setSelectedReceipt(null)}
        />
      )}

    </div>
  )
}


function ReceiptDetailDrawer({
  planCode,
  demandId,
  onClose,
}: {
  planCode: string
  demandId: number
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  const [activeTab, setActiveTab] =
    useState<'overview' | 'schedule' | 'execution'>(
      'overview'
    )

  const load = useCallback(
    () => getPublication('purchasing', planCode),
    [planCode]
  )

  const result = useDssQuery(load)
  const plan = result.data

  const demand = plan?.demands.find(
    row => row.id === demandId
  )

  const eligible =
    plan?.status === 'CONFIRMED' &&
    Boolean(plan.published_at) &&
    Boolean(demand)

  const windows =
    plan && demand
      ? demandWindows(plan, demand.id, 'purchasing')
      : []

  const waves =
    plan?.waves.filter(wave =>
      wave.stops.some(stop =>
        stop.loads.some(
          load => load.demand_id === demandId
        )
      )
    ) ?? []

  const receivingStops = waves.flatMap(wave =>
    wave.stops.filter(stop =>
      stop.role === 'OUTLET_DELIVERY' &&
      stop.loads.some(
        load => load.demand_id === demandId
      )
    )
  )

  const addresses = [
    ...new Set(
      receivingStops
        .map(stop => stop.address)
        .filter(Boolean)
    ),
  ]

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const previousOverflow =
      document.body.style.overflow

    if (!dialog.open) {
      dialog.showModal()
    }

    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow =
        previousOverflow

      if (dialog.open) {
        dialog.close()
      }
    }
  }, [])

  function closeDrawer() {
    dialogRef.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="pr-receipt-drawer"
      aria-labelledby="pr-drawer-title"
      onCancel={event => {
        event.preventDefault()
        closeDrawer()
      }}
      onClick={event => {
        if (event.target === event.currentTarget) {
          closeDrawer()
        }
      }}
    >
      <div className="pr-drawer-layout">

        {/* HEADER */}

        <header className="pr-drawer-header">

          <div className="pr-drawer-heading">

            <div>
              <p className="pr-drawer-eyebrow">
                CHI TIẾT LỊCH NHẬN HÀNG
              </p>

              <h2 id="pr-drawer-title">
                {eligible && demand
                  ? demand.code
                  : 'Lịch nhận hàng'}
              </h2>

              {eligible && (
                <span className="pr-drawer-confirmed">

                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="m8 12 3 3 5-6" />
                  </svg>

                  Vận chuyển đã xác nhận
                </span>
              )}
            </div>

            <button
              type="button"
              className="pr-drawer-close"
              aria-label="Đóng chi tiết"
              autoFocus
              onClick={closeDrawer}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>

          </div>

          {eligible && plan && (
            <div className="pr-drawer-publication-time">

              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>

              <span>
                Công bố:{' '}
                {plan.published_at
                  ? runTime(plan.published_at)
                  : '—'}
              </span>

            </div>
          )}

        </header>

        {/* BODY */}

        <div className="pr-drawer-body">

          {result.loading && (
            <p role="status">
              Đang tải chi tiết lịch nhận hàng…
            </p>
          )}

          {result.error != null && (
            <LoadError
              error={result.error}
              reload={result.reload}
            />
          )}

          {!result.loading &&
            result.error == null &&
            !eligible && (
              <div className="pr-drawer-empty">
                Lịch nhận hàng không còn khả dụng
                hoặc chưa được vận chuyển xác nhận.
              </div>
            )}

          {!result.loading &&
            result.error == null &&
            eligible &&
            plan &&
            demand && (

            <>

              {/* THÔNG TIN NỔI BẬT */}

              <section className="pr-drawer-highlight">

                <div className="pr-drawer-highlight-top">

                  <div>
                    <small>Ngày nhận dự kiến</small>
                    <strong>
                      {deliveryDate(plan.service_date)}
                    </strong>
                  </div>

                  <div>
                    <small>Khung giờ nhận</small>
                    <strong className="pr-drawer-time">
                      {windows.length
                        ? windows
                            .map(window => window.time)
                            .join(', ')
                        : 'Chưa có khung giờ'}
                    </strong>
                  </div>

                </div>

                <div className="pr-drawer-highlight-bottom">

                  <div>
                    <small>Khối lượng</small>
                    <strong>{kg(demand.weight_kg)}</strong>
                  </div>

                  <div>
                    <small>Sản phẩm</small>
                    <strong>
                      {demand.items.length} SKU
                    </strong>
                  </div>

                  <div>
                    <small>Chuyến vận chuyển</small>
                    <strong>{waves.length} Wave</strong>
                  </div>

                </div>

              </section>

              {/* BA TAB CHỨC NĂNG */}

              <div
                className="pr-drawer-tabs"
                role="group"
                aria-label="Thông tin lịch nhận hàng"
              >

                <button
                  type="button"
                  aria-pressed={activeTab === 'overview'}
                  onClick={() => setActiveTab('overview')}
                >
                  Tổng quan
                </button>

                <button
                  type="button"
                  aria-pressed={activeTab === 'schedule'}
                  onClick={() => setActiveTab('schedule')}
                >
                  Lịch trình
                </button>

                <button
                  type="button"
                  aria-pressed={activeTab === 'execution'}
                  onClick={() => setActiveTab('execution')}
                >
                  Giao nhận
                </button>

              </div>

              {/* TAB TỔNG QUAN */}

              {activeTab === 'overview' && (

                <>

                  <section className="pr-drawer-section">

                    <h3>Thông tin giao nhận</h3>

                    <div className="pr-drawer-route">

                      <div className="pr-route-point">

                        <div className="pr-route-icon">
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            aria-hidden="true"
                          >
                            <path d="m3 9 9-6 9 6v12H3z" />
                            <path d="M8 21v-8h8v8" />
                          </svg>
                        </div>

                        <div>
                          <small>Nhà cung cấp</small>
                          <strong>
                            {demand.supplier.code ||
                              entity(demand.supplier)}
                          </strong>
                          <p>{demand.supplier.name}</p>
                        </div>

                      </div>

                      <div className="pr-route-connector" />

                      {plan.hub && (
                        <>
                          <div className="pr-route-point">

                            <div className="pr-route-icon">
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.7"
                                aria-hidden="true"
                              >
                                <rect
                                  x="3"
                                  y="4"
                                  width="18"
                                  height="16"
                                  rx="2"
                                />
                                <path d="M3 10h18M9 10v10M15 10v10" />
                              </svg>
                            </div>

                            <div>
                              <small>Điểm trung chuyển</small>
                              <strong>{entity(plan.hub)}</strong>
                            </div>

                          </div>

                          <div className="pr-route-connector" />
                        </>
                      )}

                      <div className="pr-route-point">

                        <div className="pr-route-icon pr-route-icon--outlet">
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            aria-hidden="true"
                          >
                            <path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z" />
                            <circle cx="12" cy="10" r="2.5" />
                          </svg>
                        </div>

                        <div>
                          <small>Điểm nhận hàng</small>

                          <strong>
                            {demand.outlet.code ||
                              entity(demand.outlet)}
                          </strong>

                          <p>{demand.outlet.name}</p>

                          {addresses.map(address => (
                            <p key={address}>
                              {address}
                            </p>
                          ))}
                        </div>

                      </div>

                      <dl className="pr-route-meta">

                        <div>
                          <dt>Đơn vị vận chuyển</dt>
                          <dd>{entity(plan.provider)}</dd>
                        </div>

                        <div>
                          <dt>Phương thức vận chuyển</dt>
                          <dd>
                            {plan.hub
                              ? 'Qua điểm trung chuyển'
                              : 'Giao trực tiếp'}
                          </dd>
                        </div>

                      </dl>

                    </div>

                  </section>

                  {/* WAVE */}

                  <section className="pr-drawer-section">

                    <div className="pr-drawer-section-heading">
                      <h3>Chuyến vận chuyển</h3>
                      <small>{waves.length} Wave</small>
                    </div>

                    {waves.map(wave => (

                      <article
                        className="pr-drawer-wave"
                        key={wave.number}
                      >

                        <div className="pr-wave-header">

                          <div className="pr-wave-icon">
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              aria-hidden="true"
                            >
                              <path d="M1 4h14v13H1zM15 9h4l4 4v4h-8z" />
                              <circle cx="5.5" cy="18" r="2.5" />
                              <circle cx="18.5" cy="18" r="2.5" />
                            </svg>
                          </div>

                          <div className="pr-wave-description">
                            <strong>Wave {wave.number}</strong>
                            <small>
                              {wave.vehicle.code}
                              {' · '}
                              {phaseLabels[wave.phase] ||
                                wave.phase}
                            </small>
                          </div>

                        </div>

                        {wave.stops
                          .filter(stop =>
                            stop.role === 'OUTLET_DELIVERY' &&
                            stop.loads.some(
                              load => load.demand_id === demandId
                            )
                          )
                          .map(stop => (

                            <div
                              className="pr-wave-receipt"
                              key={stop.sequence}
                            >

                              <div>
                                <small>Điểm dừng</small>
                                <strong>
                                  {stop.code ||
                                    demand.outlet.code ||
                                    entity(demand.outlet)}
                                </strong>
                              </div>

                              <div>
                                <small>Dự kiến đến</small>
                                <strong>
                                  {serviceTime(
                                    stop.arrival,
                                    plan.timezone
                                  )}
                                </strong>
                              </div>

                              <div>
                                <small>Giờ nhận</small>
                                <strong>
                                  {scheduledWindow(
                                    stop.start,
                                    stop.end,
                                    plan.timezone
                                  )}
                                </strong>
                              </div>

                            </div>
                          ))}

                      </article>
                    ))}

                    {!waves.length && (
                      <p className="pr-drawer-empty">
                        Chưa có chuyến phù hợp.
                      </p>
                    )}

                    <button
                      type="button"
                      className="pr-wave-view"
                      onClick={() => setActiveTab('schedule')}
                    >
                      Xem lịch trình chi tiết →
                    </button>

                  </section>

                  {/* DANH SÁCH SKU */}

                  <section className="pr-drawer-section">

                    <div className="pr-drawer-section-heading">
                      <h3>Danh sách hàng cần nhận</h3>
                      <small>
                        {demand.items.length} SKU
                      </small>
                    </div>

                    <div className="pr-drawer-items-wrap">

                      <table className="pr-drawer-items">

                        <thead>
                          <tr>
                            <th scope="col">SKU</th>
                            <th scope="col">Sản phẩm</th>
                            <th scope="col">Khối lượng</th>
                          </tr>
                        </thead>

                        <tbody>

                          {demand.items.map(item => (
                            <tr key={item.id}>

                              <td>
                                <strong>
                                  {item.code ||
                                    `#${item.id}`}
                                </strong>
                              </td>

                              <td>
                                {item.name || '—'}
                                {item.unit && (
                                  <small>
                                    Đơn vị gốc: {item.unit}
                                  </small>
                                )}
                              </td>

                              <td>
                                {kg(item.weight_kg)}
                              </td>

                            </tr>
                          ))}

                          {!demand.items.length && (
                            <tr>
                              <td colSpan={3}>
                                Chưa có thông tin SKU.
                              </td>
                            </tr>
                          )}

                        </tbody>

                        <tfoot>
                          <tr>
                            <td colSpan={2}>
                              Tổng khối lượng nhu cầu
                            </td>
                            <td>
                              {kg(demand.weight_kg)}
                            </td>
                          </tr>
                        </tfoot>

                      </table>

                    </div>

                  </section>

                </>

              )}

              {/* TAB LỊCH TRÌNH */}

              {activeTab === 'schedule' && (

                <section className="pr-drawer-section">

                  <div className="pr-drawer-section-heading">
                    <h3>Lịch trình vận chuyển</h3>
                    <small>{waves.length} Wave</small>
                  </div>

                  {waves.map(wave => (

                    <article
                      className="pr-drawer-wave"
                      key={wave.number}
                    >

                      <div className="pr-wave-heading-simple">

                        <strong>
                          Wave {wave.number}
                          {' · '}
                          {phaseLabels[wave.phase] ||
                            wave.phase}
                        </strong>

                        <small>
                          {wave.vehicle.code}
                          {' · '}
                          {wave.vehicle.name}
                        </small>

                      </div>

                      <ol className="pr-wave-timeline">

                        {wave.stops.map(stop => {

                          const loads = stop.loads.filter(
                            load => load.demand_id === demandId
                          )

                          const isReceiving =
                            stop.role === 'OUTLET_DELIVERY' &&
                            loads.length > 0

                          return (
                            <li
                              key={stop.sequence}
                              data-receiving={isReceiving}
                            >

                              <span className="pr-wave-dot" />

                              <div className="pr-wave-stop">

                                <strong>
                                  {stopLabels[stop.role]}
                                  {stop.code
                                    ? ' · ' + stop.code
                                    : ''}
                                </strong>

                                {isReceiving && (
                                  <span className="pr-wave-target">
                                    Điểm nhận của nhu cầu đang xem
                                  </span>
                                )}

                                {stop.address && (
                                  <p>{stop.address}</p>
                                )}

                                <div className="pr-wave-time-grid">

                                  <div>
                                    <small>Dự kiến đến</small>
                                    <strong>
                                      {serviceTime(
                                        stop.arrival,
                                        plan.timezone
                                      )}
                                    </strong>
                                  </div>

                                  <div>
                                    <small>Thời gian chờ</small>
                                    <strong>
                                      {stop.wait_minutes == null
                                        ? '—'
                                        : `${stop.wait_minutes} phút`}
                                    </strong>
                                  </div>

                                  <div>
                                    <small>Phục vụ</small>
                                    <strong>
                                      {scheduledWindow(
                                        stop.start,
                                        stop.end,
                                        plan.timezone
                                      )}
                                    </strong>
                                  </div>

                                  <div>
                                    <small>Rời điểm</small>
                                    <strong>
                                      {serviceTime(
                                        stop.departure,
                                        plan.timezone
                                      )}
                                    </strong>
                                  </div>

                                </div>

                                {loads.map((load, index) => (

                                  <details
                                    className="pr-wave-load"
                                    key={index}
                                    open={isReceiving}
                                  >

                                    <summary>
                                      Hàng phân bổ ·{' '}
                                      {kg(load.weight_kg)}
                                    </summary>

                                    {load.items?.length ? (

                                      <ul className="pr-wave-items">

                                        {load.items.map(item => (
                                          <li key={item.id}>
                                            <span>
                                              {item.code}
                                              {' · '}
                                              {item.name}
                                            </span>

                                            <strong>
                                              {kg(item.weight_kg)}
                                            </strong>
                                          </li>
                                        ))}

                                      </ul>

                                    ) : (
                                      <p>
                                        Chưa có thông tin
                                        phân bổ SKU.
                                      </p>
                                    )}

                                  </details>
                                ))}

                              </div>

                            </li>
                          )
                        })}

                      </ol>

                    </article>

                  ))}

                  {!waves.length && (
                    <div className="pr-drawer-empty">
                      Chưa có lịch trình phù hợp.
                    </div>
                  )}

                </section>

              )}

              {/* TAB GIAO NHẬN */}

              <section
                className="pr-drawer-execution"
                hidden={activeTab !== 'execution'}
              >
                <ExecutionPanel
                  audience="purchasing"
                  code={plan.code}
                  selected={demand.id}
                />
              </section>

            </>

          )}

        </div>

        {/* FOOTER */}

        <footer className="pr-drawer-footer">

          <button
            type="button"
            className="pr-drawer-cancel"
            onClick={closeDrawer}
          >
            Đóng
          </button>

          {!result.loading &&
            result.error == null &&
            eligible &&
            activeTab !== 'execution' && (

              <button
                type="button"
                className="pr-drawer-primary"
                onClick={() => setActiveTab('execution')}
              >
                Thực hiện giao nhận →
              </button>

            )}

        </footer>

      </div>
    </dialog>
  )
}


function PublicationDetail({
  load,
  root,
  title,
  audience,
  selected,
}: {
  load: () => Promise<PublishedPlan>
  root: string
  title: string
  audience: Audience
  selected?: number
}) {

  const result = useDssQuery(load)
  const plan = result.data
  const selection = plan?.demands.find(demand => demand.id === selected)
  const demands = selection ? [selection] : plan?.demands ?? []

  return (
    <main className="dssr-page delivery-page manager-workspace plan-publication">
      <header className="manager-heading publication-hero publication-detail-head">
        <div>
          <Link className="pub-back-link" to={root}>
            ← Quay lại {title}
          </Link>
          <p className="publication-eyebrow">CHI TIẾT KẾ HOẠCH CÔNG BỐ</p>
          <h1>{plan ? (selection ? `${selection.code} · ${title}` : `${title} · ${plan.code}`) : title}</h1>
          {plan && <p className="publication-code">Mã kế hoạch: {plan.code}</p>}
        </div>
        {plan && <PublicationBadge status={plan.status} />}
      </header>

      {result.loading && <p role="status">Đang tải phiên bản kế hoạch…</p>}
      {result.error != null && <LoadError error={result.error} reload={result.reload} />}

      {plan && (
        <>
          <section className="dssr-panel delivery-section pub-surface">
            <div className="manager-row">
              <div>
                <h2>Thông tin công bố</h2>
                <p className="pub-section-desc">
                  Thông tin phiên bản kế hoạch, đơn vị vận hành và mốc thời gian từ hệ thống.
                </p>
              </div>
              <button type="button" className="dssr-secondary-button pub-refresh-btn" onClick={result.reload}>
                ↻ Làm mới
              </button>
            </div>

            <dl className="pub-info-grid">
              <div className="pub-info-cell">
                <dt>Ngày dịch vụ</dt>
                <dd>
                  {deliveryDate(plan.service_date)} · {plan.timezone}
                </dd>
              </div>
              <div className="pub-info-cell">
                <dt>Đơn vị vận chuyển</dt>
                <dd>{entity(plan.provider)}</dd>
              </div>
              {plan.hub && (
                <div className="pub-info-cell">
                  <dt>Điểm trung chuyển</dt>
                  <dd>{entity(plan.hub)}</dd>
                </div>
              )}
              <div className="pub-info-cell">
                <dt>Thời điểm công bố</dt>
                <dd>{plan.published_at ? runTime(plan.published_at) : '—'}</dd>
              </div>
              {plan.responded_at && (
                <div className="pub-info-cell">
                  <dt>Phản hồi vận chuyển</dt>
                  <dd>{runTime(plan.responded_at)}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="dssr-panel delivery-section pub-surface">
            <div className="pub-section-head-simple">
              <h2>Nhu cầu và SKU</h2>
              <p className="pub-section-desc">
                Danh sách nhu cầu, tuyến cung ứng – điểm nhận và phân bổ sản phẩm chi tiết.
              </p>
            </div>
            {demands.map(demand => (
              <details open key={demand.id} className="pub-demand-box">
                <summary>
                  <span>{demand.code}</span>
                  <strong>{kg(demand.weight_kg)}</strong>
                </summary>
                <p className="pub-route-line">
                  {entity(demand.supplier)} → {entity(demand.outlet)}
                </p>
                <Items items={demand.items} />
              </details>
            ))}
          </section>

          <PublicationSchedule plan={plan} selected={selection?.id} />
          <ExecutionPanel audience={audience} code={plan.code} selected={selection?.id} />
        </>
      )}
    </main>
  )
}