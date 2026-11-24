import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { deliveryDate, runTime } from '../components/dss/f1Display'
import { kg } from '../components/dss/f3Display'
import { useAuth } from '../contexts/useAuth'
import { ApiError, apiRequest } from '../services/api/client'
import { useDssQuery } from '../services/dss/useDssQuery'
import type { PublishedPlan, PublicationStop } from '../types/planPublication'
import './dss/DSSRunDetailPage.css'
import './dss/PlanDeliveryPage.css'
import './PlanPublicationPage.css'
import './ExecutionWorkspace.css'

type Audience = 'supplier' | 'provider' | 'purchasing' | 'manager'
type ExecutionMode = 'COMMERCIAL_EXECUTION' | 'SIMULATION'
type Event = { id: number; action: string; demand_id: number; wave: number; stop: number; occurred_at: string;
  quantities: Record<string, string>; reason: string; exception_code: string; provenance: string; simulation_at?: string }
type Detail = Omit<PublishedPlan, 'events'> & { blocker: string | null; execution_provenance: string;
  execution_mode: ExecutionMode; simulation_started_at: string | null;
  demand_status: Record<string, string>; events: Event[]; reason_presets: Record<string, Record<string, string>> }
type InventoryWeight = string | number
type Balance = { supplier_item_id: number; sku: string; name: string; unit: string;
  on_hand_kg: InventoryWeight | null; reserved_kg: InventoryWeight | null; available_kg: InventoryWeight | null; updated_at: string | null;
  opening_provenance: 'MANAGER_APPROVED_SYNTHETIC' | 'SUPPLIER_DECLARED' | null }
type Ledger = { id: number; kind: string; balance__supplier_item_id: number; on_hand_delta_kg: InventoryWeight;
  reserved_delta_kg: InventoryWeight; recorded_at: string; reason: string; source_reference: string }
type Inventory = { balances: Balance[]; history: Ledger[]; provenance: string }

function inventoryKg(value: InventoryWeight) {
  const text = String(value)
  return text.startsWith('-') ? '-' + kg(text.slice(1)) : kg(text)
}
const stockKinds: Record<string, string> = {
  OPENING: 'Tồn đầu kỳ', INBOUND: 'Nhập kho', ADJUST: 'Điều chỉnh', RESERVE: 'Giữ chỗ', RELEASE: 'Giải phóng', PICKUP: 'Xuất kho',
}
const stockReasons = {
  OPENING: ['Ghi nhận tồn đầu kỳ'],
  INBOUND: ['Nhập hàng từ sản xuất', 'Nhập hàng bổ sung', 'Hàng hoàn trả hợp lệ'],
  ADJUST: ['Chênh lệch kiểm kê', 'Hàng hư hỏng', 'Hàng hết hạn', 'Điều chỉnh sai sót'],
}
const internalStockPrefix = 'SYNTHETIC/INTERNAL:'
const declaredStockPrefix = 'SUPPLIER_DECLARED/INVENTORY:'
function stockHistoryReason(reason: string) {
  return ({
    'Supplier commitment': 'Giữ chỗ theo cam kết nhà cung cấp',
    'Supplier commitment released': 'Giải phóng tồn đã giữ theo cam kết',
    'Supplier and carrier confirmed pickup': 'Nhà cung cấp và đơn vị vận chuyển đã xác nhận lấy hàng',
    'Supplier declared opening when adding a SKU': 'Nhà cung cấp khai báo tồn đầu kỳ khi thêm SKU',
    'CP11 final refinement / Manager-approved simulated opening for internal planning': 'Tồn đầu kỳ mô phỏng do Manager duyệt',
  } as Record<string, string>)[reason] ?? reason
}
function stockHistoryReference(source: string) {
  if (source.startsWith(internalStockPrefix)) return 'Chứng từ nội bộ mô phỏng · ' + source.slice(internalStockPrefix.length)
  if (source.startsWith(declaredStockPrefix)) return 'Khai báo của nhà cung cấp · ' + source.slice(declaredStockPrefix.length)
  if (source === 'MANAGER_APPROVED_OPENING_BALANCE') return 'Nguồn tồn đầu kỳ do Manager duyệt'
  if (source === 'SUPPLIER_DECLARED_CATALOG_OPENING') return 'Khai báo tồn khi thêm SKU'
  const commitment = /CP6 request (\d+); confirmation (\d+)$/.exec(source)
  return commitment ? `Yêu cầu CP6 #${commitment[1]} · Xác nhận #${commitment[2]}` : source
}
const endpoints = { supplier: '/supplier/shipments', purchasing: '/purchasing/receipts',
  provider: '/provider/trips', manager: '/dss/execution' }
const statuses: Record<string, string> = { AWAITING_PICKUP: 'Chờ lấy hàng', PICKING_UP: 'Đang lấy hàng',
  IN_TRANSIT: 'Đang vận chuyển', AWAITING_RECEIPT: 'Chờ kiểm nhận', COMPLETED: 'Hoàn thành', EXCEPTION: 'Có ngoại lệ',
  CANCELLED: 'Đã dừng thực hiện' }
const actions: Record<string, string> = { READY: 'Xác nhận hàng sẵn sàng', ARRIVE: 'Đã đến điểm dừng',
  SUPPLIER_HANDOVER: 'Ghi nhận hàng bàn giao', CARRIER_PICKUP: 'Xác nhận hàng đã nhận',
  PICKUP_COMPLETE: 'Hai bên đã chốt lấy hàng', HUB_RECEIVE: 'Ghi nhận hàng đến Hub',
  HUB_DISPATCH: 'Ghi nhận chuyển sang chuyến ra Hub', DELIVER: 'Xác nhận bàn giao tại Outlet',
  RECEIVE: 'Ghi nhận hàng kiểm nhận', RECEIVE_COMPLETE: 'Đã kiểm nhận đầy đủ', INCIDENT: 'Báo sự cố',
  CANCELLED: 'Dừng thực hiện' }
