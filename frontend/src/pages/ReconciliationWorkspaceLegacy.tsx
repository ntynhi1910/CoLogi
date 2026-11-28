import {
  ReconciliationFilters,
  ReconciliationTabs,
  ReconciliationPlanList,
  LogisticsReports,
} from './reconciliation/components/ReconciliationOverviewSections'

import RolePerformanceDashboard from './reconciliation/components/RolePerformanceDashboard'
import { useCallback, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/useAuth'
import { deliveryDate, runTime } from '../components/dss/f1Display'
import { ApiError, apiRequest, getToken } from '../services/api/client'
import { useDssQuery } from '../services/dss/useDssQuery'
import { PlanningResultNotices } from './foundation/LogisticsDashboard'
import './dss/DSSRunDetailPage.css'
import './dss/PlanDeliveryPage.css'
import './foundation/CoUI.css'
import './ReconciliationWorkspace.css'
import GoodsReconciliationDetail from './reconciliation/components/GoodsReconciliationDetail'

type Audience = 'manager' | 'supplier' | 'provider' | 'purchasing'
type Quantity = number | string | null
type Entity = { id: number; code: string | null; name: string | null }
type RecordRow = { id: number; action: string; actor: string; reason: string; at: string; mode: string; evidence: Record<string, string> }
type Allocation = { outlet_id: number; outlet_code: string; baseline_cost: Quantity; allocated_cost: Quantity; participant_saving: Quantity }
type Cost = { baseline_vnd: Quantity; planned_vnd: Quantity; actual_vnd: Quantity; variance_vnd: Quantity; planned_saving_vnd: Quantity;
  actual_saving_vnd: Quantity; status: string; claim: RecordRow | null; review: RecordRow | null;
  planned_allocations: Allocation[]; actual_allocations: Allocation[] | null;
  planned_components: {component_type: string; scope: string; amount: Quantity; source_reference: string}[] }
type PlanSummary = { code: string; version: number; date: string; status: string; current: boolean; template: string; mode: string;
  source: { classification: string; time_source?: string; price_source?: string }; provider: Entity; hub: Entity | null; cost: Cost | null;
  demands: number; planned_kg: Quantity; received_kg: Quantity }
type Line = { id: number; code: string; name: string; demand_id: number; demand_code: string; supplier: Entity; outlet: Entity }
  & Record<string, unknown>
type Issue = { key: string; demand_id: number; item_id: number | null; codes: string[]; fingerprint: string;
  unresolved_kg: Quantity; status: string; history: RecordRow[] }
type Detail = Omit<PlanSummary, 'demands'> & { execution_provenance: string; started: boolean; completed_delivery: boolean; closure: RecordRow | null;
  seal: string; closure_blockers: string[] | null; lines: Line[]; issues: Issue[];
  demands: { id: number; code: string; supplier: Entity; outlet: Entity; pickup_at: string | null; received_at: string | null }[];
  waves: { number: number; phase: string; vehicle: Entity; planned_load_kg: Quantity; peak_actual_load_kg: Quantity;
    planned_distance_km: Quantity; actual_distance_km: Quantity;
    stops: { sequence: number; role: string; code: string; start: string | null; end: string | null; demand_ids: number[];
      actual: { action: string; time: string; demand_id: number }[] }[] }[] }
type Overview = { mode: string; generated_at: string; plans: PlanSummary[]; kpis: Record<string, Quantity>;
  trends: (Record<string, Quantity> & {date: string})[]; templates: Record<string, Record<string, Quantity>>;
  facets: Record<string, Entity[]>; breakdown: Record<string, ({entity: Entity} & Record<string, Quantity | Entity>)[]> }

const roots = { manager: '/dss/reconciliation', provider: '/provider/reconciliation', supplier: '/supplier/reconciliation',
  purchasing: '/purchasing/reconciliation' }
const statuses: Record<string, string> = { AWAITING_EXECUTION: 'Chờ thực hiện', IN_PROGRESS: 'Đang thực hiện',
  PENDING_RECONCILIATION: 'Chờ đối soát', EXCEPTION: 'Có ngoại lệ', RECONCILED: 'Đã đối soát', COMPLETED: 'Hoàn thành',
  OPEN: 'Chờ xử lý', EVIDENCE_REQUESTED: 'Chờ bổ sung bằng chứng', RESOLVED: 'Đã xử lý',
  UNAVAILABLE: 'Chưa đối soát', SUBMITTED: 'Chờ Manager xác nhận', APPROVED: 'Đã xác nhận', RETURNED: 'Yêu cầu bổ sung' }
const labels: Record<string, string> = { SHORTAGE: 'Thiếu hàng', SHORT_PICKUP: 'Lấy thiếu', SURPLUS: 'Thừa hàng',
  CUSTODY_MISMATCH: 'Chênh lệch bàn giao', PICKUP_QUANTITY_MISMATCH: 'Lượng nhận khác lượng bàn giao',
  DAMAGED: 'Hàng hỏng', WRONG_SKU: 'Sai SKU', PICKUP_LATE: 'Lấy hàng trễ', DELIVERY_LATE: 'Giao hàng trễ',
  DELIVER: 'Giao hàng', RECEIVE: 'Kiểm nhận', HUB_RECEIVE: 'Nhập Hub', HUB_DISPATCH: 'Xuất Hub',
  READY: 'Hàng sẵn sàng', ARRIVE: 'Đến điểm dừng', SUPPLIER_HANDOVER: 'Supplier bàn giao',
  CARRIER_PICKUP: 'Vận chuyển xác nhận lấy', PICKUP_COMPLETE: 'Chốt lấy hàng', RECEIVE_COMPLETE: 'Kiểm nhận đủ',
  DELIVERY_IMPOSSIBLE: 'Không giao được', QUANTITY_MISMATCH: 'Số lượng không khớp',
  SUPPLIER_PICKUP: 'Lấy hàng', OUTLET_DELIVERY: 'Giao Outlet',
  ISSUE_REPORT: 'Ghi nhận ngoại lệ', ISSUE_REQUEST: 'Yêu cầu bổ sung bằng chứng', ISSUE_EVIDENCE: 'Bổ sung bằng chứng', ISSUE_RESOLVE: 'Phê duyệt xử lý',
  COST_SUBMIT: 'Khai báo chi phí', COST_APPROVE: 'Xác nhận chi phí', COST_RETURN: 'Trả lại khai báo',
  GOODS_PENDING: 'Chờ lượng xuất, bàn giao và kiểm nhận hợp lệ', COST_PENDING: 'Chờ xác nhận chi phí',
  UNRESOLVED_ISSUES: 'Còn ngoại lệ chưa xử lý', PLAN_INACTIVE: 'Kế hoạch không còn hiệu lực',
  COST_CLAIM_CHANGED: 'Khai báo đã thay đổi. Tải lại trước khi xác nhận.',
  ISSUE_QUANTITY_MUST_MATCH: 'Số lượng xử lý phải khớp số lượng đang chênh lệch.',
  SUPPLEMENTAL_RECEIPT_REQUIRED: 'Cần bản ghi kiểm nhận của Demand giao bổ sung đúng Supplier, Outlet và SKU.',
  RECONCILIATION_CHANGED: 'Bằng chứng đã thay đổi. Tải lại trước khi tiếp tục.' }
const dispositions = { ACCEPT_SHORT: 'Chấp nhận giao thiếu có lý do', RETURNED: 'Xác nhận đã hoàn trả',
  DAMAGED: 'Xác nhận hư hỏng', REFUSED: 'Xác nhận Outlet từ chối', SUPPLEMENTAL_DELIVERY: 'Đối chiếu giao bổ sung',
  RESOLVED_WITH_EVIDENCE: 'Xử lý theo bằng chứng' }
const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 })
const value = (input: unknown, suffix = '') => typeof input === 'number' || typeof input === 'string' && input !== ''
  ? number.format(Number(input)) + suffix : '—'
