import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { runTime } from '../../components/dss/f1Display'
import { ApiError, apiRequest } from '../../services/api/client'
import { useDssQuery } from '../../services/dss/useDssQuery'
import './DSSRunDetailPage.css'
import './PlanDeliveryPage.css'
import './AccountWorkspacePage.css'

const accountPath = '/accounts/workspace/users/'
const roles = {
  PURCHASING_STAFF: 'Nhân viên mua hàng',
  SUPPLIER: 'Nhà cung cấp',
  TRANSPORT_PROVIDER: 'Đơn vị vận chuyển',
}
type Role = keyof typeof roles
type Scope = { id: number; code: string; name: string }
type Account = { id: number; full_name: string; email: string; role: Role; scopes: Scope[]; is_active: boolean }
type AccountEvent = {
  action: string; at: string; actor: string | null; target_id: number
  before?: Record<string, unknown>; after?: Record<string, unknown>
}
type Detail = Account & { history: AccountEvent[] }
type Accounts = {
  users: Account[]; writes_enabled: boolean; profile_writes_enabled: boolean; external_scope_writes_enabled: boolean
  units: {
    outlets: { id: number; outlet_code: string; outlet_name: string }[]
    suppliers: { id: number; supplier_code: string; supplier_name: string }[]
    providers: { id: number; provider_code: string; provider_name: string }[]
  }
}
const actions = { RESET_PASSWORD: 'Đổi mật khẩu', ACTIVATE: 'Kích hoạt lại', DEACTIVATE: 'Xóa tài khoản' }
type Operation = keyof typeof actions
type Editor = { kind: 'create' } | { kind: 'edit'; user: Account } | { kind: 'operation'; user: Account; operation: Operation }
const events: Record<string, string> = {
  ACCOUNT_CREATED: 'Tạo tài khoản', ACCOUNT_EDITED: 'Chỉnh sửa tài khoản', ACCOUNT_PASSWORD_RESET: 'Đặt lại mật khẩu',
  ACCOUNT_ACTIVATED: 'Kích hoạt', ACCOUNT_DEACTIVATED: 'Vô hiệu hóa', ASSIGN_ROLE: 'Gán vai trò', CHANGE_ROLE: 'Đổi vai trò',
  REVOKE_ROLE: 'Thu hồi vai trò', ASSIGN_OUTLET_ACCESS: 'Cấp quyền Outlet', REVOKE_OUTLET_ACCESS: 'Thu hồi quyền Outlet',
}
const auditLabels: Record<string, string> = {
  full_name: 'Họ và tên', email: 'Email đăng nhập', role: 'Vai trò', scopes: 'ID đơn vị', outlet_ids: 'ID Outlet',
  scope: 'Phạm vi', external_accesses: 'Đơn vị bên ngoài', is_active: 'Hoạt động', active_outlet_ids: 'Outlet hiệu lực',
  sessions_revoked: 'Đã thu hồi phiên API', reason: 'Lý do', credential_changed: 'Đã đổi mật khẩu',
}

function failure(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Phiên đăng nhập đã hết hạn.'
    if (error.status === 404) return 'Tài khoản không còn trong phạm vi quản lý.'
    if (error.status === 403) {
      return error.message.startsWith('API request failed') ? 'Bạn không có quyền thực hiện thao tác này.' : error.message
    }
    if (error.status === 400) {
      if (Array.isArray(error.data) && error.data.every(value => typeof value === 'string')) return error.data.join(' ')
      if (error.data && typeof error.data === 'object') {
        const messages = Object.values(error.data).flat().filter(value => typeof value === 'string')
        if (messages.length) return messages.join(' ')
      }
      return 'Vui lòng kiểm tra email, phạm vi hoặc điều kiện mật khẩu.'
    }
  }
  return 'Không thể xử lý yêu cầu. Hãy thử lại.'
}

function statusLabel(active: boolean) {
  return active ? 'Hoạt động' : 'Vô hiệu hóa'
}