const failures: Record<string, string> = { SERVICE_DATE_NOT_REACHED: 'Chưa tới ngày thực hiện theo lịch đã duyệt.',
  FINAL_PLAN_NOT_CONFIRMED_CURRENT: 'Chỉ thực hiện phiên bản hiện hành đã được vận chuyển xác nhận.',
  COMMERCIAL_EVIDENCE_REQUIRED: 'Kế hoạch còn sử dụng giả định nội bộ. Cần bằng chứng vận hành đã xác minh.',
  SIMULATION_MANAGER_APPROVAL_REQUIRED: 'Manager cần xác nhận chế độ mô phỏng cho phiên bản này.',
  SIMULATION_CLOCK_ALREADY_CONFIRMED: 'Phiên bản này đã có mốc giờ mô phỏng được xác nhận.',
  SIMULATION_FLEET_SNAPSHOT_REQUIRED: 'Thiếu lịch xe bao phủ wave trong snapshot F4 để diễn tập.',
  SIMULATION_OPENING_REQUIRED: 'SKU chưa có tồn đầu kỳ dùng được trong mô phỏng.',
  COMMERCIAL_STOCK_EVIDENCE_REQUIRED: 'SKU dùng tồn đầu kỳ khai báo hoặc mô phỏng. Cần đủ lượng nhập có chứng từ trước khi bàn giao thực tế.',
  FLEET_CAPACITY_RESERVED: 'Phương tiện đã được giữ cho lịch trùng giờ.',
  VERIFIED_FLEET_AVAILABILITY_REQUIRED: 'Thiếu lịch xe đã xác minh cho toàn bộ chuyến.',
  OPENING_STOCK_REQUIRED: 'Cần nhập tồn đầu kỳ có chứng từ.',
  PAST_COMMITMENT_REQUIRES_RECONCILIATION_POLICY: 'Cam kết đã qua ngày giao. Cần đối chiếu hồ sơ theo quy trình xử lý lịch sử.',
  STOCK_ALREADY_INITIALIZED: 'SKU đã có tồn đầu kỳ. Hãy ghi nhập hoặc điều chỉnh.',
  INSUFFICIENT_AVAILABLE_STOCK: 'Tồn khả dụng không đủ cho thao tác này.',
  INVALID_STOCK_DELTA: 'Nhập kho cần khối lượng dương. Điều chỉnh cần khối lượng khác 0.',
  OPENING_STOCK_EVIDENCE_REQUIRED: 'Cần chứng từ và khối lượng tồn đầu kỳ hợp lệ.',
  INTERNAL_STOCK_REFERENCE_NOT_ALLOWED: 'Mã nội bộ chỉ dùng cho tồn kho mô phỏng.',
  INTERNAL_STOCK_REFERENCE_RESERVED: 'Chọn loại chứng từ phù hợp rồi nhập mã chứng từ, không nhập tiền tố nguồn.',
  INTERNAL_STOCK_REFERENCE_TOO_LONG: 'Mã chứng từ nội bộ quá dài.',
  STOCK_LIMIT_EXCEEDED: 'Tồn sau giao dịch vượt giới hạn lưu trữ.',
  PICKUP_RESERVATION_MISSING_OR_INSUFFICIENT: 'Chưa có giữ chỗ đủ cho số hàng xác nhận.',
  PREVIOUS_STOP_ACTION_REQUIRED: 'Cần hoàn tất thao tác trước tại điểm này hoặc điểm trước.',
  TRANSFER_QUANTITY_NOT_RECONCILED: 'Số lượng phải khớp với lượng hàng đã nhận ở bước trước.',
  DISCREPANCY_REASON_REQUIRED: 'Nhập lý do khi số lượng thực tế khác kế hoạch.',
  REASON_ACTION_INVALID: 'Lý do này không áp dụng cho thao tác đã chọn.',
  REASON_QUANTITY_MISMATCH: 'Chọn lý do phù hợp với số lượng thực tế.',
  REASON_OTHER_REQUIRED: 'Vui lòng nhập nội dung lý do khác.',
  REASON_FORMAT_INVALID: 'Vui lòng kiểm tra lại lý do và ghi chú.',
  REASON_TOO_LONG: 'Lý do và ghi chú vượt giới hạn lưu.',
  INCIDENT_CODE_REQUIRED: 'Vui lòng chọn loại sự cố và nêu lý do.',
  QUANTITY_EXCEEDS_PLAN: 'Số lượng thực tế vượt khối lượng SKU theo kế hoạch.',
  RECEIPT_EXCEEDS_DELIVERY: 'Số lượng kiểm nhận vượt phần Transport đã giao.',
  EXECUTION_ACTION_ALREADY_COMPLETED: 'Thao tác này đã được ghi nhận.',
  SKU_ALLOCATION_NOT_CAPTURED: 'Thiếu phân bổ SKU cho phần hàng ở điểm dừng này.',
  EXECUTION_CANCELLED: 'Manager đã dừng thực hiện kế hoạch.',
  CANCELLATION_AFTER_HANDOVER_REQUIRES_RECONCILIATION: 'Đã ghi nhận bàn giao. Cần đối chiếu hàng trước khi xử lý dừng chuyến.' }
const incidents: Record<string, string> = { SHORTAGE: 'Thiếu hàng', DAMAGED: 'Hàng hư hỏng', PICKUP_LATE: 'Lấy hàng trễ',
  DELIVERY_LATE: 'Giao hàng trễ', QUANTITY_MISMATCH: 'Số lượng không khớp', DELIVERY_IMPOSSIBLE: 'Không thể giao hàng',
  VEHICLE_UNAVAILABLE: 'Phương tiện không khả dụng' }
const stopLabels: Record<PublicationStop['role'], string> = { SUPPLIER_PICKUP: 'Lấy hàng', OUTLET_DELIVERY: 'Giao hàng',
  HUB_RECEIVE: 'Nhập Hub', HUB_DISPATCH: 'Xuất Hub' }
