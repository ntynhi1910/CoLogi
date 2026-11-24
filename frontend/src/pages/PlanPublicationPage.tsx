import { useCallback, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { deliveryDate, runTime } from '../components/dss/f1Display'
import { kg } from '../components/dss/f3Display'
import { ApiError } from '../services/api/client'
import { getPublication, listPublications } from '../services/api/planPublication'
import { useDssQuery } from '../services/dss/useDssQuery'
import { ExecutionPanel } from './ExecutionWorkspace'
import { hasEffectiveFinalPlan, publicationLabels, publicationPaths, type LogisticsStatus, type PublicationAudience as Audience,
  type PublicationEntity as Entity, type PublicationEvent, type PublicationIndex, type PublicationItem as Item,
  type PublicationRecipient, type PublicationRecipients, type PublishedPlan } from '../types/planPublication'
import './dss/DSSRunDetailPage.css'
import './dss/PlanDeliveryPage.css'
import './PlanPublicationPage.css'

export type { PublicationEvent, PublicationRecipients, PublishedPlan } from '../types/planPublication'
const stopLabels = {
  SUPPLIER_PICKUP: 'Lấy hàng', OUTLET_DELIVERY: 'Giao hàng',
  HUB_RECEIVE: 'Nhập hàng tại Hub', HUB_DISPATCH: 'Xuất hàng từ Hub',
}
const phaseLabels: Record<string, string> = { DIRECT: 'Giao trực tiếp', INBOUND: 'Supplier → Hub', OUTBOUND: 'Hub → Outlet' }
const entity = (row: Entity) => [row.code, row.name].filter(Boolean).join(' · ') || '#' + row.id

function serviceTime(value: string | null, zone: string) {
  return value ? new Intl.DateTimeFormat('vi-VN', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'
}

function scheduledWindow(start: string | null, end: string | null, timezone: string) {
  if (!start || !end) return 'Chưa có khung giờ'
  return `${serviceTime(start, timezone)}–${serviceTime(end, timezone)}`
}

function demandWindows(plan: PublishedPlan, demandId: number, audience: Audience) {
  const role = audience === 'supplier' ? 'SUPPLIER_PICKUP' : 'OUTLET_DELIVERY'
  return plan.waves.flatMap(wave => wave.stops
    .filter(stop => stop.role === role && stop.loads.some(load => load.demand_id === demandId))
    .map(stop => ({ key: `${wave.number}:${stop.sequence}`, time: scheduledWindow(stop.start, stop.end, plan.timezone) })))
}

function statusTone(status: LogisticsStatus) {
  if (status === 'CONFIRMED') return 'green'
  if (status === 'DECLINED' || status === 'NEEDS_ADJUSTMENT') return 'red'
  return status === 'SUPERSEDED' ? 'neutral' : 'amber'
}

export function PublicationBadge({ status }: { status: LogisticsStatus }) {
  return <span className="manager-badge" data-tone={statusTone(status)}>{publicationLabels[status]}</span>
}

export function PublicationEvents({ events, path, title = 'Thông báo kế hoạch' }: {
  events: PublicationEvent[]; path: string; title?: string
}) {
  return <details className="dssr-panel delivery-section publication-events">
    <summary>{title} ({events.length})</summary>
    {events.length ? <ol className="delivery-records">{events.map(event => <li key={event.id}>
      <Link to={path + '/' + event.code}>{publicationLabels[event.kind]} · Phiên bản {event.version}</Link>
      <time dateTime={event.at}>{runTime(event.at)}</time>
    </li>)}</ol> : <p>Chưa có thông báo.</p>}
  </details>
}

function Items({ items }: { items: Item[] | null }) {
  if (items === null) return <p>Snapshot chưa ghi phân bổ SKU cho phần khối lượng này.</p>
  return <div className="manager-table-scroll" tabIndex={0} aria-label="Bảng SKU">
    <table className="manager-table publication-items">
      <thead><tr><th scope="col">SKU</th><th scope="col">Tên sản phẩm</th><th scope="col">Khối lượng (kg)</th><th scope="col">Đơn vị gốc</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.id}><th scope="row">{item.code ?? '#' + item.id}</th>
        <td>{item.name ?? '—'}</td><td>{kg(item.weight_kg)}</td><td>{item.unit ?? '—'}</td></tr>)}</tbody>
    </table>
  </div>
}

