import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { deliveryDate, runTime } from '../components/dss/f1Display'
import { ApiError, apiRequest } from '../services/api/client'
import { useDssQuery } from '../services/dss/useDssQuery'
import './dss/DSSRunDetailPage.css'
import './dss/PlanDeliveryPage.css'
import './OutletWorkspacePage.css'

type Outlet = {
  id: number; outlet_code: string; outlet_name: string; address: string; contact_name: string | null; phone: string | null; is_active: boolean
}
type Source = { id: number; source: string; source_reference: string }
type Interval = Source & { start_time: string; end_time: string }
type Window = Interval & { day_of_week: number; is_active: boolean }
type Slot = Interval & { slot_date: string; slot_type: 'BLOCKED' | 'AVAILABLE'; status: string; reason: string | null }
type Detail = Outlet & {
  can_edit: boolean; windows: Window[]; slots: Slot[]
  planning: { date: string; ready: boolean; checks: { code: string; phase: string; status: string; missing: string[] }[] }
  deactivation_blockers: { open_demands?: number; active_final_plans?: number; reserved_plans?: number }
  history: { action: string; at: string; actor: string | null; before: unknown; after: unknown }[]
}
type Store = { outlets: Outlet[]; summary: { total: number; active: number; inactive: number }; writes_enabled: boolean; can_create: boolean }
type Editor =
  | { kind: 'create' }
  | { kind: 'details' | 'state'; outlet: Outlet }
  | { kind: 'windows'; outlet: Outlet; row?: Window }
  | { kind: 'slots'; outlet: Outlet; date: string; row?: Slot }
const root = '/masterdata/outlet-workspace/'
const days = ['Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy', 'Chủ nhật']
const labels: Record<string, string> = {
  RECEIVING_WINDOWS: 'Khung nhận theo tuần', RECEIVING_SLOTS: 'Lịch nhận theo ngày đã xác nhận',
  SERVICE_DURATION: 'Thời lượng phục vụ điểm nhận', SUPPLIER_OUTLET_DISTANCE: 'Khoảng cách Supplier–Outlet',
  HUB_OUTLET_DISTANCE: 'Khoảng cách Hub–Outlet', TRAVEL_TIME: 'Thời gian di chuyển', HUB_COVERAGE: 'Phạm vi phục vụ từ Hub',
  BASELINE_COST: 'Chi phí giao độc lập', OUTLET_CREATED: 'Tạo điểm giao nhận', OUTLET_UPDATED: 'Sửa thông tin',
  OUTLET_ACTIVATED: 'Kích hoạt lại', OUTLET_DEACTIVATED: 'Ngừng hoạt động',
  OUTLET_RECEIVING_WINDOW: 'Cập nhật lịch tuần', OUTLET_RECEIVING_SLOT: 'Cập nhật lịch theo ngày',
}

function errorText(error: unknown) {
  if (!(error instanceof ApiError)) return 'Không thể kết nối. Hãy thử lại.'
  if (error.status === 401) return 'Phiên đăng nhập đã hết hạn.'
  if (error.status === 404) return 'Không tìm thấy điểm giao nhận trong phạm vi được cấp.'
  if (error.data && typeof error.data === 'object' && !Array.isArray(error.data)) {
    const values = Object.values(error.data).flat().filter(value => typeof value === 'string')
    if (values.length) return values.join(' ')
  }
  return error.status === 403 ? 'Bạn không có quyền thực hiện thao tác này.' : 'Không thể xử lý yêu cầu. Hãy kiểm tra dữ liệu.'
}

function Badge({ active }: { active: boolean }) {
  return <span className="manager-badge" data-tone={active ? 'green' : 'amber'}>{active ? 'Hoạt động' : 'Ngừng hoạt động'}</span>
}