const phaseLabels: Record<string, string> = { DIRECT: 'Giao trực tiếp', INBOUND: 'Vào Hub', OUTBOUND: 'Ra Hub' }
const hasQuantity = new Set(['SUPPLIER_HANDOVER', 'CARRIER_PICKUP', 'HUB_RECEIVE', 'HUB_DISPATCH', 'DELIVER', 'RECEIVE'])
const modeQuery = (mode: ExecutionMode) => mode === 'SIMULATION' ? '?mode=SIMULATION' : ''
const executionPath = (audience: Audience, code?: string, mode: ExecutionMode = 'COMMERCIAL_EXECUTION', action = '') =>
  '/planning/execution/' + audience + '/' + (code ? encodeURIComponent(code) + '/' : '') + action + modeQuery(mode)
const formatError = (error: unknown) => {
  if (error instanceof ApiError) {
    const data = error.data as { code?: string } | null
    if (data?.code) return failures[data.code] ?? data.code
    if (error.status === 404) return 'Không tìm thấy dữ liệu thực hiện trong phạm vi của bạn hoặc CP11 chưa được bật.'
    if (error.status === 401 || error.status === 403) return 'Phiên hết hạn hoặc tài khoản chưa có quyền thao tác.'
  }
  return 'Không lưu hoặc tải được dữ liệu. Kiểm tra giá trị và thử lại.'
}

function post(path: string, body: object) {
  return apiRequest(path, { method: 'POST', body: JSON.stringify(body) })
}

function useSave() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const pending = useRef<{ signature: string; id: string } | null>(null)
  async function save(path: string, body: object, onSuccess: () => void) {
    if (busy) return
    const signature = path + JSON.stringify(body)
    if (pending.current?.signature !== signature) pending.current = { signature, id: crypto.randomUUID() }
    setBusy(true)
    setSaved(false)
    setError('')
    try {
      await post(path, { ...body, request_id: pending.current.id })
      pending.current = null
      setSaved(true)
      onSuccess()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, saved, save }
}

function StateMessage({ error, saved }: { error: string; saved?: boolean }) {
  if (error) return <p className="dssr-alert" role="alert">{error}</p>
  return saved ? <p role="status">Đã lưu.</p> : null
}

function StockModal({ balance, close, reload }: {
  balance: Balance; close: () => void; reload: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [kind, setKind] = useState<keyof typeof stockReasons>(balance.on_hand_kg === null ? 'OPENING' : 'INBOUND')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [other, setOther] = useState('')
  const [direction, setDirection] = useState<'increase' | 'decrease'>('increase')
  const [note, setNote] = useState('')
  const [review, setReview] = useState(false)
  const state = useSave()
  useEffect(() => {
    const el = dialog.current
    el?.showModal()
    return () => el?.close()
  }, [])
  const signed = kind === 'ADJUST' && direction === 'decrease'
  const magnitude = Math.round(Number(amount) * 1000)
  const change = signed ? -magnitude : magnitude
  const onHand = Math.round(Number(balance.on_hand_kg ?? 0) * 1000)
  const expected = onHand + change
  const reserved = Math.round(Number(balance.reserved_kg ?? 0) * 1000)
  const amountValid = /^\d{1,11}(?:\.\d{1,3})?$/.test(amount)
  const amountError = amountValid && (
    kind !== 'OPENING' && magnitude === 0 ? 'Số lượng giao dịch phải lớn hơn 0 kg.' :
    expected < reserved ? 'Tồn dự kiến phải lớn hơn hoặc bằng số lượng đã giữ.' :
    expected > 99999999999999 ? 'Tồn dự kiến vượt giới hạn lưu trữ.' : ''
  )
  const finalReason = reason === 'OTHER' ? other.trim() : reason
  function selectKind(value: 'INBOUND' | 'ADJUST') {
    setKind(value)
    setDirection('increase')
    setReason('')
    setOther('')
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!amountValid || amountError || !finalReason) return
    if (!review) { setReview(true); return }
    void state.save('/planning/inventory/', { supplier_item_id: balance.supplier_item_id, kind,
      amount: signed ? '-' + amount : amount, reason: finalReason, note: note.trim(),
      reference_kind: 'DECLARED' }, () => { reload(); close() })
  }
  return <dialog ref={dialog} className="delivery-confirm stock-modal" aria-labelledby="stock-modal-title" onCancel={event => {
    event.preventDefault()
    if (!state.busy) close()
  }}>
    <header className="stock-modal-header">
      <h2 id="stock-modal-title">Nhập / điều chỉnh tồn kho</h2>
      <button className="dssr-secondary-button" type="button" aria-label="Đóng" onClick={close} disabled={state.busy}>×</button>
    </header>
    <div className="stock-modal-product"><strong>{balance.name}</strong>
      <span>{balance.sku} · Đơn vị {balance.unit === 'KG' ? 'Kilogram (kg)' : balance.unit}</span>
    </div>
    <dl className="stock-modal-kpis">
      <div><dt>Tồn hiện tại</dt><dd>{balance.on_hand_kg === null ? 'Chưa mở sổ' : inventoryKg(balance.on_hand_kg)}</dd></div>
      <div><dt>Đã giữ chỗ</dt><dd>{inventoryKg(balance.reserved_kg ?? 0)}</dd></div>
      <div><dt>Khả dụng</dt><dd>{inventoryKg(balance.available_kg ?? 0)}</dd></div>
    </dl>
    <form className="stock-modal-form" onSubmit={submit}>
      <fieldset hidden={review} disabled={state.busy || review}>
        <legend>Thông tin giao dịch</legend>
        {kind === 'OPENING' ? <strong>Tồn đầu kỳ</strong> : <div className="stock-modal-tabs" role="group" aria-label="Loại giao dịch">
          <button type="button" aria-pressed={kind === 'INBOUND'} onClick={() => selectKind('INBOUND')}>Nhập kho</button>
          <button type="button" aria-pressed={kind === 'ADJUST'} onClick={() => selectKind('ADJUST')}>Điều chỉnh tồn</button>
        </div>}
        {kind === 'ADJUST' && <fieldset className="stock-modal-direction">
          <legend>Hình thức điều chỉnh</legend>
          <label><input type="radio" name="direction" checked={direction === 'increase'} onChange={() => setDirection('increase')} /> Tăng tồn kho</label>
          <label><input type="radio" name="direction" checked={direction === 'decrease'} onChange={() => setDirection('decrease')} /> Giảm tồn kho</label>
        </fieldset>}
        <label>Số lượng (kg)<input type="number" step="0.001" min={kind === 'OPENING' ? 0 : 0.001}
          required value={amount} onChange={event => setAmount(event.target.value)} /></label>
        {amountError && <p role="alert">{amountError}</p>}
        <label>Lý do<select aria-label="Lý do" value={reason} required onChange={event => {
          setReason(event.target.value); setOther('')
        }}>
          <option value="">Chọn lý do</option>
          {stockReasons[kind].map(option => <option key={option}>{option}</option>)}
          <option value="OTHER">Khác</option>
        </select></label>
        {reason === 'OTHER' && <label>Lý do khác<textarea required maxLength={300} value={other}
          onChange={event => setOther(event.target.value)} /></label>}
        <label>Ghi chú bổ sung<textarea value={note} maxLength={190} onChange={event => setNote(event.target.value)} /></label>
      </fieldset>
      {review && <section className="stock-modal-review" aria-label="Xác nhận giao dịch">
        <h3>Xác nhận giao dịch</h3><p>{stockKinds[kind]} · {finalReason}</p>
        {note.trim() && <p>Ghi chú · {note.trim()}</p>}
      </section>}
      <section className="stock-modal-preview" aria-labelledby="stock-preview-title">
        <h3 id="stock-preview-title">Dự kiến sau giao dịch</h3>
        <dl aria-live="polite">
          <div><dt>Tồn trước giao dịch</dt><dd>{inventoryKg(onHand / 1000)}</dd></div>
          <div><dt>Số lượng thay đổi</dt><dd>{change > 0 && amountValid ? '+' : ''}{inventoryKg(amountValid ? change / 1000 : 0)}</dd></div>
          <div><dt>Tồn sau giao dịch</dt><dd>{inventoryKg((amountValid ? expected : onHand) / 1000)}</dd></div>
          <div><dt>Đã giữ chỗ</dt><dd>{inventoryKg(reserved / 1000)}</dd></div>
          <div><dt>Tồn khả dụng mới</dt><dd>{inventoryKg(((amountValid ? expected : onHand) - reserved) / 1000)}</dd></div>
        </dl>
      </section>
      <p className="stock-modal-note">Hệ thống tự sinh mã giao dịch trong sổ kho. Số đã giữ chỗ giữ nguyên.</p>
      <StateMessage error={state.error} />
      <div className="delivery-actions">
        <button type="button" className="dssr-secondary-button" onClick={review ? () => setReview(false) : close}
          disabled={state.busy}>{review ? 'Quay lại' : 'Hủy'}</button>
        <button className="dssr-primary-button" disabled={state.busy || !amountValid || Boolean(amountError) || !finalReason}>
          {state.busy ? 'Đang ghi tồn…' : review ? 'Xác nhận ghi tồn' : 'Kiểm tra giao dịch'}
        </button>
      </div>
    </form>
  </dialog>
}