function AccountStatus({ active }: { active: boolean }) {
  return <span className="manager-badge" data-tone={active ? 'green' : 'red'}>{statusLabel(active)}</span>
}

function AuditValues({ values }: { values?: Record<string, unknown> }) {
  if (!values || !Object.keys(values).length) return <p>—</p>
  return <dl className="manager-fields">{Object.entries(values).map(([key, value]) => {
    const text = typeof value === 'boolean' ? (value ? 'Có' : 'Không')
      : typeof value === 'object' ? JSON.stringify(value) : String(value)
    return <div key={key}><dt>{auditLabels[key] ?? key}</dt><dd>{text}</dd></div>
  })}</dl>
}

function AccountDetails({ id }: { id: number }) {
  const query = useCallback(() => apiRequest<Detail>(accountPath + id + '/'), [id])
  const result = useDssQuery(query)
  const detail = result.data
  return <>
    {result.loading && <p role="status">Đang tải tài khoản…</p>}
    {result.error != null && <p role="alert" className="dssr-alert">{failure(result.error)}</p>}
    {detail && <>
      <h3>{detail.full_name}</h3><p>{detail.email}</p>
      <p><strong>{roles[detail.role]}</strong></p><AccountStatus active={detail.is_active} />
      <h3>Phạm vi đơn vị</h3>
      <ul className="manager-scope-list">{detail.scopes.map(scope => <li key={scope.id}>{scope.code} · {scope.name}</li>)}</ul>
      <dl className="manager-fields"><div><dt>Mật khẩu</dt><dd>••••••••</dd></div></dl>
      <h3>Lịch sử tài khoản</h3>
      {detail.history.length ? <ol className="manager-timeline">{detail.history.map((record, index) => <li key={record.at + index}>
        <details><summary><strong>{events[record.action] ?? record.action}</strong>
          <small>{runTime(record.at)} · {record.actor ?? 'Hệ thống'} · Tài khoản #{record.target_id}</small></summary>
          <p>Trước thay đổi</p><AuditValues values={record.before} />
          <p>Sau thay đổi</p><AuditValues values={record.after} />
        </details>
      </li>)}</ol> : <p className="delivery-empty">Chưa ghi nhận thay đổi tài khoản hoặc vai trò.</p>}
    </>}
  </>
}

function AccountModal({ title, busy, close, children }: { title: string; busy: boolean; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current!
    el.showModal()
    return () => el.close()
  }, [])
  return <dialog ref={dialog} className="delivery-confirm account-dialog" aria-labelledby="account-dialog-title"
    onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <h2 id="account-dialog-title">{title}</h2>{children}
  </dialog>
}

function getUnits(units: Accounts['units'], role: Role | ''): Scope[] {
  if (role === 'PURCHASING_STAFF') return units.outlets.map(row => ({id: row.id, code: row.outlet_code, name: row.outlet_name}))
  if (role === 'SUPPLIER') return units.suppliers.map(row => ({id: row.id, code: row.supplier_code, name: row.supplier_name}))
  if (role === 'TRANSPORT_PROVIDER') return units.providers.map(row => ({id: row.id, code: row.provider_code, name: row.provider_name}))
  return []
}