function Blockers({ counts }: { counts: Detail['deactivation_blockers'] }) {
  const entries = [
    [counts.open_demands, 'nhu cầu chưa kết thúc'],
    [counts.active_final_plans, 'FinalPlan còn giữ nhu cầu'],
    [counts.reserved_plans, 'kế hoạch có phân bổ đang xử lý'],
  ] as const
  if (!entries.some(([count]) => Boolean(count))) return null
  return <p className="outlet-warning" role="status">Chưa thể ngừng hoạt động. Còn {entries.filter(([count]) => count).map(([count, label]) => count + ' ' + label).join(', ')}.</p>
}

function OutletDetail({ selected, open, writesEnabled }: { selected: number; open: (editor: Editor) => void; writesEnabled: boolean }) {
  const [date, setDate] = useState('')
  const query = useCallback(() => apiRequest<Detail>(root + selected + '/' + (date ? '?date=' + encodeURIComponent(date) : '')), [selected, date])
  const result = useDssQuery(query)
  const data = result.data
  return <>
    {result.loading && <p role="status">Đang tải điểm giao nhận…</p>}
    {result.error != null && <div role="alert" className="dssr-alert">{errorText(result.error)} <button className="dssr-secondary-button" onClick={result.reload}>Thử lại</button></div>}
    {data && <>
      <div className="manager-row"><h3>{data.outlet_name}</h3><Badge active={data.is_active} /></div>
      <p className="outlet-code">{data.outlet_code}</p>
      <dl className="manager-fields">
        <div><dt>Địa chỉ</dt><dd>{data.address}</dd></div>
        <div><dt>Người liên hệ</dt><dd>{data.contact_name || '—'}</dd></div>
        <div><dt>Điện thoại</dt><dd>{data.phone || '—'}</dd></div>
      </dl>
      <Blockers counts={data.deactivation_blockers} />
      {writesEnabled && !data.can_edit && <p className="outlet-warning">Chưa xác định được Manager phụ trách duy nhất để cập nhật điểm giao nhận này.</p>}
      {data.can_edit && <div className="delivery-actions">
        <button type="button" className="dssr-primary-button" onClick={() => open({kind: 'details', outlet: data})}>Chỉnh sửa</button>
        <button type="button" className="dssr-secondary-button" disabled={data.is_active && Object.values(data.deactivation_blockers).some(Boolean)}
          onClick={() => open({kind: 'state', outlet: data})}>{data.is_active ? 'Ngừng hoạt động' : 'Kích hoạt lại'}</button>
      </div>}
      <section className="outlet-subsection" aria-label="Dữ liệu lập kế hoạch">
        <div className="manager-row"><h3>Dữ liệu lập kế hoạch</h3>
          <span className="manager-badge" data-tone={data.planning.ready ? 'green' : 'amber'}>
            {data.planning.ready ? 'Đủ dữ liệu' : 'Thiếu dữ liệu lập kế hoạch'}
          </span>
        </div>
        <label className="outlet-date">Ngày kiểm tra
          <input type="date" value={date || data.planning.date} onChange={event => setDate(event.target.value)} />
        </label>
        <small>Kiểm tra nguồn cấp Outlet, Supplier và Hub theo ngày. DSS vẫn xác minh theo từng nhu cầu và phương án.</small>
        <ul className="outlet-checks">{data.planning.checks.map(row => <li key={row.code}>
          <div><strong>{labels[row.code] ?? row.code}</strong><small>{row.phase}{row.missing.length ? ' · ' + row.missing.join(', ') : ''}</small></div>
          <span className="manager-badge" data-tone={row.status === 'MISSING' ? 'amber' : 'green'}>
            {row.status === 'READY' ? 'Có dữ liệu' : row.status === 'MISSING' ? 'Thiếu' : 'Không áp dụng'}
          </span>
        </li>)}</ul>
      </section>
      <section className="outlet-subsection" aria-label="Lịch nhận hàng">
        <div className="manager-row"><h3>Lịch nhận theo tuần</h3>
          {data.can_edit && data.is_active && <button type="button" className="dssr-secondary-button" onClick={() => open({kind: 'windows', outlet: data})}>+ Khung nhận</button>}
        </div>
        {!data.windows.length && <p className="delivery-empty">Chưa có khung nhận theo tuần.</p>}
        <ul className="outlet-checks">{data.windows.map(row => <li key={row.id}>
          <div><strong>{days[row.day_of_week]}</strong><small>{row.start_time.slice(0, 5)}–{row.end_time.slice(0, 5)} · {row.is_active ? 'Đang áp dụng' : 'Đã tắt'}</small></div>
          {data.can_edit && data.is_active && row.source === 'PURCHASING_OUTLET_WORKSPACE'
            && <button type="button" className="dssr-secondary-button" onClick={() => open({kind: 'windows', outlet: data, row})}>Sửa</button>}
        </li>)}</ul>
        <div className="manager-row"><h3>Khung theo ngày {deliveryDate(data.planning.date)}</h3>
          {data.can_edit && data.is_active && <button type="button" className="dssr-secondary-button" onClick={() => open({kind: 'slots', outlet: data, date: data.planning.date})}>+ Mục lịch ngày</button>}
        </div>
        {!data.slots.length && <p className="delivery-empty">Chưa có mục lịch cho ngày này.</p>}
        <ul className="outlet-checks">{data.slots.map(row => <li key={row.id}>
          <div><strong>{row.slot_type === 'BLOCKED' ? 'Không tiếp nhận' : 'Có thể tiếp nhận'}</strong>
            <small>{row.start_time.slice(0, 5)}–{row.end_time.slice(0, 5)} · {row.status}{row.reason ? ' · ' + row.reason : ''}</small></div>
          {data.can_edit && data.is_active && row.source === 'PURCHASING_OUTLET_WORKSPACE' && ['OPEN', 'CANCELLED'].includes(row.status)
            && <button type="button" className="dssr-secondary-button" onClick={() => open({kind: 'slots', outlet: data, date: data.planning.date, row})}>Sửa</button>}
        </li>)}</ul>
      </section>
      <section className="outlet-subsection" aria-label="Lịch sử thay đổi"><h3>Lịch sử thay đổi</h3>
        {!data.history.length && <p className="delivery-empty">Chưa có thay đổi ghi nhận trong workspace.</p>}
        <ol className="manager-timeline">{data.history.map((row, index) => <li key={row.at + index}><details>
          <summary>{labels[row.action] ?? row.action}<small>{runTime(row.at)} · {row.actor ?? 'Hệ thống'}</small></summary>
          {row.before != null && <pre>{JSON.stringify(row.before, null, 2)}</pre>}
          {row.after != null && <pre>{JSON.stringify(row.after, null, 2)}</pre>}
        </details></li>)}</ol>
      </section>
    </>}
  </>
}