export function InventoryWorkspace() {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<Balance | null>(null)
  const [reconcileError, setReconcileError] = useState('')
  const [reconciled, setReconciled] = useState(false)
  const [matching, setMatching] = useState(false)
  const [historySku, setHistorySku] = useState('')
  const [historyKind, setHistoryKind] = useState('')
  const [historyDay, setHistoryDay] = useState('')
  const load = useCallback(() => apiRequest<Inventory>('/planning/inventory/'), [])
  const query = useDssQuery(load)
  const historyFiltered = Boolean(historySku || historyKind || historyDay)
  const readHistory = useCallback(() => {
    const params = new URLSearchParams()
    if (historySku) params.set('supplier_item', historySku)
    if (historyKind) params.set('kind', historyKind)
    if (historyDay) params.set('day', historyDay)
    return params.size ? apiRequest<Inventory>('/planning/inventory/?' + params) : Promise.resolve(null)
  }, [historySku, historyKind, historyDay])
  const filteredHistory = useDssQuery(readHistory)
  const history = historyFiltered ? filteredHistory.data?.history : query.data?.history
  const [stockSaved, setStockSaved] = useState(false)
  const rows = query.data?.balances.filter(row => {
    const found = (row.sku + ' ' + row.name).toLocaleLowerCase('vi').includes(search.trim().toLocaleLowerCase('vi'))
    return found && (filter === 'all' || (filter === 'missing') === (row.on_hand_kg === null))
  }) ?? []
  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const id = Number(values.get('request'))
    setMatching(true)
    setReconciled(false)
    setReconcileError('')
    try {
      await post('/planning/inventory/commitments/' + id + '/', { source_reference: values.get('source_reference') })
      setReconciled(true)
      query.reload()
    } catch (err) {
      setReconcileError(formatError(err))
    } finally {
      setMatching(false)
    }
  }
  return <main className="dssr-page delivery-page manager-workspace plan-publication">
    <header className="manager-heading"><h1>Quản lý tồn kho</h1></header>
    {query.loading && <p role="status">Đang tải tồn kho…</p>}
    {query.error != null && <StateMessage error={formatError(query.error)} />}
    {query.data && <>
      {query.data.provenance !== 'OPERATIONAL' && <p className="dssr-alert">Dữ liệu diễn tập cô lập · {query.data.provenance}</p>}
      <section className="dssr-panel delivery-section">
        <div className="delivery-filters publication-filters">
          <label>Tìm SKU<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <label>Tình trạng<select value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">Tất cả</option><option value="missing">Chưa nhập tồn đầu kỳ</option><option value="ready">Đã có tồn</option>
          </select></label>
        </div>
        {!rows.length ? <p>Không có SKU phù hợp.</p> :
          <div className="manager-table-scroll" tabIndex={0} aria-label="Tồn kho theo SKU">
            <table className="manager-table publication-items"><thead><tr>{['SKU', 'Tồn ghi sổ', 'Đã giữ', 'Khả dụng', 'Cập nhật', 'Thao tác']
              .map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.supplier_item_id}><th scope="row">{row.sku} · {row.name}
                {row.opening_provenance && <small className="execution-stock-source">{row.opening_provenance === 'MANAGER_APPROVED_SYNTHETIC'
                  ? 'Tồn đầu kỳ mô phỏng do Manager duyệt' : 'Tồn đầu kỳ do nhà cung cấp khai báo'}</small>}</th>
                <td>{row.on_hand_kg !== null ? inventoryKg(row.on_hand_kg) : 'Chưa nhập tồn đầu kỳ'}</td>
                <td>{row.reserved_kg !== null ? inventoryKg(row.reserved_kg) : '—'}</td><td>{row.available_kg !== null ? inventoryKg(row.available_kg) : '—'}</td>
                <td>{row.updated_at ? runTime(row.updated_at) : '—'}</td><td>
                  <button className="dssr-secondary-button" type="button" onClick={() => { setStockSaved(false); setSelected(row) }}>
                    {row.on_hand_kg === null ? 'Nhập tồn đầu kỳ' : 'Nhập / điều chỉnh'}
                  </button></td></tr>)}</tbody></table>
          </div>}
        <StateMessage error="" saved={stockSaved} />
        {selected && <StockModal key={selected.supplier_item_id} balance={selected}
          close={() => setSelected(null)} reload={() => { setStockSaved(true); query.reload(); filteredHistory.reload() }} />}
      </section>
      <details className="dssr-panel delivery-section"><summary>Đối chiếu cam kết có trước CP11</summary>
        <p>Đối chiếu tồn đã kiểm kê với yêu cầu cung ứng hiện hành. Giao dịch giữ chỗ được ghi ở thời điểm đối chiếu.</p>
        <form className="execution-form" onSubmit={event => { void reconcile(event) }}>
          <label>ID yêu cầu cung ứng<input type="number" name="request" min={1} required /></label>
          <label>Chứng từ đối chiếu<input name="source_reference" maxLength={200} required /></label>
          <button className="dssr-primary-button" disabled={matching}>Xác nhận đối chiếu</button>
        </form>
        <StateMessage error={reconcileError} saved={reconciled} />
      </details>
      <section className="dssr-panel delivery-section"><h2>Lịch sử tồn kho</h2>
        <div className="delivery-filters publication-filters">
          <label>SKU trong lịch sử<select aria-label="SKU trong lịch sử" value={historySku} onChange={event => setHistorySku(event.target.value)}>
            <option value="">Tất cả SKU</option>{query.data.balances.map(row => <option key={row.supplier_item_id}
              value={row.supplier_item_id}>{row.sku} · {row.name}</option>)}
          </select></label>
          <label>Loại giao dịch<select aria-label="Loại giao dịch" value={historyKind} onChange={event => setHistoryKind(event.target.value)}>
            <option value="">Tất cả giao dịch</option>{Object.entries(stockKinds).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select></label>
          <label>Ngày ghi sổ<input type="date" value={historyDay} onChange={event => setHistoryDay(event.target.value)} /></label>
        </div>
        {historyFiltered && filteredHistory.loading && <p role="status">Đang tải lịch sử…</p>}
        {historyFiltered && filteredHistory.error != null && <StateMessage error={formatError(filteredHistory.error)} />}
        <ul className="delivery-records">{history?.map(row => <li key={row.id}>
          <strong>{query.data?.balances.find(balance => balance.supplier_item_id === row.balance__supplier_item_id)?.sku} · {stockKinds[row.kind] ?? row.kind}</strong>
          <span>Tồn {inventoryKg(row.on_hand_delta_kg)} · Giữ {inventoryKg(row.reserved_delta_kg)} · {runTime(row.recorded_at)}</span>
          <span>{stockHistoryReason(row.reason)}</span>
          {row.source_reference && <small>{stockHistoryReference(row.source_reference)}</small>}
        </li>)}</ul>
        {history?.length === 0 && <p>Không có giao dịch tồn kho khớp bộ lọc.</p>}
      </section>
    </>}
  </main>
}