function AccountForm({ data, user, close, save }: { data: Accounts; user?: Account; close: () => void; save: () => void }) {
  const [role, setRole] = useState<Role | ''>(user?.role ?? '')
  const [selected, setSelected] = useState<number[]>(user?.scopes.map(scope => scope.id) ?? [])
  const [active, setActive] = useState(user?.is_active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const profileEditable = !user || data.profile_writes_enabled
  const externalLocked = Boolean(user && user.role === role && role !== 'PURCHASING_STAFF' && !data.external_scope_writes_enabled)
  const mustExplain = Boolean(user?.is_active && !active)
  const catalog = getUnits(data.units, role)
  const entries = role === user?.role
    ? [...catalog, ...user.scopes.filter(scope => !catalog.some(unit => unit.id === scope.id))]
    : catalog
  function changeRole(code: Role) {
    setRole(code)
    setSelected(code === user?.role ? user.scopes.map(scope => scope.id) : [])
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!role || !selected.length || busy) return
    const form = event.currentTarget
    const values = new FormData(form)
    const scope = role === 'PURCHASING_STAFF' ? {outlet_ids: selected} : role === 'SUPPLIER' ? {supplier_id: selected[0]} : {provider_id: selected[0]}
    const profile = profileEditable ? { full_name: values.get('full_name'), email: values.get('email') } : {}
    const details = user ? { confirm: values.has('confirm'), ...(mustExplain ? {reason: values.get('reason')} : {}) }
      : { password: values.get('password') }
    setBusy(true)
    setError('')
    try {
      await apiRequest<Account>(user ? accountPath + user.id + '/' : accountPath, {
        method: user ? 'PATCH' : 'POST', body: JSON.stringify({
          ...profile, ...scope, ...details, role_code: role, is_active: active,
        }),
      })
      form.reset()
      save()
    } catch (err) {
      const password = form.elements.namedItem('password')
      if (password instanceof HTMLInputElement) password.value = ''
      setError(failure(err))
    } finally {
      setBusy(false)
    }
  }
  return <AccountModal title={user ? 'Chỉnh sửa tài khoản' : 'Tạo tài khoản mới'} busy={busy} close={close}>
    <form className="manager-account-form" onSubmit={event => void submit(event)}>
      <label>Họ và tên<input name="full_name" required maxLength={255} autoComplete="name" defaultValue={user?.full_name} readOnly={!profileEditable} /></label>
      <label>Email đăng nhập<input name="email" type="email" required maxLength={254} autoComplete="username" defaultValue={user?.email} readOnly={!profileEditable} /></label>
      {!profileEditable && <small>Đổi họ tên hoặc email cần phê duyệt quyền bổ sung.</small>}
      <fieldset disabled={busy}><legend>Vai trò</legend>
        {Object.entries(roles).map(([key, label]) => <label className="manager-check" key={key}>
          <input type="radio" name="role" value={key} required checked={role === key} onChange={() => changeRole(key as Role)} /> {label}
        </label>)}
      </fieldset>
      {role && <fieldset disabled={busy || externalLocked}><legend>{role === 'PURCHASING_STAFF' ? 'Phạm vi Outlet' : 'Đơn vị nghiệp vụ'}</legend>
        <div className="account-scope-options">
          {entries.map(entry => <label key={entry.id} className="manager-check">
            <input type={role === 'PURCHASING_STAFF' ? 'checkbox' : 'radio'} name="scope" value={entry.id}
              checked={selected.includes(entry.id)} onChange={event => {
                const checked = event.target.checked
                setSelected(current => role !== 'PURCHASING_STAFF' ? [entry.id]
                  : checked ? [...current, entry.id] : current.filter(id => id !== entry.id))
              }} /> {entry.code} · {entry.name}
          </label>)}
          {!entries.length && <small>Chưa có đơn vị đủ điều kiện trong phạm vi quản lý.</small>}
        </div>
        {role === 'PURCHASING_STAFF' && <small>Đã chọn {selected.length} Outlet</small>}
      </fieldset>}
      {externalLocked && <small>Đổi đơn vị bên ngoài hiện tại cần phê duyệt quyền bổ sung.</small>}
      {!user && <label>Mật khẩu ban đầu<input required name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} /></label>}
      <label>Trạng thái<select value={String(active)} onChange={event => setActive(event.target.value === 'true')}>
        <option value="true">Hoạt động</option><option value="false">Vô hiệu hóa</option>
      </select></label>
      {mustExplain && <label>Lý do vô hiệu hóa<textarea required name="reason" maxLength={1000} /></label>}
      {user && <label className="manager-check"><input type="checkbox" name="confirm" required /> Xác nhận thay đổi tài khoản và phạm vi đã chọn</label>}
      {error && <p role="alert" className="dssr-alert">{error}</p>}
      <div className="delivery-actions"><button type="button" className="dssr-secondary-button" disabled={busy} onClick={close}>Hủy</button>
        <button className="dssr-primary-button" disabled={busy || !selected.length}>{user ? 'Lưu thay đổi' : 'Tạo tài khoản'}</button>
      </div>
    </form>
  </AccountModal>
}

