import { useCallback, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { deliveryDate, runTime } from '../../components/dss/f1Display'
import { kg as weight } from '../../components/dss/f3Display'
import { ApiError, apiRequest } from '../../services/api/client'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F4Wave } from '../../types/f4'
import { ManagerPublication, PublicationEvents, PublicationSchedule, type PublicationEvent,
  type PublicationRecipients, type PublishedPlan } from '../PlanPublicationPage'
import {
  canReviewDecision, decisionActions as decisions, decisionPayload, decisionReason, decisionReasons, isComparableOption,
  otherReason, reasonLimit, sortDecisionOptions, type DecisionOutcome,
} from './managerDecision'
import './DSSRunDetailPage.css'
import './PlanDeliveryPage.css'

type CarrierOutcome = 'CONFIRM' | 'DECLINE'
type Candidate = { run_code: string; group_code: string }
type PlanConflict = { plan_id: number; version: number; code: string | null; active: boolean; demands: { id: number; code: string }[] }
type Group = Candidate & {
  run_number: number
  group_number: number
  service_date: string
  demand_count: number
  total_weight_kg: string
  publication: Final | null
  last_outcome: DecisionOutcome | null
  conflicts?: PlanConflict[]
  queue_status?: 'WAITING' | 'APPROVED' | 'CONFLICT' | 'UNAVAILABLE'
  can_replace?: boolean
  risk_code?: string | null
  estimate?: { cost: string | number; saving: string | number; currency: string } | null
}
type Evidence = {
  classification: string
  time_source: string
  price_source: string
  internal_sources: { version?: string; valid_from?: string; valid_to?: string }[]
}
type Final = Candidate & {
  code: string
  version: number
  current: boolean
  supersedes_code: string | null
  approved_at: string
  reason: string
  provider_code: string
  service_date: string
  provenance: Evidence
  handover: {
    sent_at: string
    sent_by: number
    response: { outcome: CarrierOutcome; reason: string; actor_id: number; responded_at: string } | null
  } | null
}
type Decision = Candidate & {
  id: number
  outcome: DecisionOutcome
  reason: string
  recorded_at: string
  actor_id: number
  actor_name?: string
  group_number?: number
  run_number?: number
  final_plan_code: string | null
  final?: Final | null
}
type Option = {
  evaluation_code: string
  plan: { plan_code: string; hub_id: number | null; hub?: { code: string; name: string }; revision: number }
  lineage: { f4_evaluation_code: string; f3_evaluation_code?: string }
  baseline_cost: string | number
  collaborative_cost: string | number
  cost_saving: string | number
  saving_rate_pct: string | number | null
  currency: string
  timeline: F4Wave[]
  warnings: Record<string, { code: string }[]>
  provenance: Evidence
  approval: { allowed: boolean; code: string | null; version: number | null; replaces: string | null }
  publication: Final | null
  evidence_details: {
    fingerprints: Record<string, string>
    records: Record<string, {
      id: number; kind: string; version: string; provenance: string; source_reference: string
      valid_from?: string; valid_to?: string; fingerprint: string
    }[]>
  }
}
type Workbench = { options: Option[]; decisions: Decision[]; group: Group | null }
type Detail = Final & {
  snapshot_hash: string
  publication?: PublicationRecipients | PublishedPlan
  approved_by?: string
  delivery: {
    demands: { id: number; code: string; supplier_id: number; supplier_code?: string; outlet_code: string; required_weight_kg: string;
      items?: { item_id: number; item_code?: string; sku?: string; required_weight_kg: string; confirmed_weight_kg: string }[] }[]
    total_weight_kg: string
    stops: { key: string; kind: string; address: string | null }[]
    timeline: F4Wave[]
    cost: string
    currency: string
  }
}

const decisionPath = '/planning/decisions/'
const finalPath = '/planning/final-plans/'
const carrierPath = '/providers/me/handovers/'
function money(amount: string | number, currency: string) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(Number(amount))
}

function reviewRoute(run: string, group: string) {
  return '/dss/decisions/' + run + '/' + encodeURIComponent(group)
}

function publicationStatus(plan: Final) {
  if (!plan.current) return 'Đã được thay thế'
  if (!plan.handover) return 'Đã phê duyệt · Chờ bàn giao'
  if (!plan.handover.response) return 'Đã bàn giao · Chờ TP001 phản hồi'
  return plan.handover.response.outcome === 'CONFIRM' ? 'Đã bàn giao · TP001 đã xác nhận' : 'Đã bàn giao · TP001 đã từ chối'
}

function approvalMessage(code: string) {
  const labels: Record<string, string> = {
    FINAL_PLAN_VERSION_CHANGED: 'Phiên bản hiện hành đã thay đổi. Hãy tải lại trước khi xác nhận.',
    DEMAND_ALREADY_FINALIZED: 'Có nhu cầu đã thuộc kế hoạch có hiệu lực.',
    EVALUATION_ALREADY_APPROVED: 'Kết quả đánh giá này đã được phê duyệt.',
    SERVICE_DATE_PAST: 'Ngày giao đã qua. Cần chọn lịch mới.',
    SCHEDULE_ALREADY_STARTED: 'Lịch đã đến giờ thực hiện. Cần chọn lịch mới.',
    F2_REVISION_SUPERSEDED: 'Đã có phiên bản F2 mới hơn. Cần đánh giá lại phương án.',
    F1_HARD_GATE: 'Phương án chưa đáp ứng điều kiện F1.',
    F3_F4_HARD_GATE: 'Phương án chưa đáp ứng điều kiện F3 hoặc F4.',
    CARRIER_UNAVAILABLE: 'Nhà vận chuyển hiện không khả dụng.',
    DELIVERY_SOURCE_INVALID: 'Nguồn đánh giá không hợp lệ. Cần kiểm tra lại bằng chứng.',
    DELIVERY_SOURCE_UNAVAILABLE: 'Nguồn đánh giá không còn khả dụng.',
  }
  if (code.endsWith('_SOURCE_CHANGED')) return 'Bằng chứng hoặc kết quả đã thay đổi. Cần đánh giá lại. (' + code + ')'
  return labels[code] ?? 'Hệ thống chặn thao tác (' + code + ').'
}

