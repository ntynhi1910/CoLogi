import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { deliveryDate, runTime } from '../components/dss/f1Display'
import { kg } from '../components/dss/f3Display'
import { ApiError, apiRequest } from '../services/api/client'
import { useDssQuery } from '../services/dss/useDssQuery'
import type { PublishedPlan, PublicationStop } from '../types/planPublication'
import './dss/DSSRunDetailPage.css'
import './dss/PlanDeliveryPage.css'
import './PlanPublicationPage.css'
import './ExecutionWorkspace.css'
import './SupplierInventoryWorkspace.css'

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
  SERVICE_DATE_PASSED: 'Đã qua ngày giao nhận theo lịch đã duyệt. Liên hệ Manager để xử lý theo quy trình.',
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
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')
  const [stale, setStale] = useState(false)
  const checkingRef = useRef(false)
  const [note, setNote] = useState('')
  const [review, setReview] = useState(false)
  const state = useSave()
  const busy = checking || state.busy
  useEffect(() => {
    const el = dialog.current
    el?.showModal()
    return () => el?.close()
  }, [])
  const onHand = Math.round(
    Number(balance.on_hand_kg ?? 0) * 1000
  )

  const reserved = Math.round(
    Number(balance.reserved_kg ?? 0) * 1000
  )

  const amountValid = /^\d{1,11}(?:\.\d{1,3})?$/.test(amount)
  const magnitude = Math.round(Number(amount) * 1000)

  const isCount = kind === 'ADJUST'

  const change = isCount
    ? magnitude - onHand
    : magnitude

  const expected = onHand + change

  const matched =
    isCount && amountValid && change === 0

  const amountError = amountValid && (
    kind === 'INBOUND' && magnitude === 0
      ? 'Số lượng nhập phải lớn hơn 0 kg.'
      : expected < reserved
        ? 'Tồn kiểm kê thấp hơn lượng đã giữ chỗ. Cần xử lý cam kết cung ứng trước.'
        : expected > 99999999999999
          ? 'Tồn dự kiến vượt giới hạn lưu trữ.'
          : ''
  )

  const options = isCount
    ? change > 0
      ? [
          'Kiểm kê phát hiện thừa hàng',
          'Điều chỉnh sai sót'
        ]
      : [
          'Kiểm kê phát hiện thiếu hàng',
          'Hàng hư hỏng',
          'Hàng hết hạn',
          'Điều chỉnh sai sót'
        ]
    : stockReasons[kind]

  const reasonText =
    reason === 'OTHER' ? other.trim() : reason

  const finalReason = isCount && reasonText
    ? `Kiểm kê: Tồn ghi sổ ${(onHand / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 3 })} kg; tồn thực tế ${Number(amount).toLocaleString("vi-VN", { maximumFractionDigits: 3 })} kg. ${reasonText}`
    : reasonText

  const reasonTooLong = (
    finalReason +
    (note.trim() ? '\nGhi chú · ' + note.trim() : '')
  ).length > 500

  const blocked =
    busy ||
    stale ||
    !amountValid ||
    Boolean(amountError) ||
    matched ||
    !reasonText ||
    reasonTooLong

  function selectKind(value: 'INBOUND' | 'ADJUST') {
    setKind(value)
    setAmount('')
    setReason('')
    setOther('')
    setReview(false)
    setCheckError('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (blocked || checkingRef.current) return

    if (!review) {
      setReview(true)
      return
    }

    checkingRef.current = true
    setChecking(true)
    setCheckError('')

    try {
      if (isCount) {
        const latest = await apiRequest<Inventory>(
          '/planning/inventory/'
        )

        const row = latest.balances.find(
          r => r.supplier_item_id === balance.supplier_item_id
        )

        if (
          !row ||
          row.on_hand_kg === null ||
          row.reserved_kg === null ||
          Math.round(Number(row.on_hand_kg) * 1000) !== onHand ||
          Math.round(Number(row.reserved_kg) * 1000) !== reserved ||
          row.updated_at !== balance.updated_at
        ) {
          setStale(true)
          setCheckError(
            'Số dư đã thay đổi. Hãy đóng form, làm mới và kiểm kê lại trước khi ghi tồn.'
          )
          return
        }
      }

      await state.save(
        '/planning/inventory/',
        {
          supplier_item_id: balance.supplier_item_id,
          kind,
          amount: (change / 1000).toFixed(3),
          reason: finalReason,
          note: note.trim(),
          reference_kind: 'DECLARED'
        },
        () => {
          reload()
          close()
        }
      )
    } catch (err) {
      setCheckError(formatError(err))
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }
  return <dialog ref={dialog} className="delivery-confirm stock-modal" aria-labelledby="stock-modal-title" onCancel={event => {
    event.preventDefault()
    if (!busy) close()
  }}>
    <header className="stock-modal-header">
      <h2 id="stock-modal-title">Giao dịch tồn kho</h2>
      <button className="dssr-secondary-button" type="button" aria-label="Đóng" onClick={close} disabled={busy}>×</button>
    </header>
    <div className="stock-modal-product"><strong>{balance.name}</strong>
      <span>{balance.sku} · Đơn vị {balance.unit === 'KG' ? 'Kilogram (kg)' : balance.unit}</span>
    </div>
    <dl className="stock-modal-kpis">
      <div><dt>Tồn ghi sổ</dt><dd>{balance.on_hand_kg === null ? 'Chưa mở sổ' : inventoryKg(balance.on_hand_kg)}</dd></div>
      <div><dt>Đã giữ chỗ</dt><dd>{inventoryKg(balance.reserved_kg ?? 0)}</dd></div>
      <div><dt>Khả dụng</dt><dd>{inventoryKg(balance.available_kg ?? 0)}</dd></div>
    </dl>
    <form className="stock-modal-form" onSubmit={submit}>
      <fieldset hidden={review} disabled={busy || review}>
        <legend>Thông tin giao dịch</legend>
        {kind === 'OPENING' ? <strong>Tồn đầu kỳ</strong> : <div className="stock-modal-tabs" role="group" aria-label="Loại giao dịch">
          <button type="button" aria-pressed={kind === 'INBOUND'} onClick={() => selectKind('INBOUND')}><strong>Nhập kho</strong>
          <small>Bổ sung hàng hóa</small></button>
          <button type="button" aria-pressed={kind === 'ADJUST'} onClick={() => selectKind('ADJUST')}><strong>Kiểm kê tồn kho</strong>
          <small>Đối chiếu tồn thực tế</small></button>
        </div>}
        <label>
          {isCount
            ? 'Số lượng tồn thực tế kiểm kê (kg)'
            : kind === 'OPENING'
              ? 'Tồn đầu kỳ (kg)'
              : 'Số lượng nhập kho (kg)'}

          <input
            type="number"
            step="0.001"
            min={kind === 'INBOUND' ? 0.001 : 0}
            required
            value={amount}
            onChange={event => {
              setAmount(event.target.value)

              if (isCount) {
                setReason('')
                setOther('')
              }
            }}
          />
        </label>

        {isCount && amountValid && (
          <div
            className="stock-count-result"
            data-tone={
              change < 0
                ? 'negative'
                : change > 0
                  ? 'positive'
                  : 'neutral'
            }
          >
            <small>Chênh lệch kiểm kê</small>

            <strong>
              {change > 0 ? '+' : ''}
              {inventoryKg(change / 1000)}
            </strong>

            <span>
              {change > 0
                ? 'Thừa hàng · Điều chỉnh tăng'
                : change < 0
                  ? 'Thiếu hàng · Điều chỉnh giảm'
                  : 'Khớp sổ · Không cần điều chỉnh'}
            </span>
          </div>
        )}

        {amountError && (
          <p role="alert">{amountError}</p>
        )}

        {!matched && <>
        <label>{isCount ? 'Nguyên nhân chênh lệch' : 'Lý do'}<select aria-label="Lý do" value={reason} required onChange={event => {
          setReason(event.target.value); setOther('')
        }}>
          <option value="">Chọn lý do</option>
          {options.map(option => <option key={option}>{option}</option>)}
          <option value="OTHER">Khác</option>
        </select></label>
        {reason === 'OTHER' && <label>Lý do khác<textarea required maxLength={300} value={other}
          onChange={event => setOther(event.target.value)} /></label>}
        </>}
        <label>Ghi chú bổ sung<textarea value={note} maxLength={190} onChange={event => setNote(event.target.value)} /></label>
      </fieldset>
      {review && <section className="stock-modal-review" aria-label="Xác nhận giao dịch">
        <h3>Xác nhận giao dịch</h3>
        <p>
          {isCount
            ? 'Điều chỉnh sau kiểm kê'
            : stockKinds[kind]} · {finalReason}
        </p>
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
      {matched && (
        <p role="status">
          Tồn thực tế khớp sổ kho.
          Không phát sinh bút toán điều chỉnh.
        </p>
      )}

      {reasonTooLong && (
        <p role="alert">
          Lý do và ghi chú vượt giới hạn 500 ký tự.
        </p>
      )}

      <StateMessage error={checkError || state.error} />
      <div className="delivery-actions">
        <button type="button" className="dssr-secondary-button" onClick={review ? () => setReview(false) : close}
          disabled={busy}>{review ? 'Quay lại' : matched || stale ? 'Đóng' : 'Hủy'}</button>
        <button className="dssr-primary-button" disabled={blocked}>
          {busy
          ? 'Đang xử lý…'
          : review
            ? 'Xác nhận ghi tồn'
            : isCount
              ? 'Kiểm tra chênh lệch'
              : 'Kiểm tra giao dịch'}
        </button>
      </div>
    </form>
  </dialog>
}

export function InventoryWorkspace() {
  const [inventoryTab, setInventoryTab] =
    useState<'balances' | 'history'>('balances')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<Balance | null>(null)
  const [historySku, setHistorySku] = useState('')
  const [historyKind, setHistoryKind] = useState('')
  const [historyDay, setHistoryDay] = useState('')
  const [stockSaved, setStockSaved] = useState(false)
  const [page, setPage] = useState(1)
  const [historyPage, setHistoryPage] = useState(1)

  const load = useCallback(
    () => apiRequest<Inventory>('/planning/inventory/'),
    []
  )

  const query = useDssQuery(load)

  const historyFiltered = Boolean(
    historySku || historyKind || historyDay
  )

  const readHistory = useCallback(() => {
    const params = new URLSearchParams()
    if (historySku) params.set('supplier_item', historySku)
    if (historyKind) params.set('kind', historyKind)
    if (historyDay) params.set('day', historyDay)

    return params.size
      ? apiRequest<Inventory>('/planning/inventory/?' + params)
      : Promise.resolve(null)
  }, [historySku, historyKind, historyDay])

  const filteredHistory = useDssQuery(readHistory)

  const history = historyFiltered
    ? filteredHistory.data?.history
    : query.data?.history

  const balances = query.data?.balances ?? []

  const initialized = balances.filter(
    row => row.on_hand_kg !== null
  )

  const missingCount = balances.length - initialized.length

  const sumKg = (
    key: 'on_hand_kg' | 'reserved_kg' | 'available_kg'
  ) => {
    if (
      !initialized.length ||
      initialized.some(row => row[key] === null)
    ) return '—'

    const grams = initialized.reduce(
      (sum, row) =>
        sum + BigInt(Math.round(Number(row[key]) * 1000)),
      0n
    )

    const whole = grams / 1000n
    const fraction = (grams % 1000n)
      .toString()
      .padStart(3, '0')
      .replace(/0+$/, '')

    return inventoryKg(
      whole.toString() + (fraction ? '.' + fraction : '')
    )
  }

  const rows = balances.filter(row => {
    const found = (row.sku + ' ' + row.name)
      .toLocaleLowerCase('vi')
      .includes(search.trim().toLocaleLowerCase('vi'))

    return found && (
      filter === 'all' ||
      (filter === 'ready' && row.on_hand_kg !== null) ||
      (filter === 'missing' && row.on_hand_kg === null) ||
      (filter === 'reserved' && Number(row.reserved_kg) > 0) ||
      (filter === 'empty' &&
        row.available_kg !== null &&
        Number(row.available_kg) <= 0)
    )
  })

  const pageSize = 10
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const activePage = Math.min(page, pageCount)

  const visibleRows = rows.slice(
    (activePage - 1) * pageSize,
    activePage * pageSize
  )

  const historyCount = Math.max(
    1,
    Math.ceil((history?.length ?? 0) / pageSize)
  )

  const activeHistoryPage = Math.min(historyPage, historyCount)

  const visibleHistory = history?.slice(
    (activeHistoryPage - 1) * pageSize,
    activeHistoryPage * pageSize
  )

  function refresh() {
    query.reload()
    filteredHistory.reload()
  }

  function changeFilter(value: string) {
    setFilter(value)
    setPage(1)
  }

  const metrics = [
    {
      label: 'Danh mục SKU',
      value: String(balances.length),
      description: `${initialized.length} SKU đã mở sổ`,
      icon: '▤',
      tone: 'neutral'
    },
    {
      label: 'Tồn ghi sổ',
      value: sumKg('on_hand_kg'),
      description: 'Tổng khối lượng hàng đã ghi nhận',
      icon: '▦',
      tone: 'neutral'
    },
    {
      label: 'Đã giữ chỗ',
      value: sumKg('reserved_kg'),
      description: 'Dành cho cam kết cung ứng',
      icon: '◷',
      tone: 'amber'
    },
    {
      label: 'Tồn khả dụng',
      value: sumKg('available_kg'),
      description: 'Tồn ghi sổ − Đã giữ chỗ',
      icon: '✓',
      tone: 'green'
    }
  ]

  return (
    <main className="dssr-page delivery-page manager-workspace plan-publication supplier-inventory">

      <header className="inv-heading">
        <div>
          <p className="inv-eyebrow">
            SUPPLIER WORKSPACE / INVENTORY
          </p>
          <h1>Quản lý tồn kho</h1>
          <p className="inv-subtitle">
            Kiểm soát hàng hóa, lượng giữ chỗ và giao dịch tồn kho.
          </p>
        </div>

        <div className="inv-actions">
          <Link
            className="dssr-secondary-button"
            to="/supplier/items"
          >
            Danh mục mặt hàng
          </Link>

          <button
            type="button"
            className="dssr-secondary-button"
            onClick={refresh}
            disabled={query.loading}
          >
            ↻ Làm mới
          </button>
        </div>
      </header>

      {query.loading && (
        <p role="status">Đang tải dữ liệu tồn kho...</p>
      )}

      {query.error != null && (
        <StateMessage error={formatError(query.error)} />
      )}

      {query.data && <>
        {query.data.provenance !== 'OPERATIONAL' && (
          <p className="dssr-alert">
            Dữ liệu diễn tập cô lập · {query.data.provenance}
          </p>
        )}

        <section className="inv-kpis">
          {metrics.map(metric => (
            <article
              key={metric.label}
              className="inv-kpi"
              data-tone={metric.tone}
            >
              <div className="inv-kpi-header">
                <span>{metric.label}</span>
                <span className="inv-kpi-icon" aria-hidden="true">
                  {metric.icon}
                </span>
              </div>

              <strong>{metric.value}</strong>
              <small>{metric.description}</small>
            </article>
          ))}
        </section>

        {missingCount > 0 && (
          <div className="inv-notice">
            <span>
              <strong>{missingCount} SKU chưa mở sổ.</strong>
              {' '}Tổng khối lượng chỉ tính SKU đã ghi nhận tồn.
            </span>
            <button
              type="button"
              className="dssr-secondary-button"
              onClick={() => {
                setSearch('')
                changeFilter('missing')
              }}
            >
              Xem mặt hàng
            </button>
          </div>
        )}

        <nav className="inv-tabs" aria-label="Nội dung tồn kho">
          <button
            type="button"
            className="inv-tab"
            aria-pressed={inventoryTab === 'balances'}
            aria-controls="inv-balances"
            onClick={() => setInventoryTab('balances')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7l9-4 9 4-9 4-9-4Z" />
              <path d="M3 7v10l9 4 9-4V7" />
              <path d="M12 11v10" />
            </svg>
            <span>Tồn kho theo mặt hàng</span>
            <span className="inv-tab-count">
              {balances.length}
            </span>
          </button>

          <button
            type="button"
            className="inv-tab"
            aria-pressed={inventoryTab === 'history'}
            aria-controls="inv-history"
            onClick={() => setInventoryTab('history')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span>Lịch sử tồn kho</span>
          </button>
        </nav>

        <section
          className="inv-panel"
          id="inv-balances"
          hidden={inventoryTab !== 'balances'}
        >
          <div className="inv-section-header">
            <div>
              <h2>Tồn kho theo mặt hàng</h2>
              <p>Quản lý số dư và giao dịch theo từng SKU.</p>
            </div>
          </div>

          <div className="inv-toolbar">
            <label>
              Tìm kiếm mặt hàng
              <input
                type="search"
                placeholder="Nhập mã SKU hoặc tên mặt hàng..."
                value={search}
                onChange={event => {
                  setSearch(event.target.value)
                  setPage(1)
                }}
              />
            </label>

            <label>
              Tình trạng
              <select
                value={filter}
                onChange={event => changeFilter(event.target.value)}
              >
                <option value="all">Tất cả</option>
                <option value="ready">Đã mở sổ</option>
                <option value="missing">Chưa nhập tồn đầu kỳ</option>
                <option value="reserved">Có hàng giữ chỗ</option>
                <option value="empty">Hết tồn khả dụng</option>
              </select>
            </label>

            <button
              type="button"
              className="dssr-secondary-button"
              onClick={() => {
                setSearch('')
                changeFilter('all')
              }}
            >
              Xóa bộ lọc
            </button>
          </div>

          <div className="inv-table-scroll" tabIndex={0}>
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Mặt hàng / SKU</th>
                  <th>Tồn ghi sổ</th>
                  <th>Đã giữ chỗ</th>
                  <th>Khả dụng</th>
                  <th>Cập nhật</th>
                  <th>Thao tác</th>
                </tr>
              </thead>

              <tbody>
                {visibleRows.map(row => (
                  <tr key={row.supplier_item_id}>
                    <th scope="row">
                      <div className="inv-product">
                        <div className="inv-product-icon">▦</div>
                        <div>
                          <strong>{row.name}</strong>
                          <small>{row.sku}</small>
                        </div>
                      </div>
                    </th>

                    <td>
                      {row.on_hand_kg !== null
                        ? inventoryKg(row.on_hand_kg)
                        : <span className="inv-badge amber">
                            Chưa mở sổ
                          </span>}
                    </td>

                    <td>
                      <span className={
                        Number(row.reserved_kg) > 0
                          ? 'inv-reserved'
                          : ''
                      }>
                        {row.reserved_kg !== null
                          ? inventoryKg(row.reserved_kg)
                          : '—'}
                      </span>
                    </td>

                    <td>
                      <strong className="inv-available">
                        {row.available_kg !== null
                          ? inventoryKg(row.available_kg)
                          : '—'}
                      </strong>

                      {row.available_kg !== null &&
                        Number(row.available_kg) <= 0 && (
                          <small className="inv-badge amber">
                            Hết khả dụng
                          </small>
                      )}
                    </td>

                    <td className="inv-date">
                      {row.updated_at
                        ? runTime(row.updated_at)
                        : '—'}
                    </td>

                    <td>
                      <button
                        type="button"
                        className="inv-stock-button"
                        onClick={() => {
                          setStockSaved(false)
                          setSelected(row)
                        }}
                      >
                        {row.on_hand_kg === null
                          ? 'Nhập tồn đầu kỳ'
                          : 'Nhập / kiểm kê'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!rows.length && (
              <p className="inv-empty">
                Không tìm thấy mặt hàng phù hợp.
              </p>
            )}
          </div>

          <InventoryPager
            count={rows.length}
            page={activePage}
            pageSize={pageSize}
            onChange={setPage}
          />

          <StateMessage error="" saved={stockSaved} />

          {selected && (
            <StockModal
              key={selected.supplier_item_id}
              balance={selected}
              close={() => setSelected(null)}
              reload={() => {
                setStockSaved(true)
                refresh()
              }}
            />
          )}
        </section>

        <section
          className="inv-panel"
          id="inv-history"
          hidden={inventoryTab !== 'history'}
        >
          <div className="inv-section-header">
            <div>
              <h2>Lịch sử tồn kho</h2>
              <p>Tra cứu tối đa 100 giao dịch gần nhất theo bộ lọc.</p>
            </div>
          </div>

          <div className="inv-toolbar inv-history-toolbar">
            <label>
              Mặt hàng
              <select
                aria-label="SKU trong lịch sử"
                value={historySku}
                onChange={event => {
                  setHistorySku(event.target.value)
                  setHistoryPage(1)
                }}
              >
                <option value="">Tất cả SKU</option>
                {balances.map(row => (
                  <option
                    key={row.supplier_item_id}
                    value={row.supplier_item_id}
                  >
                    {row.sku} · {row.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Loại giao dịch
              <select
                value={historyKind}
                onChange={event => {
                  setHistoryKind(event.target.value)
                  setHistoryPage(1)
                }}
              >
                <option value="">Tất cả giao dịch</option>
                {Object.entries(stockKinds).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>

            <label>
              Ngày ghi sổ
              <input
                type="date"
                value={historyDay}
                onChange={event => {
                  setHistoryDay(event.target.value)
                  setHistoryPage(1)
                }}
              />
            </label>

            <button
              type="button"
              className="dssr-secondary-button"
              onClick={() => {
                setHistorySku('')
                setHistoryKind('')
                setHistoryDay('')
                setHistoryPage(1)
              }}
            >
              Xóa lọc
            </button>
          </div>

          {historyFiltered && filteredHistory.loading && (
            <p role="status">Đang tải lịch sử...</p>
          )}

          {historyFiltered && filteredHistory.error != null && (
            <StateMessage error={formatError(filteredHistory.error)} />
          )}

          {history && <>
            <div className="inv-table-scroll" tabIndex={0}>
              <table className="inv-table inv-ledger-table">
                <thead>
                  <tr>
                    <th>Thời gian / Mã</th>
                    <th>Mặt hàng</th>
                    <th>Giao dịch</th>
                    <th>Thay đổi tồn</th>
                    <th>Thay đổi giữ chỗ</th>
                    <th>Lý do / Nguồn</th>
                  </tr>
                </thead>

                <tbody>
                  {visibleHistory?.map(row => {
                    const item = balances.find(
                      balance =>
                        balance.supplier_item_id ===
                        row.balance__supplier_item_id
                    )

                    return (
                      <tr key={row.id}>
                        <td className="inv-date">
                          {runTime(row.recorded_at)}
                          <small>#{row.id}</small>
                        </td>

                        <th scope="row">
                          {item?.name ?? 'Mặt hàng'}
                          <small>
                            {item?.sku ?? row.balance__supplier_item_id}
                          </small>
                        </th>

                        <td>
                          <span className={
                            'inv-badge ' +
                            (row.kind === 'RESERVE'
                              ? 'amber'
                              : row.kind === 'PICKUP'
                                ? 'red'
                                : 'green')
                          }>
                            {stockKinds[row.kind] ?? row.kind}
                          </span>
                        </td>

                        <td>
                          <StockDelta value={row.on_hand_delta_kg} />
                        </td>

                        <td>
                          <StockDelta value={row.reserved_delta_kg} />
                        </td>

                        <td className="inv-reason">
                          {stockHistoryReason(row.reason)}
                          {row.source_reference && (
                            <small>
                              {stockHistoryReference(row.source_reference)}
                            </small>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {!history.length && (
                <p className="inv-empty">
                  Không có giao dịch phù hợp.
                </p>
              )}
            </div>

            <InventoryPager
              count={history.length}
              page={activeHistoryPage}
              pageSize={pageSize}
              onChange={setHistoryPage}
            />
          </>}
        </section>

      </>}
    </main>
  )
}

function InventoryPager({
  count, page, pageSize, onChange
}: {
  count: number
  page: number
  pageSize: number
  onChange: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(count / pageSize))

  return (
    <footer className="inv-pagination">
      <span>
        {count
          ? `Hiển thị ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, count)} / ${count}`
          : '0 kết quả'}
      </span>

      {pages > 1 && (
        <div>
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => onChange(page - 1)}
          >
            ‹ Trước
          </button>

          <strong>Trang {page}/{pages}</strong>

          <button
            type="button"
            disabled={page >= pages}
            onClick={() => onChange(page + 1)}
          >
            Sau ›
          </button>
        </div>
      )}
    </footer>
  )
}

function StockDelta({ value }: { value: InventoryWeight }) {
  const number = Number(value)

  return (
    <span className={
      'inv-delta ' +
      (number > 0 ? 'positive' : number < 0 ? 'negative' : '')
    }>
      {number > 0 ? '+' : ''}
      {inventoryKg(value)}
    </span>
  )
}

function stopActions(role: PublicationStop['role'], audience: Audience) {
  if (audience === 'supplier') return role === 'SUPPLIER_PICKUP' ? ['READY', 'SUPPLIER_HANDOVER', 'INCIDENT'] : []
  if (audience === 'purchasing') return role === 'OUTLET_DELIVERY' ? ['RECEIVE', 'INCIDENT'] : []
  if (audience !== 'provider') return []
  return ['ARRIVE', ({ SUPPLIER_PICKUP: 'CARRIER_PICKUP', OUTLET_DELIVERY: 'DELIVER',
    HUB_RECEIVE: 'HUB_RECEIVE', HUB_DISPATCH: 'HUB_DISPATCH' })[role], 'INCIDENT']
}

function ReceiptConditions({
  action,
  message,
}: {
  action: string
  message: string
}) {
  if (!action || !message) return null

  return (
    <div
      className="pr-action-warning"
      role="status"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 7h.01" />
      </svg>

      <div>
        <strong>
          {action === 'RECEIVE'
            ? 'Chưa thể kiểm nhận hàng'
            : 'Chưa thể báo sự cố'}
        </strong>

        <p>{message}</p>
      </div>
    </div>
  )
}


// CP19: visual status only; API remains authoritative for permissions and sequence.
function ProviderIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    ARRIVE: 'M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    INCIDENT: 'M12 3 2 21h20L12 3ZM12 9v5m0 3v.1',
    DELIVER: 'M3 7h12v11H3zM15 10h3l3 3v5h-6M7 18v2m12-2v2M6 10h6',
    CARRIER_PICKUP: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M7 5l9 4',
    CHECK: 'm5 12 4 4L19 6',
    TRUCK: 'M2 5h12v12H2zM14 9h4l4 4v4h-8M5 19a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm12 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM18 9v4h4',
    CLOCK: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
    HUB_RECEIVE: 'M3 21V8l9-5 9 5v13M7 21V12h10v9M12 12v9',
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.CARRIER_PICKUP} /></svg>
}

function providerStopName(plan: Detail, stop: PublicationStop) {
  if (stop.code) return stop.code
  if (stop.role === 'HUB_RECEIVE' || stop.role === 'HUB_DISPATCH') return plan.hub?.code ?? 'Hub'
  const party = stop.role === 'SUPPLIER_PICKUP' ? 'supplier' : 'outlet'
  const codes = new Set(stop.loads.map(load => plan.demands.find(demand => demand.id === load.demand_id)?.[party].code).filter(Boolean))
  return codes.size === 1 ? [...codes][0] : 'Điểm dừng ' + stop.sequence
}

function providerStopStatus(plan: Detail, wave: number, stop: PublicationStop) {
  const events = plan.events.filter(event => event.wave === wave && event.stop === stop.sequence)
  const all = (action: string) => stop.loads.length > 0 && stop.loads.every(load => events.some(event => event.demand_id === load.demand_id && event.action === action))
  const completion = ({ SUPPLIER_PICKUP: 'PICKUP_COMPLETE', OUTLET_DELIVERY: 'DELIVER', HUB_RECEIVE: 'HUB_RECEIVE', HUB_DISPATCH: 'HUB_DISPATCH' })[stop.role]
  if (all(completion)) return { tone: 'done', label: stop.role === 'OUTLET_DELIVERY' ? 'Đã bàn giao' : 'Đã chốt điểm dừng' }
  if (events.some(event => event.action === 'INCIDENT')) return { tone: 'incident', label: 'Đã ghi sự cố' }
  if (stop.role === 'SUPPLIER_PICKUP' && all('CARRIER_PICKUP')) return { tone: 'active', label: 'Chờ chốt hai bên' }
  if (events.some(event => event.action === 'ARRIVE' || event.action === completion)) return { tone: 'active', label: 'Đang xử lý' }
  return { tone: 'pending', label: 'Chưa ghi nhận đến' }
}

// CP19.1: use the first unfinished stop in sequence, not a local click or draft.
function providerCurrentStop(plan: Detail, wave: number, stops: PublicationStop[]) {
  if (plan.blocker === 'EXECUTION_CANCELLED') return undefined
  return [...stops].sort((a, b) => a.sequence - b.sequence)
    .find(stop => providerStopStatus(plan, wave, stop).tone !== 'done')?.sequence
}

function providerPrerequisiteMessage(plan: Detail, wave: number, stop: number, demandId: number, action: string) {
  const atStop = (name: string) => plan.events.some(event => event.wave === wave && event.stop === stop && event.demand_id === demandId && event.action === name)
  const missing: string[] = []
  if (action === 'CARRIER_PICKUP' && !atStop('READY')) missing.push('Nhà cung cấp xác nhận hàng sẵn sàng')
  if (['CARRIER_PICKUP', 'HUB_RECEIVE', 'HUB_DISPATCH', 'DELIVER'].includes(action) && !atStop('ARRIVE')) missing.push('Provider xác nhận đã đến điểm dừng')
  return missing.length ? 'Còn thiếu: ' + missing.join('; ') + '. Thực hiện các bước này rồi làm mới kế hoạch.' : ''
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
  // Điều kiện giao nhận dành cho Purchasing

  const isPurchasing = audience === 'purchasing'

  const receiptAlreadyRecorded = plan.events.some(
    event =>
      event.demand_id === load.demand_id &&
      event.wave === wave &&
      event.stop === stop &&
      (
        event.action === 'RECEIVE' ||
        event.action === 'RECEIVE_COMPLETE'
      )
  )

  const delivered = plan.events.some(
    event =>
      event.demand_id === load.demand_id &&
      event.wave === wave &&
      event.stop === stop &&
      event.action === 'DELIVER'
  )

  let actionWarning = ''

  if (isPurchasing && action) {
    if (plan.blocker) {
      actionWarning =
        failures[plan.blocker] ?? plan.blocker
    } else if (!load.items) {
      actionWarning =
        'Chưa có dữ liệu phân bổ SKU tại điểm dừng.'
    } else if (action === 'RECEIVE') {
      if (receiptAlreadyRecorded) {
        actionWarning =
          'Đã có bản ghi kiểm nhận tại điểm dừng này. ' +
          'Vui lòng xem lịch sử giao nhận.'
      } else if (!delivered) {
        actionWarning =
          'Chưa tìm thấy bản ghi vận chuyển bàn giao ' +
          'tại Outlet.'
      }
    }
  }

  const hideActionForm =
    isPurchasing &&
    Boolean(actionWarning) &&
    Boolean(plan.blocker || !load.items)
  const providerWarning = audience === 'provider' ? providerPrerequisiteMessage(plan, wave, stop, load.demand_id, action) : ''
  const canSubmit = !providerWarning && options.includes(action) && (!plan.blocker ||
    (plan.execution_provenance !== 'OPERATIONAL' && plan.blocker === 'SERVICE_DATE_NOT_REACHED' && action === 'READY'))
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
      const incident_code = String(values.get('incident_code') ?? '').trim()
      const isIncident = action === 'INCIDENT'
      const quantity_rows = !isIncident && hasQuantity.has(action)
        ? load.items.map(item => ({
            item_id: item.id,
            quantity_kg: String(values.get('qty-' + item.id) ?? ''),
          }))
        : []
      const short = quantity_rows.some(
        (row, index) => Number(row.quantity_kg) < Number(load.items?.[index].weight_kg)
      )
      if (isIncident && !incident_code) {
        return setValidation('Vui lòng chọn loại sự cố.')
      }
      if (isIncident && !reason_other) {
        return setValidation(failures.REASON_OTHER_REQUIRED)
      }
      if (!isIncident && reasonCode === 'OTHER' && !reason_other) {
        return setValidation(failures.REASON_OTHER_REQUIRED)
      }
      if (!isIncident && !reasonCode && short && ['SUPPLIER_HANDOVER', 'CARRIER_PICKUP', 'RECEIVE'].includes(action)) {
        return setValidation(failures.DISCREPANCY_REASON_REQUIRED)
      }
      if (!isIncident && (reasonCode === 'FULL' && short || ['PARTIAL', 'ADJUST_QUANTITY', 'REFUSED'].includes(reasonCode) && !short)) {
        return setValidation(failures.REASON_QUANTITY_MISMATCH)
      }
      setDraft({
        action,
        wave,
        stop,
        demand_id: load.demand_id,
        quantity_rows,
        reason_code: isIncident ? incident_code : reasonCode,
        reason_other,
        note,
        incident_code: isIncident ? incident_code : '',
      })
    }
    if (!options.length) return null
    const uniquePresets = Object.entries(presets).filter(
      ([, label], idx, arr) => arr.findIndex(([, l]) => l === label) === idx
    )
    return <form
      className={`execution-form ${
        audience === 'purchasing'
          ? 'pr-execution-form'
          : ''
      }`}
      onSubmit={submit}
    >

      <fieldset disabled={draft !== null || state.busy}>
      
      {audience === 'purchasing' ? (

        <div className="pr-execution-actions">

          <span className="pr-execution-label">
            Thao tác tại điểm dừng
          </span>

          <div
            className="pr-execution-action-grid"
            role="group"
            aria-label="Chọn thao tác giao nhận"
          >

            {options.map(option => (

              <button
                key={option}
                type="button"
                className="pr-execution-action"
                aria-pressed={action === option}
                data-action={option}
                onClick={() => {
                  setAction(option)
                  setReasonCode('')
                  setValidation('')
                }}
              >

                <span className="pr-action-icon">

                  {option === 'RECEIVE' ? (

                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
                      <path d="m3 7 9 4 9-4M12 11v10" />
                      <path d="m7 14 2 2 4-4" />
                    </svg>

                  ) : (

                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3 2 20h20z" />
                      <path d="M12 9v4M12 17h.01" />
                    </svg>

                  )}

                </span>

                <span>
                  <strong>{actions[option]}</strong>

                  <small>
                    {option === 'RECEIVE'
                      ? 'Nhập khối lượng thực nhận'
                      : 'Ghi nhận vấn đề phát sinh'}
                  </small>
                </span>

                <span className="pr-action-radio" />

              </button>

            ))}

          </div>

        </div>

      ) : audience === 'provider' ? (
        <div className="pt-action-picker">
          <div className="pt-action-title"><strong>Thao tác tại điểm dừng</strong><small>Chọn một nghiệp vụ</small></div>
          <div className="pt-action-grid" role="group" aria-label="Chọn thao tác tại điểm dừng">
            {options.map(option => {
              const recorded = plan.events.some(event => event.wave === wave && event.stop === stop && event.demand_id === load.demand_id && event.action === option)
              return <button type="button" key={option} data-action={option} aria-pressed={action === option} onClick={() => { setAction(option); setReasonCode(''); setValidation('') }}>
                <span className="pt-action-icon"><ProviderIcon name={option} /></span>
                <span><strong>{actions[option]}</strong><small>{recorded ? 'Đã có bản ghi' : option === 'INCIDENT' ? 'Ghi nhận ngoại lệ' : option === 'ARRIVE' ? 'Xác nhận mốc đến' : 'Xác nhận khối lượng'}</small></span>
                <span className="pt-action-radio" aria-hidden="true" />
              </button>
            })}
          </div>
          {action && !canSubmit && <p className="pt-action-blocked" role="status">{plan.blocker ? failures[plan.blocker] ?? plan.blocker : providerWarning || 'Thao tác chưa đủ điều kiện.'}</p>}
        </div>
      ) : (

        <label>
          Thao tác tại điểm dừng

          <select
            value={action}
            onChange={event => {
              setAction(event.target.value)
              setReasonCode('')
              setValidation('')
            }}
          >

            <option value="">Chọn thao tác</option>

            {options.map(option => (
              <option value={option} key={option}>
                {actions[option]}
              </option>
            ))}

          </select>

        </label>

      )}

      {isPurchasing && action && (
        <ReceiptConditions
          action={action}
          message={actionWarning}
        />
      )}

      <div
        key={action}
        className="execution-form-fields"
        hidden={isPurchasing && (
          !action || hideActionForm
        )}
      >
      {action === 'INCIDENT' ? <>
        <label>Loại sự cố<select name="incident_code" required>
          <option value="">Chọn loại sự cố</option>
          {Object.entries(incidents).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Mô tả sự cố<textarea name="reason_other" maxLength={300} required /></label>
        <label>Ghi chú bổ sung (không bắt buộc)<textarea name="note" maxLength={160} /></label>
      </> : <>
        
        {hasQuantity.has(action) && (

          audience === 'purchasing' ? (

            <div className="pr-quantity-section">

              <div className="pr-quantity-heading">
                <strong>Khối lượng kiểm nhận thực tế</strong>

                <small>
                  {load.items?.length ?? 0} SKU
                </small>
              </div>

              {load.items?.map(item => (

                <label
                  key={item.id}
                  className="pr-quantity-card"
                >

                  <div className="pr-quantity-card-head">

                    <div>
                      <strong>
                        {item.code ?? item.id}
                      </strong>

                      <span>
                        {item.name || '—'}
                      </span>
                    </div>

                    <div className="pr-quantity-expected">

                      <small>Dự kiến</small>

                      <strong>
                        {kg(item.weight_kg)}
                      </strong>

                    </div>

                  </div>

                  <div className="pr-quantity-input">

                    <input
                      type="number"
                      min="0"
                      max={item.weight_kg}
                      step="0.001"
                      name={'qty-' + item.id}
                      placeholder="Nhập khối lượng thực tế"
                      aria-label={`Khối lượng kiểm nhận ${item.code ?? item.id}`}
                      required
                    />

                    <span>kg</span>

                  </div>

                </label>

              ))}

            </div>

          ) : (

            load.items?.map(item => (
              <label key={item.id}>

                {item.code ?? item.id}
                {' · dự kiến '}
                {kg(item.weight_kg)}

                <input
                  type="number"
                  min="0"
                  max={item.weight_kg}
                  step="0.001"
                  name={'qty-' + item.id}
                  required
                />

              </label>
            ))

          )

        )}

        {action && <>
          <label>Đánh giá<select aria-label="Lý do" value={reasonCode} onChange={event => {
            setReasonCode(event.target.value); setValidation('')
          }}>
            <option value="">Chọn</option>
            {uniquePresets.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            <option value="OTHER">Khác — Nhập đánh giá</option>
          </select></label>
          {reasonCode === 'OTHER' && <label>Đánh giá khác<textarea name="reason_other" maxLength={300} required /></label>}
          <label>Ghi chú bổ sung (không bắt buộc)<textarea name="note" maxLength={160} /></label>
        </>}
      </>}
      </div></fieldset>
      {draft && <p role="status">{plan.execution_mode === 'SIMULATION' ? 'Mô phỏng Capstone' : 'Vận hành thực tế'} · {actions[draft.action]} · FinalPlan v{plan.version}
        {draft.action === 'INCIDENT'
          ? (draft.incident_code ? ' · ' + (incidents[draft.incident_code] ?? draft.incident_code) : '') +
            (draft.reason_other ? ' · ' + draft.reason_other : '')
          : (draft.reason_code && ' · ' + (draft.reason_other || presets[draft.reason_code]))}
        {draft.note && ' · ' + draft.note}</p>}
    {(!isPurchasing || (action && !hideActionForm)) && (
      <button
        className="dssr-primary-button"
        disabled={
          state.busy ||
          !canSubmit ||
          !load.items
        }
      >
        {draft
          ? plan.execution_mode === 'SIMULATION'
            ? 'Xác nhận ghi mô phỏng'
            : 'Xác nhận ghi nhận thực tế'
          : 'Kiểm tra trước khi lưu'}
      </button>
    )}
    {draft && <button className="dssr-secondary-button" type="button" disabled={state.busy} onClick={() => setDraft(null)}>Quay lại</button>}
    <StateMessage error={validation || state.error} saved={state.saved} />
  </form>
}


// CP18: explicit execution mode, scoped to the current URL; never silently switch modes.
function useExecutionMode() {
  const [params, setParams] = useSearchParams()
  const mode: ExecutionMode = params.get('mode') === 'SIMULATION' ? 'SIMULATION' : 'COMMERCIAL_EXECUTION'
  const changeMode = (next: ExecutionMode) => {
    if (next === mode) return
    const updated = new URLSearchParams(params)
    if (next === 'SIMULATION') updated.set('mode', 'SIMULATION')
    else updated.delete('mode')
    setParams(updated, { preventScrollReset: true })
  }
  return { mode, changeMode }
}

function ExecutionModeControl({ mode, onChange }: { mode: ExecutionMode; onChange: (mode: ExecutionMode) => void }) {
  const simulation = mode === 'SIMULATION'
  return <section className="execution-mode-switch" data-mode={mode} aria-label="Chế độ thực hiện giao nhận">
    <div className="execution-mode-switch-heading">
      <strong>Chế độ thực hiện</strong>
      <span className="execution-mode-switch-current" role="status">{simulation ? 'Mô phỏng Capstone' : 'Vận hành thực tế'}</span>
    </div>
    <div className="execution-mode-switch-options" role="group" aria-label="Chọn chế độ thực hiện">
      <button type="button" aria-pressed={simulation} onClick={() => onChange('SIMULATION')}>
        <strong>Mô phỏng Capstone</strong><small>Diễn tập theo mốc giờ Manager xác nhận</small>
      </button>
      <button type="button" aria-pressed={!simulation} onClick={() => onChange('COMMERCIAL_EXECUTION')}>
        <strong>Vận hành thực tế</strong><small>Chỉ ghi nhận đúng ngày giao nhận đã duyệt</small>
      </button>
    </div>
    <p>{simulation ? 'Có thể diễn tập không phụ thuộc ngày hiện tại. Sự kiện và tồn kho mô phỏng được lưu riêng; vẫn cần đúng trình tự và đủ điều kiện nghiệp vụ.' : 'Ghi nhận thực tế theo ngày dịch vụ và bằng chứng vận hành đã xác minh.'}</p>
    <small>Chuyển chế độ sẽ bỏ bản nháp chưa lưu. Dữ liệu đã ghi nhận không bị xóa hoặc chuyển chế độ.</small>
  </section>
}

export function ExecutionPanel({ audience, code, selected }: { audience: Audience; code: string; selected?: number }) {
  const availability = useDssQuery(useCallback(() => apiRequest<{ enabled: boolean }>('/planning/execution/availability/'), []))
  const { mode, changeMode } = useExecutionMode()
  return availability.data?.enabled
    ? <>
      <ExecutionModeControl mode={mode} onChange={changeMode} />
      <ExecutionDetails key={`${mode}:${code}:${selected ?? ''}`} audience={audience} code={code} selected={selected} mode={mode} />
    </>
    : null
}

function ExecutionDetails({ audience, code, selected, mode, providerTripDetail = false }: { audience: Audience; code: string; selected?: number; mode: ExecutionMode; providerTripDetail?: boolean }) {
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
  const tripDetail = audience === 'provider' && providerTripDetail
  const demandStates = Object.values(plan.demand_status)
  const done = demandStates.filter(state => state === 'COMPLETED').length
  const stopCount = plan.waves.reduce((sum, wave) => sum + wave.stops.length, 0)
  const totalKg = plan.demands.reduce((sum, demand) => sum + Number(demand.weight_kg), 0)
  const finishedStops = plan.waves.reduce((sum, wave) => sum + wave.stops.filter(stop => providerStopStatus(plan, wave.number, stop).tone === 'done').length, 0)
  return <section
    className={
      'dssr-panel delivery-section execution-timeline' +
      (tripDetail ? ' pt-trip-content' : '') +
      (audience === 'purchasing'
        ? ' pr-execution-timeline'
        : '')
    }
  >
    {tripDetail ? <>
      <div className="pt-trip-overview">
        <header className="pt-trip-header">
          <div><p className="pt-trip-eyebrow">KẾ HOẠCH VẬN CHUYỂN</p>
            <h2>FinalPlan v{plan.version}</h2>
            <p>{deliveryDate(plan.service_date)} · {plan.hub ? 'Qua Hub ' + (plan.hub.code ?? '') : 'Giao trực tiếp'} · {plan.provider.code ?? '—'}</p>
          </div>
          <button type="button" className="dssr-secondary-button" onClick={query.reload} disabled={query.loading}>↻ Làm mới</button>
        </header>
        <dl className="pt-trip-kpis" aria-label="Tổng quan chuyến">
          <div><dt>Demand theo dõi</dt><dd>{plan.demands.length}</dd></div>
          <div><dt>Khối lượng kế hoạch</dt><dd>{kg(String(totalKg))}</dd></div>
          <div><dt>Wave vận chuyển</dt><dd>{plan.waves.length}</dd></div>
          <div><dt>Điểm dừng theo lịch</dt><dd>{stopCount}</dd></div>
        </dl>
        <div className="pt-trip-progress-grid">
          <ExecutionProgress label="Demand hoàn thành" current={done} total={demandStates.length} />
          <ExecutionProgress label="Điểm dừng đã chốt / bàn giao" current={finishedStops} total={stopCount} />
        </div>
        <div className="pt-trip-mode-note"><ProviderIcon name={simulation ? 'CLOCK' : 'CHECK'} /><span>{simulation ? 'Mô phỏng Capstone' : 'Vận hành thực tế'} · {plan.events.length} sự kiện đã ghi nhận</span></div>
      </div>
    </> : audience === 'purchasing' ? (
        <h2>Thực hiện giao nhận</h2>
      ) : (
        <h2>
          Thực hiện · v{plan.version}
          {' · '}
          {deliveryDate(plan.service_date)}
        </h2>
      )}
    {simulation ? <p className="dssr-alert">Mô phỏng Capstone · Sự kiện và tồn mô phỏng được ghi riêng.
      {plan.simulation_started_at && <> Mốc giờ đã xác nhận <strong>{runTime(plan.simulation_started_at)}</strong>.</>}
    </p> : plan.execution_provenance !== 'OPERATIONAL' && <p className="dssr-alert">Diễn tập cô lập · {plan.execution_provenance}</p>}
    {plan.blocker && audience !== 'purchasing' &&
      !(tripDetail && plan.blocker === 'COMMERCIAL_EVIDENCE_REQUIRED') &&
      (tripDetail ? <div className="pt-trip-blocker" role="status"><strong>Chưa thể ghi nhận giao nhận</strong>
      <span>{plan.blocker === 'COMMERCIAL_EVIDENCE_REQUIRED' ? 'Cần xác minh bằng chứng vận hành trước khi ghi nhận thực tế.' : failures[plan.blocker] ?? plan.blocker}</span>
    </div> : <p className="dssr-alert">{failures[plan.blocker] ?? plan.blocker}</p>)}
    {audience === 'manager' && simulation && awaitingApproval && <form className="execution-form" onSubmit={event => {
      event.preventDefault()
      const clock_time = String(new FormData(event.currentTarget).get('clock_time') ?? '')
      if (clock_time) void approval.save(executionPath('manager', code, 'COMMERCIAL_EXECUTION', 'simulation/'), { clock_time }, query.reload)
    }}>
      <label>Giờ bắt đầu mô phỏng<input name="clock_time" type="time" required /></label>
      <p>Mốc giờ áp dụng cho ngày {deliveryDate(plan.service_date)} của FinalPlan v{plan.version}. Có thể xác nhận và diễn tập ngay, không cần chờ đến ngày dịch vụ. Mốc giờ chỉ được xác nhận một lần cho phiên bản này.</p>
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
    {tripDetail && <div className="pt-trip-section-heading"><h3>Demand trong kế hoạch</h3><span>{plan.demands.length} nhu cầu</span></div>}
    <ul className={'delivery-records' + (tripDetail ? ' pt-trip-demands' : '')}>{Object.entries(plan.demand_status).filter(([id]) => !selected || Number(id) === selected)
      .map(([id, status]) => {
        const demand = plan.demands.find(row => row.id === Number(id))
        return <li key={id}><strong>{codes.get(Number(id))}</strong>
          {tripDetail && demand && <div className="pt-demand-meta"><span>{demand.supplier.code ?? '—'} → {demand.outlet.code ?? '—'}</span><strong>{kg(demand.weight_kg)}</strong></div>}
          <span className="execution-badge" data-state={status}>{statuses[status] ?? status}</span></li>
      })}</ul>
    {tripDetail && <div className="pt-trip-section-heading"><h3>Lộ trình và điểm dừng</h3><span>{stopCount} điểm dừng theo kế hoạch</span></div>}
    {plan.waves
      .filter(wave =>
        audience !== 'purchasing' ||
        !selected ||
        wave.stops.some(stop =>
          stop.role === 'OUTLET_DELIVERY' &&
          stop.loads.some(
            load => load.demand_id === selected
          )
        )
      )
      .map(wave =>
        <details
          key={wave.number}
          open
          className={tripDetail ? 'pt-wave' : undefined}
        >
      <summary>{tripDetail ? <span className="pt-wave-summary"><span className="pt-wave-icon" aria-hidden="true">{wave.number}</span><span><strong>Wave {wave.number} · {wave.vehicle.code}</strong><small>{phaseLabels[wave.phase] ?? wave.phase} · {wave.stops.length} điểm dừng</small></span></span> : <>Wave {wave.number} · {wave.vehicle.code} · {phaseLabels[wave.phase] ?? wave.phase}</>}</summary>
      {wave.in_transit_kg !== undefined && <p className={tripDetail ? 'pt-wave-load' : undefined}>Khối lượng đang trên xe <strong>{kg(wave.in_transit_kg)}</strong></p>}
      {tripDetail && <div className="pt-route-board">
        <div className="pt-route-title"><strong>Hành trình Wave {wave.number}</strong><small>Xe tải: điểm tiếp theo · Giờ theo lịch</small></div>
        <ol className="pt-route-overview" aria-label="Trình tự điểm dừng">{wave.stops.map(stop => {
          const state = providerStopStatus(plan, wave.number, stop)
          const current = providerCurrentStop(plan, wave.number, wave.stops) === stop.sequence
          return <li key={stop.sequence} data-role={stop.role} data-progress={state.tone} data-current={current ? 'true' : undefined}>
            <button type="button" className="pt-route-jump" aria-current={current ? "step" : undefined} onClick={() => { const target = document.getElementById(`pt-stop-${wave.number}-${stop.sequence}`); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'start', behavior: 'auto' }) }}>
              <span className="pt-route-card-head">
                <span className="pt-route-dot" aria-label={current ? `Điểm tiếp theo ${stop.sequence}` : undefined}>{current ? <ProviderIcon name="TRUCK" /> : stop.sequence}</span>
                <small className="pt-route-kind">{stopLabels[stop.role]}</small>
              </span>
              <span className="pt-route-node">
                <strong>{providerStopName(plan, stop)}</strong>
                <time><ProviderIcon name="CLOCK" />{displayTime(stop.arrival)}</time>
              </span>
              <span className="pt-route-card-footer"><span className="pt-stop-state" data-progress={state.tone}>{current && state.tone === 'pending' ? 'Điểm tiếp theo' : state.label}</span></span>
            </button>
          </li>
        })}</ol>
      </div>}
      {wave.stops
        .filter(stop =>
          audience !== 'purchasing' ||
          !selected ||
          (
            stop.role === 'OUTLET_DELIVERY' &&
            stop.loads.some(
              load => load.demand_id === selected
            )
          )
        )
        .map(stop =>
          <div
            key={stop.sequence}
            className="execution-stop"
            data-role={tripDetail ? stop.role : undefined}
            id={tripDetail ? `pt-stop-${wave.number}-${stop.sequence}` : undefined}
            tabIndex={tripDetail ? -1 : undefined}
          >
        {tripDetail ? <header className="pt-stop-heading"><span className="pt-stop-number" aria-hidden="true">{String(stop.sequence).padStart(2, '0')}</span>
          <div><span className="pt-stop-role">{stopLabels[stop.role]} · Điểm {stop.sequence}</span><h3>{providerStopName(plan, stop)}</h3>{stop.address && <p>{stop.address}</p>}</div>
          <div className="pt-stop-meta"><span className="pt-stop-state" data-progress={providerStopStatus(plan, wave.number, stop).tone}>{providerStopStatus(plan, wave.number, stop).label}</span><span className="pt-stop-weight">{kg(stop.weight_kg)}</span></div>
        </header> : (
          <h3>
            {audience !== 'purchasing'
              ? `${stop.sequence}. `
              : ''}
            {stopLabels[stop.role]}
            {' · '}
            {stop.code ??
              plan.demands.find(
                demand => demand.id === stop.loads[0]?.demand_id
              )?.[
                audience === 'purchasing'
                  ? 'outlet'
                  : 'supplier'
              ].code}
          </h3>
        )}
        <dl className="execution-plan-facts" aria-label="Khung giờ dự kiến">
          <div><dt>Dự kiến đến</dt><dd>{displayTime(stop.arrival)}</dd></div>
          <div><dt>Chờ</dt><dd>{stop.wait_minutes ?? '—'} phút</dd></div>
          <div><dt>Phục vụ</dt><dd>{displayTime(stop.start)}–{displayTime(stop.end)}</dd></div>
          <div><dt>Rời điểm</dt><dd>{displayTime(stop.departure)}</dd></div>
        </dl>
        {stop.loads.filter(load => !selected || load.demand_id === selected).map(load => <div className="execution-stop-load" key={load.demand_id}>
          {tripDetail ? <div className="pt-load-heading"><div><small>DEMAND · PHẦN TẢI</small><strong>{codes.get(load.demand_id)}</strong></div><strong>{kg(load.weight_kg)}</strong></div> : <strong>{codes.get(load.demand_id)} · {kg(load.weight_kg)}</strong>}
          <ul aria-label={simulation ? 'Mốc mô phỏng' : 'Mốc thực tế'}>{plan.events.filter(event => event.demand_id === load.demand_id && event.wave === wave.number &&
            event.stop === stop.sequence && ['ARRIVE', 'PICKUP_COMPLETE', 'HUB_RECEIVE', 'HUB_DISPATCH', 'DELIVER', 'RECEIVE_COMPLETE']
              .includes(event.action)).map(event => <li key={event.id}>
            {actions[event.action]} {simulation ? 'mô phỏng' : 'thực tế'} <time dateTime={eventTime(event)}>{runTime(eventTime(event))}</time>
          </li>)}</ul>
          {load.items?.length ? (tripDetail ? <div className="pt-sku-table-wrap"><table className="pt-sku-table"><thead><tr><th scope="col">SKU / Mặt hàng</th><th scope="col">Khối lượng</th></tr></thead><tbody>{load.items.map(item => <tr key={item.id}><td><small>{item.code}</small><strong>{item.name ?? '—'}</strong></td><td>{kg(item.weight_kg)}</td></tr>)}</tbody></table></div> : <ul>{load.items.map(item => <li key={item.id}>{item.code} · {item.name} · {kg(item.weight_kg)}</li>)}</ul>) :
            <p>Chưa có phân bổ SKU cho phần tải này.</p>}
          <StopForm options={stopActions(stop.role, audience)} plan={plan} wave={wave.number} stop={stop.sequence}
            load={load} audience={audience} reload={query.reload} />
        </div>)}
      </div>)}
    </details>)}
    {tripDetail ? <div className="pt-trip-section-heading"><h3>{simulation ? 'Lịch sử giao nhận mô phỏng' : 'Lịch sử giao nhận thực tế'}</h3><span>{plan.events.filter(event => !selected || event.demand_id === selected).length} sự kiện</span></div> : <h3>{simulation ? 'Lịch sử giao nhận mô phỏng' : 'Lịch sử giao nhận thực tế'}</h3>}
    {!plan.events.some(
      event => !selected || event.demand_id === selected
    ) && (tripDetail ? <div className="pt-history-empty"><span aria-hidden="true">◷</span><strong>{simulation ? 'Chưa có sự kiện giao nhận mô phỏng' : 'Chưa có sự kiện giao nhận thực tế'}</strong><p>Các mốc lấy hàng, bàn giao và kiểm nhận đã ghi nhận sẽ xuất hiện tại đây.</p></div> : <p>Chưa có sự kiện thực hiện.</p>)}
    <ol className={'delivery-records' + (tripDetail ? ' pt-trip-history' : '')}>{plan.events.filter(event => !selected || event.demand_id === selected).map(event => <li key={event.id}>
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

// CP19.3: Provider index dashboard only. Data is from the selected execution mode.
const providerStatusColors: Record<string, string> = {
  AWAITING_PICKUP: '#c48a2c', PICKING_UP: '#4b83bb', IN_TRANSIT: '#176d87',
  AWAITING_RECEIPT: '#8768b2', COMPLETED: '#21835b', EXCEPTION: '#bd5145', CANCELLED: '#74827a',
}

function ProviderExecutionOverview({ counts, completed, planned, picked, received }: {
  counts: string[]; completed: number; planned: number; picked: number; received: number
}) {
  const total = counts.length
  const keys = [...Object.keys(statuses), ...new Set(counts.filter(state => !Object.prototype.hasOwnProperty.call(statuses, state)))]
  let offset = 0
  const segments = keys.map(key => {
    const count = counts.filter(state => state === key).length
    const percent = total ? count / total * 100 : 0
    const start = offset
    offset += percent
    return { key, label: statuses[key] ?? key, color: providerStatusColors[key] ?? '#53685b', count, percent, start }
  })
  const format = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 3 })
  const percentText = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + '%'
  const metrics = [
    { label: 'Demand đã hoàn thành', current: completed, total, unit: '', tone: 'completed', icon: '✓' },
    { label: 'Khối lượng đã lấy', current: picked, total: planned, unit: ' kg', tone: 'pickup', icon: '↑' },
    { label: 'Khối lượng đã nhận', current: received, total: planned, unit: ' kg', tone: 'receipt', icon: '↓' },
  ]
  return <section className="dssr-panel delivery-section pt-dashboard" aria-label="Tổng quan thực hiện">
    <header className="pt-dashboard-heading"><div><h2>Tổng quan thực hiện</h2><p>Phân bổ trạng thái và tiến độ giao nhận</p></div>
      <span className="pt-dashboard-scope">Kế hoạch hiện hành</span></header>
    <div className="pt-dashboard-body">
      <section className="pt-dashboard-status" aria-label="Trạng thái thực hiện Demand">
        <h3>Trạng thái Demand</h3>
        <div className="pt-donut-layout">
          <div className="pt-donut" role="img" aria-label={total ? `Tổng ${total} Demand. ${segments.filter(row => row.count).map(row => `${row.label}: ${row.count}`).join('; ')}` : 'Chưa có Demand'}>
            <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
              <circle cx="60" cy="60" r="46" fill="none" stroke="#e7eee9" strokeWidth="16" />
              {segments.filter(row => row.count > 0).map(row => <circle key={row.key} cx="60" cy="60" r="46" fill="none" stroke={row.color} strokeWidth="16" pathLength="100" strokeDasharray={`${row.percent} ${Math.max(0, 100 - row.percent)}`} strokeDashoffset={-row.start} transform="rotate(-90 60 60)" />)}
            </svg>
            <div className="pt-donut-center" aria-hidden="true"><strong>{format(total)}</strong><span>Demand</span></div>
          </div>
          <ul className="pt-donut-legend" aria-label="Chi tiết trạng thái">
            {segments.map(row => <li key={row.key}><span className="pt-legend-dot" style={{ backgroundColor: row.color }} aria-hidden="true" /><span>{row.label}</span><strong>{format(row.count)}</strong><small>{total ? percentText(row.percent) : '—'}</small></li>)}
          </ul>
        </div>
        {!total && <p className="pt-dashboard-note">Chưa có Demand trong kế hoạch hiện hành.</p>}
      </section>
      <section className="pt-dashboard-progress" aria-label="Tiến độ giao nhận">
        <h3>Tiến độ giao nhận</h3>
        <div className="pt-dashboard-metrics">
          {metrics.map(metric => {
            const valid = Number.isFinite(metric.current) && Number.isFinite(metric.total) && metric.total > 0
            const percent = valid ? Math.max(0, metric.current / metric.total * 100) : 0
            return <div key={metric.tone} className="pt-dashboard-metric" data-tone={metric.tone}>
              <div className="pt-metric-heading"><span className="pt-metric-icon" aria-hidden="true">{metric.icon}</span><span>{metric.label}</span><strong>{valid ? percentText(percent) : '—'}</strong></div>
              <div className="pt-metric-value">{Number.isFinite(metric.current) ? format(metric.current) : '—'}<span> / {Number.isFinite(metric.total) ? format(metric.total) : '—'}{metric.unit}</span></div>
              <progress aria-label={metric.label} value={Math.min(100, percent)} max={100} />
            </div>
          })}
        </div>
      </section>
    </div>
    <p className="pt-dashboard-note">Chỉ số theo chế độ thực hiện đang chọn; bộ lọc bên dưới chỉ áp dụng cho danh sách kế hoạch.</p>
  </section>
}

export function ExecutionWorkspace({ audience }: { audience: 'manager' | 'provider' }) {
  const { code } = useParams()
  const { mode, changeMode } = useExecutionMode()
  const [search, setSearch] = useState('')
  const [date, setDate] = useState('')
  const [status, setStatus] = useState('')
  const [template, setTemplate] = useState('')
  const query = useDssQuery<ExecutionIndex | null>(useCallback(() => code ? Promise.resolve(null) :
    apiRequest<ExecutionIndex>(executionPath(audience, undefined, mode)), [audience, code, mode]))
  const title = audience === 'provider' ? 'Điều phối chuyến vận chuyển' : 'Theo dõi thực hiện kế hoạch'
  const current = query.data?.plans.filter(row => row.current) ?? []
  const counts = current.flatMap(row => Object.values(row.demand_status))
  const rows = query.data?.plans.filter(row => {
    const searchText = [row.code, ...(audience === 'provider' ? ['FinalPlan v' + row.version, row.template === 'DIRECT' ? 'Direct Consolidated' : 'Qua Hub'] : []), row.run_number && 'Run ' + row.run_number, row.provider.code, row.hub?.code, ...row.demand_codes]
      .join(' ').toLocaleLowerCase('vi')
    return searchText.includes(search.trim().toLocaleLowerCase('vi')) &&
      (!date || row.service_date === date) && (!status || Object.values(row.demand_status).includes(status)) &&
      (!template || row.template === template)
  }) ?? []
  const planned = current.reduce((sum, plan) => sum + Number(plan.weight), 0)
  const providerIndex = audience === 'provider' && !code
  const providerDetail = audience === 'provider' && Boolean(code)
  const completed = counts.filter(value => value === 'COMPLETED').length
  const active = counts.filter(value => ['PICKING_UP', 'IN_TRANSIT', 'AWAITING_RECEIPT'].includes(value)).length
  const clearFilters = () => { setSearch(''); setDate(''); setStatus(''); setTemplate('') }
  return <main className={'dssr-page delivery-page manager-workspace plan-publication execution-workspace' + (providerIndex ? ' provider-trips-index' : providerDetail ? ' provider-trip-detail' : '')}>
    <header className="manager-heading">{code && <Link to={endpoints[audience] + modeQuery(mode)}>← Danh sách kế hoạch</Link>}<h1>{providerDetail ? 'Chi tiết chuyến vận chuyển' : title}</h1>
      {providerDetail && <p className="pt-trip-subtitle">Theo dõi lộ trình, khung giờ và giao nhận theo từng điểm dừng.</p>}
      {providerIndex && <div className="pt-heading-extra"><p>Theo dõi kế hoạch và tiến độ giao nhận trong phạm vi đơn vị vận chuyển.</p>
        <button type="button" className="dssr-secondary-button" disabled={query.loading} onClick={query.reload}>↻ Làm mới</button></div>}
    </header>
    <ExecutionModeControl mode={mode} onChange={changeMode} />
    {code ? <ExecutionDetails key={`${mode}:${code}`} audience={audience} code={code} mode={mode} providerTripDetail={providerDetail} /> : <>
      {query.loading && <p role="status">Đang tải kế hoạch…</p>}
      {query.error != null && <StateMessage error={formatError(query.error)} />}
      {query.data && <>
        {providerIndex ? <>
          <dl className="pt-kpis" aria-label="Tổng quan kế hoạch hiện hành">
            {[
              ['▤', 'FinalPlan hiện hành', current.length, 'Kế hoạch đang có hiệu lực'],
              ['▦', 'Demand theo dõi', counts.length, 'Nhu cầu trong kế hoạch hiện hành'],
              ['↗', 'Demand đang thực hiện', active, 'Lấy hàng, vận chuyển, chờ kiểm nhận'],
              ['✓', 'Demand hoàn thành', completed, 'Đã hoàn tất giao nhận'],
            ].map(([icon, label, value, note]) => <div key={label}><dt><span aria-hidden="true">{icon}</span>{label}</dt><dd>{value}</dd><small>{note}</small></div>)}
          </dl>
          <ProviderExecutionOverview counts={counts} completed={completed} planned={planned}
            picked={current.reduce((sum, plan) => sum + Number(plan.pickup_kg), 0)}
            received={current.reduce((sum, plan) => sum + Number(plan.receipt_kg), 0)} />
        </> : <dl className="execution-metrics" aria-label="Chỉ số giao nhận"><div><dt>FinalPlan hiện hành</dt><dd>{current.length}</dd></div>
          <div><dt>Demand theo dõi</dt><dd>{counts.length}</dd></div>
          {Object.entries(statuses).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{counts.filter(state => state === key).length}</dd></div>)}
        </dl>}
        {!providerIndex && <section className="dssr-panel delivery-section">
          <h2>Tiến độ giao nhận</h2>
          <ExecutionProgress label="Demand đã hoàn thành" current={counts.filter(value => value === 'COMPLETED').length} total={counts.length} />
          <ExecutionProgress label="Khối lượng đã lấy" current={current.reduce((sum, plan) => sum + Number(plan.pickup_kg), 0)} total={planned} unit=" kg" />
          <ExecutionProgress label="Khối lượng đã nhận" current={current.reduce((sum, plan) => sum + Number(plan.receipt_kg), 0)} total={planned} unit=" kg" />
        </section>}
        <section className="dssr-panel delivery-section">
          <h2>Danh sách kế hoạch thực hiện</h2>
          {providerIndex && <div className="pt-list-toolbar"><span>Hiển thị {rows.length} / {query.data.plans.length} kế hoạch</span><button type="button" className="dssr-secondary-button" onClick={clearFilters} disabled={!search && !date && !status && !template}>Xóa bộ lọc</button></div>}
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
              <div>{providerIndex && <span className="pt-card-eyebrow">KẾ HOẠCH VẬN CHUYỂN</span>}<Link to={endpoints[audience] + '/' + plan.code + modeQuery(mode)}>
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
            {plan.blocker && !(providerIndex && plan.blocker === 'COMMERCIAL_EVIDENCE_REQUIRED') && <p className="execution-warning">{failures[plan.blocker] ?? plan.blocker}</p>}
            {plan.provenance.classification !== 'OPERATIONAL_EVIDENCE' && plan.blocker !== 'COMMERCIAL_EVIDENCE_REQUIRED' &&
              (providerIndex ? <p className="pt-plan-source" title={plan.provenance.classification}><span aria-hidden="true">ⓘ</span> Nguồn lập kế hoạch · {plan.provenance.classification === 'INTERNAL_ASSUMPTIONS' ? 'Giả định nội bộ' : plan.provenance.classification}</p> : <p className="execution-warning">Nguồn lập kế hoạch · {plan.provenance.classification}</p>)}
            {providerIndex && <div className="pt-card-footer">
              <ExecutionProgress label="Demand hoàn thành" current={Object.values(plan.demand_status).filter(value => value === 'COMPLETED').length} total={Object.keys(plan.demand_status).length} />
              <Link className="pt-detail-link" to={endpoints[audience] + '/' + plan.code + modeQuery(mode)}>Xem chi tiết chuyến <span aria-hidden="true">→</span></Link>
            </div>}
          </li>)}</ul>
        </section>
      </>}
    </>}
  </main>
}