function stopActions(role: PublicationStop['role'], audience: Audience) {
  if (audience === 'supplier') return role === 'SUPPLIER_PICKUP' ? ['READY', 'SUPPLIER_HANDOVER', 'INCIDENT'] : []
  if (audience === 'purchasing') return role === 'OUTLET_DELIVERY' ? ['RECEIVE', 'INCIDENT'] : []
  if (audience !== 'provider') return []
  return ['ARRIVE', ({ SUPPLIER_PICKUP: 'CARRIER_PICKUP', OUTLET_DELIVERY: 'DELIVER',
    HUB_RECEIVE: 'HUB_RECEIVE', HUB_DISPATCH: 'HUB_DISPATCH' })[role], 'INCIDENT']
}

function StopForm({ options, plan, wave, stop, load, audience, reload }: { options: string[]; plan: Detail;
  wave: number; stop: number; load: PublicationStop['loads'][number]; audience: Audience; reload: () => void }) {
  const [action, setAction] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [draft, setDraft] = useState<{ action: string; wave: number; stop: number; demand_id: number;
    quantity_rows: { item_id: number; quantity_kg: string }[]; reason_code: string; reason_other: string;
    note: string; incident_code: string } | null>(null)
  const [validation, setValidation] = useState('')
  const state = useSave()
  const presets = plan.reason_presets?.[action] ?? {}
  const canSubmit = options.includes(action) && (!plan.blocker || plan.blocker === 'SERVICE_DATE_NOT_REACHED' && action === 'READY')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit || !load.items) return
    if (draft) {
      void state.save(executionPath(audience, plan.code, plan.execution_mode), draft, () => {
        setDraft(null)
        setAction('')
        setReasonCode('')
        reload()
      })
      return
    }
    setValidation('')
    const values = new FormData(event.currentTarget)
    const reason_other = String(values.get('reason_other') ?? '').trim()
    const note = String(values.get('note') ?? '').trim()
    const incident_code = String(values.get('incident_code') ?? '')
    const quantity_rows = hasQuantity.has(action) ? load.items.map(item => ({
      item_id: item.id, quantity_kg: String(values.get('qty-' + item.id) ?? ''),
    })) : []
    const short = quantity_rows.some((row, index) => Number(row.quantity_kg) < Number(load.items?.[index].weight_kg))
    if (reasonCode === 'OTHER' && !reason_other) return setValidation(failures.REASON_OTHER_REQUIRED)
    if (!reasonCode && short && ['SUPPLIER_HANDOVER', 'CARRIER_PICKUP', 'RECEIVE'].includes(action)) {
      return setValidation(failures.DISCREPANCY_REASON_REQUIRED)
    }
    if (reasonCode === 'FULL' && short || ['PARTIAL', 'ADJUST_QUANTITY', 'REFUSED'].includes(reasonCode) && !short) {
      return setValidation(failures.REASON_QUANTITY_MISMATCH)
    }
    setDraft({ action, wave, stop, demand_id: load.demand_id, quantity_rows, reason_code: reasonCode,
      reason_other, note, incident_code })
  }
  if (!options.length) return null
  return <form className="execution-form" onSubmit={submit}>
    <fieldset disabled={draft !== null || state.busy}>
    <label>Thao tác tại điểm dừng<select value={action} onChange={event => {
      setAction(event.target.value); setReasonCode(''); setValidation('')
    }}>
      <option value="">Chọn thao tác</option>{options.map(option => <option value={option} key={option}>{actions[option]}</option>)}
    </select></label>
    <div key={action} className="execution-form-fields">
    {hasQuantity.has(action) && load.items?.map(item => <label key={item.id}>
      {item.code ?? item.id} · dự kiến {kg(item.weight_kg)}
      <input type="number" min="0" max={item.weight_kg} step="0.001" name={'qty-' + item.id} required />
    </label>)}
    {action && <>
      <label>Lý do<select aria-label="Lý do" value={reasonCode} required={action === 'INCIDENT'} onChange={event => {
        setReasonCode(event.target.value); setValidation('')
      }}>
        <option value="">Chọn lý do</option>
        {Object.entries(presets).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        <option value="OTHER">Khác — Nhập lý do</option>
      </select></label>
      {action === 'INCIDENT' && reasonCode === 'OTHER' && <label>Loại sự cố<select name="incident_code" required>
        <option value="">Chọn loại sự cố</option>
        {Object.entries(incidents).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>}
      {reasonCode === 'OTHER' && <label>Lý do khác<textarea name="reason_other" maxLength={300} required /></label>}
      <label>Ghi chú bổ sung (không bắt buộc)<textarea name="note" maxLength={160} /></label>
    </>}
    </div></fieldset>
    {draft && <p role="status">{actions[draft.action]} · FinalPlan v{plan.version}
      {draft.reason_code && ' · ' + (draft.reason_other || presets[draft.reason_code])}
      {draft.note && ' · ' + draft.note}</p>}
    <button className="dssr-primary-button" disabled={state.busy || !canSubmit || !load.items}>
      {draft ? (plan.execution_mode === 'SIMULATION' ? 'Xác nhận ghi mô phỏng' : 'Xác nhận ghi nhận thực tế') : 'Kiểm tra trước khi lưu'}
    </button>
    {draft && <button className="dssr-secondary-button" type="button" disabled={state.busy} onClick={() => setDraft(null)}>Quay lại</button>}
    <StateMessage error={validation || state.error} saved={state.saved} />
  </form>
}

function useExecutionMode() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const allowed = Boolean(user && !user.capstone_scenario)
  const mode: ExecutionMode = allowed && params.get('mode') === 'SIMULATION' ? 'SIMULATION' : 'COMMERCIAL_EXECUTION'
  function change(value: ExecutionMode) {
    const next = new URLSearchParams(params)
    if (value === 'SIMULATION') next.set('mode', value)
    else next.delete('mode')
    setParams(next)
  }
  return { allowed, mode, change }
}