function message(error: unknown) {
  if (!(error instanceof ApiError)) return 'Không thể kết nối dịch vụ. Vui lòng thử lại.'
  if (error.status === 401) return 'Phiên đăng nhập đã hết hạn.'
  if (error.status === 403) return 'Bạn không có quyền trong phạm vi này.'
  if (error.status === 404) return 'Không tìm thấy bản ghi trong phạm vi truy cập.'
  const code = error.data && typeof error.data === 'object' && 'code' in error.data ? String(error.data.code) : ''
  if (code === 'DELIVERY_MIGRATION_REQUIRED') return 'Quy trình phê duyệt và bàn giao chưa được kích hoạt.'
  if (code) return approvalMessage(code)
  if (error.status === 400 && error.data && typeof error.data === 'object' && 'reason' in error.data) {
    return 'Lý do không hợp lệ. Hãy nhập tối đa 2.000 ký tự.'
  }
  return 'Không thể xử lý yêu cầu (HTTP ' + error.status + ').'
}

function EvidenceNotice({ evidence }: { evidence: Evidence }) {
  const classification = {
    INTERNAL_ASSUMPTIONS: 'Nguồn giả định lập kế hoạch nội bộ đã duyệt',
    CAPSTONE: 'Dữ liệu mô phỏng Capstone',
    UAT: 'Dữ liệu mô phỏng UAT',
    OPERATIONAL_EVIDENCE: 'Nguồn lập kế hoạch vận hành',
  }[evidence.classification] ?? evidence.classification
  return <div className="delivery-evidence">
    <strong>{classification}</strong>
    <span>Lịch {evidence.time_source} · Chi phí {evidence.price_source}</span>
    {evidence.internal_sources.map((source, index) => <span key={index}>
      {source.version} {source.valid_from && '· ' + deliveryDate(source.valid_from)}
      {source.valid_to && ' đến ' + deliveryDate(source.valid_to)}
    </span>)}
    {evidence.classification !== 'OPERATIONAL_EVIDENCE' && <span>
      Phản hồi TP001 áp dụng cho phiên bản lập kế hoạch này. Bằng chứng thương mại cần được xác minh riêng.
    </span>}
  </div>
}

function Timeline({ waves, stops }: { waves: F4Wave[]; stops?: Detail['delivery']['stops'] }) {
  const addresses = new Map(stops?.map(stop => [stop.key, stop.address]))
  return <div className="delivery-waves">{waves.map(wave => <details key={wave.wave_no}>
    <summary>Wave {wave.wave_no} · {wave.phase} · {weight(wave.weight_kg)} · {wave.vehicle.vehicle_code}
      {' · '}{runTime(wave.start)} → {runTime(wave.end)}</summary>
    <p>{wave.vehicle.vehicle_name} · Tải trọng {weight(wave.vehicle.capacity_kg)} · Offer #{wave.vehicle.offer_id}
      {' · '}{wave.vehicle.available_vehicle_count} xe khả dụng theo đánh giá F3</p>
    <ol>{wave.stops.map(stop => <li key={stop.sequence}>
      {stop.code ?? stop.stop} {stop.name && '· ' + stop.name}
      {' · '}Đến {runTime(stop.arrival)} · Xử lý {runTime(stop.service_start)} → {runTime(stop.service_end)}
      {stop.demand_codes.length > 0 && ' · ' + stop.demand_codes.join(', ')}
      {addresses.get(stop.stop) && <div>{addresses.get(stop.stop)}</div>}
      {stop.travel_from_previous && <small>
        {' · '}{stop.travel_from_previous.distance_km} km / {stop.travel_from_previous.minutes} phút
        {' · '}{stop.travel_from_previous.source} · {stop.travel_from_previous.reference}
      </small>}
    </li>)}</ol>
  </details>)}</div>
}

function Decisions({ rows, filtered = false }: { rows: Decision[]; filtered?: boolean }) {
  if (!rows.length) return <p className="delivery-empty">{filtered
    ? 'Không có quyết định khớp bộ lọc. Hãy thay đổi bộ lọc để xem lại lịch sử.'
    : 'Chưa có quyết định. Mở nhóm có kết quả F5 đã lưu, chọn phương án và ghi quyết định. Sau khi lưu, lý do và trạng thái bàn giao sẽ xuất hiện tại đây.'}</p>
  return <ul className="delivery-records">{rows.map(row => <li key={row.id}>
    <strong>{decisions[row.outcome]}</strong><span className="delivery-saved-reason">{row.reason}</span>
    <span>{runTime(row.recorded_at)} · {row.actor_name ?? 'Người thực hiện #' + row.actor_id}</span>
    {row.final_plan_code && <Link to={'/dss/final-plans/' + row.final_plan_code}>
      {row.final ? 'Phiên bản ' + row.final.version + ' · ' + publicationStatus(row.final) : 'Mở FinalPlan'}
    </Link>}
    {row.final?.handover?.response?.outcome === 'DECLINE' && <span role="status">
      TP001 từ chối: {row.final.handover.response.reason}
    </span>}
  </li>)}</ul>
}

function groupStatus(group: Group) {
  if (group.conflicts?.length) return 'Không khả dụng'
  if (group.publication) return publicationStatus(group.publication)
  if (group.last_outcome === 'REJECT') return 'Đã từ chối phương án'
  if (group.last_outcome === 'REQUEST_RECALCULATION') return 'Đã yêu cầu tính lại'
  return 'Chờ quyết định'
}

function Trace({ values }: { values: Record<string, string | undefined> }) {
  const [copyResult, setCopyResult] = useState('')
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]))
  async function copy() {
    try {
      await navigator.clipboard.writeText(entries.map(([key, value]) => key + ' · ' + value).join('\n'))
      setCopyResult('Đã sao chép mã truy vết.')
    } catch {
      setCopyResult('Hãy chọn và sao chép mã trong phần chi tiết.')
    }
  }
  return <details className="delivery-trace"><summary>Mã truy vết</summary>
    <dl>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
    <button type="button" className="dssr-secondary-button" onClick={() => void copy()}>Sao chép mã</button>
    {copyResult && <p role="status">{copyResult}</p>}
  </details>
}

type DecisionIndex = {
  candidates: Group[]
  decisions: Decision[]
  carrier_declines: Final[]
  history_counts: Partial<Record<DecisionOutcome, number>>
  page_size: number
  total: number
}

function WorkspaceHeading({ title, detail }: { title: string; detail: string }) {
  return <header className="manager-heading"><p className="dssr-eyebrow">CoLogi Workspace</p>
    <h1>{title}</h1><p>{detail}</p></header>
}