const status = (input: string) => statuses[input] ?? labels[input] ?? input
const modeLabel = (mode: string) => mode === 'SIMULATION' ? 'Mô phỏng' : mode === 'CAPSTONE' ? 'Capstone' : 'Vận hành'
const planName = (plan: PlanSummary | Detail) => plan.template === 'DIRECT' ? 'Direct Consolidated' : plan.hub?.code ?? 'Hub'
const errorMessage = (error: unknown) => {
  if (error instanceof ApiError) {
    const data = error.data as {code?: string} | null
    if (data?.code) return status(data.code)
    if (error.status === 403 || error.status === 404) return 'Dữ liệu chưa khả dụng hoặc nằm ngoài phạm vi được cấp.'
    if (error.status === 400) return 'Kiểm tra giá trị và thông tin bắt buộc.'
  }
  return 'Không tải hoặc lưu được dữ liệu. Vui lòng thử lại.'
}

function CostComparison({ cost, label, weight }: { cost: Cost; label: string; weight: Quantity }) {
  const max = Math.max(Number(cost.baseline_vnd), Number(cost.planned_vnd), Number(cost.actual_vnd), 1)
  return <section className="dssr-panel cp12-panel">
    <h2>So sánh chi phí · {label}</h2>
    {([['Baseline giao độc lập', cost.baseline_vnd], ['Chi phí kế hoạch DSS', cost.planned_vnd],
      ['Chi phí đã xác nhận', cost.actual_vnd]] as const).filter(([name, amount]) => name !== 'Baseline giao độc lập' || amount !== null)
      .map(([name, amount], index) => <div className="cp12-cost-bar" key={name}>
      <span>{name}</span><strong>{amount === null ? 'Chưa đối soát' : value(amount, ' đ')}</strong>
      {amount !== null && <progress data-series={index} aria-label={name} value={Number(amount)} max={max} />}
    </div>)}
    <dl className="cp12-key-values"><div><dt>Tiết kiệm dự kiến</dt><dd>{value(cost.planned_saving_vnd, ' đ')}</dd></div>
      <div><dt>Khối lượng kế hoạch</dt><dd>{value(weight, ' kg')}</dd></div></dl>
  </section>
}

