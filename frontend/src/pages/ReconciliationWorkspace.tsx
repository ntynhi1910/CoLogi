import { useCallback, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/useAuth'
import { deliveryDate, runTime } from '../components/dss/f1Display'
import { ApiError, apiRequest, getToken } from '../services/api/client'
import { useDssQuery } from '../services/dss/useDssQuery'
import './dss/DSSRunDetailPage.css'
import './dss/PlanDeliveryPage.css'
import './ReconciliationWorkspace.css'

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

const metricFields = [
  ['on_time_delivery_pct', 'Giao đúng hạn', '%', 'Demand kiểm nhận trong khung yêu cầu / Demand có kiểm nhận và khung giờ hợp lệ'],
  ['otif_pct', 'Giao đủ và đúng hạn', '%', 'Demand nhận đủ từng SKU và đúng khung / Demand kiểm nhận có khung giờ hợp lệ'],
  ['fill_pct', 'Tỷ lệ đáp ứng', '%', 'Kg Outlet chấp nhận, tối đa lượng kế hoạch mỗi SKU / kg đã có kiểm nhận theo SKU'],
  ['load_factor_pct', 'Sử dụng tải trọng', '%', 'Tổng tải đồng thời đỉnh / tổng sức chứa các wave đã ghi nhận chuyển hàng'],
  ['planned_saving_pct', 'Tiết kiệm dự kiến', '%', 'Baseline trừ chi phí F5 / baseline của phương án hiện hành'],
  ['actual_saving_pct', 'Tiết kiệm thực tế', '%', 'Baseline trừ chi phí đã xác nhận / baseline của cùng tập phương án'],
  ['final_plans', 'FinalPlan hiện hành', '', 'Số phiên bản đã được Transport xác nhận còn hiệu lực'],
  ['demands', 'Nhu cầu', '', 'Số Demand khác nhau trong tập lọc'],
  ['shipped_kg', 'Đã xuất', ' kg', 'Chỉ tính pickup hai bên đã xác nhận'],
  ['received_kg', 'Đã nhận', ' kg', 'Lượng Outlet chấp nhận ở lần kiểm nhận mới nhất tại từng điểm dừng'],
  ['completion_pct', 'Hoàn thành giao nhận', '%', 'Demand nhận đủ theo SKU / Demand trong phạm vi hiện hành khi đã có thực hiện'],
  ['on_time_pickup_pct', 'Lấy đúng hạn', '%', 'Demand lấy trong khung sẵn sàng / Demand có xác nhận pickup và khung giờ'],
  ['actual_cost_per_kg', 'Chi phí trên mỗi kg', ' đ/kg', 'Chi phí đã xác nhận / kg nhận của cùng các kế hoạch'],
  ['exception_pct', 'Tỷ lệ ngoại lệ', '%', 'Demand có ngoại lệ ghi nhận / số Demand hiện hành khi đã có thực hiện'],
  ['average_delivery_delay_min', 'Giao trễ trung bình', ' phút', 'Phút sau hạn nhận, trung bình trên Demand đã kiểm nhận có khung giờ'],
] as const

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
  return <main className="dssr-page cp12">
    <header><h1>{audience === 'manager' ? 'Đối soát & Hiệu suất logistics' : 'Lịch sử giao nhận & Đối soát'}</h1>
      {code && <Link to={roots[audience] + '?mode=' + mode}>Về danh sách FinalPlan</Link>}
      {audience === 'supplier' && <Link to="/supplier/inventory">Xem lịch sử tồn kho</Link>}
      <label>Chế độ<select value={mode} onChange={event => filter('mode', event.target.value)} disabled={mode === 'CAPSTONE'}>
        {mode === 'CAPSTONE' ? <option value="CAPSTONE">Capstone</option> : <>
          <option value="COMMERCIAL_EXECUTION">Vận hành</option><option value="SIMULATION">Mô phỏng</option></>}</select></label>
    </header>
    {query.loading && <p role="status">Đang tải đối soát…</p>}
    {query.error != null && <p role="alert" className="dssr-alert">{errorMessage(query.error)}</p>}
    {overview && <>
      <section className="dssr-panel cp12-panel cp12-fields" aria-label="Bộ lọc hiệu suất">
        <label>Từ ngày<input type="date" value={params.get('from_date') ?? ''} onChange={event => filter('from_date', event.target.value)} /></label>
        <label>Đến ngày<input type="date" value={params.get('to_date') ?? ''} onChange={event => filter('to_date', event.target.value)} /></label>
        <label>Phương án<select value={params.get('template') ?? ''} onChange={event => filter('template', event.target.value)}>
          <option value="">Tất cả</option><option value="DIRECT">Direct</option><option value="HUB">Hub</option></select></label>
        <label>FinalPlan<input type="search" placeholder="Dán mã FinalPlan" defaultValue={params.get('plan') ?? ''}
          onBlur={event => filter('plan', event.target.value.trim())} /></label>
        <label>Trạng thái<select value={params.get('status') ?? ''} onChange={event => filter('status', event.target.value)}>
          <option value="">Tất cả</option>{Object.entries(statuses).slice(0, 6).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        {([['supplier', 'Supplier'], ['outlet', 'Outlet']] as const).filter(([key]) => key !== audience && !(key === 'outlet' && audience === 'purchasing'))
          .map(([key, title]) => <label key={key}>{title}<select value={params.get(key) ?? ''} onChange={event => filter(key, event.target.value)}>
            <option value="">Tất cả</option>{params.get(key) && !overview.facets[key].some(row => String(row.id) === params.get(key)) &&
              <option value={params.get(key) ?? ''}>Phạm vi đã chọn</option>}
            {overview.facets[key].map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
          </select></label>)}
      </section>
      <nav className="cp12-switch" aria-label="Chức năng đối soát">
        {Object.entries({ performance: 'Hiệu suất logistics', goods: 'Đối soát giao nhận',
          ...(audience === 'manager' || audience === 'provider' ? { costs: 'Đối soát chi phí' } : {}),
          ...(audience === 'manager' ? { exceptions: 'Quản lý ngoại lệ' } : {}), reports: 'Báo cáo logistics',
        }).map(([key, label]) => <button type="button" key={key} aria-pressed={tab === key} onClick={() => filter('tab', key)}>{label}</button>)}
      </nav>
      {tab === 'performance' && <>
        <section className="dssr-panel cp12-panel"><h2>Hiệu suất logistics</h2><p>{modeLabel(mode)} · Theo phiên bản hiện hành</p>
          <dl className="cp12-kpis">{(audience === 'manager' ? metricFields.slice(0, 6) : metricFields).filter(([key]) => {
            if (audience === 'supplier') return ['final_plans', 'demands', 'shipped_kg', 'on_time_pickup_pct', 'exception_pct'].includes(key)
            if (audience === 'purchasing') return !['on_time_pickup_pct', 'shipped_kg', 'load_factor_pct', 'planned_saving_pct',
              'actual_saving_pct', 'actual_cost_per_kg'].includes(key)
            if (audience === 'provider') return !['planned_saving_pct', 'actual_saving_pct'].includes(key)
            return true
          }).map(([key, title, suffix, definition]) => <div key={key}><dt>{title}</dt>
            <dd>{value(overview.kpis[key], suffix)}</dd><small>{definition}</small></div>)}</dl>
        </section>
        {sample?.cost && <CostComparison cost={sample.cost} label={'FinalPlan v' + sample.version} weight={sample.planned_kg} />}
        {audience === 'manager' && <details className="dssr-panel cp12-panel cp12-detail">
          <summary>Chỉ số giao nhận và đối soát khác</summary>
          <dl className="cp12-kpis">{metricFields.slice(6).map(([key, title, suffix, definition]) => <div key={key}>
            <dt>{title}</dt><dd>{value(overview.kpis[key], suffix)}</dd><small>{definition}</small></div>)}</dl>
        </details>}
        {audience === 'manager' && <section className="dssr-panel cp12-panel"><h2>Hiệu suất theo đơn vị</h2>
          {Object.entries(overview.breakdown).map(([key, group]) => <details key={key} className="cp12-detail">
            <summary>{{ supplier: 'Nhà cung cấp', outlet: 'Outlet', provider: 'Đơn vị vận chuyển' }[key]}</summary>
            <div className="cp12-scroll"><table><thead><tr>{['Đơn vị', 'Demand', 'Lấy đúng hạn', 'Giao đúng hạn', 'OTIF', 'Đã nhận']
              .map(name => <th key={name}>{name}</th>)}</tr></thead>
              <tbody>{group.map(row => <tr key={row.entity.id}><th>{row.entity.code} · {row.entity.name}</th>
                <td>{value(row.demands)}</td><td>{value(row.on_time_pickup_pct, '%')}</td><td>{value(row.on_time_delivery_pct, '%')}</td>
                <td>{value(row.otif_pct, '%')}</td><td>{value(row.received_kg, ' kg')}</td></tr>)}</tbody></table></div>
          </details>)}
        </section>}
        <section className="dssr-panel cp12-panel"><h2>Xu hướng và phương án</h2>
          <div className="cp12-fields">{['DIRECT', 'HUB'].map(type => <div key={type}><h3>{type === 'DIRECT' ? 'Direct' : 'Qua Hub'}</h3>
            <p>{value(overview.templates[type].final_plans)} kế hoạch · OTIF {value(overview.templates[type].otif_pct, '%')}</p>
            <p>Đã nhận {value(overview.templates[type].received_kg, ' kg')}</p></div>)}</div>
          <div className="cp12-trend">{overview.trends.map(day => <div key={day.date}><span>{deliveryDate(day.date)}</span>
            {day.otif_pct != null && <progress aria-label={'OTIF ' + deliveryDate(day.date)} value={Number(day.otif_pct)} max={100} />}
            <strong>{value(day.otif_pct, '%')}</strong></div>)}</div>
        </section>
      </>}
      {tab === 'reports' && <section className="dssr-panel cp12-panel"><h2>Báo cáo logistics</h2>
        <p>{modeLabel(mode)} · Xuất lúc {runTime(overview.generated_at)}</p>
        <p>Kỳ báo cáo · {params.get('from_date') ? deliveryDate(params.get('from_date')) : 'Từ đầu kỳ'}
          {' '}– {params.get('to_date') ? deliveryDate(params.get('to_date')) : 'Đến cuối kỳ'}</p>
        <div className="delivery-actions"><button onClick={() => void download('csv')}>CSV</button>
          <button onClick={() => void download('xlsx')}>Excel</button><button onClick={() => window.print()}>In / lưu PDF</button></div>
        {exportError && <p role="alert">{exportError}</p>}
        <ul>{overview.plans.map(row => <li key={row.code}>{deliveryDate(row.date)} · {planName(row)} v{row.version}
          {' '}· {row.source.classification} · {row.demands} Demand · Kế hoạch {value(row.planned_kg, ' kg')}
          {' '}· Nhận {value(row.received_kg, ' kg')} · Chi phí {value(row.cost?.actual_vnd, ' đ')}</li>)}</ul>
      </section>}
      {tab !== 'reports' && <section className="dssr-panel cp12-panel"><h2>{tab === 'exceptions' ? 'FinalPlan có ngoại lệ' : 'Danh sách FinalPlan'}</h2>
        {!(tab === 'exceptions' ? overview.plans.some(row => row.status === 'EXCEPTION') : overview.plans.length)
          && <p>Không tìm thấy FinalPlan trong phạm vi và bộ lọc hiện tại.</p>}
        <ul className="cp12-plans">{overview.plans.filter(row => tab !== 'exceptions' || row.status === 'EXCEPTION').map(row => <li key={row.code}>
          <div><Link to={roots[audience] + '/' + row.code + '?mode=' + mode}>
            {planName(row)} · FinalPlan v{row.version}</Link>
            <small>{deliveryDate(row.date)} · {row.provider.code} · {row.demands} Demand · {value(row.planned_kg, ' kg')}</small></div>
          <span className="cp12-badge">{row.current ? status(tab === 'costs' ? row.cost?.status ?? 'UNAVAILABLE' : row.status) : 'Lịch sử'}</span>
        </li>)}</ul>
      </section>}
    </>}
    {plan && <PlanDetail key={plan.code + plan.mode} plan={plan} audience={audience} endpoint={endpoint} reload={query.reload} />}
  </main>
}