function AccountOperation({ user, operation, close, save }: { user: Account; operation: Operation; close: () => void; save: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const values = new FormData(form)
    setBusy(true)
    setError('')
    try {
      await apiRequest(accountPath + user.id + '/', { method: 'POST', body: JSON.stringify({
        operation, confirm: values.has('confirm'),
        ...(operation === 'RESET_PASSWORD' ? { password: values.get('password') } : {}),
        ...(operation === 'DEACTIVATE' ? { reason: values.get('reason') } : {}),
      }) })
      form.reset()
      save()
    } catch (err) {
      const input = form.elements.namedItem('password')
      if (input instanceof HTMLInputElement) input.value = ''
      setError(failure(err))
    } finally {
      setBusy(false)
    }
  }
  return <AccountModal title={actions[operation]} busy={busy} close={close}>
    <p><strong>{user.full_name}</strong> · {user.email}</p>
    {operation === 'DEACTIVATE' && <p>Tài khoản sẽ bị vô hiệu hóa và phiên API bị thu hồi. Dữ liệu nghiệp vụ và lịch sử được giữ để tra cứu.</p>}
    <form className="manager-account-form" onSubmit={event => void submit(event)}>
      {operation === 'RESET_PASSWORD' && <label>Mật khẩu mới
        <input required type="password" name="password" autoComplete="new-password" minLength={12} maxLength={128} />
      </label>}
      {operation === 'DEACTIVATE' && <label>Lý do vô hiệu hóa<textarea name="reason" required maxLength={1000} /></label>}
      <label className="manager-check"><input type="checkbox" name="confirm" required /> Xác nhận {actions[operation].toLowerCase()}</label>
      {error && <p role="alert" className="dssr-alert">{error}</p>}
      <div className="delivery-actions">
        <button type="button" autoFocus className="dssr-secondary-button" disabled={busy} onClick={close}>Hủy</button>
        <button className={operation === 'DEACTIVATE' ? 'account-danger' : 'dssr-primary-button'} disabled={busy}>
          {operation === 'DEACTIVATE' ? 'Xác nhận vô hiệu hóa' : actions[operation]}
        </button>
      </div>
    </form>
  </AccountModal>
}