function Audit({ records }: {records: RecordRow[]}) {
  return <ol className="cp12-audit">{records.map(row => <li key={row.id}><strong>{status(row.action)}</strong>
    <span>{row.actor} · {runTime(row.at)}</span><p>{row.reason}</p>
    {row.evidence.reference && <small>Bằng chứng · {row.evidence.reference}</small>}</li>)}</ol>
}

type Editor = { action: string; issue?: Issue }

function ReconciliationForm({ editor, plan, endpoint, cancel, reload }: {
  editor: Editor; plan: Detail; endpoint: string; cancel: () => void; reload: () => void
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [disposition, setDisposition] = useState('')
  const requestKey = useRef<{ body: string; id: string } | null>(null)
  const { action, issue } = editor
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const values = new FormData(event.currentTarget)
    const field = (key: string) => String(values.get(key) ?? '').trim()
    const data: Record<string, unknown> = {}
    if (issue) data.target = issue.key
    if (action === 'ISSUE_REQUEST' || action === 'ISSUE_RESOLVE') data.issue_fingerprint = issue?.fingerprint
    if (action === 'ISSUE_REQUEST') data.audience = field('audience')
    if (['ISSUE_RESOLVE', 'ISSUE_EVIDENCE', 'ISSUE_REPORT', 'COST_SUBMIT'].includes(action)) data.reference = field('reference')
    if (action === 'ISSUE_REPORT') {
      data.demand_id = Number(field('demand_id'))
      data.issue_type = field('issue_type')
      if (field('sku_code')) data.sku_code = field('sku_code')
      if (field('quantity')) data.reported_kg = field('quantity')
    }
    if (action === 'ISSUE_RESOLVE') {
      data.disposition = disposition
      if (issue?.unresolved_kg != null) data.quantity_kg = field('quantity')
      if (disposition === 'SUPPLEMENTAL_DELIVERY') {
        data.supplemental_plan = field('supplemental_plan'); data.supplemental_demand = Number(field('supplemental_demand'))
      }
    }
    if (action === 'CLOSE') data.seal = plan.seal
    if (action === 'COST_APPROVE' || action === 'COST_RETURN') data.target = String(plan.cost?.claim?.id)
    if (action === 'COST_SUBMIT') {
      data.transport = field('transport'); data.hub = field('hub') || '0'; data.additional = field('additional')
      data.distances = Object.fromEntries(plan.waves.map(wave => [String(wave.number), field('km' + wave.number)]).filter(([, km]) => km))
    }
    const body = { action, data, reason: field('reason') }
    const signature = JSON.stringify(body)
    if (requestKey.current?.body !== signature) requestKey.current = { body: signature, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      await apiRequest(endpoint, { method: 'POST', body: JSON.stringify({ ...body, request_id: requestKey.current.id }) })
      reload(); cancel()
    } catch (error) {
      setError(errorMessage(error))
    } finally { setBusy(false) }
  }
  return <form className="cp12-entry" onSubmit={submit}>
    <h3>{action === 'CLOSE' ? 'Xác nhận đóng FinalPlan' : status(action)}</h3>
    {action === 'ISSUE_REQUEST' && <label>Bên cung cấp bằng chứng<select name="audience" required defaultValue="">
      <option value="">Chọn đơn vị</option><option value="supplier">Supplier</option><option value="provider">Vận chuyển</option>
      <option value="purchasing">Purchasing / Outlet</option></select></label>}
    {action === 'ISSUE_REPORT' && <div className="cp12-fields">
      <label>Demand<select name="demand_id" defaultValue="" required><option value="">Chọn Demand</option>
        {plan.demands.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}</select></label>
      <label>Loại ngoại lệ<select name="issue_type" defaultValue="" required><option value="">Chọn loại ngoại lệ</option>
        {['SHORTAGE', 'SURPLUS', 'DAMAGED', 'WRONG_SKU', 'PICKUP_LATE', 'DELIVERY_LATE', 'DELIVERY_IMPOSSIBLE',
          'QUANTITY_MISMATCH'].map(key => <option key={key} value={key}>{status(key)}</option>)}</select></label>
      <label>Mã SKU (nếu có)<input name="sku_code" maxLength={40} /></label>
      <label>Lượng báo cáo (kg, nếu có)<input name="quantity" type="number" min="0" step=".001" /></label>
    </div>}
    {action === 'ISSUE_RESOLVE' && <>
      <label>Phương án xử lý<select value={disposition} onChange={event => setDisposition(event.target.value)} required>
        <option value="">Chọn phương án</option>{Object.entries(dispositions).filter(([key]) =>
          issue?.unresolved_kg == null ? key === 'RESOLVED_WITH_EVIDENCE' : key !== 'RESOLVED_WITH_EVIDENCE',
        ).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></label>
      {issue?.unresolved_kg != null && <label>Số lượng đối soát (kg)<input name="quantity" type="number" step=".001"
        min=".001" max={Number(issue.unresolved_kg)} defaultValue={issue.unresolved_kg} required /></label>}
      {disposition === 'SUPPLEMENTAL_DELIVERY' && <><label>Mã FinalPlan giao bổ sung<input name="supplemental_plan" required /></label>
        <label>ID Demand giao bổ sung<input type="number" min="1" name="supplemental_demand" required /></label></>}
    </>}
    {action === 'COST_SUBMIT' && <div className="cp12-fields">{([['transport', 'Vận chuyển'], ['hub', 'Xử lý Hub'], ['additional', 'Phụ phí']] as const)
      .map(([field, name]) => <label key={field}>{name} (VND)<input name={field} type="number" min="0" step="1"
        disabled={field === 'hub' && plan.template === 'DIRECT'} required /></label>)}
      {plan.waves.map(wave => <label key={wave.number}>Wave {wave.number} thực tế (km, nếu có)<input name={'km' + wave.number}
        type="number" min="0" step=".001" /></label>)}</div>}
    {['ISSUE_RESOLVE', 'ISSUE_EVIDENCE', 'ISSUE_REPORT', 'COST_SUBMIT'].includes(action) &&
      <label>Tham chiếu bằng chứng<input name="reference" required maxLength={240} /></label>}
    <label>Lý do / nội dung<textarea name="reason" required maxLength={500} rows={2} /></label>
    {error && <p role="alert" className="dssr-alert">{error}</p>}
    <div className="delivery-actions"><button className="dssr-primary-button" disabled={busy}>Xác nhận ghi</button>
      <button className="dssr-secondary-button" type="button" disabled={busy} onClick={cancel}>Hủy</button></div>
  </form>
}

function PlanDetail({ plan, audience, endpoint, reload }: {plan: Detail; audience: Audience; endpoint: string; reload: () => void}) {
  const [editor, setEditor] = useState<Editor>()
  const section = useRef<HTMLElement>(null)
  const write = plan.current && plan.status !== 'COMPLETED'
  const edit = (action: string, issue?: Issue) => {
    setEditor({ action, issue })
    section.current?.scrollIntoView({ block: 'start' })
  }
  return <>
    <section ref={section} className="dssr-panel cp12-panel">
      <h2>{planName(plan)} · v{plan.version}</h2>
      <p>{deliveryDate(plan.date)} · {plan.provider.code} · {status(plan.status)} · {modeLabel(plan.mode)} · {plan.source.classification}</p>
      <p>Giao nhận · {plan.completed_delivery ? 'Đã kiểm nhận đủ' : 'Chưa kiểm nhận đủ'}</p>
      {audience === 'manager' && plan.closure_blockers?.length ? <p>{plan.closure_blockers.map(status).join(' · ')}</p> : null}
      {plan.closure && <p>Đã đóng bởi {plan.closure.actor} · {runTime(plan.closure.at)} · {plan.closure.reason}</p>}
      {write && audience === 'manager' && plan.status === 'RECONCILED' &&
        <button className="dssr-primary-button" onClick={() => edit('CLOSE')}>Đóng FinalPlan</button>}
      {editor && <ReconciliationForm key={editor.action + (editor.issue?.key ?? '')} editor={editor} plan={plan}
        endpoint={endpoint} cancel={() => setEditor(undefined)} reload={reload} />}
    </section>
    <section className="dssr-panel cp12-panel">
      <h2>Đối soát giao nhận theo SKU</h2>
      <GoodsReconciliationDetail
  audience={audience}
  lines={plan.lines}
  issues={plan.issues}
/>
      <div className="cp12-scroll" tabIndex={0} aria-label="Đối soát theo SKU"><table><thead><tr>
        {['Demand · Tuyến', 'SKU', 'Kế hoạch', 'Bàn giao', 'Vận chuyển nhận', 'Xuất kho', 'Nhập Hub', 'Ra Hub', 'Giao Outlet',
          'Chấp nhận', 'Thiếu', 'Thừa', 'Hỏng', 'Từ chối', 'Hoàn trả', 'Chưa đối soát'].map(name => <th key={name}>{name}</th>)}
      </tr></thead><tbody>{plan.lines.map(row => <tr key={row.demand_id + ':' + row.id}>
        <th scope="row">{row.demand_code}<small>{row.supplier.code} → {row.outlet.code}</small></th><td>{row.code}<small>{row.name}</small></td>
        {['planned', 'supplier_handover', 'carrier_pickup', 'shipped', 'hub_received', 'hub_dispatched', 'delivered', 'received',
          'shortage', 'excess', 'damaged', 'refused', 'returned', 'unreconciled'].map(key => <td key={key}>{value(row[key + '_kg'], ' kg')}</td>)}
      </tr>)}</tbody></table></div>
    </section>
    <section className="dssr-panel cp12-panel"><h2>Tiến độ theo wave và điểm dừng</h2>
      {plan.waves.map(wave => <details key={wave.number} className="cp12-detail">
        <summary>Wave {wave.number} · {wave.phase} · {wave.vehicle.code}</summary>
        <p>Tải kế hoạch {value(wave.planned_load_kg, ' kg')} · Tải thực tế đỉnh {value(wave.peak_actual_load_kg, ' kg')}
          {' '}· Chặng kế hoạch {value(wave.planned_distance_km, ' km')} · Thực tế {value(wave.actual_distance_km, ' km')}</p>
        <ul>{wave.stops.map(stop => <li key={stop.sequence}><strong>{status(stop.role)} · {stop.code}</strong>
          <p>Kế hoạch {runTime(stop.start)} – {runTime(stop.end)}</p>
          <p>Giao nhận {stop.actual.length ? stop.actual.map(row => status(row.action) + ' · ' +
            (plan.demands.find(demand => demand.id === row.demand_id)?.code ?? '') + ' · ' + runTime(row.time)).join('; ') : '—'}</p></li>)}</ul>
      </details>)}
    </section>
    <section className="dssr-panel cp12-panel" id="cp12-issues"><h2>Ngoại lệ và bằng chứng</h2>
      {write && plan.started && <button className="dssr-secondary-button" onClick={() => edit('ISSUE_REPORT')}>Ghi nhận ngoại lệ</button>}
      {!plan.issues.length && <p>Chưa ghi nhận ngoại lệ trong phạm vi này.</p>}
      {plan.issues.map(issue => <details key={issue.key} className="cp12-detail">
        <summary>{plan.demands.find(row => row.id === issue.demand_id)?.code} · {issue.codes.map(status).join(', ')} · {status(issue.status)}</summary>
        {issue.unresolved_kg != null && <p>Chênh lệch ghi nhận {value(issue.unresolved_kg, ' kg')}</p>}
        <Audit records={issue.history} />
        {write && issue.status !== 'RESOLVED' && <div className="delivery-actions">
          {audience === 'manager' ? <><button className="dssr-secondary-button" onClick={() => edit('ISSUE_REQUEST', issue)}>Yêu cầu bằng chứng</button>
            <button className="dssr-secondary-button" onClick={() => edit('ISSUE_RESOLVE', issue)}>Phê duyệt xử lý</button></>
            : <button className="dssr-secondary-button" onClick={() => edit('ISSUE_EVIDENCE', issue)}>Nộp bằng chứng</button>}
        </div>}
      </details>)}
    </section>
    {plan.cost && <>
      <CostComparison cost={plan.cost} label={'FinalPlan v' + plan.version}
        weight={plan.lines.reduce((sum, row) => sum + Number(row.planned_kg), 0)} />
      <section className="dssr-panel cp12-panel" id="cp12-cost">
        <h2>Đối soát chi phí</h2><p>{status(plan.cost.status)} · Chênh lệch {value(plan.cost.variance_vnd, ' đ')}
          {' '}· Tiết kiệm thực tế {value(plan.cost.actual_saving_vnd, ' đ')}</p>
        {plan.cost.claim && <p>Đã khai · Vận chuyển {value(plan.cost.claim.evidence.transport, ' đ')} · Hub {value(plan.cost.claim.evidence.hub, ' đ')}
          {' '}· Phụ phí {value(plan.cost.claim.evidence.additional, ' đ')}</p>}
        <Audit records={[plan.cost.claim, plan.cost.review].filter((row): row is RecordRow => row !== null)} />
        {write && plan.started && audience === 'provider' && plan.cost.status !== 'APPROVED' && <button className="dssr-secondary-button"
          onClick={() => edit('COST_SUBMIT')}>Khai báo chi phí thực hiện</button>}
        {write && audience === 'manager' && plan.cost.status === 'SUBMITTED' && <div className="delivery-actions">
          <button className="dssr-secondary-button" onClick={() => edit('COST_RETURN')}>Trả lại khai báo</button>
          <button className="dssr-primary-button" onClick={() => edit('COST_APPROVE')}>Xác nhận chi phí</button>
        </div>}
        <details><summary>Chi tiết cấu phần và phân bổ</summary>
          <ul>{plan.cost.planned_components.map((row, index) => <li key={index}>{row.component_type} · {row.scope}
            {' '}· {value(row.amount, ' đ')}<small>{row.source_reference}</small></li>)}</ul>
          <ul>{plan.cost.planned_allocations.map(row => <li key={row.outlet_id}>{row.outlet_code} · Kế hoạch {value(row.allocated_cost, ' đ')}
            {' '}· Đã đối soát {value(plan.cost?.actual_allocations?.find(allocated => allocated.outlet_id === row.outlet_id)?.allocated_cost, ' đ')}</li>)}</ul>
        </details>
      </section>
    </>}
  </>
}

type PerformanceGroup = 'supplier' | 'outlet' | 'provider'

function ManagerPerformance({
  overview,
  mode,
}: {
  overview: Overview
  mode: string
}) {
  const [group, setGroup] = useState<PerformanceGroup>('outlet')

  const mainMetrics = [
    {
      key: 'on_time_delivery_pct',
      label: 'Giao đúng hạn',
      help: 'Theo thời gian kiểm nhận thực tế',
    },
    {
      key: 'otif_pct',
      label: 'Giao đủ và đúng hạn (OTIF)',
      help: 'Đúng khối lượng và thời gian',
    },
    {
      key: 'fill_pct',
      label: 'Tỷ lệ đáp ứng',
      help: 'Theo lượng hàng Outlet chấp nhận',
    },
    {
      key: 'load_factor_pct',
      label: 'Sử dụng tải trọng',
      help: 'Theo tải trọng thực tế các wave',
    },
  ] as const

  const supportingMetrics = [
    { key: 'final_plans', label: 'FinalPlan hiện hành', suffix: '' },
    { key: 'demands', label: 'Nhu cầu', suffix: '' },
    { key: 'received_kg', label: 'Đã nhận', suffix: ' kg' },
    { key: 'exception_pct', label: 'Tỷ lệ ngoại lệ', suffix: '%' },
  ] as const

  const groups: { key: PerformanceGroup; label: string }[] = [
    { key: 'supplier', label: 'Nhà cung cấp' },
    { key: 'outlet', label: 'Outlet' },
    { key: 'provider', label: 'Đơn vị vận chuyển' },
  ]

  const currentGroup = overview.breakdown[group] ?? []
  const recentTrends = overview.trends.slice(-7)
  const currentPlans = overview.plans.filter(plan => plan.current)

  const percentValue = (key: string) => {
    const raw = overview.kpis[key]
    if (raw === null || raw === undefined || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }

  return (
    <div className="cp12-performance">
      <section className="dssr-panel cp12-panel">
        <div className="cp12-section-heading">
          <div>
            <h2>Chất lượng vận hành</h2>
            <p>
              Kết quả thực tế theo bộ lọc đang áp dụng.
              Chỉ số chưa đủ bằng chứng sẽ hiển thị dấu —.
            </p>
          </div>
          <span className="cp12-context-label">{modeLabel(mode)}</span>
        </div>

        <div className="cp12-performance-main-kpis">
          {mainMetrics.map(metric => {
            const n = percentValue(metric.key)
            return (
              <article className="cp12-performance-kpi" key={metric.key}>
                <span>{metric.label}</span>
                <strong>
                  {n === null ? '—' : value(n, '%')}
                </strong>
                <small>
                  {n === null
                    ? 'Chưa đủ dữ liệu thực hiện'
                    : metric.help}
                </small>
              </article>
            )
          })}
        </div>

        <div className="cp12-performance-supporting">
          {supportingMetrics.map(metric => (
            <div key={metric.key}>
              <span>{metric.label}</span>
              <strong>
                {value(overview.kpis[metric.key], metric.suffix)}
              </strong>
            </div>
          ))}
        </div>
      </section>

      <section className="dssr-panel cp12-panel">
        <div className="cp12-section-heading">
          <div>
            <h2>Hiệu suất theo đơn vị</h2>
            <p>Chọn nhóm để đối chiếu cùng một bộ chỉ số.</p>
          </div>
        </div>

        <div
          className="cp12-group-switch"
          role="group"
          aria-label="Nhóm đơn vị"
        >
          {groups.map(item => (
            <button
              type="button"
              key={item.key}
              aria-pressed={group === item.key}
              onClick={() => setGroup(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="cp12-scroll">
          <table className="cp12-performance-table">
            <thead>
              <tr>
                <th scope="col">Đơn vị</th>
                <th scope="col">Nhu cầu</th>
                <th scope="col">Lấy đúng hạn</th>
                <th scope="col">Giao đúng hạn</th>
                <th scope="col">OTIF</th>
                <th scope="col">Đã nhận</th>
              </tr>
            </thead>
            <tbody>
              {currentGroup.map(row => (
                <tr key={row.entity.id}>
                  <th scope="row">
                    {row.entity.code}
                    {row.entity.name && (
                      <small>{row.entity.name}</small>
                    )}
                  </th>
                  <td>{value(row.demands)}</td>
                  <td>{value(row.on_time_pickup_pct, '%')}</td>
                  <td>{value(row.on_time_delivery_pct, '%')}</td>
                  <td>{value(row.otif_pct, '%')}</td>
                  <td>{value(row.received_kg, ' kg')}</td>
                </tr>
              ))}

              {currentGroup.length === 0 && (
                <tr>
                  <td colSpan={6} className="cp12-empty-table">
                    Chưa có đơn vị trong phạm vi đã lọc.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dssr-panel cp12-panel">
        <div className="cp12-section-heading">
          <div>
            <h2>Xu hướng và phương án vận chuyển</h2>
            <p>So sánh Direct và Hub theo kết quả thực tế.</p>
          </div>
        </div>

        <div className="cp12-template-grid">
          {(['DIRECT', 'HUB'] as const).map(type => {
            const summary = overview.templates[type]
            return (
              <div className="cp12-template-item" key={type}>
                <strong>{type === 'DIRECT' ? 'Direct' : 'Qua Hub'}</strong>

                <div>
                  <span>FinalPlan</span>
                  <b>{value(summary?.final_plans)}</b>
                </div>

                <div>
                  <span>OTIF</span>
                  <b>{value(summary?.otif_pct, '%')}</b>
                </div>

                <div>
                  <span>Đã nhận</span>
                  <b>{value(summary?.received_kg, ' kg')}</b>
                </div>
              </div>
            )
          })}
        </div>

        {recentTrends.length > 0 && (
          <div className="cp12-trend-section">
            <h3>Xu hướng OTIF gần đây</h3>

            <div className="cp12-trend">
              {recentTrends.map(day => {
                const raw = day.otif_pct
                const n = raw == null ? null : Number(raw)
                const valid = n !== null && Number.isFinite(n)

                return (
                  <div key={day.date}>
                    <span>{deliveryDate(day.date)}</span>

                    {valid ? (
                      <progress
                        value={Math.max(0, Math.min(100, n))}
                        max={100}
                        aria-label={`OTIF ${deliveryDate(day.date)}`}
                      />
                    ) : (
                      <span className="cp12-trend-empty">
                        Chưa có dữ liệu
                      </span>
                    )}

                    <strong>{value(raw, '%')}</strong>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <section className="dssr-panel cp12-panel">
        <div className="cp12-section-heading">
          <div>
            <h2>FinalPlan đang theo dõi</h2>
            <p>
              Mở phương án để kiểm tra quá trình thực hiện
              và tình trạng đối soát.
            </p>
          </div>
          <span className="cp12-context-label">
            {currentPlans.length} phương án
          </span>
        </div>

        <div className="cp12-performance-plans">
          {currentPlans.map(plan => (
            <Link
              key={plan.code}
              className="cp12-performance-plan"
              to={`${roots.manager}/${plan.code}?mode=${mode}`}
            >
              <div>
                <strong>{planName(plan)} · v{plan.version}</strong>
                <small>
                  {deliveryDate(plan.date)}
                  {' · '}
                  {plan.demands} nhu cầu
                  {' · '}
                  {value(plan.planned_kg, ' kg')}
                </small>
              </div>

              <span className="cp12-badge">
                {status(plan.status)}
              </span>
            </Link>
          ))}

          {currentPlans.length === 0 && (
            <p className="cp12-empty-message">
              Chưa có FinalPlan hiện hành trong phạm vi lọc.
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
export default function ReconciliationWorkspace({ audience }: {audience: Audience}) {
  const { user } = useAuth()
  const { code } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'performance'
  const [exportError, setExportError] = useState('')
  const mode = user?.capstone_scenario ? 'CAPSTONE' : params.get('mode') === 'SIMULATION' ? 'SIMULATION' : 'COMMERCIAL_EXECUTION'
  const q = new URLSearchParams(params)
  q.delete('tab')
  q.set('mode', mode)
  const endpoint = '/planning/reconciliation/' + audience + '/' + (code ? code + '/' : '') + '?' + q
  const query = useDssQuery(useCallback(() => apiRequest<Detail | Overview>(endpoint), [endpoint]))
  const data = query.data
  const overview = data && 'kpis' in data ? data : undefined
  const plan = data && 'lines' in data ? data : undefined
  const sample = overview?.plans.find(row => row.current && row.cost)
  function filter(field: string, next: string) {
    const updated = new URLSearchParams(params)
    if (next) updated.set(field, next)
    else updated.delete(field)
    setParams(updated)
  }
  async function download(kind: string) {
    setExportError('')
    try {
      const response = await fetch('/api' + endpoint + '&export=' + kind, { headers: { Authorization: 'Token ' + getToken() } })
      if (!response.ok) throw new Error()
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url; link.download = 'cologi-logistics.' + kind; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setExportError('Không xuất được báo cáo.') }
  }

return <main
  className={`dssr-page cp12 cp12--${audience}`}
  data-active-tab={tab}
>
  <header className="cp12-page-header">
    <div className="cp12-page-heading">
      {audience !== 'supplier' && (
    <span className="cp12-eyebrow">
      COLOGI · LOGISTICS CONTROL CENTER
    </span>
  )}
      <h1>
        {audience === 'supplier'
          ? 'Hiệu suất cung ứng'
          : audience === 'manager'
            ? 'Hiệu suất & Đối soát logistics'
            : 'Lịch sử giao nhận & Đối soát'}
      </h1>

      <p>
        {audience === 'supplier'
          ? 'Theo dõi kết quả cung ứng, tiến độ xuất hàng và chất lượng thực hiện kế hoạch.'
          : 'Theo dõi hiệu suất vận hành, giao nhận, chi phí và các vấn đề cần xử lý.'}
      </p>
    </div>

    <div className="cp12-header-actions">
      {code && (
        <Link
          className="cp12-header-link"
          to={roots[audience] + '?mode=' + mode}
        >
          ← Danh sách FinalPlan
        </Link>
      )}

      {audience === 'supplier' && (
        <Link
          className="cp12-header-link"
          to="/supplier/inventory"
        >
          Xem lịch sử tồn kho
        </Link>
      )}
    </div>
  </header>

    {query.loading && <p role="status">Đang tải đối soát…</p>}
    {query.error != null && <p role="alert" className="dssr-alert">{errorMessage(query.error)}</p>}
    {overview && <>

<ReconciliationFilters
  audience={audience}
  params={params}
  facets={overview.facets}
  onFilter={filter}
  onReset={() => {
    const updated = new URLSearchParams()
    updated.set('tab', tab)
    updated.set('mode', mode)
    setParams(updated)
  }}
/>


<ReconciliationTabs
  audience={audience}
  active={tab}
  onChange={nextTab => filter('tab', nextTab)}
/>


{tab === 'performance' && audience === 'manager' && (
  <ManagerPerformance overview={overview} mode={mode} />
)}


{tab === 'performance' && audience !== 'manager' && (
  <>
    <RolePerformanceDashboard
      audience={audience}
      overview={overview}
      mode={mode}
    />

    {sample?.cost && (
      <CostComparison
        cost={sample.cost}
        label={'FinalPlan v' + sample.version}
        weight={sample.planned_kg}
      />
    )}

    <PlanningResultNotices
      audience={audience}
      plans={overview.plans}
    />
  </>
)}


{tab === 'reports' && (
  <LogisticsReports
    audience={audience}
    overview={overview}
    mode={mode}
    from={params.get('from_date') ?? ''}
    to={params.get('to_date') ?? ''}
    exportError={exportError}
    onDownload={kind => {
      void download(kind)
    }}
  />
)}

      
{tab !== 'reports' &&
  tab !== 'performance' && (
    <ReconciliationPlanList
      audience={audience}
      tab={tab}
      mode={mode}
      plans={overview.plans}
    />
  )}

    </>}
    {plan && <PlanDetail key={plan.code + plan.mode} plan={plan} audience={audience} endpoint={endpoint} reload={query.reload} />}
  </main>
}