function ExecutionModeSelect({ mode, change }: { mode: ExecutionMode; change: (value: ExecutionMode) => void }) {
  return <label className="execution-mode-control">Chế độ thực hiện
    <select aria-label="Chế độ thực hiện" value={mode} onChange={event => change(event.target.value as ExecutionMode)}>
      <option value="COMMERCIAL_EXECUTION">Giao nhận thương mại</option>
      <option value="SIMULATION">Mô phỏng Capstone</option>
    </select>
  </label>
}

export function ExecutionPanel({ audience, code, selected }: { audience: Audience; code: string; selected?: number }) {
  const availability = useDssQuery(useCallback(() => apiRequest<{ enabled: boolean }>('/planning/execution/availability/'), []))
  const { allowed, mode, change } = useExecutionMode()
  return availability.data?.enabled ? <>
    {allowed && <ExecutionModeSelect mode={mode} change={change} />}
    <ExecutionDetails key={mode} audience={audience} code={code} selected={selected} mode={mode} />
  </> : null
}

function ExecutionDetails({ audience, code, selected, mode }: { audience: Audience; code: string; selected?: number; mode: ExecutionMode }) {
  const query = useDssQuery(useCallback(() => apiRequest<Detail>(executionPath(audience, code, mode)), [audience, code, mode]))
  const cancellation = useSave()
  const approval = useSave()
  const plan = query.data
  if (query.loading) return <p role="status">Đang tải tiến độ thực hiện…</p>
  if (query.error != null) return <StateMessage error={formatError(query.error)} />
  if (!plan) return null
  const codes = new Map(plan.demands.map(demand => [demand.id, demand.code]))
  const displayTime = (value: string | null) => value ? new Date(value).toLocaleTimeString('vi-VN', {
    timeZone: plan.timezone, hour: '2-digit', minute: '2-digit',
  }) : '—'
  const simulation = mode === 'SIMULATION'
  const awaitingApproval = plan.blocker === 'SIMULATION_MANAGER_APPROVAL_REQUIRED'
  const eventTime = (event: Event) => event.simulation_at ?? event.occurred_at
  return <section className="dssr-panel delivery-section execution-timeline">
    <h2>Thực hiện · v{plan.version} · {deliveryDate(plan.service_date)}</h2>
    {simulation ? <p className="dssr-alert">Mô phỏng Capstone · Sự kiện và tồn mô phỏng được ghi riêng.
      {plan.simulation_started_at && <> Mốc giờ đã xác nhận <strong>{runTime(plan.simulation_started_at)}</strong>.</>}
    </p> : plan.execution_provenance !== 'OPERATIONAL' && <p className="dssr-alert">Diễn tập cô lập · {plan.execution_provenance}</p>}
    {plan.blocker && <p className="dssr-alert">{failures[plan.blocker] ?? plan.blocker}</p>}
    {audience === 'manager' && simulation && awaitingApproval && <form className="execution-form" onSubmit={event => {
      event.preventDefault()
      const clock_time = String(new FormData(event.currentTarget).get('clock_time') ?? '')
      if (clock_time) void approval.save(executionPath('manager', code, 'COMMERCIAL_EXECUTION', 'simulation/'), { clock_time }, query.reload)
    }}>
      <label>Giờ bắt đầu mô phỏng<input name="clock_time" type="time" required /></label>
      <p>Mốc giờ áp dụng cho ngày {deliveryDate(plan.service_date)} của FinalPlan v{plan.version}.</p>
      <button className="dssr-primary-button" disabled={approval.busy}>Xác nhận diễn tập phiên bản này</button>
      <StateMessage error={approval.error} saved={approval.saved} />
    </form>}
    {audience === 'manager' && plan.status === 'CONFIRMED' && !awaitingApproval && plan.blocker !== 'EXECUTION_CANCELLED' &&
      <details><summary>Dừng thực hiện trước bàn giao</summary>
        <form className="execution-form" onSubmit={event => {
          event.preventDefault()
          const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
          if (reason) void cancellation.save(executionPath('manager', code, mode, 'cancel/'), { reason }, query.reload)
        }}>
          <label>Lý do dừng<input name="reason" required maxLength={500} /></label>
          <button className="dssr-secondary-button" disabled={cancellation.busy}>Xác nhận dừng phiên bản này</button>
        </form>
        <StateMessage error={cancellation.error} saved={cancellation.saved} />
      </details>}
    <ul className="delivery-records">{Object.entries(plan.demand_status).filter(([id]) => !selected || Number(id) === selected)
      .map(([id, status]) => <li key={id}><strong>{codes.get(Number(id))}</strong>
        <span className="execution-badge" data-state={status}>{statuses[status] ?? status}</span></li>)}</ul>
    {plan.waves.map(wave => <details key={wave.number} open>
      <summary>Wave {wave.number} · {wave.vehicle.code} · {phaseLabels[wave.phase] ?? wave.phase}</summary>
      {wave.in_transit_kg !== undefined && <p>Khối lượng đang trên xe <strong>{kg(wave.in_transit_kg)}</strong></p>}
      {wave.stops.map(stop => <div key={stop.sequence} className="execution-stop">
        <h3>{stop.sequence}. {stopLabels[stop.role]} {stop.code ?? plan.demands.find(
          demand => demand.id === stop.loads[0]?.demand_id)?.supplier.code}</h3>
        <dl className="execution-plan-facts" aria-label="Khung giờ dự kiến">
          <div><dt>Dự kiến đến</dt><dd>{displayTime(stop.arrival)}</dd></div>
          <div><dt>Chờ</dt><dd>{stop.wait_minutes ?? '—'} phút</dd></div>
          <div><dt>Phục vụ</dt><dd>{displayTime(stop.start)}–{displayTime(stop.end)}</dd></div>
          <div><dt>Rời điểm</dt><dd>{displayTime(stop.departure)}</dd></div>
        </dl>
        {stop.loads.filter(load => !selected || load.demand_id === selected).map(load => <div className="execution-stop-load" key={load.demand_id}>
          <strong>{codes.get(load.demand_id)} · {kg(load.weight_kg)}</strong>
          <ul aria-label={simulation ? 'Mốc mô phỏng' : 'Mốc thực tế'}>{plan.events.filter(event => event.demand_id === load.demand_id && event.wave === wave.number &&
            event.stop === stop.sequence && ['ARRIVE', 'PICKUP_COMPLETE', 'HUB_RECEIVE', 'HUB_DISPATCH', 'DELIVER', 'RECEIVE_COMPLETE']
              .includes(event.action)).map(event => <li key={event.id}>
            {actions[event.action]} {simulation ? 'mô phỏng' : 'thực tế'} <time dateTime={eventTime(event)}>{runTime(eventTime(event))}</time>
          </li>)}</ul>
          {load.items?.length ? <ul>{load.items.map(item => <li key={item.id}>{item.code} · {item.name} · {kg(item.weight_kg)}</li>)}</ul> :
            <p>Chưa có phân bổ SKU cho phần tải này.</p>}
          <StopForm options={stopActions(stop.role, audience)} plan={plan} wave={wave.number} stop={stop.sequence}
            load={load} audience={audience} reload={query.reload} />
        </div>)}
      </div>)}
    </details>)}
    <h3>{simulation ? 'Lịch sử giao nhận mô phỏng' : 'Lịch sử giao nhận thực tế'}</h3>
    {!plan.events.length && <p>Chưa có sự kiện thực hiện.</p>}
    <ol className="delivery-records">{plan.events.filter(event => !selected || event.demand_id === selected).map(event => <li key={event.id}>
      <strong>{actions[event.action] ?? event.action} · {codes.get(event.demand_id)} · Wave {event.wave}</strong>
      <time dateTime={eventTime(event)}>{runTime(eventTime(event))}</time>
      {simulation && <span>Ghi sổ {runTime(event.occurred_at)} · {event.provenance}</span>}
      <span>{Object.entries(event.quantities).map(([itemId, amount]) => {
        const item = plan.demands.find(demand => demand.id === event.demand_id)?.items.find(row => row.id === Number(itemId))
        return (item?.code ?? itemId) + ' ' + kg(amount)
      }).join(' · ')}</span>
      {event.exception_code && <span>{incidents[event.exception_code] ?? event.exception_code}</span>}
      {event.reason && <span>{event.reason}</span>}
    </li>)}</ol>
  </section>
}