function WorkspaceMetrics({ metrics }: { metrics: { label: string; value: number | string; note?: string; tone?: string }[] }) {
  return <dl className="manager-metrics">{metrics.map(metric => <div key={metric.label} data-tone={metric.tone}>
    <dt>{metric.label}</dt><dd>{metric.value}</dd>{metric.note && <small>{metric.note}</small>}
  </div>)}</dl>
}

function WorkspaceError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="dssr-alert" role="alert">{message(error)} <button type="button" className="dssr-secondary-button" onClick={retry}>Thử lại</button></div>
}

function Conflicts({ rows }: { rows: PlanConflict[] }) {
  return <ul className="delivery-records manager-conflicts">{rows.map(row => <li key={row.plan_id}>
    <strong>FinalPlan #{row.plan_id} · v{row.version} · Đang hiệu lực</strong>
    <span>Nhu cầu trùng · {row.demands.map(demand => demand.code || '#' + demand.id).join(', ')}</span>
    {row.code && <Link to={'/dss/final-plans/' + row.code}>Xem kế hoạch</Link>}
  </li>)}</ul>
}

const queueFilters = { WAITING: 'Chờ quyết định', APPROVED: 'Đã phê duyệt', UNAVAILABLE: 'Không khả dụng', ALL: 'Tất cả' } as const
type QueueFilter = keyof typeof queueFilters

function canOpenGroup(row: Group) {
  return row.queue_status === 'WAITING' || row.queue_status === 'APPROVED'
}

export function DecisionIndexPage() {
  const [filter, setFilter] = useState<QueueFilter>('WAITING')
  const [selection, setSelection] = useState<string | null>(null)
  const query = useCallback(() => apiRequest<DecisionIndex>(decisionPath), [])
  const result = useDssQuery(query)
  const groups = result.data?.candidates ?? []
  const pending = groups.filter(row => row.queue_status === 'WAITING')
  const approved = groups.filter(row => row.queue_status === 'APPROVED')
  const blocked = groups.filter(row => !canOpenGroup(row))
  const shown = filter === 'WAITING' ? pending : filter === 'APPROVED' ? approved : filter === 'UNAVAILABLE' ? blocked : groups
  const selected = shown.find(row => row.group_code === selection)
  const savings = pending.reduce((sum, row) => sum + (row.estimate?.currency === 'VND' ? Number(row.estimate.saving) : 0), 0)
  const declines = result.data?.carrier_declines ?? []
  return <main className="dssr-page delivery-page manager-workspace">
    <WorkspaceHeading title="Phê duyệt phương án" detail="Xem kết quả F5, kiểm tra điều kiện và ghi quyết định vận chuyển." />
    {result.loading && <p role="status">Đang tải danh sách phê duyệt…</p>}
    {result.error != null && <WorkspaceError error={result.error} retry={result.reload} />}
    {result.data && <>
      <WorkspaceMetrics metrics={[
        { label: 'Chờ phê duyệt', value: pending.length, note: 'Nhóm đủ điều kiện' },
        { label: 'Đã phê duyệt', value: approved.length, note: 'Nhóm có kế hoạch hiệu lực' },
        { label: 'Tiết kiệm dự kiến', value: money(savings, 'VND'), note: 'Ước tính F5 của các nhóm chờ', tone: 'amber' },
        { label: 'Rủi ro cần xem', value: blocked.length + declines.length, note: 'Nhóm bị chặn và bàn giao bị từ chối', tone: 'red' },
      ]} />
      {declines.length > 0 && <section className="dssr-panel delivery-section" role="status">
        <h2>TP001 từ chối bàn giao</h2>
        <ul className="delivery-records">{declines.map(plan => <li key={plan.code}>
          <Link to={'/dss/final-plans/' + plan.code}>Phiên bản {plan.version} · {deliveryDate(plan.service_date)}</Link>
          <span>{plan.handover?.response?.reason}</span>
        </li>)}</ul>
      </section>}
      <div className="manager-columns">
        <section className="dssr-panel delivery-section"><h2>Danh sách phương án</h2>
          <div className="manager-tabs" role="group" aria-label="Lọc trạng thái">{Object.entries(queueFilters).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => {
              setFilter(value as QueueFilter)
              setSelection(null)
            }}>{label}</button>)}</div>
          {shown.length ? <ul className="delivery-records manager-queue">{shown.map(row =>
            <li key={row.group_code} data-blocked={!canOpenGroup(row)} data-selected={selected === row}>
              <div className="manager-row">
                <div><strong>Run #{row.run_number} · Nhóm #{row.group_number}</strong>
                  <small>{deliveryDate(row.service_date)} · {row.demand_count} nhu cầu · {weight(row.total_weight_kg)}</small></div>
                <span className="manager-badge" data-tone={!canOpenGroup(row) ? 'red' : row.queue_status === 'WAITING' ? 'amber' : 'green'}>
                  {canOpenGroup(row) ? groupStatus(row) : 'Không khả dụng'}
                </span>
              </div>
              {row.estimate && row.queue_status === 'WAITING' && <strong>{money(row.estimate.cost, row.estimate.currency)}</strong>}
              {canOpenGroup(row)
                ? <div className="manager-row"><button type="button" className="dssr-secondary-button"
                  aria-pressed={selected === row} onClick={() => setSelection(row.group_code)}>Xem tóm tắt</button>
                  <Link to={reviewRoute(row.run_code, row.group_code)}>Xem phương án</Link></div>
                : <><small>{approvalMessage(row.risk_code ?? 'DELIVERY_SOURCE_UNAVAILABLE')}</small>
                    {!!row.conflicts?.length && <Conflicts rows={row.conflicts} />}</>}
            </li>)}</ul> : <p className="delivery-empty">{filter === 'WAITING'
              ? 'Hiện chưa có nhóm đủ điều kiện phê duyệt. Xem các bộ lọc khác để tra cứu nhóm đã duyệt hoặc bị chặn.'
              : 'Không có nhóm trong bộ lọc này.'}</p>}
        </section>
        <section className="dssr-panel delivery-section"><h2>Chi tiết nhóm</h2>
          {selected ? <>
            <h3>Run #{selected.run_number} · Nhóm #{selected.group_number}</h3>
            <p>{deliveryDate(selected.service_date)} · {selected.demand_count} nhu cầu · {weight(selected.total_weight_kg)}</p>
            <p className="manager-badge">{groupStatus(selected)}</p>
            {selected.estimate && <dl className="manager-fields">
              <div><dt>Chi phí ước tính</dt><dd>{money(selected.estimate.cost, selected.estimate.currency)}</dd></div>
              <div><dt>Tiết kiệm dự kiến</dt><dd>{money(selected.estimate.saving, selected.estimate.currency)}</dd></div>
            </dl>}
            <Trace values={{ Run: selected.run_code, Candidate: selected.group_code }} />
            <Link className="dssr-primary-button" to={reviewRoute(selected.run_code, selected.group_code)}>So sánh F1–F5 và quyết định</Link>
          </> : <p className="delivery-empty">Chọn “Xem tóm tắt” trên một nhóm để xem thông tin tại đây.</p>}
        </section>
      </div>
    </>}
  </main>
}