export function PublicationSchedule({ plan, selected }: { plan: PublishedPlan; selected?: number }) {
  const demands = new Map(plan.demands.map(demand => [demand.id, demand]))
  const visibleWaves = plan.waves.filter(wave => wave.stops.some(stop => !selected || stop.loads.some(row => row.demand_id === selected)))
  return <div className="publication-schedule">
    {!visibleWaves.length && <p>Phiên bản này chưa có mốc lịch phù hợp.</p>}
    {visibleWaves.map(wave => <section className="dssr-panel delivery-section" key={wave.number}>
      <h3>Wave {wave.number} · {phaseLabels[wave.phase] ?? wave.phase}</h3>
      <p>{wave.vehicle.name} · {wave.vehicle.code}{wave.weight_kg && ' · ' + kg(wave.weight_kg)}</p>
      <ol className="manager-timeline">{wave.stops.map(stop => {
        const loads = stop.loads.filter(row => !selected || row.demand_id === selected)
        if (!loads.length) return null
        const firstDemand = demands.get(loads[0].demand_id)
        const location = stop.role === 'SUPPLIER_PICKUP' ? firstDemand?.supplier
          : stop.role === 'OUTLET_DELIVERY' ? firstDemand?.outlet : plan.hub
        return <li key={stop.sequence}><details open>
          <summary>{wave.weight_kg && `${stop.sequence}. `}{stopLabels[stop.role]}
            {location ? ' · ' + entity(location) : stop.code && ' · ' + stop.code}
            <small>{scheduledWindow(stop.start, stop.end, plan.timezone)}</small>
          </summary>
          {stop.address && <p>{stop.address}</p>}
          <dl className="publication-stop-times">
            <div><dt>Giờ đến</dt><dd>{serviceTime(stop.arrival, plan.timezone)}</dd></div>
            <div><dt>Thời gian chờ</dt><dd>{stop.wait_minutes == null ? '—' : `${new Intl.NumberFormat('vi-VN').format(stop.wait_minutes)} phút`}</dd></div>
            <div><dt>Giờ phục vụ</dt><dd>{scheduledWindow(stop.start, stop.end, plan.timezone)}</dd></div>
            <div><dt>Giờ rời điểm</dt><dd>{serviceTime(stop.departure, plan.timezone)}</dd></div>
          </dl>
          {loads.map(load => <div key={load.demand_id}>
            <strong>{demands.get(load.demand_id)?.code} · {kg(load.weight_kg)}</strong>
            <Items items={load.items} />
          </div>)}
        </details></li>
      })}</ol>
    </section>)}
  </div>
}

export function ManagerPublication({ publication }: { publication: PublicationRecipients }) {
  const accessLabels = {
    AVAILABLE: 'Có quyền xem bản công bố', AWAITING_PUBLICATION: 'Đủ quyền · Chờ công bố',
    NO_ACTIVE_SCOPE: 'Chưa có tài khoản đủ quyền', HISTORY_ONLY: 'Có quyền xem lịch sử',
  }
  const access = (party: PublicationRecipient) => accessLabels[party.view_access] + (
    party.account_count ? ` · ${party.account_count} tài khoản` : ''
  )
  return <div className="publication-recipients">
    <h3>Công bố kế hoạch đa bên</h3>
    <PublicationBadge status={publication.status} />
    <p>CoLogi chưa theo dõi lượt đọc của từng tài khoản.</p>
    <dl className="manager-fields">
      <div><dt>Đơn vị vận chuyển</dt><dd>{entity(publication.provider)}<br />{access(publication.provider)}</dd></div>
      {publication.suppliers.map(supplier => <div key={supplier.id}>
        <dt>Nhà cung cấp</dt><dd>{entity(supplier)}<br />{access(supplier)}</dd>
      </div>)}
      {publication.outlets.map(outlet => <div key={outlet.id}>
        <dt>Phạm vi mua hàng</dt><dd>{entity(outlet)}<br />{access(outlet)}
          {outlet.purchasing_staff.length > 0 && <><br />{outlet.purchasing_staff.join(', ')}</>}
        </dd>
      </div>)}
    </dl>
    <PublicationEvents events={publication.events} path="/dss/final-plans" title="Lịch sử công bố" />
  </div>
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
  const loadIndex = useCallback(() => listPublications(audience), [audience])
  const loadDetail = useCallback(() => getPublication(audience, code ?? ''), [audience, code])
  return code
    ? <PublicationDetail load={loadDetail} root={root} title={title} audience={audience} selected={Number(params.get('demand')) || undefined} />
    : <main className="dssr-page delivery-page manager-workspace plan-publication">
      <header className="manager-heading"><h1>{title}</h1></header>
      <PublicationList load={loadIndex} root={root} audience={audience} search={search} date={date} state={state} outlet={outlet}
        setSearch={setSearch} setDate={setDate} setState={setState} setOutlet={setOutlet} />
    </main>
}