export default function AccountWorkspacePage() {
  const query = useCallback(() => apiRequest<Accounts>(accountPath), [])
  const result = useDssQuery(query)
  const data = result.data
  const [id, setId] = useState<number | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('active')
  const rows = data?.users.filter(row =>
    (!role || row.role === role) && (status === 'all' || row.is_active === (status === 'active'))
    && (row.full_name + ' ' + row.email).toLocaleLowerCase('vi-VN').includes(search.trim().toLocaleLowerCase('vi-VN'))) ?? []
  const detail = id == null ? null : data?.users.find(row => row.id === id)
  const saved = () => {
    setEditor(null)
    setNotice('Đã lưu thay đổi tài khoản.')
    result.reload()
  }
  const close = () => setEditor(null)
  return <main className="dssr-page delivery-page manager-workspace account-workspace">
    <header className="manager-heading"><p className="dssr-eyebrow">CoLogi Workspace</p>
      <h1>Phân quyền và tài khoản</h1><p>Quản lý vai trò, đơn vị và lịch sử tài khoản trong phạm vi được cấp.</p>
    </header>
    {notice && <p role="status" className="account-notice">{notice}</p>}
    {result.loading && <p role="status">Đang tải tài khoản…</p>}
    {result.error != null && <p role="alert" className="dssr-alert">{failure(result.error)} <button className="dssr-secondary-button" onClick={result.reload}>Thử lại</button></p>}
    {data && <>
      <dl className="manager-metrics">
        <div><dt>Tài khoản trong phạm vi</dt><dd>{data.users.length}</dd></div>
        <div><dt>Đang hoạt động</dt><dd>{data.users.filter(user => user.is_active).length}</dd></div>
        <div data-tone="amber"><dt>Vô hiệu hóa</dt><dd>{data.users.filter(user => !user.is_active).length}</dd></div>
        <div><dt>Vai trò hiện có</dt><dd>{new Set(data.users.map(user => user.role)).size}</dd></div>
      </dl>
      {!data.writes_enabled && <p className="delivery-empty">Tài khoản đang ở chế độ chỉ đọc.</p>}
      <div className={detail ? 'manager-columns account-columns' : 'account-columns'}>
        <section className="dssr-panel delivery-section">
          <div className="manager-row"><h2>Danh sách người dùng</h2>
            {data.writes_enabled && <button type="button" className="dssr-primary-button" onClick={() => setEditor({kind: 'create'})}>+ Tạo tài khoản</button>}
          </div>
          <div className="delivery-filters account-filters">
            <label>Tìm tài khoản<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Tìm tên hoặc email" /></label>
            <label>Vai trò<select value={role} onChange={event => setRole(event.target.value)}>
              <option value="">Tất cả vai trò</option>{Object.entries(roles).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select></label>
            <label>Trạng thái<select value={status} onChange={event => setStatus(event.target.value)}>
              <option value="all">Tất cả trạng thái</option><option value="active">Hoạt động</option><option value="inactive">Vô hiệu hóa</option>
            </select></label>
          </div>
          {rows.length ? <div className="manager-table-scroll" tabIndex={0} aria-label="Danh sách tài khoản">
            <table className="manager-table account-table"><thead><tr><th scope="col">Họ tên và email</th><th scope="col">Vai trò</th>
              <th scope="col">Phạm vi</th><th scope="col">Trạng thái</th><th scope="col">Mật khẩu</th>
              {data.writes_enabled && <th scope="col">Thao tác</th>}</tr></thead><tbody>
              {rows.map(row => <tr key={row.id} data-selected={row.id === id}>
                <th scope="row"><button type="button" aria-expanded={row.id === id} onClick={() => setId(current => current === row.id ? null : row.id)}>
                  {row.full_name}</button><small>{row.email}</small></th>
                <td data-label="Vai trò">{roles[row.role]}</td>
                <td data-label="Phạm vi">{row.scopes.map(scope => scope.code).join(', ')}</td>
                <td data-label="Trạng thái"><AccountStatus active={row.is_active} /></td>
                <td data-label="Mật khẩu">••••••••</td>
                {data.writes_enabled && <td data-label="Thao tác"><div className="account-row-actions">
                  <button type="button" onClick={() => setEditor({kind: 'edit', user: row})}>Chỉnh sửa</button>
                  <button type="button" onClick={() => setEditor({kind: 'operation', user: row, operation: 'RESET_PASSWORD'})}>Đổi mật khẩu</button>
                  {row.is_active
                    ? <button type="button" className="account-danger" onClick={() => setEditor({kind: 'operation', user: row, operation: 'DEACTIVATE'})}>Xóa</button>
                    : <button type="button" onClick={() => setEditor({kind: 'operation', user: row, operation: 'ACTIVATE'})}>Kích hoạt lại</button>}
                </div></td>}
              </tr>)}
            </tbody></table>
          </div> : <p className="delivery-empty">Chưa có tài khoản phù hợp với bộ lọc.</p>}
        </section>
        {detail && <section className="dssr-panel delivery-section account-details-panel"><div className="manager-row"><h2>Chi tiết tài khoản</h2>
          <button type="button" className="dssr-secondary-button" onClick={() => setId(null)}>Đóng</button></div><AccountDetails key={detail.id} id={detail.id} />
        </section>}
      </div>
      {data.writes_enabled && editor && (editor.kind === 'operation'
        ? <AccountOperation user={editor.user} operation={editor.operation} close={close} save={saved} />
        : <AccountForm data={data} user={editor.kind === 'edit' ? editor.user : undefined} close={close} save={saved} />)}
    </>}
  </main>
}
