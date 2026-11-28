import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'

import { deliveryDate, runTime } from '../components/dss/f1Display'
import { ApiError, apiRequest } from '../services/api/client'
import { useDssQuery } from '../services/dss/useDssQuery'
import { useAuth } from '../contexts/useAuth'

import './dss/DSSRunDetailPage.css'
import './dss/PlanDeliveryPage.css'
import './OutletWorkspacePage.css'

// Giữ nguyên các interface/types từ hệ thống CoLogi
type Outlet = {
  id: number
  outlet_code: string
  outlet_name: string
  address: string
  contact_name: string | null
  phone: string | null
  is_active: boolean
}

type Source = {
  id: number
  source: string
  source_reference: string
}

type Interval = Source & {
  start_time: string
  end_time: string
}

type Window = Interval & {
  day_of_week: number
  is_active: boolean
}

type Slot = Interval & {
  slot_date: string
  slot_type: 'BLOCKED' | 'AVAILABLE'
  status: string
  reason: string | null
}

type Detail = Outlet & {
  can_edit: boolean
  windows: Window[]
  slots: Slot[]

  planning: {
    date: string
    ready: boolean

    checks: {
      code: string
      phase: string
      status: string
      missing: string[]
    }[]
  }

  deactivation_blockers: {
    open_demands?: number
    active_final_plans?: number
    reserved_plans?: number
  }

  history: {
    action: string
    at: string
    actor: string | null
    before: unknown
    after: unknown
  }[]
}

type Store = {
  outlets: Outlet[]

  summary: {
    total: number
    active: number
    inactive: number
  }

  writes_enabled: boolean
  can_create: boolean
}

type Editor =
  | { kind: 'create' }
  | { kind: 'details' | 'state'; outlet: Outlet }
  | { kind: 'windows'; outlet: Outlet; row?: Window }
  | {
      kind: 'slots'
      outlet: Outlet
      date: string
      row?: Slot
    }

const root = '/masterdata/outlet-workspace/'

const days = [
  'Thứ hai',
  'Thứ ba',
  'Thứ tư',
  'Thứ năm',
  'Thứ sáu',
  'Thứ bảy',
  'Chủ nhật',
]

const labels: Record<string, string> = {
  RECEIVING_WINDOWS: 'Khung nhận theo tuần',
  RECEIVING_SLOTS: 'Lịch nhận theo ngày đã xác nhận',
  SERVICE_DURATION: 'Thời lượng phục vụ điểm nhận',
  SUPPLIER_OUTLET_DISTANCE: 'Khoảng cách Supplier–Outlet',
  HUB_OUTLET_DISTANCE: 'Khoảng cách Hub–Outlet',
  TRAVEL_TIME: 'Thời gian di chuyển',
  HUB_COVERAGE: 'Phạm vi phục vụ từ Hub',
  BASELINE_COST: 'Chi phí giao độc lập',

  OUTLET_CREATED: 'Tạo điểm giao nhận',
  OUTLET_UPDATED: 'Sửa thông tin',
  OUTLET_ACTIVATED: 'Kích hoạt lại',
  OUTLET_DEACTIVATED: 'Ngừng hoạt động',
  OUTLET_RECEIVING_WINDOW: 'Cập nhật lịch tuần',
  OUTLET_RECEIVING_SLOT: 'Cập nhật lịch theo ngày',
}
function errorText(error: unknown) {
  if (!(error instanceof ApiError)) {
    return 'Không thể kết nối. Hãy thử lại.'
  }

  if (error.status === 401) {
    return 'Phiên đăng nhập đã hết hạn.'
  }

  if (error.status === 404) {
    return 'Không tìm thấy điểm giao nhận trong phạm vi được cấp.'
  }

  if (
    error.data &&
    typeof error.data === 'object' &&
    !Array.isArray(error.data)
  ) {
    const values = Object.values(error.data)
      .flat()
      .filter(value => typeof value === 'string')

    if (values.length) {
      return values.join(' ')
    }
  }

  return error.status === 403
    ? 'Bạn không có quyền thực hiện thao tác này.'
    : 'Không thể xử lý yêu cầu. Hãy kiểm tra dữ liệu.'
}

function Badge({ active }: { active: boolean }) {
  return (
    <span
      className="manager-badge"
      data-tone={active ? 'green' : 'amber'}
    >
      {active ? 'Hoạt động' : 'Ngừng hoạt động'}
    </span>
  )
}