function LoadError({ error, reload }: { error: unknown; reload: () => void }) {
  const status = error instanceof ApiError ? error.status : null
  return <div className="dssr-alert" role="alert">{status === 404 ? 'Không tìm thấy kế hoạch đã công bố trong phạm vi được cấp.'
    : status === 403 ? 'Tài khoản chưa có quyền xem lịch này.'
      : status === 401 ? 'Phiên đăng nhập đã hết hạn.' : 'Không tải được dữ liệu kế hoạch.'}
    <button type="button" className="dssr-secondary-button" onClick={reload}>Thử lại</button>
  </div>
}

type ListProps = {
  load: () => Promise<PublicationIndex>; audience: Audience; root: string
  search: string; date: string; state: string; outlet: string
  setSearch: (value: string) => void; setDate: (value: string) => void
  setState: (value: string) => void; setOutlet: (value: string) => void
}

function PublicationList({ load, audience, root, search, date, state, outlet, setSearch, setDate, setState, setOutlet }: ListProps) {
  const result = useDssQuery(load)
  if (result.loading) return <p role="status">Đang tải lịch…</p>
  if (result.error != null) return <LoadError error={result.error} reload={result.reload} />
  if (!result.data) return null
  const { plans, summary, events } = result.data
  const activeDemandCount = summary.active_demand_count ??
    new Set(plans.filter(plan => hasEffectiveFinalPlan(plan.status)).flatMap(plan => plan.demands.map(demand => demand.id))).size
  const outlets = new Map(plans.flatMap(plan => plan.demands.map(demand => [String(demand.outlet.id), demand.outlet])))
  const rows = plans.filter(plan => (!date || plan.service_date === date) &&
    (state === 'ALL' || (state === 'CURRENT' ? plan.status !== 'SUPERSEDED' : plan.status === state)))
    .flatMap(plan => plan.demands.filter(demand => (!outlet || String(demand.outlet.id) === outlet) &&
      matches([plan.code, demand.code, entity(demand.supplier), entity(demand.outlet)].join(' '), search))
      .map(demand => ({ plan, demand, windows: demandWindows(plan, demand.id, audience) })))
    .sort((left, right) => left.plan.service_date.localeCompare(right.plan.service_date))
  return <>
    <dl className="manager-metrics">
      <div><dt>FinalPlan sắp tới</dt><dd>{summary.upcoming}</dd></div>
      <div data-tone="amber"><dt>FinalPlan chờ vận chuyển xác nhận</dt><dd>{summary.awaiting}</dd></div>
      <div><dt>FinalPlan đã xác nhận</dt><dd>{summary.confirmed}</dd></div>
      <div><dt>Demand có FinalPlan hiệu lực</dt><dd>{activeDemandCount}</dd></div>
    </dl>
    <PublicationEvents events={events} path={root} />
    <section className="dssr-panel delivery-section">
      <div className="manager-row"><h2>Lịch đã công bố</h2>
        <button type="button" className="dssr-secondary-button" onClick={result.reload}>Làm mới</button>
      </div>
      <div className="delivery-filters publication-filters">
        <label>Tìm kiếm<input type="search" placeholder="Mã Demand, kế hoạch, đơn vị" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label>{audience === 'supplier' ? 'Ngày lấy hàng' : 'Ngày nhận hàng'}
          <input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
        {audience === 'purchasing' && <label>Outlet<select value={outlet} onChange={event => setOutlet(event.target.value)}>
          <option value="">Tất cả Outlet</option>{[...outlets].map(([id, row]) => <option key={id} value={id}>{entity(row)}</option>)}
        </select></label>}
        <label>Trạng thái<select value={state} onChange={event => setState(event.target.value)}>
          <option value="CURRENT">Phiên bản hiện hành</option><option value="ALL">Tất cả phiên bản</option>
          {(['AWAITING_TRANSPORT', 'CONFIRMED', 'DECLINED', 'SUPERSEDED'] as const).map(key =>
            <option key={key} value={key}>{publicationLabels[key]}</option>)}
        </select></label>
      </div>
      {!rows.length ? <p>{plans.length ? 'Không tìm thấy lịch phù hợp với bộ lọc.' : 'Chưa có kế hoạch được công bố trong phạm vi của bạn.'}</p>
        : <ul className="delivery-records">{rows.map(({ plan, demand, windows }) => <li key={plan.code + ':' + demand.id}>
          <Link to={root + '/' + plan.code + '?demand=' + demand.id}>{demand.code} · v{plan.version}</Link>
          <span>{deliveryDate(plan.service_date)} · {entity(audience === 'supplier' ? demand.outlet : demand.supplier)} · {kg(demand.weight_kg)}</span>
          <span className="publication-window">
            <strong>{audience === 'supplier' ? 'Lấy hàng' : 'Giao hàng'}</strong>
            {windows.map(window => <span key={window.key}>{window.time}</span>)}
            {!windows.length && <span>Chưa có khung giờ</span>}
          </span>
          <PublicationBadge status={plan.status} />
        </li>)}</ul>}
    </section>
  </>
}