type ExecutionIndex = { plans: { code: string; version: number; service_date: string; current: boolean;
  run_number?: number; provider: PublishedPlan['provider']; provenance: PublishedPlan['provenance'];
  hub: PublishedPlan['hub']; template: 'DIRECT' | 'HUB'; demand_codes: string[];
  weight: number | string; pickup_kg: number | string; receipt_kg: number | string;
  wave_count: number; vehicles: string[]; demand_status: Record<string, string>; blocker: string | null }[] }

function ExecutionProgress({ label, current, total, unit = '' }: {
  label: string; current: number; total: number; unit?: string
}) {
  const display = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 3 })
  return <div className="execution-progress-row">
    <span>{label}</span><strong>{display(current)} / {display(total)}{unit}</strong>
    <progress aria-label={label} value={current} max={total || 1} />
  </div>
}

export function ExecutionWorkspace({ audience }: { audience: 'manager' | 'provider' }) {
  const { code } = useParams()
  const { allowed, mode, change } = useExecutionMode()
  const [search, setSearch] = useState('')
  const [date, setDate] = useState('')
  const [status, setStatus] = useState('')
  const [template, setTemplate] = useState('')
  const query = useDssQuery(useCallback(() => code ? Promise.resolve(null) :
    apiRequest<ExecutionIndex>(executionPath(audience, undefined, mode)), [audience, code, mode]))
  const title = audience === 'provider' ? 'Điều phối chuyến vận chuyển' : 'Theo dõi thực hiện kế hoạch'
  const current = query.data?.plans.filter(row => row.current) ?? []
  const counts = current.flatMap(row => Object.values(row.demand_status))
  const rows = query.data?.plans.filter(row => {
    const searchText = [row.code, row.run_number && 'Run ' + row.run_number, row.provider.code, row.hub?.code, ...row.demand_codes]
      .join(' ').toLocaleLowerCase('vi')
    return searchText.includes(search.trim().toLocaleLowerCase('vi')) &&
      (!date || row.service_date === date) && (!status || Object.values(row.demand_status).includes(status)) &&
      (!template || row.template === template)
  }) ?? []
  const planned = current.reduce((sum, plan) => sum + Number(plan.weight), 0)
  return <main className="dssr-page delivery-page manager-workspace plan-publication execution-workspace">
    <header className="manager-heading">{code && <Link to={endpoints[audience] + modeQuery(mode)}>← Danh sách kế hoạch</Link>}<h1>{title}</h1>
      {allowed && <ExecutionModeSelect mode={mode} change={change} />}
    </header>
    {code ? <ExecutionDetails key={mode} audience={audience} code={code} mode={mode} /> : <>
      {query.loading && <p role="status">Đang tải kế hoạch…</p>}
      {query.error != null && <StateMessage error={formatError(query.error)} />}
      {query.data && <>
        {mode === 'SIMULATION' && <p className="dssr-alert">KPI mô phỏng Capstone · SIMULATION</p>}
        <dl className="execution-metrics" aria-label="Chỉ số giao nhận"><div><dt>FinalPlan hiện hành</dt><dd>{current.length}</dd></div>
          <div><dt>Demand theo dõi</dt><dd>{counts.length}</dd></div>
          {Object.entries(statuses).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{counts.filter(state => state === key).length}</dd></div>)}
        </dl>
        <section className="dssr-panel delivery-section">
          <h2>Tiến độ giao nhận</h2>
          <ExecutionProgress label="Demand đã hoàn thành" current={counts.filter(value => value === 'COMPLETED').length} total={counts.length} />
          <ExecutionProgress label="Khối lượng đã lấy" current={current.reduce((sum, plan) => sum + Number(plan.pickup_kg), 0)} total={planned} unit=" kg" />
          <ExecutionProgress label="Khối lượng đã nhận" current={current.reduce((sum, plan) => sum + Number(plan.receipt_kg), 0)} total={planned} unit=" kg" />
        </section>
        <section className="dssr-panel delivery-section">
          <h2>Danh sách kế hoạch thực hiện</h2>
          <div className="execution-filters">
            <label>Tìm kế hoạch hoặc Demand<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label>Ngày thực hiện<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
            <label>Trạng thái<select value={status} onChange={event => setStatus(event.target.value)}>
              <option value="">Tất cả trạng thái</option>
              {Object.entries(statuses).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
            </select></label>
            <label>Phương án<select aria-label="Phương án" value={template} onChange={event => setTemplate(event.target.value)}>
              <option value="">Tất cả phương án</option><option value="DIRECT">Direct Consolidated</option>
              <option value="HUB">Qua Hub</option>
            </select></label>
          </div>
          {!rows.length && <p className="execution-empty">{query.data.plans.length
            ? 'Không có kế hoạch khớp với bộ lọc.' : 'Chưa có kế hoạch được công bố trong phạm vi của bạn.'}</p>}
          <ul className="execution-plans">{rows.map(plan => <li key={plan.code}>
            <header>
              <div><Link to={endpoints[audience] + '/' + plan.code + modeQuery(mode)}>
                {plan.run_number ? 'Run ' + plan.run_number + ' · ' : ''}FinalPlan v{plan.version}
              </Link><p>{deliveryDate(plan.service_date)} · {plan.hub?.code ?? 'Direct Consolidated'} · {plan.provider.code}</p></div>
              <div className="execution-badges">
                {!plan.current ? <span className="execution-badge">Phiên bản lịch sử</span> :
                  [...new Set(Object.values(plan.demand_status))].map(key => <span key={key} className="execution-badge" data-state={key}>
                    {statuses[key] ?? key}
                  </span>)}
              </div>
            </header>
            <dl className="execution-plan-facts">
              <div><dt>Demand</dt><dd>{plan.demand_codes.length}</dd></div>
              <div><dt>Khối lượng</dt><dd>{kg(String(plan.weight))}</dd></div>
              <div><dt>Wave</dt><dd>{plan.wave_count}</dd></div>
              <div><dt>Phương tiện</dt><dd>{plan.vehicles.join(', ') || '—'}</dd></div>
            </dl>
            {plan.blocker && <p className="execution-warning">{failures[plan.blocker] ?? plan.blocker}</p>}
            {plan.provenance.classification !== 'OPERATIONAL_EVIDENCE' && plan.blocker !== 'COMMERCIAL_EVIDENCE_REQUIRED' &&
              <p className="execution-warning">Nguồn lập kế hoạch · {plan.provenance.classification}</p>}
          </li>)}</ul>
        </section>
      </>}
    </>}
  </main>
}