function Blockers({
  counts,
}: {
  counts: Detail['deactivation_blockers']
}) {
  const entries = [
    [counts.open_demands, 'nhu cầu chưa kết thúc'],
    [counts.active_final_plans, 'FinalPlan còn giữ nhu cầu'],
    [counts.reserved_plans, 'kế hoạch có phân bổ đang xử lý'],
  ] as const

  if (!entries.some(([count]) => Boolean(count))) {
    return null
  }

  return (
    <p className="outlet-warning" role="status">
      Chưa thể ngừng hoạt động. Còn{' '}
      {entries
        .filter(([count]) => count)
        .map(([count, label]) => count + ' ' + label)
        .join(', ')}
      .
    </p>
  )
}
function OutletDrawer({
  outlet,
  open,
  writesEnabled,
  revision,
  onClose,
}: {
  outlet: Outlet
  open: (editor: Editor) => void
  writesEnabled: boolean
  revision: number
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

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
      document.body.style.overflow = previousOverflow

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
      className="outlet-drawer"
      aria-labelledby="outlet-drawer-title"
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
      <div className="outlet-drawer-layout">

        <header className="outlet-drawer-header">

          <div className="outlet-drawer-heading">

            <div>
              <p className="outlet-drawer-eyebrow">
                COLOGI · CHI TIẾT ĐIỂM GIAO NHẬN
              </p>

              <h2 id="outlet-drawer-title">
                {outlet.outlet_name}
              </h2>

              <div className="outlet-drawer-identity">

                <span className="outlet-code">
                  {outlet.outlet_code}
                </span>

                <Badge active={outlet.is_active} />

              </div>
            </div>

            <button
              type="button"
              className="outlet-drawer-close"
              aria-label="Đóng chi tiết điểm giao nhận"
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

        </header>

        <OutletDetail
          selected={outlet.id}
          open={open}
          writesEnabled={writesEnabled}
          revision={revision}
        />

      </div>
    </dialog>
  )
}
function OutletDetail({
  selected,
  open,
  writesEnabled,
  revision,
}: {
  selected: number
  open: (editor: Editor) => void
  writesEnabled: boolean
  revision: number
}) {

  const [date, setDate] = useState('')

  const [tab, setTab] = useState<
    'overview' | 'planning' | 'schedule' | 'history'
  >('overview')

  const query = useCallback(
    () => apiRequest<Detail>(
      root +
      selected +
      '/' +
      (date ? '?date=' + encodeURIComponent(date) : '')
    ),
    [selected, date]
  )

  const result = useDssQuery(query)

  const data = result.data

  const lastRevision = useRef(revision)

  useEffect(() => {
    if (lastRevision.current !== revision) {
      lastRevision.current = revision
      result.reload()
    }
  }, [revision, result.reload])

  const tabs = [
    { value: 'overview', label: 'Tổng quan' },
    { value: 'planning', label: 'Dữ liệu lập kế hoạch' },
    { value: 'schedule', label: 'Lịch nhận hàng' },
    { value: 'history', label: 'Lịch sử thay đổi' },
  ] as const

  return (
    <>

      {/* ACTIONS */}

      {data?.can_edit && (
        <div className="outlet-drawer-actions">

          <button
            type="button"
            className="dssr-primary-button"
            onClick={() => open({
              kind: 'details',
              outlet: data,
            })}
          >
            Chỉnh sửa
          </button>

          <button
            type="button"
            className="dssr-secondary-button"
            disabled={
              data.is_active &&
              Object.values(data.deactivation_blockers)
                .some(Boolean)
            }
            onClick={() => open({
              kind: 'state',
              outlet: data,
            })}
          >
            {data.is_active
              ? 'Ngừng hoạt động'
              : 'Kích hoạt lại'}
          </button>

        </div>
      )}

      {/* TABS */}

      <div
        className="outlet-detail-tabs"
        role="group"
        aria-label="Nội dung chi tiết điểm giao nhận"
      >
        {tabs.map(item => (
          <button
            key={item.value}
            type="button"
            aria-pressed={tab === item.value}
            onClick={() => setTab(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* BODY */}

      <div className="outlet-drawer-body">

        {result.loading && (
          <p className="outlet-loading" role="status">
            Đang tải điểm giao nhận…
          </p>
        )}

        {result.error != null && (
          <div className="dssr-alert" role="alert">
            {errorText(result.error)}

            <button
              type="button"
              className="dssr-secondary-button"
              onClick={result.reload}
            >
              Thử lại
            </button>
          </div>
        )}

        {data && (
          <>

            {/* TAB 1 — TỔNG QUAN */}

            {tab === 'overview' && (
              <section className="outlet-detail-section">

                <h3>Thông tin điểm giao nhận</h3>

                <dl className="outlet-overview-grid">

                  <div className="outlet-overview-address">
                    <dt>Địa chỉ</dt>
                    <dd>{data.address}</dd>
                  </div>

                  <div>
                    <dt>Người liên hệ</dt>
                    <dd>{data.contact_name || '—'}</dd>
                  </div>

                  <div>
                    <dt>Điện thoại</dt>
                    <dd>{data.phone || '—'}</dd>
                  </div>

                </dl>

                <Blockers counts={data.deactivation_blockers} />

                {writesEnabled && !data.can_edit && (
                  <p className="outlet-warning">
                    Chưa xác định được Manager phụ trách duy nhất
                    để cập nhật điểm giao nhận này.
                  </p>
                )}

              </section>
            )}

            {/* TAB 2 — DỮ LIỆU LẬP KẾ HOẠCH */}

            {tab === 'planning' && (
              <section className="outlet-detail-section">

                <div className="outlet-section-heading">

                  <h3>Dữ liệu lập kế hoạch</h3>

                  <span
                    className="manager-badge"
                    data-tone={
                      data.planning.ready ? 'green' : 'amber'
                    }
                  >
                    {data.planning.ready
                      ? 'Đủ dữ liệu'
                      : 'Thiếu dữ liệu lập kế hoạch'}
                  </span>

                </div>

                <div className="outlet-date-panel">

                  <label className="outlet-date">

                    Ngày kiểm tra

                    <input
                      type="date"
                      value={date || data.planning.date}
                      onChange={event =>
                        setDate(event.target.value)
                      }
                    />

                  </label>

                  <small>
                    Kiểm tra nguồn cấp Outlet, Supplier và Hub theo ngày.
                    DSS vẫn xác minh theo từng nhu cầu và phương án.
                  </small>

                </div>

                <div className="outlet-readiness-wrap">

                  <table className="outlet-readiness-table">

                    <thead>
                      <tr>
                        <th scope="col">Nguồn dữ liệu</th>
                        <th scope="col">Chức năng</th>
                        <th scope="col">Trạng thái</th>
                      </tr>
                    </thead>

                    <tbody>

                      {data.planning.checks.map(row => (
                        <tr key={row.code}>

                          <td>
                            <strong>
                              {labels[row.code] ?? row.code}
                            </strong>

                            {row.missing.length > 0 && (
                              <small className="outlet-missing-detail">
                                {row.missing.join(', ')}
                              </small>
                            )}
                          </td>

                          <td>{row.phase}</td>

                          <td>
                            <span
                              className="manager-badge"
                              data-tone={
                                row.status === 'MISSING'
                                  ? 'amber'
                                  : 'green'
                              }
                            >
                              {row.status === 'READY'
                                ? 'Có dữ liệu'
                                : row.status === 'MISSING'
                                  ? 'Thiếu'
                                  : 'Không áp dụng'}
                            </span>
                          </td>

                        </tr>
                      ))}

                    </tbody>

                  </table>

                </div>

              </section>
            )}

            {/* TAB 3 — LỊCH NHẬN HÀNG */}

            {tab === 'schedule' && (
              <section className="outlet-detail-section">

                <div className="outlet-schedule-block">

                  <div className="outlet-section-heading">

                    <h3>Lịch nhận theo tuần</h3>

                    {data.can_edit && data.is_active && (
                      <button
                        type="button"
                        className="dssr-primary-button"
                        onClick={() => open({
                          kind: 'windows',
                          outlet: data,
                        })}
                      >
                        + Khung nhận
                      </button>
                    )}

                  </div>

                  {!data.windows.length ? (
                    <div className="outlet-empty-state">
                      <p>Chưa có khung nhận theo tuần.</p>
                    </div>
                  ) : (
                    <ul className="outlet-schedule-list">

                      {data.windows.map(row => (
                        <li key={row.id}>

                          <div>

                            <strong>
                              {days[row.day_of_week]}
                            </strong>

                            <small>
                              {row.start_time.slice(0, 5)}
                              {' – '}
                              {row.end_time.slice(0, 5)}
                              {' · '}
                              {row.is_active
                                ? 'Đang áp dụng'
                                : 'Đã tắt'}
                            </small>

                          </div>

                          {data.can_edit &&
                            data.is_active &&
                            row.source ===
                              'PURCHASING_OUTLET_WORKSPACE' && (
                              <button
                                type="button"
                                className="dssr-secondary-button"
                                onClick={() => open({
                                  kind: 'windows',
                                  outlet: data,
                                  row,
                                })}
                              >
                                Sửa
                              </button>
                            )}

                        </li>
                      ))}

                    </ul>
                  )}

                </div>

                {/* LỊCH THEO NGÀY */}

                <div className="outlet-schedule-block">

                  <div className="outlet-section-heading">

                    <h3>Khung theo ngày</h3>

                    {data.can_edit && data.is_active && (
                      <button
                        type="button"
                        className="dssr-primary-button"
                        onClick={() => open({
                          kind: 'slots',
                          outlet: data,
                          date: data.planning.date,
                        })}
                      >
                        + Mục lịch ngày
                      </button>
                    )}

                  </div>

                  <div className="outlet-date-panel">

                    <label className="outlet-date">

                      Ngày nhận hàng

                      <input
                        type="date"
                        value={date || data.planning.date}
                        onChange={event =>
                          setDate(event.target.value)
                        }
                      />

                    </label>

                    <small>
                      Lịch nhận ngày {deliveryDate(data.planning.date)}
                    </small>

                  </div>

                  {!data.slots.length ? (
                    <div className="outlet-empty-state">
                      <p>Chưa có mục lịch cho ngày này.</p>
                    </div>
                  ) : (
                    <ul className="outlet-schedule-list">

                      {data.slots.map(row => (
                        <li key={row.id}>

                          <div>

                            <strong>
                              {row.slot_type === 'BLOCKED'
                                ? 'Không tiếp nhận'
                                : 'Có thể tiếp nhận'}
                            </strong>

                            <small>
                              {row.start_time.slice(0, 5)}
                              {' – '}
                              {row.end_time.slice(0, 5)}
                              {' · '}
                              {row.status}

                              {row.reason
                                ? ' · ' + row.reason
                                : ''}
                            </small>

                          </div>

                          {data.can_edit &&
                            data.is_active &&
                            row.source ===
                              'PURCHASING_OUTLET_WORKSPACE' &&
                            ['OPEN', 'CANCELLED']
                              .includes(row.status) && (

                              <button
                                type="button"
                                className="dssr-secondary-button"
                                onClick={() => open({
                                  kind: 'slots',
                                  outlet: data,
                                  date: data.planning.date,
                                  row,
                                })}
                              >
                                Sửa
                              </button>

                            )}

                        </li>
                      ))}

                    </ul>
                  )}

                </div>

              </section>
            )}

            {/* TAB 4 — LỊCH SỬ THAY ĐỔI */}

            {tab === 'history' && (
              <section className="outlet-detail-section">

                <h3>Lịch sử thay đổi</h3>

                {!data.history.length ? (
                  <div className="outlet-empty-state">

                    <strong>Chưa có lịch sử thay đổi</strong>

                    <p>
                      Chưa có thay đổi ghi nhận trong workspace.
                    </p>

                  </div>
                ) : (
                  <ol className="outlet-history-timeline">

                    {data.history.map((row, index) => (
                      <li key={row.at + index}>

                        <div className="outlet-history-marker">
                          <span />
                        </div>

                        <details>

                          <summary>

                            <strong>
                              {labels[row.action] ?? row.action}
                            </strong>

                            <small>
                              {runTime(row.at)}
                              {' · '}
                              {row.actor ?? 'Hệ thống'}
                            </small>

                          </summary>

                          {row.before != null && (
                            <div className="outlet-history-change">

                              <small>Trước thay đổi</small>

                              <pre>
                                {JSON.stringify(row.before, null, 2)}
                              </pre>

                            </div>
                          )}

                          {row.after != null && (
                            <div className="outlet-history-change">

                              <small>Sau thay đổi</small>

                              <pre>
                                {JSON.stringify(row.after, null, 2)}
                              </pre>

                            </div>
                          )}

                        </details>

                      </li>
                    ))}

                  </ol>
                )}

              </section>
            )}

          </>
        )}

      </div>

    </>
  )
}

function Modal({
  title,
  busy,
  close,
  children,
  purchasingCreate = false,
}: {
  title: string
  busy: boolean
  close: () => void
  children: ReactNode
  purchasingCreate?: boolean
}) {

  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {

    const node = dialog.current

    if (!node) return

    if (!node.open) {
      node.showModal()
    }

    return () => {
      if (node.open) {
        node.close()
      }
    }

  }, [])

  return (
    <dialog
      ref={dialog}
      className={purchasingCreate ? 'delivery-confirm outlet-dialog purchasing-outlet-create-dialog' : 'delivery-confirm outlet-dialog'}
      aria-labelledby="outlet-dialog-title"
      onCancel={event => {
        event.preventDefault()

        if (!busy) {
          close()
        }
      }}
    >

      <h2 id="outlet-dialog-title">
        {title}
      </h2>

      {children}

    </dialog>
  )
}
function OutletForm({
  editor,
  close,
  save,
}: {
  editor: Editor
  close: () => void
  save: (message: string) => void
}) {

  const { user } = useAuth()
  // Do not apply Purchasing styling to any mixed-role or other-role account.
  const purchasingCreate = editor.kind === 'create' &&
    user?.roles.length === 1 && user.roles.includes('PURCHASING_STAFF') && !user.capstone_scenario

  const [busy, setBusy] = useState(false)

  const [error, setError] = useState('')

  const name =
    editor.kind === 'create'
      ? 'Thêm điểm giao nhận'
      : editor.kind === 'details'
        ? 'Chỉnh sửa điểm giao nhận'
        : editor.kind === 'state'
          ? (
              editor.outlet.is_active
                ? 'Ngừng hoạt động'
                : 'Kích hoạt lại'
            )
          : editor.kind === 'windows'
            ? 'Khung nhận theo tuần'
            : 'Mục lịch theo ngày'

  async function submit(
    event: FormEvent<HTMLFormElement>
  ) {

    event.preventDefault()

    if (busy) return

    const values = Object.fromEntries(
      new FormData(event.currentTarget)
    )

    let target =
      editor.kind === 'create'
        ? root
        : root + editor.outlet.id + '/'

    let method = 'POST'

    if (editor.kind === 'details') {
      method = 'PATCH'
    }

    if (editor.kind === 'state') {

      target += 'state/'

      values.is_active =
        String(!editor.outlet.is_active)

      values.confirm = 'true'

    }

    if (
      editor.kind === 'windows' ||
      editor.kind === 'slots'
    ) {

      target += editor.kind + '/'

      if (editor.row) {

        target += editor.row.id + '/'

        method = 'PATCH'

      }

    }

    setBusy(true)
    setError('')

    try {

      await apiRequest(target, {
        method,
        body: JSON.stringify(values),
      })

      save(
        editor.kind === 'create'
          ? 'Đã thêm điểm giao nhận.'
          : 'Đã lưu thay đổi.'
      )

    } catch (err) {

      setError(errorText(err))

    } finally {

      setBusy(false)

    }

  }

  const editing =
    editor.kind === 'details'
      ? editor.outlet
      : undefined

  return (
    <Modal
      title={name}
      busy={busy}
      close={close}
      purchasingCreate={purchasingCreate}
    >

      <form
        className="outlet-form"
        onSubmit={event => void submit(event)}
      >

        {/* THÊM / CHỈNH SỬA ĐIỂM GIAO NHẬN */}

        {purchasingCreate && <div className="outlet-create-fields">
          <div className="oc-intro">
            <span className="oc-intro-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><path d="M12 7v6m-3-3h6"/>
              </svg>
            </span>
            <div><strong>Thiết lập điểm nhận hàng mới</strong><small>Mã Outlet được hệ thống cấp tự động khi lưu.</small></div>
          </div>
          <section className="oc-section" aria-label="Thông tin điểm giao nhận">
            <header className="oc-section-heading"><span aria-hidden="true">01</span><h3>Thông tin điểm giao nhận</h3></header>
            <label>Tên chi nhánh <span className="oc-required" aria-hidden="true">*</span>
              <input name="outlet_name" required maxLength={200} autoComplete="organization" placeholder="Ví dụ: Chi nhánh Hải Châu" />
            </label>
            <label>Địa chỉ giao hàng <span className="oc-required" aria-hidden="true">*</span>
              <textarea name="address" required maxLength={600} rows={3} autoComplete="street-address" placeholder="Số nhà, đường, phường/xã, tỉnh/thành phố" />
            </label>
          </section>
          <section className="oc-section" aria-label="Thông tin liên hệ">
            <header className="oc-section-heading"><span aria-hidden="true">02</span><h3>Thông tin liên hệ</h3><small>Không bắt buộc</small></header>
            <div className="oc-contact-grid">
              <label>Người liên hệ<input name="contact_name" maxLength={150} autoComplete="name" placeholder="Họ và tên" /></label>
              <label>Điện thoại<input name="phone" type="tel" maxLength={30} autoComplete="tel" placeholder="Số điện thoại liên hệ" /></label>
            </div>
          </section>
          <p className="oc-note"><span className="oc-required" aria-hidden="true">*</span> Trường bắt buộc. Kiểm tra thông tin trước khi lưu điểm giao nhận.</p>
        </div>}

        {!purchasingCreate && (editor.kind === 'create' ||
          editor.kind === 'details') && (
          <>

            {editing ? (
              <p className="outlet-code">
                {editing.outlet_code}
              </p>
            ) : (
              <small>
                Mã Outlet được cấp tự động khi lưu.
              </small>
            )}

            <label>
              Tên chi nhánh

              <input
                name="outlet_name"
                required
                maxLength={200}
                defaultValue={editing?.outlet_name}
              />
            </label>

            <label>
              Địa chỉ giao hàng

              <textarea
                name="address"
                required
                maxLength={600}
                defaultValue={editing?.address}
              />
            </label>

            <label>
              Người liên hệ

              <input
                name="contact_name"
                maxLength={150}
                defaultValue={editing?.contact_name ?? ''}
              />
            </label>

            <label>
              Điện thoại

              <input
                name="phone"
                type="tel"
                maxLength={30}
                defaultValue={editing?.phone ?? ''}
              />
            </label>

          </>
        )}

        {/* THAY ĐỔI TRẠNG THÁI */}

        {editor.kind === 'state' && (
          <>

            <p>
              {editor.outlet.outlet_name}
              {' · '}
              {editor.outlet.outlet_code}
            </p>

            {editor.outlet.is_active && (
              <p>
                Điểm nhận sẽ biến mất khỏi danh sách tạo nhu cầu mới.
                Lịch sử và dữ liệu kế hoạch được giữ nguyên.
              </p>
            )}

            <label>
              Lý do

              <textarea
                name="reason"
                required
                maxLength={1000}
              />
            </label>

            <label className="outlet-confirm">

              <input
                type="checkbox"
                required
              />

              Tôi xác nhận thay đổi trạng thái

            </label>

          </>
        )}

        {/* LỊCH NHẬN THEO TUẦN */}

        {editor.kind === 'windows' && (
          <>

            <label>
              Ngày trong tuần

              <select
                name="day_of_week"
                defaultValue={
                  editor.row?.day_of_week ?? ''
                }
                required
              >

                <option value="">
                  Chọn ngày
                </option>

                {days.map((day, index) => (
                  <option
                    key={day}
                    value={index}
                  >
                    {day}
                  </option>
                ))}

              </select>

            </label>

            <label>
              Trạng thái

              <select
                name="is_active"
                defaultValue={
                  String(editor.row?.is_active ?? true)
                }
              >

                <option value="true">
                  Đang áp dụng
                </option>

                <option value="false">
                  Đã tắt
                </option>

              </select>

            </label>

          </>
        )}

        {/* LỊCH NHẬN THEO NGÀY */}

        {editor.kind === 'slots' && (
          <>

            <label>
              Ngày nhận

              <input
                name="slot_date"
                type="date"
                required
                defaultValue={
                  editor.row?.slot_date ?? editor.date
                }
              />
            </label>

            <label>
              Loại khung

              <select
                name="slot_type"
                defaultValue={
                  editor.row?.slot_type ?? 'AVAILABLE'
                }
              >

                <option value="AVAILABLE">
                  Có thể tiếp nhận
                </option>

                <option value="BLOCKED">
                  Không tiếp nhận
                </option>

              </select>

            </label>

            <label>
              Trạng thái

              <select
                name="status"
                defaultValue={
                  editor.row?.status ?? 'OPEN'
                }
              >

                <option value="OPEN">
                  Mở
                </option>

                <option value="CANCELLED">
                  Hủy
                </option>

              </select>

            </label>

            <label>
              Lý do (bắt buộc khi không tiếp nhận)

              <textarea
                name="reason"
                maxLength={1000}
                defaultValue={
                  editor.row?.reason ?? ''
                }
              />
            </label>

          </>
        )}

        {/* KHUNG GIỜ */}

        {(editor.kind === 'windows' ||
          editor.kind === 'slots') && (

          <div className="outlet-time-pair">

            <label>
              Giờ bắt đầu

              <input
                name="start_time"
                type="time"
                required
                defaultValue={
                  editor.row?.start_time.slice(0, 5)
                }
              />
            </label>

            <label>
              Giờ kết thúc

              <input
                name="end_time"
                type="time"
                required
                defaultValue={
                  editor.row?.end_time.slice(0, 5)
                }
              />
            </label>

          </div>

        )}

        {error && (
          <p className="dssr-alert" role="alert">
            {error}
          </p>
        )}

        <div className="delivery-actions">

          <button
            type="button"
            className="dssr-secondary-button"
            disabled={busy}
            onClick={close}
          >
            Hủy
          </button>

          <button
            type="submit"
            className="dssr-primary-button"
            disabled={busy}
          >
            {busy
              ? 'Đang lưu…'
              : editor.kind === 'state'
                ? 'Xác nhận'
                : purchasingCreate
                  ? 'Lưu điểm giao nhận'
                  : 'Lưu'}
          </button>

        </div>

      </form>

    </Modal>
  )
}
export default function OutletWorkspacePage() {
  const query = useCallback(
    () => apiRequest<Store>(root),
    []
  )

  const result = useDssQuery(query)

  const [selection, setSelection] =
    useState<number | null>(null)

  const [keyword, setKeyword] = useState('')

  const [status, setStatus] = useState('all')

  const [editor, setEditor] =
    useState<Editor | null>(null)

  const [notice, setNotice] = useState('')

  const [page, setPage] = useState(1)

  const [detailRevision, setDetailRevision] =
    useState(0)

  const data = result.data

  const normalized =
    keyword.trim().toLocaleLowerCase('vi-VN')

  const rows = data?.outlets.filter(row =>
    (
      status === 'all' ||
      row.is_active === (status === 'active')
    ) &&
    (
      row.outlet_code +
      ' ' +
      row.outlet_name +
      ' ' +
      row.address
    )
      .toLocaleLowerCase('vi-VN')
      .includes(normalized)
  ) ?? []

  const pageSize = 10

  const totalPages = Math.max(
    1,
    Math.ceil(rows.length / pageSize)
  )

  const currentPage = Math.min(page, totalPages)

  const startIndex = (currentPage - 1) * pageSize

  const shown = rows.slice(
    startIndex,
    startIndex + pageSize
  )

  const tabs = [
    {
      value: 'all',
      label: 'Tất cả',
      count: data?.summary.total ?? 0,
    },
    {
      value: 'active',
      label: 'Hoạt động',
      count: data?.summary.active ?? 0,
    },
    {
      value: 'inactive',
      label: 'Ngừng hoạt động',
      count: data?.summary.inactive ?? 0,
    },
  ]

  const selectedOutlet = data?.outlets.find(
    row => row.id === selection
  )

  const showStatus = status === 'all'
    return (
    <main className="dssr-page delivery-page manager-workspace outlet-workspace outlet-page">

      <header className="manager-heading">
        <p className="dssr-eyebrow">
          CoLogi Workspace · Mua hàng
        </p>

        <h1>Quản lý điểm giao nhận</h1>

        <p>
          Tra cứu địa chỉ, lịch nhận hàng và dữ liệu lập kế hoạch
          tại các điểm đã được cấp.
        </p>
      </header>

      {notice && (
        <p className="outlet-notice" role="status">
          {notice}
        </p>
      )}

      {result.loading && (
        <p className="outlet-loading" role="status">
          Đang tải danh sách điểm giao nhận…
        </p>
      )}

      {result.error != null && (
        <div className="dssr-alert" role="alert">
          {errorText(result.error)}

          <button
            type="button"
            className="dssr-secondary-button"
            onClick={result.reload}
          >
            Thử lại
          </button>
        </div>
      )}

      {data && (
        <>
          <dl className="manager-metrics outlet-metrics">
            <div>
              <dt>Tổng điểm giao nhận</dt>
              <dd>{data.summary.total}</dd>
            </div>

            <div>
              <dt>Đang hoạt động</dt>
              <dd>{data.summary.active}</dd>
            </div>

            <div data-tone="amber">
              <dt>Ngừng hoạt động</dt>
              <dd>{data.summary.inactive}</dd>
            </div>
          </dl>

          {!data.writes_enabled && (
            <p className="outlet-notice">
              Đang ở chế độ chỉ đọc. Thao tác ghi cần Manager
              phê duyệt quyền và phạm vi quản lý.
            </p>
          )}

          <section className="dssr-panel delivery-section outlet-list-panel">

            <header className="outlet-list-header">
              <div>
                <h2>Danh sách điểm giao nhận</h2>
                <p>Chọn một điểm để xem thông tin chi tiết.</p>
              </div>

              <button
                type="button"
                className="dssr-primary-button outlet-create-button"
                disabled={!data.can_create}
                onClick={() => setEditor({ kind: 'create' })}
              >
                + Thêm điểm giao nhận
              </button>
            </header>

            {data.writes_enabled && !data.can_create && (
              <small>
                Chưa xác định được Manager phụ trách để thêm điểm mới.
              </small>
            )}

            <div className="outlet-status-tabs">
              {tabs.map(tab => (
                <button
                  key={tab.value}
                  type="button"
                  data-status={tab.value}
                  aria-pressed={status === tab.value}
                  onClick={() => {
                    setStatus(tab.value)
                    setPage(1)
                  }}
                >
                  {tab.label}
                  <span>{tab.count}</span>
                </button>
              ))}
            </div>

            <div className="outlet-search-bar">
              <label className="outlet-search-box">

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
                  aria-label="Tìm điểm giao nhận"
                  placeholder="Tìm tên, mã hoặc địa chỉ..."
                  value={keyword}
                  onChange={event => {
                    setKeyword(event.target.value)
                    setPage(1)
                  }}
                />
              </label>

              <button
                type="button"
                className="outlet-refresh-button"
                aria-label="Tải lại danh sách"
                disabled={result.loading}
                onClick={result.reload}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M20 11a8 8 0 10-2 6" />
                  <path d="M20 4v7h-7" />
                </svg>
              </button>
            </div>

            <div className="outlet-table-wrap">
              <table
                className="outlet-table"
                data-show-status={showStatus}
              >
                <thead>
                  <tr>
                    <th scope="col">Mã điểm</th>
                    <th scope="col">Tên điểm giao nhận</th>
                    <th scope="col">Địa chỉ</th>

                    {showStatus && (
                      <th scope="col">Trạng thái</th>
                    )}
                  </tr>
                </thead>

                <tbody>
                  {shown.map(row => (
                    <tr
                      key={row.id}
                      className="outlet-table-row"
                      data-selected={selection === row.id}
                      onClick={() => setSelection(row.id)}
                    >
                      <td>
                        <strong className="outlet-table-code">
                          {row.outlet_code}
                        </strong>
                      </td>

                      <th scope="row">
                        <button
                          type="button"
                          className="outlet-name-button"
                          aria-haspopup="dialog"
                          onClick={event => {
                            event.stopPropagation()
                            setSelection(row.id)
                          }}
                        >
                          {row.outlet_name}
                        </button>
                      </th>

                      <td className="outlet-table-address">
                        {row.address}
                      </td>

                      {showStatus && (
                        <td>
                          <Badge active={row.is_active} />
                        </td>
                      )}
                    </tr>
                  ))}

                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={showStatus ? 4 : 3}>
                        <div className="outlet-empty-state">
                          <strong>
                            Không có điểm giao nhận phù hợp
                          </strong>
                          <p>
                            Hãy thay đổi từ khóa hoặc bộ lọc trạng thái.
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <footer className="outlet-pagination">
              <small>
                {rows.length
                  ? `Hiển thị ${startIndex + 1}–${Math.min(
                      startIndex + pageSize,
                      rows.length
                    )} trong ${rows.length} điểm giao nhận`
                  : 'Hiển thị 0 điểm giao nhận'}
              </small>

              {totalPages > 1 && (
                <div className="outlet-pagination-controls">
                  <button
                    type="button"
                    aria-label="Trang trước"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    ‹
                  </button>

                  <span className="outlet-current-page">
                    {currentPage}
                  </span>

                  <small>/ {totalPages}</small>

                  <button
                    type="button"
                    aria-label="Trang sau"
                    disabled={currentPage >= totalPages}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    ›
                  </button>
                </div>
              )}
            </footer>
          </section>

          {selection !== null && selectedOutlet && (
            <OutletDrawer
              key={selection}
              outlet={selectedOutlet}
              open={setEditor}
              writesEnabled={data.writes_enabled}
              revision={detailRevision}
              onClose={() => setSelection(null)}
            />
          )}
        </>
      )}

      {editor && (
        <OutletForm
          editor={editor}
          close={() => setEditor(null)}
          save={message => {
            setEditor(null)
            setNotice(message)
            setDetailRevision(value => value + 1)
            result.reload()
          }}
        />
      )}
    </main>
  )
}