function PublicationDetail({ load, root, title, audience, selected }: {
  load: () => Promise<PublishedPlan>; root: string; title: string; audience: Audience; selected?: number
}) {
  const result = useDssQuery(load)
  const plan = result.data
  const selection = plan?.demands.find(demand => demand.id === selected)
  const demands = selection ? [selection] : plan?.demands ?? []
  return <main className="dssr-page delivery-page manager-workspace plan-publication">
    <header className="manager-heading"><Link to={root}>← {title}</Link>
      <h1>{plan ? (selection?.code ?? title) + ' · v' + plan.version : title}</h1>
      {plan && <PublicationBadge status={plan.status} />}
    </header>
    {result.loading && <p role="status">Đang tải phiên bản kế hoạch…</p>}
    {result.error != null && <LoadError error={result.error} reload={result.reload} />}
    {plan && <>
      {plan.status === 'AWAITING_TRANSPORT' && <p className="dssr-alert">Lịch dự kiến. Đơn vị vận chuyển chưa xác nhận.</p>}
      {plan.status === 'DECLINED' && <p className="dssr-alert">Đơn vị vận chuyển đã từ chối. Chờ Manager điều chỉnh.</p>}
      {plan.status === 'SUPERSEDED' && <p className="dssr-alert">Phiên bản này chỉ dùng để tra cứu lịch sử.</p>}
      <section className="dssr-panel delivery-section"><div className="manager-row"><h2>Thông tin công bố</h2>
        <button type="button" className="dssr-secondary-button" onClick={result.reload}>Làm mới</button></div>
        <dl className="manager-fields">
          <div><dt>Ngày dịch vụ</dt><dd>{deliveryDate(plan.service_date)} · {plan.timezone}</dd></div>
          <div><dt>Đơn vị vận chuyển</dt><dd>{entity(plan.provider)}</dd></div>
          {plan.hub && <div><dt>Điểm trung chuyển</dt><dd>{entity(plan.hub)}</dd></div>}
          <div><dt>Thời điểm công bố</dt><dd>{plan.published_at ? runTime(plan.published_at) : '—'}</dd></div>
          {plan.responded_at && <div><dt>Phản hồi vận chuyển</dt><dd>{runTime(plan.responded_at)}</dd></div>}
        </dl>
        <details><summary>Nguồn lập kế hoạch và mã FinalPlan</summary>
          <p className="publication-code">{plan.code} · v{plan.version}</p>
          <p>{plan.provenance.classification === 'INTERNAL_ASSUMPTIONS' ? 'Giả định lập kế hoạch nội bộ' : plan.provenance.classification}</p>
          <p>Nguồn lịch {plan.provenance.time_source} · Nguồn chi phí {plan.provenance.price_source}</p>
          {!plan.provenance.provider_independently_verified && <p>Chưa có xác minh độc lập của đơn vị vận chuyển đối với nguồn lập kế hoạch.</p>}
        </details>
      </section>
      <section className="dssr-panel delivery-section"><h2>Nhu cầu và SKU</h2>
        {demands.map(demand => <details open key={demand.id}>
          <summary>{demand.code} · {kg(demand.weight_kg)}</summary>
          <p>{entity(demand.supplier)} → {entity(demand.outlet)}</p>
          <Items items={demand.items} />
        </details>)}
      </section>
      <PublicationSchedule plan={plan} selected={selection?.id} />
      <ExecutionPanel audience={audience} code={plan.code} selected={selection?.id} />
      <PublicationEvents events={plan.events} path={root} />
    </>}
  </main>
}