function Modal({ title, busy, close, children }: { title: string; busy: boolean; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current!
    node.showModal()
    return () => node.close()
  }, [])
  return <dialog ref={dialog} className="delivery-confirm outlet-dialog" aria-labelledby="outlet-dialog-title"
    onCancel={event => {event.preventDefault(); if (!busy) close()}}>
    <h2 id="outlet-dialog-title">{title}</h2>{children}
  </dialog>
}

function OutletForm({ editor, close, save }: { editor: Editor; close: () => void; save: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = editor.kind === 'create' ? 'Thêm điểm giao nhận' : editor.kind === 'details' ? 'Chỉnh sửa điểm giao nhận'
    : editor.kind === 'state' ? (editor.outlet.is_active ? 'Ngừng hoạt động' : 'Kích hoạt lại')
      : editor.kind === 'windows' ? 'Khung nhận theo tuần' : 'Mục lịch theo ngày'
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const values = Object.fromEntries(new FormData(event.currentTarget))
    let target = editor.kind === 'create' ? root : root + editor.outlet.id + '/'
    let method = 'POST'
    if (editor.kind === 'details') method = 'PATCH'
    if (editor.kind === 'state') {
      target += 'state/'
      values.is_active = String(!editor.outlet.is_active)
      values.confirm = 'true'
    }
    if (editor.kind === 'windows' || editor.kind === 'slots') {
      target += editor.kind + '/'
      if (editor.row) {
        target += editor.row.id + '/'
        method = 'PATCH'
      }
    }
    setBusy(true)
    setError('')
    try {
      await apiRequest(target, {method, body: JSON.stringify(values)})
      save(editor.kind === 'create' ? 'Đã thêm điểm giao nhận.' : 'Đã lưu thay đổi.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const editing = editor.kind === 'details' ? editor.outlet : undefined
  return <Modal title={name} busy={busy} close={close}>
    <form className="outlet-form" onSubmit={event => void submit(event)}>
      {(editor.kind === 'create' || editor.kind === 'details') && <>
        {editing ? <p className="outlet-code">{editing.outlet_code}</p> : <small>Mã Outlet được cấp tự động khi lưu.</small>}
        <label>Tên chi nhánh<input name="outlet_name" required maxLength={200} defaultValue={editing?.outlet_name} /></label>
        <label>Địa chỉ giao hàng<textarea name="address" required maxLength={600} defaultValue={editing?.address} /></label>
        <label>Người liên hệ<input name="contact_name" maxLength={150} defaultValue={editing?.contact_name ?? ''} /></label>
        <label>Điện thoại<input name="phone" type="tel" maxLength={30} defaultValue={editing?.phone ?? ''} /></label>
      </>}
      {editor.kind === 'state' && <>
        <p>{editor.outlet.outlet_name} · {editor.outlet.outlet_code}</p>
        {editor.outlet.is_active && <p>Điểm nhận sẽ biến mất khỏi danh sách tạo nhu cầu mới. Lịch sử và dữ liệu kế hoạch được giữ nguyên.</p>}
        <label>Lý do<textarea name="reason" required maxLength={1000} /></label>
        <label className="outlet-confirm"><input type="checkbox" required /> Tôi xác nhận thay đổi trạng thái</label>
      </>}
      {editor.kind === 'windows' && <>
        <label>Ngày trong tuần<select name="day_of_week" defaultValue={editor.row?.day_of_week ?? ''} required>
          <option value="">Chọn ngày</option>{days.map((day, index) => <option key={day} value={index}>{day}</option>)}
        </select></label>
        <label>Trạng thái<select name="is_active" defaultValue={String(editor.row?.is_active ?? true)}>
          <option value="true">Đang áp dụng</option><option value="false">Đã tắt</option>
        </select></label>
      </>}
      {editor.kind === 'slots' && <>
        <label>Ngày nhận<input name="slot_date" type="date" required defaultValue={editor.row?.slot_date ?? editor.date} /></label>
        <label>Loại khung<select name="slot_type" defaultValue={editor.row?.slot_type ?? 'AVAILABLE'}>
          <option value="AVAILABLE">Có thể tiếp nhận</option><option value="BLOCKED">Không tiếp nhận</option>
        </select></label>
        <label>Trạng thái<select name="status" defaultValue={editor.row?.status ?? 'OPEN'}>
          <option value="OPEN">Mở</option><option value="CANCELLED">Hủy</option>
        </select></label>
        <label>Lý do (bắt buộc khi không tiếp nhận)<textarea name="reason" maxLength={1000} defaultValue={editor.row?.reason ?? ''} /></label>
      </>}
      {(editor.kind === 'windows' || editor.kind === 'slots') && <div className="outlet-time-pair">
        <label>Giờ bắt đầu<input name="start_time" type="time" required defaultValue={editor.row?.start_time.slice(0, 5)} /></label>
        <label>Giờ kết thúc<input name="end_time" type="time" required defaultValue={editor.row?.end_time.slice(0, 5)} /></label>
      </div>}
      {error && <p className="dssr-alert" role="alert">{error}</p>}
      <div className="delivery-actions"><button type="button" className="dssr-secondary-button" disabled={busy} onClick={close}>Hủy</button>
        <button className="dssr-primary-button" disabled={busy}>{editor.kind === 'state' ? 'Xác nhận' : 'Lưu'}</button>
      </div>
    </form>
  </Modal>
}

export default function OutletWorkspacePage() {
  const query = useCallback(() => apiRequest<Store>(root), [])
  const result = useDssQuery(query)
  const [selection, setSelection] = useState<number | null>(null)
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('all')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [notice, setNotice] = useState('')
  const data = result.data
  const normalized = keyword.trim().toLocaleLowerCase('vi-VN')
  const rows = data?.outlets.filter(row => (status === 'all' || row.is_active === (status === 'active'))
    && (row.outlet_code + ' ' + row.outlet_name + ' ' + row.address).toLocaleLowerCase('vi-VN').includes(normalized)) ?? []
  return <main className="dssr-page delivery-page manager-workspace outlet-workspace">
    <header className="manager-heading"><p className="dssr-eyebrow">CoLogi Workspace · Mua hàng</p>
      <h1>Quản lý điểm giao nhận</h1><p>Tra cứu địa chỉ, lịch nhận hàng và dữ liệu lập kế hoạch tại các điểm đã được cấp.</p></header>
    {notice && <p className="outlet-notice" role="status">{notice}</p>}
    {result.loading && <p role="status">Đang tải danh sách điểm giao nhận…</p>}
    {result.error != null && <div className="dssr-alert" role="alert">{errorText(result.error)} <button className="dssr-secondary-button" onClick={result.reload}>Thử lại</button></div>}
    {data && <>
      <dl className="manager-metrics outlet-metrics">
        <div><dt>Tổng điểm giao nhận</dt><dd>{data.summary.total}</dd></div>
        <div><dt>Đang hoạt động</dt><dd>{data.summary.active}</dd></div>
        <div data-tone="amber"><dt>Ngừng hoạt động</dt><dd>{data.summary.inactive}</dd></div>
      </dl>
      {!data.writes_enabled && <p className="outlet-notice">Đang ở chế độ chỉ đọc. Thao tác ghi cần Manager phê duyệt quyền và phạm vi quản lý.</p>}
      <div className="manager-columns outlet-columns">
        <section className="dssr-panel delivery-section" aria-label="Danh sách điểm giao nhận">
          <div className="manager-row"><h2>Danh sách điểm giao nhận</h2>
            <button className="dssr-primary-button" type="button" disabled={!data.can_create}
              onClick={() => setEditor({kind: 'create'})}>+ Thêm điểm giao nhận</button>
          </div>
          {data.writes_enabled && !data.can_create && <small>Chưa xác định được Manager phụ trách để thêm điểm mới.</small>}
          <div className="delivery-filters outlet-filters">
            <label>Tìm điểm giao nhận<input type="search" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="Tên, mã hoặc địa chỉ" /></label>
            <label>Trạng thái<select value={status} onChange={event => setStatus(event.target.value)}>
              <option value="all">Tất cả trạng thái</option><option value="active">Hoạt động</option><option value="inactive">Ngừng hoạt động</option>
            </select></label>
          </div>
          {rows.length > 0 ? <ul className="outlet-list">{rows.map(row => <li key={row.id} data-selected={selection === row.id}>
            <div><button type="button" aria-expanded={selection === row.id} onClick={() => setSelection(row.id)}>{row.outlet_name}</button>
              <span className="outlet-code">{row.outlet_code}</span><p>{row.address}</p></div>
            <Badge active={row.is_active} />
          </li>)}</ul> : <p className="delivery-empty">Chưa có điểm giao nhận phù hợp với bộ lọc.</p>}
        </section>
        <section className="dssr-panel delivery-section" aria-label="Chi tiết điểm giao nhận">
          <div className="manager-row"><h2>Chi tiết điểm giao nhận</h2>
            {selection !== null && <button type="button" className="dssr-secondary-button" onClick={() => setSelection(null)}>Đóng</button>}
          </div>
          {selection === null ? <p className="delivery-empty">Chọn tên một điểm giao nhận để xem thông tin chi tiết.</p>
            : <OutletDetail key={selection} selected={selection} open={setEditor} writesEnabled={data.writes_enabled} />}
        </section>
      </div>
    </>}
    {editor && <OutletForm editor={editor} close={() => setEditor(null)} save={message => {
      setEditor(null)
      setNotice(message)
      result.reload()
    }} />}
  </main>
}