type DecisionTimeline = {
  run_number: number
  group_number: number
  events: { stage: string; at: string; actor: string; details: Record<string, unknown> }[]
  versions: { code: string; version: number; cost: string | number; currency: string; waves: number; reason: string; current: boolean }[]
}

const stages: Record<string, string> = {
  ...decisions, F2: 'Tạo phương án', F5: 'Đánh giá kinh tế', FINAL: 'Chốt kế hoạch',
  HANDOVER: 'Bàn giao vận chuyển', CONFIRM: 'TP001 xác nhận', DECLINE: 'TP001 từ chối',
}

function HistoryTimeline({ row }: { row: Decision }) {
  const query = useCallback(() => apiRequest<DecisionTimeline>(decisionPath + row.id + '/timeline/'), [row.id])
  const result = useDssQuery(query)
  const data = result.data
  return <>
    {result.loading && <p role="status">Đang tải nhật ký…</p>}
    {result.error != null && <WorkspaceError error={result.error} retry={result.reload} />}
    {data && <>
      <h3>Run #{data.run_number} · Nhóm #{data.group_number}</h3>
      <ol className="manager-timeline">{data.events.map(event => <li key={event.stage}>
        <details><summary><strong>{stages[event.stage] ?? event.stage}</strong>
          <small>{runTime(event.at)} · {event.actor}</small></summary>
          {'reason' in event.details && <p className="delivery-saved-reason">{String(event.details.reason)}</p>}
          {Object.entries(event.details).some(([key]) => key !== 'reason') && <pre>
            {JSON.stringify(Object.fromEntries(Object.entries(event.details).filter(([key]) => key !== 'reason')), null, 2)}
          </pre>}
        </details>
      </li>)}</ol>
      <h3>So sánh phiên bản</h3>
      {data.versions.length > 1 ? <div className="manager-table-scroll" tabIndex={0} aria-label="So sánh phiên bản">
        <table className="manager-table"><thead><tr><th scope="col">Phiên bản</th><th scope="col">Chi phí</th>
          <th scope="col">Tuyến</th><th scope="col">Lý do</th></tr></thead>
          <tbody>{data.versions.map(version => <tr key={version.code}>
            <th scope="row"><Link to={'/dss/final-plans/' + version.code}>v{version.version}</Link>
              {version.current && <small>Hiệu lực</small>}</th>
            <td>{money(version.cost, version.currency)}</td><td>{version.waves}</td>
            <td className="delivery-saved-reason">{version.reason}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="delivery-empty">Cần ít nhất hai phiên bản đã lưu để so sánh.</p>}
    </>}
  </>
}

export function DecisionHistoryPage() {
  const [params, setParams] = useSearchParams()
  const [focused, setFocused] = useState<number | null>(null)
  const filters = params.toString()
  const query = useCallback(() => apiRequest<DecisionIndex>(decisionPath + '?history_only=true' + (filters ? '&' + filters : '')), [filters])
  const result = useDssQuery(query)
  const data = result.data
  const selected = data?.decisions.find(row => row.id === focused)
  const page = Number(params.get('page') ?? 1)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const search = new URLSearchParams()
    for (const [name, raw] of new FormData(event.currentTarget)) {
      const value = String(raw).trim()
      if (value) search.set(name, value)
    }
    setFocused(null)
    setParams(search)
  }
  function turn(next: number) {
    const search = new URLSearchParams(params)
    search.set('page', String(next))
    setFocused(null)
    setParams(search)
  }
  return <main className="dssr-page delivery-page manager-workspace">
    <WorkspaceHeading title="Lịch sử quyết định" detail="Tra cứu phê duyệt, phiên bản kế hoạch và phản hồi bàn giao." />
    {data && <WorkspaceMetrics metrics={[
      { label: 'Tổng quyết định', value: data.total, note: 'Theo bộ lọc' },
      { label: 'Đã phê duyệt', value: data.history_counts.APPROVE ?? 0 },
      { label: 'Yêu cầu tính lại', value: data.history_counts.REQUEST_RECALCULATION ?? 0, tone: 'amber' },
      { label: 'Từ chối', value: data.history_counts.REJECT ?? 0, tone: 'red' },
    ]} />}
    <div className="manager-columns">
      <section className="dssr-panel delivery-section"><h2>Tra cứu quyết định</h2>
        <form key={filters} className="delivery-filters manager-history-filters" onSubmit={submit}>
          <label>Tìm kiếm <input name="search" maxLength={120} defaultValue={params.get('search') ?? ''} placeholder="Run, nhóm, người thực hiện, lý do" /></label>
          <label>Quyết định <select name="outcome" defaultValue={params.get('outcome') ?? ''}><option value="">Tất cả</option>
            {Object.entries(decisions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>ID người thực hiện <input name="actor_id" type="number" min={1} defaultValue={params.get('actor_id') ?? ''} /></label>
          <label>Phiên bản <input name="version" type="number" min={1} defaultValue={params.get('version') ?? ''} /></label>
          <label>Từ ngày <input name="date_from" type="date" defaultValue={params.get('date_from') ?? ''} /></label>
          <label>Đến ngày <input name="date_to" type="date" defaultValue={params.get('date_to') ?? ''} /></label>
          <button className="dssr-primary-button">Lọc</button>
          <button type="button" className="dssr-secondary-button" onClick={() => {setFocused(null); setParams({})}}>Xóa bộ lọc</button>
        </form>
        {result.loading && <p role="status">Đang tải lịch sử…</p>}
        {result.error != null && <WorkspaceError error={result.error} retry={result.reload} />}
        {data && (data.decisions.length ? <div className="manager-table-scroll" tabIndex={0} aria-label="Bảng lịch sử">
          <table className="manager-table"><thead><tr><th scope="col">Nhóm</th><th scope="col">Quyết định</th>
            <th scope="col">Người thực hiện</th><th scope="col">Thời điểm</th><th scope="col">Phiên bản</th></tr></thead>
            <tbody>{data.decisions.map(row => <tr key={row.id} data-selected={row === selected}>
              <th scope="row"><button type="button" aria-pressed={row === selected} onClick={() => setFocused(row.id)}>
                Run #{row.run_number} · Nhóm #{row.group_number}
              </button></th>
              <td>{decisions[row.outcome]}</td><td>{row.actor_name ?? '#' + row.actor_id}</td>
              <td>{runTime(row.recorded_at)}</td><td>{row.final ? 'v' + row.final.version : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="delivery-empty">Chưa có quyết định phù hợp. Hãy xóa bộ lọc hoặc mở trang phê duyệt để kiểm tra nhóm đang chờ.</p>)}
        {data && data.total > data.page_size && <div className="delivery-actions">
          <button type="button" className="dssr-secondary-button" disabled={page <= 1} onClick={() => turn(page - 1)}>Trang trước</button>
          <span>Trang {page} / {Math.ceil(data.total / data.page_size)}</span>
          <button type="button" className="dssr-secondary-button" disabled={page * data.page_size >= data.total} onClick={() => turn(page + 1)}>Trang sau</button>
        </div>}
      </section>
      <section className="dssr-panel delivery-section"><h2>Chi tiết lịch sử</h2>
        {selected ? <HistoryTimeline key={selected.id} row={selected} /> : <p className="delivery-empty">Chọn một dòng để xem lý do, nhật ký và các phiên bản kế hoạch.</p>}
      </section>
    </div>
  </main>
}

type ListedFinal = Final & {
  run_number: number; group_number: number; actor_name: string; demand_count: number; wave_count: number
  weight: string; cost: string | number; currency: string
}

export function FinalPlanIndexPage() {
  const query = useCallback(() => apiRequest<{ plans: ListedFinal[] }>(finalPath), [])
  const result = useDssQuery(query)
  const current = result.data?.plans.filter(plan => plan.current) ?? []
  const waves = current.reduce((count, plan) => count + plan.wave_count, 0)
  const demands = current.reduce((count, plan) => count + plan.demand_count, 0)
  const cost = current.filter(plan => plan.currency === 'VND').reduce((total, plan) => total + Number(plan.cost), 0)
  return <main className="dssr-page delivery-page manager-workspace">
    <WorkspaceHeading title="Kế hoạch cuối cùng" detail="Xem các phiên bản đã duyệt, tuyến giao và tình trạng bàn giao." />
    {result.loading && <p role="status">Đang tải kế hoạch…</p>}
    {result.error != null && <WorkspaceError error={result.error} retry={result.reload} />}
    {result.data && <>
      <WorkspaceMetrics metrics={[
        { label: 'Kế hoạch hiệu lực', value: current.length }, { label: 'Tuyến / wave', value: waves },
        { label: 'Nhu cầu giao', value: demands, tone: 'amber' }, { label: 'Chi phí kế hoạch hiệu lực', value: money(cost, 'VND'), tone: 'amber' },
      ]} />
      <section className="dssr-panel delivery-section"><h2>Danh sách phiên bản</h2>
        {!result.data.plans.length && <p className="delivery-empty">Chưa có kế hoạch được duyệt trong phạm vi của bạn.</p>}
        <ul className="delivery-records delivery-groups">{result.data.plans.map(plan => <li key={plan.code}>
          <Link to={'/dss/final-plans/' + plan.code}>Run #{plan.run_number} · Nhóm #{plan.group_number} · v{plan.version}</Link>
          <span>{deliveryDate(plan.service_date)} · {plan.demand_count} nhu cầu · {weight(plan.weight)}</span>
          <strong>{money(plan.cost, plan.currency)}</strong>
          <span className="manager-badge">{publicationStatus(plan)}</span>
          <small>{plan.actor_name} · {runTime(plan.approved_at)}</small>
        </li>)}</ul>
      </section>
    </>}
  </main>
}

const evidenceLabels: Record<string, string> = {
  INTERNAL_ASSUMPTIONS: 'Giả định lập kế hoạch nội bộ',
  CAPSTONE: 'Dữ liệu mô phỏng Capstone',
  UAT: 'Dữ liệu mô phỏng UAT',
  OPERATIONAL_EVIDENCE: 'Nguồn lập kế hoạch vận hành',
}

function optionName(row: Option) {
  if (row.plan.hub) return row.plan.hub.code + ' · ' + row.plan.hub.name
  return row.plan.hub_id ? 'Hub #' + row.plan.hub_id : 'Direct Consolidated'
}

function sourceDetails(row: Option) {
  const records = new Map<string, { record: Option['evidence_details']['records'][string][number]; stages: string[] }>()
  for (const [stage, sources] of Object.entries(row.evidence_details.records)) {
    for (const record of sources) {
      const key = [record.kind, record.id, record.fingerprint, record.source_reference].join('|')
      const existing = records.get(key)
      if (existing) {
        if (!existing.stages.includes(stage)) existing.stages.push(stage)
      } else {
        records.set(key, { record, stages: [stage] })
      }
    }
  }
  return records
}

function OptionDetails({ row }: { row: Option }) {
  const sources = sourceDetails(row)
  const versions = [...new Map(row.provenance.internal_sources.map(source => [
    [source.version, source.valid_from, source.valid_to].join('|'), source,
  ])).values()]
  return <div className="delivery-card-details">
    <details>
      <summary>Lịch trình, phương tiện và wave</summary>
      <Timeline waves={row.timeline} />
    </details>
    <details>
      <summary>Nguồn dữ liệu và kết quả kiểm tra</summary>
      <p>Thời gian · {row.provenance.time_source}<br />Chi phí · {row.provenance.price_source}</p>
      {versions.map(source => <p key={[source.version, source.valid_from, source.valid_to].join('|')}>
        {source.version}{source.valid_from ? ' · ' + deliveryDate(source.valid_from) : ''}
        {source.valid_to ? ' đến ' + deliveryDate(source.valid_to) : ''}
      </p>)}
      {[...sources].map(([key, { record, stages }]) => <details key={key}>
        <summary>{stages.join(' / ')} · {record.kind} #{record.id} · {record.provenance}</summary>
        <p>{record.version}{record.valid_from ? ' · ' + deliveryDate(record.valid_from) : ''}
          {record.valid_to ? ' đến ' + deliveryDate(record.valid_to) : ''}</p>
        <p>{record.source_reference}</p>
        <code>{record.fingerprint}</code>
      </details>)}
      {Object.entries(row.warnings).flatMap(([stage, warnings]) =>
        [...new Set(warnings.map(warning => warning.code))].map(code => <p key={stage + code}>{stage.toUpperCase()} · {code}</p>))}
      <Trace values={{
        'Mã phương án F2': row.plan.plan_code,
        'Mã đánh giá F3': row.lineage.f3_evaluation_code,
        'Mã đánh giá F4': row.lineage.f4_evaluation_code,
        'Mã đánh giá F5': row.evaluation_code,
        ...Object.fromEntries(Object.entries(row.evidence_details.fingerprints).map(([key, value]) => ['SHA-256 ' + key, value])),
      }} />
    </details>
  </div>
}

export function DecisionPage() {
  const { runId, optionId } = useParams()
  const path = decisionPath + 'runs/' + runId + '/groups/' + encodeURIComponent(optionId ?? '') + '/'
  const query = useCallback(() => apiRequest<Workbench>(path), [path])
  const workbench = useDssQuery(query)
  const [selected, setSelected] = useState('')
  const [action, setAction] = useState<DecisionOutcome | ''>('')
  const [preset, setPreset] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [saved, setSaved] = useState<Decision | null>(null)
  const [review, setReview] = useState<{ option: Option; action: DecisionOutcome; reason: string } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const reviewButton = useRef<HTMLButtonElement>(null)
  const request = useRef<{ key: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const work = workbench.data
  const options = sortDecisionOptions(work?.options ?? [])
  const recommended = options.find(isComparableOption)
  const option = options.find(row => row.evaluation_code === selected)
  const reason = decisionReason(action, preset, note)
  const conflicts = work?.group?.conflicts ?? []
  const canReview = !conflicts.length && option && canReviewDecision(action, reason, option.approval.allowed)
  const sharedEvidence = options[0]?.provenance.classification
  const sharedLabel = sharedEvidence && options.every(row => row.provenance.classification === sharedEvidence)
    ? evidenceLabels[sharedEvidence] ?? sharedEvidence : ''

  function openReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!option || !action || !canReview || busy || refreshRequired) return
    setReview({ option, action, reason })
    setError('')
    dialog.current?.showModal()
  }

  function closeReview() {
    dialog.current?.close()
    setReview(null)
    reviewButton.current?.focus()
  }

  async function decide() {
    if (!review || inFlight.current || refreshRequired) return
    const payload = decisionPayload(review.option.evaluation_code, review.action, review.reason, review.option.approval.replaces)
    const key = JSON.stringify(payload)
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const result = await apiRequest<Decision>(path, { method: 'POST',
        body: JSON.stringify({ ...payload, request_id: request.current.id }) })
      setSaved(result)
      closeReview()
      setAction('')
      setPreset('')
      setNote('')
      request.current = null
      workbench.reload()
    } catch (err) {
      setError(message(err))
      if (err instanceof ApiError && err.status === 409) setRefreshRequired(true)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function reloadReview() {
    setRefreshRequired(false)
    setError('')
    setSelected('')
    closeReview()
    workbench.reload()
  }

  return <main className="dssr-page delivery-page manager-workspace">
    <header className="dssr-header"><div><Link to="/dss/decisions">← Danh sách phê duyệt</Link>
      <p className="dssr-eyebrow">COLOGI · CP09</p><h1>Quyết định phương án</h1>
      {work?.group && <p><strong>Run #{work.group.run_number} · Nhóm #{work.group.group_number}</strong>
        {' · '}{deliveryDate(work.group.service_date)} · {work.group.demand_count} nhu cầu · {weight(work.group.total_weight_kg)}</p>}
    </div></header>
    {workbench.loading && <p role="status">Đang tải phương án đã lưu…</p>}
    {workbench.error != null && <p className="dssr-alert" role="alert">{message(workbench.error)}</p>}
    {saved && <p className="dssr-panel" role="status">Đã lưu {decisions[saved.outcome].toLowerCase()}.
      {saved.final_plan_code && <> <Link to={'/dss/final-plans/' + saved.final_plan_code}>Mở FinalPlan</Link></>}</p>}
    {work && <>
      {work.group && <div className="dssr-panel delivery-group-overview">
        <span>{groupStatus(work.group)}</span>
        {work.group.publication && <Link to={'/dss/final-plans/' + work.group.publication.code}>Mở phiên bản {work.group.publication.version}</Link>}
        <Trace values={{ Run: work.group.run_code, Candidate: work.group.group_code }} />
      </div>}
      {conflicts.length > 0 && <section className="dssr-panel delivery-section" aria-label="Kế hoạch đang giữ nhu cầu">
        <h2>Nhu cầu đang được giữ</h2><Conflicts rows={conflicts} />
      </section>}
      <div className="manager-columns manager-decision-columns">
      <section className="dssr-panel delivery-section" aria-labelledby="delivery-compare"><h2 id="delivery-compare">So sánh các phương án đã lưu</h2>
        {!options.length && <p className="delivery-empty">Hãy lưu kết quả F5 trước khi ghi quyết định.</p>}
        {sharedLabel && <span className="delivery-chip">{sharedLabel}</span>}
        <div className="delivery-options" role="radiogroup" aria-labelledby="delivery-compare" data-conflict={Boolean(conflicts.length)}>
          {options.map(row => <article key={row.evaluation_code} data-selected={option?.evaluation_code === row.evaluation_code}>
          <label><input type="radio" name="option" value={row.evaluation_code}
            checked={option?.evaluation_code === row.evaluation_code} disabled={busy || conflicts.length > 0}
            onChange={() => {
              setSelected(row.evaluation_code)
              if (action === 'APPROVE' && !row.approval.allowed) {
                setAction('')
                setPreset('')
                setNote('')
              }
            }} />
            <strong>{optionName(row)}</strong>
          </label>
          <div className="delivery-card-labels"><span>Bản F2 v{row.plan.revision}</span>
            {recommended === row && <span className="delivery-chip">Đề xuất F5</span>}
            {!sharedLabel && <span className="delivery-chip">{evidenceLabels[row.provenance.classification] ?? row.provenance.classification}</span>}
          </div>
          <div className="delivery-prices">
            <span>Tổng chi phí</span><strong>{money(row.collaborative_cost, row.currency)}</strong>
            <dl>
              <div><dt>Giao độc lập</dt><dd>{money(row.baseline_cost, row.currency)}</dd></div>
              <div><dt>Tiết kiệm</dt><dd data-negative={Number(row.cost_saving) < 0}>
                {money(row.cost_saving, row.currency)}
                {row.saving_rate_pct != null && ' · ' + Number(row.saving_rate_pct).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + '%'}
              </dd></div>
            </dl>
          </div>
          <div className="delivery-card-state">
            {row.publication && <Link to={'/dss/final-plans/' + row.publication.code}>{publicationStatus(row.publication)}</Link>}
            <p data-allowed={row.approval.allowed}>{row.approval.allowed ? 'Đủ điều kiện phê duyệt'
              : approvalMessage(row.approval.code ?? 'DELIVERY_SOURCE_UNAVAILABLE')}</p>
          </div>
          {row.timeline.length > 0 && <small>F3–F4 · {row.timeline.length} wave · {runTime(row.timeline[0].start)} → {runTime(row.timeline.at(-1)?.end)}</small>}
          <OptionDetails row={row} />
          <Link to={'/dss/runs/' + runId + '/options/' + optionId + '/f5/' + row.lineage.f4_evaluation_code}>Xem chi tiết F5</Link>
        </article>)}</div>
      </section>
      {options.length > 0 && !conflicts.length && <section className="dssr-panel delivery-section"><h2>Ghi quyết định</h2>
        <ol className="manager-pipeline" aria-label="Quy trình DSS">
          {['Phối hợp nguồn hàng', 'Xây dựng phương án', 'Phân bổ phương tiện', 'Kiểm tra thời gian', 'Đánh giá chi phí']
            .map((label, index) => <li key={label}><strong>F{index + 1}</strong><span>{label}</span></li>)}
        </ol>
        {!option && <p>Chọn một phương án từ bảng so sánh để tiếp tục.</p>}
        <form className="delivery-decision-form" onSubmit={openReview}>
          <label className="delivery-reason">Hành động
            <select value={action} required disabled={!option || busy} onChange={event => {
              setAction(event.target.value as DecisionOutcome | '')
              setPreset('')
              setNote('')
            }}>
              <option value="">Chọn hành động</option>
              {(Object.keys(decisions) as DecisionOutcome[]).map(outcome => <option key={outcome} value={outcome}
                disabled={outcome === 'APPROVE' && !option?.approval.allowed}>{decisions[outcome]}</option>)}
            </select>
          </label>
          {action && <label className="delivery-reason">Lý do
            <select value={preset} required disabled={busy} onChange={event => {
              setPreset(event.target.value)
              setNote('')
            }}>
              <option value="">Chọn lý do</option>
              {decisionReasons[action].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>}
          {preset && <label className="delivery-reason">{preset === otherReason ? 'Lý do khác (bắt buộc)' : 'Ghi chú bổ sung (tùy chọn)'}
            <textarea value={note} required={preset === otherReason} maxLength={reasonLimit} disabled={busy}
              aria-invalid={reason.length > reasonLimit} onChange={event => setNote(event.target.value)} />
          </label>}
          {reason.length > reasonLimit && <p role="alert">Lý do và ghi chú được giới hạn ở 2.000 ký tự.</p>}
          <div className="delivery-actions">
            <button ref={reviewButton} className="dssr-primary-button" disabled={!canReview || busy || refreshRequired}>
              Xem lại quyết định
            </button>
            {refreshRequired && <button className="dssr-secondary-button" type="button" onClick={reloadReview}>Tải lại phương án</button>}
          </div>
        </form>
      </section>
      }
      </div>
      <section className="dssr-panel delivery-section"><h2>Lịch sử của nhóm</h2><Decisions rows={work.decisions} /></section>
    </>}
    <dialog ref={dialog} className="delivery-confirm" aria-labelledby="delivery-confirm-title"
      onCancel={event => { event.preventDefault(); if (!busy) closeReview() }}>
      <h2 id="delivery-confirm-title">Xác nhận quyết định</h2>
      {review && <dl>
        <div><dt>Phương án</dt><dd>{optionName(review.option)}</dd></div>
        <div><dt>Phiên bản</dt><dd>F2 v{review.option.plan.revision}
          {review.action === 'APPROVE' && ' · FinalPlan v' + review.option.approval.version}
          {review.action === 'APPROVE' && review.option.approval.replaces && ' · Thay thế phiên bản hiện hành'}</dd></div>
        <div><dt>Hành động</dt><dd>{decisions[review.action]}</dd></div>
        <div><dt>Lý do sẽ lưu</dt><dd className="delivery-saved-reason">{review.reason}</dd></div>
      </dl>}
      {error && <p className="dssr-alert" role="alert">{error}</p>}
      <div className="delivery-actions">
        <button autoFocus className="dssr-secondary-button" disabled={busy} onClick={closeReview}>Quay lại</button>
        {refreshRequired
          ? <button className="dssr-primary-button" disabled={busy} onClick={reloadReview}>Tải lại phương án</button>
          : <button className="dssr-primary-button" disabled={busy || !review} onClick={() => void decide()}>
            {busy ? 'Đang lưu…' : 'Xác nhận và lưu'}
          </button>}
      </div>
    </dialog>
  </main>
}

export function ProviderHandoversPage() {
  const query = useCallback(() => apiRequest<{ plans: Final[]; events?: PublicationEvent[] }>(carrierPath), [])
  const result = useDssQuery(query)
  return <main className="dssr-page delivery-page">
    <header className="dssr-header"><div><p className="dssr-eyebrow">COLOGI · CP10</p>
      <h1>Kế hoạch được bàn giao</h1></div></header>
    {result.loading && <p role="status">Đang tải kế hoạch…</p>}
    {result.error != null && <p role="alert" className="dssr-alert">{message(result.error)}</p>}
    {result.data && <PublicationEvents events={result.data.events ?? []} path="/provider/handovers" />}
    <section className="dssr-panel delivery-section">
      {result.data?.plans.length === 0 && <p>Chưa có kế hoạch gửi đến đơn vị của bạn.</p>}
      <ul className="delivery-records">{result.data?.plans.map(plan => <li key={plan.code}>
        <Link to={'/provider/handovers/' + plan.code}>Phiên bản {plan.version} · {deliveryDate(plan.service_date)}</Link>
        <span>{publicationStatus(plan)} · {plan.code}</span>
      </li>)}</ul>
    </section>
  </main>
}

export function FinalPlanPage({ provider = false }: { provider?: boolean }) {
  const { code } = useParams()
  const path = (provider ? carrierPath : finalPath) + code + '/'
  const query = useCallback(() => apiRequest<Detail>(path), [path])
  const result = useDssQuery(query)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const plan = result.data
  async function submit(outcome?: CarrierOutcome) {
    if (busy || !plan?.current || (provider && (!outcome || !reason.trim()))) return
    if (!provider && !window.confirm('Công bố phiên bản ' + plan.version + ' cho đơn vị vận chuyển, nhà cung cấp và bộ phận mua hàng liên quan?')) return
    setError('')
    setBusy(true)
    try {
      await apiRequest<Detail>(path + (provider ? 'response/' : 'handover/'), {
        method: 'POST',
        body: JSON.stringify(provider ? { outcome, reason: reason.trim() } : {}),
      })
      result.reload()
    } catch (err) { setError(message(err)) }
    finally { setBusy(false) }
  }
  const reply = plan?.handover?.response
  return <main className={'dssr-page delivery-page' + (!provider ? ' manager-workspace manager-print' : '')}>
    <header className="dssr-header"><div>
      <Link to={provider ? '/provider/handovers' : '/dss/final-plans'}>← Danh sách kế hoạch</Link>
      <p className="dssr-eyebrow">{provider ? 'COLOGI · CP10' : 'COLOGI · CP09'}</p>
      <h1>{plan ? 'Kế hoạch cuối cùng · v' + plan.version : 'Kế hoạch cuối cùng'}</h1>
      {plan && <p>{publicationStatus(plan)}</p>}
    </div></header>
    {result.loading && <p role="status">Đang tải phiên bản đã duyệt…</p>}
    {result.error != null && <p className="dssr-alert" role="alert">{message(result.error)}</p>}
    {plan && <>
      {!provider && <WorkspaceMetrics metrics={[
        { label: 'Tuyến / wave', value: plan.delivery.timeline.length },
        { label: 'Nhu cầu giao', value: plan.delivery.demands.length },
        { label: 'Khối lượng', value: weight(plan.delivery.total_weight_kg), tone: 'amber' },
        { label: 'Chi phí cuối cùng', value: money(plan.delivery.cost, plan.delivery.currency), tone: 'amber' },
      ]} />}
      <div className={provider ? 'delivery-page' : 'manager-columns manager-final-columns'}>
      <section className="dssr-panel delivery-section"><h2>Phiên bản đã duyệt</h2>
        <EvidenceNotice evidence={plan.provenance} />
        <p>{plan.provider_code} · {deliveryDate(plan.service_date)} · {weight(plan.delivery.total_weight_kg)}
          {' · '}{money(plan.delivery.cost, plan.delivery.currency)}</p>
        <p>Phê duyệt {runTime(plan.approved_at)}{plan.approved_by && ' · ' + plan.approved_by}</p>
        <p className="delivery-saved-reason">{plan.reason}</p>
        <h3>Tuyến, điểm lấy và điểm giao</h3>
        {provider && plan.publication && 'waves' in plan.publication
          ? <PublicationSchedule plan={plan.publication} /> : <Timeline waves={plan.delivery.timeline} stops={plan.delivery.stops} />}
        <h3>Nhu cầu và SKU</h3>
        <ul className="delivery-records">{plan.delivery.demands.map(row => <li key={row.id}>
          <details><summary>{row.code} · {row.supplier_code ?? 'Supplier #' + row.supplier_id} · {row.outlet_code} · {weight(row.required_weight_kg)}</summary>
            <ul>{row.items?.map(item => <li key={item.item_id}>
              {item.item_code ?? 'SKU #' + item.item_id} · Yêu cầu {weight(item.required_weight_kg)} · Xác nhận {weight(item.confirmed_weight_kg)}
            </li>)}</ul>
          </details>
        </li>)}</ul>
        <Trace values={{ FinalPlan: plan.code, Run: plan.run_code, Candidate: plan.group_code,
          'Thay thế': plan.supersedes_code ?? undefined, 'SHA-256': plan.snapshot_hash }} />
      </section>
      <section className="dssr-panel delivery-section"><h2>{provider ? 'Bàn giao và phản hồi' : 'Công bố và phản hồi'}</h2>
        <p>{publicationStatus(plan)}</p>
        {plan.handover && <p>Đã gửi {runTime(plan.handover.sent_at)} · Manager #{plan.handover.sent_by}</p>}
        {reply && <p>{reply.reason} · {runTime(reply.responded_at)} · Tài khoản #{reply.actor_id}</p>}
        {!provider && plan.publication && 'outlets' in plan.publication && <ManagerPublication publication={plan.publication} />}
        {!provider && !plan.handover && plan.current && plan.provider_code === 'TP001' &&
          <button className="dssr-primary-button" disabled={busy || result.loading} onClick={() => void submit()}>Công bố kế hoạch</button>}
        {!provider && <Link to={reviewRoute(plan.run_code, plan.group_code)}>
          {reply?.outcome === 'DECLINE' ? 'Mở nhóm để yêu cầu tính lại' : 'Quyết định của nhóm'}</Link>}
        {!provider && <button type="button" className="dssr-secondary-button" onClick={() => window.print()}>In / lưu PDF</button>}
        {provider && plan.current && !reply && <div>
          <label className="delivery-reason">Lý do hoặc nội dung xác nhận <textarea value={reason} disabled={busy}
            maxLength={2000} onChange={event => setReason(event.target.value)} /></label>
          <div className="delivery-actions">
            <button className="dssr-primary-button" disabled={!reason.trim() || busy || result.loading}
              onClick={() => void submit('CONFIRM')}>Xác nhận phiên bản</button>
            <button className="dssr-secondary-button" disabled={!reason.trim() || busy || result.loading}
              onClick={() => void submit('DECLINE')}>Từ chối</button>
          </div>
        </div>}
        {error && <p className="dssr-alert" role="alert">{error}</p>}
      </section>
      </div>
    </>}
  </main>
}

