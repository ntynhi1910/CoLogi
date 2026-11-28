import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { deliveryDate, runTime } from '../../components/dss/f1Display'
import { kg as weight } from '../../components/dss/f3Display'
import { ApiError, apiRequest } from '../../services/api/client'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F4Wave } from '../../types/f4'
import {
  ManagerPublication,
  PublicationSchedule,
  type PublicationRecipients,
  type PublishedPlan,
} from '../PlanPublicationPage'
import {
  canReviewDecision,
  decisionActions as decisions,
  decisionPayload,
  decisionReason,
  decisionReasons,
  isComparableOption,
  otherReason,
  reasonLimit,
  sortDecisionOptions,
  type DecisionOutcome,
} from './managerDecision'
import './DSSRunDetailPage.css'
import './PlanDeliveryPage.css'

type CarrierOutcome = 'CONFIRM' | 'DECLINE'
type Candidate = { run_code: string; group_code: string }
type PlanConflict = {
  plan_id: number
  version: number
  code: string | null
  active: boolean
  demands: { id: number; code: string }[]
}
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
    records: Record<
      string,
      {
        id: number
        kind: string
        version: string
        provenance: string
        source_reference: string
        valid_from?: string
        valid_to?: string
        fingerprint: string
      }[]
    >
  }
}
type Workbench = { options: Option[]; decisions: Decision[]; group: Group | null }
type Detail = Final & {
  snapshot_hash: string
  publication?: PublicationRecipients | PublishedPlan
  approved_by?: string
  delivery: {
    demands: {
      id: number
      code: string
      supplier_id: number
      supplier_code?: string
      outlet_code: string
      required_weight_kg: string
      items?: {
        item_id: number
        item_code?: string
        sku?: string
        required_weight_kg: string
        confirmed_weight_kg: string
      }[]
    }[]
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

function shortTime(value: string | null | undefined) {
  if (!value) return '--:--'
  const formatted = runTime(value)
  const match = formatted.match(/\b\d{2}:\d{2}\b/)
  return match ? match[0] : formatted
}

function reviewRoute(run: string, group: string) {
  return '/dss/decisions/' + run + '/' + encodeURIComponent(group)
}

function publicationStatus(plan: Final) {
  if (!plan.current) return 'Đã được thay thế'
  if (!plan.handover) return 'Đã phê duyệt · Chờ bàn giao'
  if (!plan.handover.response) return 'Đã bàn giao · Chờ TP001 phản hồi'
  return plan.handover.response.outcome === 'CONFIRM'
    ? 'Đã bàn giao · TP001 đã xác nhận'
    : 'Đã bàn giao · TP001 đã từ chối'
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


function Timeline({ waves, stops }: { waves: F4Wave[]; stops?: Detail['delivery']['stops'] }) {
  const addresses = new Map(stops?.map(stop => [stop.key, stop.address]))
  return (
    <div className="delivery-waves">
      {waves.map(wave => (
        <details key={wave.wave_no}>
          <summary>
            Wave {wave.wave_no} · {wave.phase} · {weight(wave.weight_kg)} · {wave.vehicle.vehicle_code}
            {' · '}
            {runTime(wave.start)} → {runTime(wave.end)}
          </summary>
          <p>
            {wave.vehicle.vehicle_name} · Tải trọng {weight(wave.vehicle.capacity_kg)} · Offer #{wave.vehicle.offer_id}
            {' · '}
            {wave.vehicle.available_vehicle_count} xe khả dụng theo đánh giá F3
          </p>
          <ol>
            {wave.stops.map(stop => (
              <li key={stop.sequence}>
                {stop.code ?? stop.stop} {stop.name && '· ' + stop.name}
                {' · '}Đến {runTime(stop.arrival)} · Xử lý {runTime(stop.service_start)} → {runTime(stop.service_end)}
                {stop.demand_codes.length > 0 && ' · ' + stop.demand_codes.join(', ')}
                {addresses.get(stop.stop) && <div>{addresses.get(stop.stop)}</div>}
                {stop.travel_from_previous && (
                  <small>
                    {' · '}
                    {stop.travel_from_previous.distance_km} km / {stop.travel_from_previous.minutes} phút
                    {' · '}
                    {stop.travel_from_previous.source} · {stop.travel_from_previous.reference}
                  </small>
                )}
              </li>
            ))}
          </ol>
        </details>
      ))}
    </div>
  )
}

function Decisions({ rows, filtered = false }: { rows: Decision[]; filtered?: boolean }) {
  if (!rows.length)
    return (
      <p className="delivery-empty">
        {filtered
          ? 'Không có quyết định khớp bộ lọc. Hãy thay đổi bộ lọc để xem lại lịch sử.'
          : 'Chưa có quyết định. Mở nhóm có kết quả F5 đã lưu, chọn phương án và ghi quyết định. Sau khi lưu, lý do và trạng thái bàn giao sẽ xuất hiện tại đây.'}
      </p>
    )
  return (
    <ul className="delivery-records">
      {rows.map(row => (
        <li key={row.id}>
          <strong>{decisions[row.outcome]}</strong>
          <span className="delivery-saved-reason">{row.reason}</span>
          <span>
            {runTime(row.recorded_at)} · {row.actor_name ?? 'Người thực hiện #' + row.actor_id}
          </span>
          {row.final_plan_code && (
            <Link to={'/dss/final-plans/' + row.final_plan_code}>
              {row.final ? 'Phiên bản ' + row.final.version + ' · ' + publicationStatus(row.final) : 'Mở FinalPlan'}
            </Link>
          )}
          {row.final?.handover?.response?.outcome === 'DECLINE' && (
            <span role="status">TP001 từ chối: {row.final.handover.response.reason}</span>
          )}
        </li>
      ))}
    </ul>
  )
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
  return (
    <details className="delivery-trace">
      <summary>Mã truy vết</summary>
      <dl>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
      </dl>
      <button type="button" className="dssr-secondary-button" onClick={() => void copy()}>
        Sao chép mã
      </button>
      {copyResult && <p role="status">{copyResult}</p>}
    </details>
  )
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
  return (
    <header className="manager-heading">
      <p className="dssr-eyebrow">CoLogi Workspace</p>
      <h1>{title}</h1>
      <p>{detail}</p>
    </header>
  )
}

function WorkspaceMetrics({
  metrics,
}: {
  metrics: { label: string; value: number | string; note?: string; tone?: string }[]
}) {
  return (
    <dl className="manager-metrics">
      {metrics.map(metric => (
        <div key={metric.label} data-tone={metric.tone}>
          <dt>{metric.label}</dt>
          <dd>{metric.value}</dd>
          {metric.note && <small>{metric.note}</small>}
        </div>
      ))}
    </dl>
  )
}

function WorkspaceError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="dssr-alert" role="alert">
      {message(error)}{' '}
      <button type="button" className="dssr-secondary-button" onClick={retry}>
        Thử lại
      </button>
    </div>
  )
}

function Conflicts({ rows }: { rows: PlanConflict[] }) {
  return (
    <ul className="delivery-records manager-conflicts">
      {rows.map(row => (
        <li key={row.plan_id}>
          <strong>
            FinalPlan #{row.plan_id} · v{row.version} · Đang hiệu lực
          </strong>
          <span>Nhu cầu trùng · {row.demands.map(demand => demand.code || '#' + demand.id).join(', ')}</span>
          {row.code && <Link to={'/dss/final-plans/' + row.code}>Xem kế hoạch</Link>}
        </li>
      ))}
    </ul>
  )
}

const queueFilters = {
  ALL: 'Tất cả',
  WAITING: 'Chờ quyết định',
  APPROVED: 'Đã phê duyệt',
  UNAVAILABLE: 'Không khả dụng',
} as const
type QueueFilter = keyof typeof queueFilters

function canOpenGroup(row: Group) {
  return row.queue_status === 'WAITING' || row.queue_status === 'APPROVED'
}

// ============================================================================
// 1. TRANG PHÊ DUYỆT PHƯƠNG ÁN (DECISION INDEX)
// ============================================================================
function ApprovalGroupDrawer({ group, onClose }: { group: Group; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const available = canOpenGroup(group)
  const status = available ? groupStatus(group) : 'Không khả dụng'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousOverflow = document.body.style.overflow
    if (!dialog.open) dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      if (dialog.open) dialog.close()
    }
  }, [])

  function closeDrawer() {
    dialogRef.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="cp09-drawer"
      aria-labelledby="cp09-drawer-title"
      onCancel={event => {
        event.preventDefault()
        closeDrawer()
      }}
      onClick={event => {
        if (event.target === event.currentTarget) closeDrawer()
      }}
    >
      <div className="cp09-drawer-layout">
        <header className="cp09-drawer-header">
          <div className="cp09-drawer-heading">
            <div>
              <p className="dssr-eyebrow">COLOGI · CHI TIẾT NHÓM</p>
              <h2 id="cp09-drawer-title">Nhóm {String(group.group_number).padStart(2, '0')}</h2>
              <p className="cp09-drawer-subtitle">Lần chạy F1 #{group.run_number}</p>
            </div>
            <button
              type="button"
              className="cp09-drawer-close"
              aria-label="Đóng chi tiết nhóm"
              onClick={closeDrawer}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="cp09-drawer-actions">
            <span
              className="cp09-status"
              data-tone={!available ? 'red' : group.queue_status === 'WAITING' ? 'amber' : 'green'}
            >
              {status}
            </span>
            {available && (
              <Link
                className="dssr-primary-button cp09-review-link"
                to={reviewRoute(group.run_code, group.group_code)}
                onClick={closeDrawer}
              >
                Xem phương án
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 12h15M13 6l6 6-6 6" />
                </svg>
              </Link>
            )}
          </div>
        </header>

        <div className="cp09-drawer-body">
          <section className="cp09-drawer-section">
            <h3>Thông tin nhóm phương án</h3>
            <dl className="cp09-group-overview">
              <div>
                <dt>Ngày giao hàng</dt>
                <dd>{deliveryDate(group.service_date)}</dd>
              </div>
              <div>
                <dt>Tổng số nhu cầu</dt>
                <dd>{group.demand_count}</dd>
              </div>
              <div>
                <dt>Tổng khối lượng</dt>
                <dd>{weight(group.total_weight_kg)}</dd>
              </div>
            </dl>
          </section>

          {group.estimate && (
            <section className="cp09-drawer-section">
              <h3>Thông tin chi phí dự kiến</h3>
              <dl className="cp09-cost-overview">
                <div>
                  <dt>Chi phí ước tính</dt>
                  <dd>{money(group.estimate.cost, group.estimate.currency)}</dd>
                </div>
                <div>
                  <dt>Tiết kiệm dự kiến</dt>
                  <dd data-negative={Number(group.estimate.saving) < 0}>
                    {money(group.estimate.saving, group.estimate.currency)}
                  </dd>
                </div>
              </dl>
            </section>
          )}

          {!available && (
            <section className="cp09-drawer-section">
              <h3>Điều kiện chưa đạt</h3>
              <div className="cp09-warning">
                {approvalMessage(group.risk_code ?? 'DELIVERY_SOURCE_UNAVAILABLE')}
              </div>
            </section>
          )}

          {!!group.conflicts?.length && (
            <section className="cp09-drawer-section">
              <h3>Xung đột kế hoạch</h3>
              <Conflicts rows={group.conflicts} />
            </section>
          )}
        </div>
      </div>
    </dialog>
  )
}

export function DecisionIndexPage() {
  const [filter, setFilter] = useState<QueueFilter>('ALL')
  const [selection, setSelection] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [dateFilter, setDateFilter] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 10

  const query = useCallback(() => apiRequest<DecisionIndex>(decisionPath), [])
  const result = useDssQuery(query)
  const groups = result.data?.candidates ?? []

  const pending = groups.filter(row => row.queue_status === 'WAITING')
  const approved = groups.filter(row => row.queue_status === 'APPROVED')
  const blocked = groups.filter(row => !canOpenGroup(row))

  const savings = pending.reduce(
    (sum, row) => sum + (row.estimate?.currency === 'VND' ? Number(row.estimate.saving) : 0),
    0
  )
  const declines = result.data?.carrier_declines ?? []

  const counts = {
    ALL: groups.length,
    WAITING: pending.length,
    APPROVED: approved.length,
    UNAVAILABLE: blocked.length,
  }

  const statusGroups =
    filter === 'WAITING'
      ? pending
      : filter === 'APPROVED'
      ? approved
      : filter === 'UNAVAILABLE'
      ? blocked
      : groups

  const keyword = search.trim().toLowerCase()
  const filtered = statusGroups.filter(row => {
    const searchText = [
      `Nhóm ${row.group_number}`,
      `Nhóm #${row.group_number}`,
      `Nhóm ${String(row.group_number).padStart(2, '0')}`,
      `Run #${row.run_number}`,
      `Run ${row.run_number}`,
      row.run_code,
      row.group_code,
    ]
      .join(' ')
      .toLowerCase()

    return (!keyword || searchText.includes(keyword)) && (!dateFilter || row.service_date === dateFilter)
  })

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const startIndex = (currentPage - 1) * pageSize
  const shown = filtered.slice(startIndex, startIndex + pageSize)

  const groupKey = (row: Group) => `${row.run_code}:${row.group_code}`
  const selected = groups.find(row => groupKey(row) === selection)

  const showStatus = filter === 'ALL'
  const showApproval = filter === 'APPROVED'
  const showRisk = filter === 'UNAVAILABLE'

  return (
    <main className="dssr-page delivery-page manager-workspace cp09-page">
      <WorkspaceHeading
        title="Phê duyệt phương án"
        detail="Xem kết quả F5, kiểm tra điều kiện và ghi quyết định vận chuyển."
      />

      {result.loading && (
        <div className="cp09-loading" role="status" aria-label="Đang tải danh sách phê duyệt">
          <div className="cp09-skeleton-metrics">
            {[1, 2, 3, 4].map(index => (
              <div key={index} className="cp09-skeleton-card">
                <span />
                <strong />
                <small />
              </div>
            ))}
          </div>
          <section className="dssr-panel cp09-skeleton-list">
            <p>Đang tải danh sách phê duyệt…</p>
            {[1, 2, 3, 4].map(index => (
              <div key={index} className="cp09-skeleton-row" />
            ))}
          </section>
        </div>
      )}

      {result.error != null && <WorkspaceError error={result.error} retry={result.reload} />}

      {result.data && (
        <>
          <WorkspaceMetrics
            metrics={[
              { label: 'Chờ phê duyệt', value: pending.length, note: 'Nhóm đủ điều kiện' },
              { label: 'Đã phê duyệt', value: approved.length, note: 'Nhóm có kế hoạch hiệu lực' },
              {
                label: 'Tiết kiệm dự kiến',
                value: money(savings, 'VND'),
                note: 'Ước tính F5 của các nhóm chờ',
                tone: 'amber',
              },
              {
                label: 'Rủi ro cần xem',
                value: blocked.length + declines.length,
                note: 'Nhóm bị chặn và bàn giao bị từ chối',
                tone: 'red',
              },
            ]}
          />

          {declines.length > 0 && (
            <section className="dssr-panel delivery-section cp09-carrier-warning" role="status">
              <h2>TP001 từ chối bàn giao</h2>
              <ul className="delivery-records">
                {declines.map(plan => (
                  <li key={plan.code}>
                    <Link to={'/dss/final-plans/' + plan.code}>
                      Phiên bản {plan.version} · {deliveryDate(plan.service_date)}
                    </Link>
                    <span>{plan.handover?.response?.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="dssr-panel delivery-section cp09-list">
            <header className="cp09-list-heading">
              <div>
                <h2>Danh sách phương án</h2>
                <p>Chọn một nhóm để xem chi tiết.</p>
              </div>
              <button
                type="button"
                className="cp09-refresh"
                title="Tải lại danh sách"
                aria-label="Tải lại danh sách"
                onClick={() => {
                  setSelection(null)
                  result.reload()
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 11a8 8 0 10-2 6" />
                  <path d="M20 4v7h-7" />
                </svg>
              </button>
            </header>

            <div className="cp09-tabs" role="group" aria-label="Lọc trạng thái">
              {Object.entries(queueFilters).map(([value, label]) => {
                const key = value as QueueFilter
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => {
                      setFilter(key)
                      setSelection(null)
                      setPage(1)
                    }}
                  >
                    {label}
                    <span>{counts[key]}</span>
                  </button>
                )
              })}
            </div>

            <div className="cp09-filters">
              <label className="cp09-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <path d="M16 16l4 4" />
                </svg>
                <input
                  type="search"
                  aria-label="Tìm kiếm nhóm phương án"
                  placeholder="Tìm kiếm nhóm, lần chạy..."
                  value={search}
                  onChange={event => {
                    setSearch(event.target.value)
                    setPage(1)
                  }}
                />
              </label>

              <label className="cp09-date">
                <span>Ngày giao</span>
                <input
                  type="date"
                  aria-label="Lọc theo ngày giao"
                  value={dateFilter}
                  onChange={event => {
                    setDateFilter(event.target.value)
                    setPage(1)
                  }}
                />
              </label>

              {(search || dateFilter) && (
                <button
                  type="button"
                  className="dssr-secondary-button"
                  onClick={() => {
                    setSearch('')
                    setDateFilter('')
                    setPage(1)
                  }}
                >
                  Xóa bộ lọc
                </button>
              )}
            </div>

            <div className="cp09-table-wrap">
              <table className="cp09-table">
                <thead>
                  <tr>
                    <th scope="col">Nhóm phương án</th>
                    <th scope="col">Ngày giao</th>
                    <th scope="col">Nhu cầu</th>
                    <th scope="col">Khối lượng</th>
                    {showApproval ? (
                      <th scope="col">Ngày phê duyệt</th>
                    ) : showRisk ? (
                      <th scope="col">Điều kiện chưa đạt</th>
                    ) : (
                      <th scope="col">Chi phí dự kiến</th>
                    )}
                    {showStatus && <th scope="col">Trạng thái</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map(row => (
                    <tr
                      key={groupKey(row)}
                      className="cp09-clickable-row"
                      data-selected={selected === row}
                      tabIndex={0}
                      aria-haspopup="dialog"
                      aria-label={`Xem chi tiết Run ${row.run_number}, nhóm ${row.group_number}`}
                      onClick={() => setSelection(groupKey(row))}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelection(groupKey(row))
                        }
                      }}
                    >
                      <td>
                        <strong className="cp09-group-name">
                          Nhóm {String(row.group_number).padStart(2, '0')}
                        </strong>
                        <small>Run #{row.run_number}</small>
                      </td>
                      <td>{deliveryDate(row.service_date)}</td>
                      <td className="cp09-number">{row.demand_count}</td>
                      <td className="cp09-number">{weight(row.total_weight_kg)}</td>
                      {showApproval ? (
                        <td>{row.publication ? runTime(row.publication.approved_at) : '—'}</td>
                      ) : showRisk ? (
                        <td className="cp09-risk-cell">
                          {approvalMessage(row.risk_code ?? 'DELIVERY_SOURCE_UNAVAILABLE')}
                        </td>
                      ) : (
                        <td className="cp09-money">
                          {row.estimate && row.queue_status === 'WAITING'
                            ? money(row.estimate.cost, row.estimate.currency)
                            : '—'}
                        </td>
                      )}
                      {showStatus && (
                        <td>
                          <span
                            className="cp09-status"
                            data-tone={
                              !canOpenGroup(row)
                                ? 'red'
                                : row.queue_status === 'WAITING'
                                ? 'amber'
                                : 'green'
                            }
                          >
                            {canOpenGroup(row) ? groupStatus(row) : 'Không khả dụng'}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}

                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={5 + Number(showStatus)}>
                        <div className="cp09-empty">
                          {filter === 'WAITING' && !search && !dateFilter
                            ? 'Hiện chưa có nhóm đủ điều kiện phê duyệt.'
                            : 'Không có nhóm phù hợp với bộ lọc hiện tại.'}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <footer className="cp09-pagination">
              <small>
                {filtered.length
                  ? `Hiển thị ${startIndex + 1}–${Math.min(startIndex + pageSize, filtered.length)} trong ${filtered.length} nhóm`
                  : 'Hiển thị 0 nhóm'}
              </small>
              <div>
                <button
                  type="button"
                  aria-label="Trang trước"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  ‹
                </button>
                <span className="cp09-current-page">{currentPage}</span>
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
            </footer>
          </section>
        </>
      )}

      {selected && (
        <ApprovalGroupDrawer key={groupKey(selected)} group={selected} onClose={() => setSelection(null)} />
      )}
    </main>
  )
}

// ============================================================================
// 2. TRANG LỊCH SỬ QUYẾT ĐỊNH (DECISION HISTORY PAGE)
// ============================================================================
type DecisionTimeline = {
  run_number: number
  group_number: number
  events: { stage: string; at: string; actor: string; details: Record<string, unknown> }[]
  versions: {
    code: string
    version: number
    cost: string | number
    currency: string
    waves: number
    reason: string
    current: boolean
  }[]
}

const stages: Record<string, string> = {
  ...decisions,
  F2: 'Tạo phương án',
  F5: 'Đánh giá kinh tế',
  FINAL: 'Chốt kế hoạch',
  HANDOVER: 'Bàn giao vận chuyển',
  CONFIRM: 'TP001 xác nhận',
  DECLINE: 'TP001 từ chối',
}

function HistoryTimeline({ row }: { row: Decision }) {
  const query = useCallback(() => apiRequest<DecisionTimeline>(decisionPath + row.id + '/timeline/'), [row.id])
  const result = useDssQuery(query)
  const data = result.data

  return (
    <div className="cp09-history-timeline-content">
      {result.loading && (
        <p className="cp09-history-loading" role="status">
          Đang tải nhật ký…
        </p>
      )}
      {result.error != null && <WorkspaceError error={result.error} retry={result.reload} />}

      {data && (
        <>
          <section className="cp09-history-section">
            <h3>Nhật ký xử lý</h3>
            {data.events.length === 0 && <p className="delivery-empty">Chưa có nhật ký xử lý.</p>}
            <ol className="cp09-history-timeline">
              {data.events.map((event, index) => (
                <li
                  key={`${event.stage}-${event.at}-${index}`}
                  data-stage={event.stage}
                  data-last={index === data.events.length - 1}
                >
                  <div className="cp09-history-marker">
                    <span className="cp09-history-dot">
                      {event.stage === 'DECLINE' || event.stage === 'REJECT' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      ) : event.stage === 'REQUEST_RECALCULATION' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M20 11a8 8 0 10-2 6" />
                          <path d="M20 4v7h-7" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m5 12 4 4L19 6" />
                        </svg>
                      )}
                    </span>
                  </div>

                  <div className="cp09-history-event">
                    <strong>{stages[event.stage] ?? event.stage}</strong>
                    <div className="cp09-history-event-meta">
                      <span>{runTime(event.at)}</span>
                    </div>
                    {'reason' in event.details &&
                      event.details.reason != null &&
                      String(event.details.reason).trim() !== '' && (
                        <p className="cp09-history-event-reason">{String(event.details.reason)}</p>
                      )}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {data.versions.length > 1 && (
            <section className="cp09-history-section">
              <h3>So sánh phiên bản</h3>
              <div className="manager-table-scroll cp09-history-version-scroll" tabIndex={0} aria-label="So sánh phiên bản">
                <table className="manager-table cp09-history-version-table">
                  <thead>
                    <tr>
                      <th scope="col">Phiên bản</th>
                      <th scope="col">Chi phí</th>
                      <th scope="col">Tuyến</th>
                      <th scope="col">Lý do</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.versions.map(version => (
                      <tr key={version.code}>
                        <th scope="row">
                          <Link to={'/dss/final-plans/' + version.code}>v{version.version}</Link>
                          {version.current && <small>Hiệu lực</small>}
                        </th>
                        <td>{money(version.cost, version.currency)}</td>
                        <td>{version.waves}</td>
                        <td className="delivery-saved-reason">{version.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function DecisionHistoryDrawer({ row, onClose }: { row: Decision; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const tone =
    row.outcome === 'APPROVE' ? 'green' : row.outcome === 'REQUEST_RECALCULATION' ? 'amber' : 'red'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousOverflow = document.body.style.overflow
    if (!dialog.open) dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      if (dialog.open) dialog.close()
    }
  }, [])

  function closeDrawer() {
    dialogRef.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="cp09-history-drawer"
      aria-labelledby="cp09-history-drawer-title"
      onCancel={event => {
        event.preventDefault()
        closeDrawer()
      }}
      onClick={event => {
        if (event.target === event.currentTarget) closeDrawer()
      }}
    >
      <div className="cp09-history-drawer-layout">
        <header className="cp09-history-drawer-header">
          <div className="cp09-history-drawer-heading">
            <div>
              <p className="cp09-history-eyebrow">COLOGI · CHI TIẾT LỊCH SỬ</p>
              <h2 id="cp09-history-drawer-title">
                Nhóm {row.group_number != null ? String(row.group_number).padStart(2, '0') : row.group_code}
              </h2>
              <p className="cp09-history-subtitle">Run #{row.run_number ?? row.run_code}</p>
            </div>
            <button
              type="button"
              className="cp09-history-close"
              aria-label="Đóng chi tiết lịch sử"
              onClick={closeDrawer}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className="cp09-history-drawer-actions">
            <span className="cp09-history-status" data-tone={tone}>
              {decisions[row.outcome]}
            </span>
            {row.final_plan_code && (
              <Link className="cp09-history-plan-link" to={'/dss/final-plans/' + row.final_plan_code} onClick={closeDrawer}>
                Xem kế hoạch
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 12h15M13 6l6 6-6 6" />
                </svg>
              </Link>
            )}
          </div>
        </header>

        <div className="cp09-history-drawer-body">
          <section className="cp09-history-section">
            <h3>Thông tin quyết định</h3>
            <dl className="cp09-history-overview">
              <div>
                <dt>Người thực hiện</dt>
                <dd>{row.actor_name ?? 'Người thực hiện #' + row.actor_id}</dd>
              </div>
              <div>
                <dt>Thời điểm</dt>
                <dd>{runTime(row.recorded_at)}</dd>
              </div>
            </dl>
          </section>

          <section className="cp09-history-section">
            <h3>Lý do quyết định</h3>
            <div className="cp09-history-reason">{row.reason || '—'}</div>
          </section>

          {row.final && (
            <section className="cp09-history-section">
              <h3>Trạng thái kế hoạch</h3>
              <div className="cp09-history-plan-status">{publicationStatus(row.final)}</div>
              {row.final.handover?.response?.outcome === 'DECLINE' && (
                <div className="cp09-history-warning">
                  TP001 từ chối: {row.final.handover.response.reason}
                </div>
              )}
            </section>
          )}

          <HistoryTimeline key={row.id} row={row} />
        </div>
      </div>
    </dialog>
  )
}

export function DecisionHistoryPage() {
  const [params, setParams] = useSearchParams()
  const [focused, setFocused] = useState<number | null>(null)
  const [showFilters, setShowFilters] = useState(false)

  const filters = params.toString()
  const activeOutcome = params.get('outcome') ?? ''

  const query = useCallback(
    () => apiRequest<DecisionIndex>(decisionPath + '?history_only=true' + (filters ? '&' + filters : '')),
    [filters]
  )

  const result = useDssQuery(query)
  const data = result.data
  const selected = data?.decisions.find(row => row.id === focused)
  const page = Number(params.get('page') ?? 1)
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.page_size || 1)))

  const tabs = [
    { value: '', label: 'Tất cả' },
    { value: 'APPROVE', label: 'Đã phê duyệt' },
    { value: 'REQUEST_RECALCULATION', label: 'Yêu cầu tính lại' },
    { value: 'REJECT', label: 'Từ chối' },
  ]

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

  function changeOutcome(value: string) {
    const search = new URLSearchParams(params)
    if (value) search.set('outcome', value)
    else search.delete('outcome')
    search.delete('page')
    setFocused(null)
    setParams(search)
  }

  function turn(next: number) {
    const search = new URLSearchParams(params)
    search.set('page', String(next))
    setFocused(null)
    setParams(search)
  }

  function clearFilters() {
    setFocused(null)
    setShowFilters(false)
    setParams({})
  }

  const advancedCount = ['actor_id', 'version', 'date_from', 'date_to'].filter(name =>
    Boolean(params.get(name))
  ).length

  return (
    <main className="dssr-page delivery-page manager-workspace cp09-history-page">
      <WorkspaceHeading
        title="Lịch sử quyết định"
        detail="Tra cứu phê duyệt, phiên bản kế hoạch và phản hồi bàn giao."
      />

      {data && (
        <WorkspaceMetrics
          metrics={[
            { label: 'Tổng quyết định', value: data.total, note: 'Theo bộ lọc' },
            { label: 'Đã phê duyệt', value: data.history_counts.APPROVE ?? 0 },
            {
              label: 'Yêu cầu tính lại',
              value: data.history_counts.REQUEST_RECALCULATION ?? 0,
              tone: 'amber',
            },
            { label: 'Từ chối', value: data.history_counts.REJECT ?? 0, tone: 'red' },
          ]}
        />
      )}

      <section className="dssr-panel delivery-section cp09-history-list">
        <header className="cp09-history-list-heading">
          <div>
            <h2>Tra cứu quyết định</h2>
            <p>Chọn một bản ghi để xem chi tiết lịch sử.</p>
          </div>
          <button
            type="button"
            className="cp09-history-refresh"
            title="Tải lại lịch sử"
            aria-label="Tải lại lịch sử"
            disabled={result.loading}
            onClick={() => {
              setFocused(null)
              result.reload()
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 10-2 6" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
        </header>

        <div className="cp09-history-tabs" role="group" aria-label="Lọc theo quyết định">
          {tabs.map(tab => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={activeOutcome === tab.value}
              onClick={() => changeOutcome(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form key={filters} className="cp09-history-filter-form" onSubmit={submit}>
          <input type="hidden" name="outcome" value={activeOutcome} />
          <div className="cp09-history-filter-bar">
            <label className="cp09-history-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M16 16l4 4" />
              </svg>
              <input
                name="search"
                type="search"
                maxLength={120}
                aria-label="Tìm kiếm quyết định"
                defaultValue={params.get('search') ?? ''}
                placeholder="Tìm Run, nhóm, người thực hiện, lý do..."
              />
            </label>

            <button
              type="button"
              className="cp09-history-filter-toggle"
              aria-expanded={showFilters}
              aria-controls="cp09-history-advanced"
              onClick={() => setShowFilters(value => !value)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
                <circle cx="8" cy="7" r="2" fill="white" />
                <circle cx="16" cy="12" r="2" fill="white" />
                <circle cx="10" cy="17" r="2" fill="white" />
              </svg>
              Bộ lọc
              {advancedCount > 0 && <span className="cp09-history-filter-count">{advancedCount}</span>}
              <span aria-hidden="true">{showFilters ? '▴' : '▾'}</span>
            </button>

            <button type="submit" className="cp09-history-apply">
              Lọc
            </button>
          </div>

          <div id="cp09-history-advanced" className="cp09-history-advanced" hidden={!showFilters}>
            <label>
              ID người thực hiện
              <input name="actor_id" type="number" min={1} defaultValue={params.get('actor_id') ?? ''} placeholder="Nhập ID" />
            </label>
            <label>
              Phiên bản
              <input name="version" type="number" min={1} defaultValue={params.get('version') ?? ''} placeholder="Nhập phiên bản" />
            </label>
            <label>
              Từ ngày
              <input name="date_from" type="date" defaultValue={params.get('date_from') ?? ''} />
            </label>
            <label>
              Đến ngày
              <input name="date_to" type="date" defaultValue={params.get('date_to') ?? ''} />
            </label>
          </div>

          {['search', 'outcome', 'actor_id', 'version', 'date_from', 'date_to'].some(name =>
            Boolean(params.get(name))
          ) && (
            <div className="cp09-history-filter-actions">
              <button type="button" className="cp09-history-clear" onClick={clearFilters}>
                Xóa bộ lọc
              </button>
            </div>
          )}
        </form>

        {result.loading && (
          <div className="cp09-history-loading" role="status">
            Đang tải lịch sử…
          </div>
        )}
        {result.error != null && <WorkspaceError error={result.error} retry={result.reload} />}

        {data && (
          <div className="cp09-history-table-wrap">
            <table className="cp09-history-table">
              <thead>
                <tr>
                  <th scope="col">Nhóm phương án</th>
                  <th scope="col">Quyết định</th>
                  <th scope="col">Người thực hiện</th>
                  <th scope="col">Thời điểm</th>
                </tr>
              </thead>
              <tbody>
                {data.decisions.map(row => (
                  <tr
                    key={row.id}
                    className="cp09-history-row"
                    data-selected={row.id === focused}
                    onClick={event => {
                      if (event.target instanceof Element && event.target.closest('button, a')) return
                      setFocused(row.id)
                    }}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="cp09-history-group-button"
                        aria-haspopup="dialog"
                        aria-label={'Xem chi tiết quyết định nhóm ' + (row.group_number ?? row.group_code)}
                        onClick={() => setFocused(row.id)}
                      >
                        <strong>
                          Nhóm {row.group_number != null ? String(row.group_number).padStart(2, '0') : row.group_code}
                        </strong>
                        <small>Run #{row.run_number ?? row.run_code}</small>
                      </button>
                    </th>
                    <td>
                      <span
                        className="cp09-history-status"
                        data-tone={
                          row.outcome === 'APPROVE'
                            ? 'green'
                            : row.outcome === 'REQUEST_RECALCULATION'
                            ? 'amber'
                            : 'red'
                        }
                      >
                        {decisions[row.outcome]}
                      </span>
                    </td>
                    <td>{row.actor_name ?? '#' + row.actor_id}</td>
                    <td className="cp09-history-time">{runTime(row.recorded_at)}</td>
                  </tr>
                ))}

                {data.decisions.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <div className="cp09-history-empty">
                        <strong>Không có quyết định phù hợp</strong>
                        <p>Hãy thay đổi hoặc xóa bộ lọc để xem lại lịch sử.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {data && (
          <footer className="cp09-history-pagination">
            <small>
              {data.decisions.length > 0
                ? `Hiển thị ${(page - 1) * data.page_size + 1}–${Math.min(
                    (page - 1) * data.page_size + data.decisions.length,
                    data.total
                  )} trong ${data.total} quyết định`
                : 'Hiển thị 0 quyết định'}
            </small>
            {totalPages > 1 && (
              <div>
                <button
                  type="button"
                  aria-label="Trang trước"
                  disabled={page <= 1 || result.loading}
                  onClick={() => turn(page - 1)}
                >
                  ‹
                </button>
                <span className="cp09-current-page">{page}</span>
                <small>/ {totalPages}</small>
                <button
                  type="button"
                  aria-label="Trang sau"
                  disabled={page >= totalPages || result.loading}
                  onClick={() => turn(page + 1)}
                >
                  ›
                </button>
              </div>
            )}
          </footer>
        )}
      </section>

      {selected && <DecisionHistoryDrawer key={selected.id} row={selected} onClose={() => setFocused(null)} />}
    </main>
  )
}

// ============================================================================
// 3. CHI TIẾT QUYẾT ĐỊNH PHƯƠNG ÁN (DECISION PAGE)
// ============================================================================
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
  const records = new Map<
    string,
    { record: Option['evidence_details']['records'][string][number]; stages: string[] }
  >()
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
  const versions = [
    ...new Map(
      row.provenance.internal_sources.map(source => [
        [source.version, source.valid_from, source.valid_to].join('|'),
        source,
      ])
    ).values(),
  ]
  return (
    <div className="delivery-card-details">
      <details>
        <summary>Lịch trình, phương tiện và wave</summary>
        <Timeline waves={row.timeline} />
      </details>
      <details>
        <summary>Nguồn dữ liệu và kết quả kiểm tra</summary>
        <p>
          Thời gian · {row.provenance.time_source}
          <br />
          Chi phí · {row.provenance.price_source}
        </p>
        {versions.map(source => (
          <p key={[source.version, source.valid_from, source.valid_to].join('|')}>
            {source.version}
            {source.valid_from ? ' · ' + deliveryDate(source.valid_from) : ''}
            {source.valid_to ? ' đến ' + deliveryDate(source.valid_to) : ''}
          </p>
        ))}
        {[...sources].map(([key, { record, stages }]) => (
          <details key={key}>
            <summary>
              {stages.join(' / ')} · {record.kind} #{record.id} · {record.provenance}
            </summary>
            <p>
              {record.version}
              {record.valid_from ? ' · ' + deliveryDate(record.valid_from) : ''}
              {record.valid_to ? ' đến ' + deliveryDate(record.valid_to) : ''}
            </p>
            <p>{record.source_reference}</p>
            <code>{record.fingerprint}</code>
          </details>
        ))}
        {Object.entries(row.warnings).flatMap(([stage, warnings]) =>
          [...new Set(warnings.map(warning => warning.code))].map(code => (
            <p key={stage + code}>
              {stage.toUpperCase()} · {code}
            </p>
          ))
        )}
        <Trace
          values={{
            'Mã phương án F2': row.plan.plan_code,
            'Mã đánh giá F3': row.lineage.f3_evaluation_code,
            'Mã đánh giá F4': row.lineage.f4_evaluation_code,
            'Mã đánh giá F5': row.evaluation_code,
            ...Object.fromEntries(
              Object.entries(row.evidence_details.fingerprints).map(([key, value]) => ['SHA-256 ' + key, value])
            ),
          }}
        />
      </details>
    </div>
  )
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
  const decisionSectionRef = useRef<HTMLElement>(null)
  const request = useRef<{ key: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const work = workbench.data
  const options = sortDecisionOptions(work?.options ?? [])

  const publication = work?.group?.publication ?? null
  const approvedPublication =
    publication?.current === true &&
    publication.run_code === runId &&
    publication.group_code === optionId
      ? publication
      : null

  const savedApproval =
    saved?.outcome === 'APPROVE' &&
    saved.run_code === runId &&
    saved.group_code === optionId &&
    Boolean(saved.final_plan_code)
      ? saved
      : null

  const approvedDecision = work?.decisions.find(
    row =>
      row.outcome === 'APPROVE' &&
      row.run_code === runId &&
      row.group_code === optionId &&
      row.final?.current === true &&
      Boolean(row.final_plan_code)
  )

  const approvedPlanCode =
    approvedPublication?.code ??
    approvedDecision?.final_plan_code ??
    (!work ? savedApproval?.final_plan_code : null) ??
    null

  const isApprovedGroup = Boolean(approvedPlanCode)
  const visibleOptions = isApprovedGroup
    ? options.filter(row => row.publication?.code === approvedPlanCode)
    : options

  const recommended = options.find(isComparableOption)
  const option = options.find(row => row.evaluation_code === selected)
  const reason = decisionReason(action, preset, note)
  const conflicts = work?.group?.conflicts ?? []
  const canReview =
    !isApprovedGroup && !conflicts.length && option && canReviewDecision(action, reason, option.approval.allowed)

  const sharedEvidence = options[0]?.provenance.classification
  const sharedLabel =
    sharedEvidence && options.every(row => row.provenance.classification === sharedEvidence)
      ? evidenceLabels[sharedEvidence] ?? sharedEvidence
      : ''

  function selectDecisionOption(row: Option) {
    if (isApprovedGroup || busy || conflicts.length > 0) return
    if (selected === row.evaluation_code) return
    setSelected(row.evaluation_code)
    setAction('')
    setPreset('')
    setNote('')
  }

  function closeDecisionSection() {
    if (busy) return
    setSelected('')
    setAction('')
    setPreset('')
    setNote('')
  }

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
    if (isApprovedGroup || !review || inFlight.current || refreshRequired) return
    const payload = decisionPayload(
      review.option.evaluation_code,
      review.action,
      review.reason,
      review.option.approval.replaces
    )
    const key = JSON.stringify(payload)
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const result = await apiRequest<Decision>(path, {
        method: 'POST',
        body: JSON.stringify({ ...payload, request_id: request.current.id }),
      })
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

  return (
    <main className="dssr-page delivery-page manager-workspace cp09-decision-page">
      <header className="dssr-header">
        <div>
          <Link to="/dss/decisions">← Danh sách phê duyệt</Link>
          <p className="dssr-eyebrow">COLOGI · CP09</p>
          <h1>{isApprovedGroup ? 'Phương án đã phê duyệt' : 'Quyết định phương án'}</h1>
          {work?.group && (
            <p>
              <strong>
                Run #{work.group.run_number} · Nhóm #{work.group.group_number}
              </strong>
              {' · '}
              {deliveryDate(work.group.service_date)} · {work.group.demand_count} nhu cầu ·{' '}
              {weight(work.group.total_weight_kg)}
            </p>
          )}
        </div>
      </header>
      {workbench.loading && <p role="status">Đang tải phương án đã lưu…</p>}
      {workbench.error != null && (
        <p className="dssr-alert" role="alert">
          {message(workbench.error)}
        </p>
      )}
      {saved && (
        <p className="dssr-panel" role="status">
          Đã lưu {decisions[saved.outcome].toLowerCase()}.
          {saved.final_plan_code && (
            <>
              {' '}
              <Link to={'/dss/final-plans/' + saved.final_plan_code}>Mở FinalPlan</Link>
            </>
          )}
        </p>
      )}
      {work && (
        <>
          {conflicts.length > 0 && (
            <section className="dssr-panel delivery-section" aria-label="Kế hoạch đang giữ nhu cầu">
              <h2>Nhu cầu đang được giữ</h2>
              <Conflicts rows={conflicts} />
            </section>
          )}
          <div className="cp09-decision-layout" data-readonly={isApprovedGroup}>
            <section className="dssr-panel delivery-section" aria-labelledby="delivery-compare">
              <h2 id="delivery-compare">
                {isApprovedGroup ? 'Phương án được phê duyệt' : 'So sánh các phương án đã lưu'}
              </h2>
              {!isApprovedGroup && options.length > 0 && !conflicts.length && (
                <p className="cp09-option-hint">Chọn một phương án để ghi quyết định.</p>
              )}
              {!isApprovedGroup && !options.length && (
                <p className="delivery-empty">Hãy lưu kết quả F5 trước khi ghi quyết định.</p>
              )}

              {isApprovedGroup && !visibleOptions.length && (
                <div className="cp09-approved-fallback">
                  <p>Nhóm đã được phê duyệt. Xem phương án đã lưu trong FinalPlan.</p>
                  {approvedPlanCode && (
                    <Link className="dssr-secondary-button" to={'/dss/final-plans/' + approvedPlanCode}>
                      Xem FinalPlan
                    </Link>
                  )}
                </div>
              )}
              {sharedLabel && <span className="delivery-chip">{sharedLabel}</span>}
              <div
                className="delivery-options cp09-decision-options"
                role="group"
                aria-labelledby="delivery-compare"
                data-conflict={Boolean(conflicts.length)}
              >
                {visibleOptions.map(row => (
                  <article
                    key={row.evaluation_code}
                    className="cp09-option-clickable"
                    data-selected={isApprovedGroup || option?.evaluation_code === row.evaluation_code}
                    data-recommended={!isApprovedGroup && recommended === row}
                    data-disabled={!isApprovedGroup && (busy || conflicts.length > 0)}
                    data-readonly={isApprovedGroup}
                    onClick={event => {
                      if (isApprovedGroup) return
                      if (
                        event.target instanceof Element &&
                        event.target.closest('a, button, input, select, textarea, details, summary, label')
                      ) {
                        return
                      }
                      selectDecisionOption(row)
                    }}
                  >
                    <div className="cp09-option-heading">
                      <h3>{optionName(row)}</h3>
                      {!isApprovedGroup && (
                        <button
                          type="button"
                          className="cp09-option-indicator"
                          aria-label={`Chọn phương án ${optionName(row)}`}
                          aria-pressed={option?.evaluation_code === row.evaluation_code}
                          disabled={busy || conflicts.length > 0}
                          onClick={() => selectDecisionOption(row)}
                        >
                          {option?.evaluation_code === row.evaluation_code && (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="m5 12 4 4L19 6" />
                            </svg>
                          )}
                        </button>
                      )}
                      {isApprovedGroup && (
                        <span className="cp09-approved-badge">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="9" />
                            <path d="m8 12 3 3 5-6" />
                          </svg>
                          Đã phê duyệt
                        </span>
                      )}
                    </div>
                    <div className="delivery-card-labels">
                      <span>Bản F2 v{row.plan.revision}</span>
                      {!isApprovedGroup && recommended === row && <span className="delivery-chip">Đề xuất F5</span>}
                      {!sharedLabel && (
                        <span className="delivery-chip">
                          {evidenceLabels[row.provenance.classification] ?? row.provenance.classification}
                        </span>
                      )}
                    </div>
                    <div className="delivery-prices">
                      <span>Tổng chi phí</span>
                      <strong>{money(row.collaborative_cost, row.currency)}</strong>
                      <dl>
                        <div>
                          <dt>Giao độc lập</dt>
                          <dd>{money(row.baseline_cost, row.currency)}</dd>
                        </div>
                        <div>
                          <dt>Tiết kiệm</dt>
                          <dd data-negative={Number(row.cost_saving) < 0}>
                            {money(row.cost_saving, row.currency)}
                            {row.saving_rate_pct != null &&
                              ' · ' +
                                Number(row.saving_rate_pct).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) +
                                '%'}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <div className="delivery-card-state">
                      {row.publication && (
                        <Link to={'/dss/final-plans/' + row.publication.code}>
                          {publicationStatus(row.publication)}
                        </Link>
                      )}
                      {!isApprovedGroup && (
                        <p data-allowed={row.approval.allowed}>
                          {row.approval.allowed
                            ? 'Đủ điều kiện phê duyệt'
                            : approvalMessage(row.approval.code ?? 'DELIVERY_SOURCE_UNAVAILABLE')}
                        </p>
                      )}
                    </div>
                    <OptionDetails row={row} />

                    <div className="cp09-option-footer">
                      <Link
                        className="cp09-option-f5-link"
                        to={
                          '/dss/runs/' +
                          runId +
                          '/options/' +
                          optionId +
                          '/f5/' +
                          row.lineage.f4_evaluation_code
                        }
                      >
                        Xem chi tiết F5 ↗
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            </section>
            {!isApprovedGroup && option && !conflicts.length && (
              <section
                ref={decisionSectionRef}
                id="cp09-decision-form-panel"
                className="dssr-panel delivery-section cp09-decision-form-panel"
              >
                <div className="cp09-decision-form-heading">
                  <h2>Ghi quyết định</h2>
                  <button
                    type="button"
                    className="dssr-secondary-button"
                    disabled={busy}
                    onClick={closeDecisionSection}
                  >
                    Đóng
                  </button>
                </div>

                <div className="cp09-selected-option-summary">
                  <div>
                    <span>Phương án đang chọn</span>
                    <strong>{optionName(option)}</strong>
                  </div>
                  <div>
                    <span>Tổng chi phí</span>
                    <strong>{money(option.collaborative_cost, option.currency)}</strong>
                  </div>
                </div>
                <ol className="manager-pipeline" aria-label="Quy trình DSS">
                  {[
                    'Phối hợp nguồn hàng',
                    'Xây dựng phương án',
                    'Phân bổ phương tiện',
                    'Kiểm tra thời gian',
                    'Đánh giá chi phí',
                  ].map((label, index) => (
                    <li key={label}>
                      <strong>F{index + 1}</strong>
                      <span>{label}</span>
                    </li>
                  ))}
                </ol>
                <form className="delivery-decision-form" onSubmit={openReview}>
                  <label className="delivery-reason">
                    Hành động
                    <select
                      value={action}
                      required
                      disabled={!option || busy}
                      onChange={event => {
                        setAction(event.target.value as DecisionOutcome | '')
                        setPreset('')
                        setNote('')
                      }}
                    >
                      <option value="">Chọn hành động</option>
                      {(Object.keys(decisions) as DecisionOutcome[]).map(outcome => (
                        <option
                          key={outcome}
                          value={outcome}
                          disabled={outcome === 'APPROVE' && !option?.approval.allowed}
                        >
                          {decisions[outcome]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {action && (
                    <label className="delivery-reason">
                      Lý do
                      <select
                        value={preset}
                        required
                        disabled={busy}
                        onChange={event => {
                          setPreset(event.target.value)
                          setNote('')
                        }}
                      >
                        <option value="">Chọn lý do</option>
                        {decisionReasons[action].map(value => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {preset && (
                    <label className="delivery-reason">
                      {preset === otherReason ? 'Lý do khác (bắt buộc)' : 'Ghi chú bổ sung (tùy chọn)'}
                      <textarea
                        value={note}
                        required={preset === otherReason}
                        maxLength={reasonLimit}
                        disabled={busy}
                        aria-invalid={reason.length > reasonLimit}
                        onChange={event => setNote(event.target.value)}
                      />
                    </label>
                  )}
                  {reason.length > reasonLimit && (
                    <p role="alert">Lý do và ghi chú được giới hạn ở 2.000 ký tự.</p>
                  )}
                  <div className="delivery-actions">
                    <button
                      ref={reviewButton}
                      className="dssr-primary-button"
                      disabled={!canReview || busy || refreshRequired}
                    >
                      Xác nhận
                    </button>
                    {refreshRequired && (
                      <button className="dssr-secondary-button" type="button" onClick={reloadReview}>
                        Tải lại phương án
                      </button>
                    )}
                  </div>
                </form>
              </section>
            )}
          </div>

          <section className="dssr-panel delivery-section">
            <h2>Lịch sử của nhóm</h2>
            <Decisions rows={work.decisions} />
          </section>
        </>
      )}
      {!isApprovedGroup && (
        <dialog
          ref={dialog}
          className="delivery-confirm"
          aria-labelledby="delivery-confirm-title"
          onCancel={event => {
            event.preventDefault()
            if (!busy) closeReview()
          }}
        >
          <h2 id="delivery-confirm-title">Xác nhận quyết định</h2>
          {review && (
            <dl>
              <div>
                <dt>Phương án</dt>
                <dd>{optionName(review.option)}</dd>
              </div>
              <div>
                <dt>Phiên bản</dt>
                <dd>
                  F2 v{review.option.plan.revision}
                  {review.action === 'APPROVE' && ' · FinalPlan v' + review.option.approval.version}
                  {review.action === 'APPROVE' &&
                    review.option.approval.replaces &&
                    ' · Thay thế phiên bản hiện hành'}
                </dd>
              </div>
              <div>
                <dt>Hành động</dt>
                <dd>{decisions[review.action]}</dd>
              </div>
              <div>
                <dt>Lý do sẽ lưu</dt>
                <dd className="delivery-saved-reason">{review.reason}</dd>
              </div>
            </dl>
          )}
          {error && (
            <p className="dssr-alert" role="alert">
              {error}
            </p>
          )}
          <div className="delivery-actions">
            <button autoFocus className="dssr-secondary-button" disabled={busy} onClick={closeReview}>
              Quay lại
            </button>
            {refreshRequired ? (
              <button className="dssr-primary-button" disabled={busy} onClick={reloadReview}>
                Tải lại phương án
              </button>
            ) : (
              <button
                className="dssr-primary-button"
                disabled={busy || !review}
                onClick={() => void decide()}
              >
                {busy ? 'Đang lưu…' : 'Xác nhận và lưu'}
              </button>
            )}
          </div>
        </dialog>
      )}
    </main>
  )
}

// ============================================================================
// 4. TRANG BÀN GIAO CHO NHÀ VẬN CHUYỂN (PROVIDER HANDOVERS PAGE)
// ============================================================================
type ProviderHandoverState = 'WAITING' | 'CONFIRMED' | 'DECLINED' | 'HISTORY' | 'UNSENT'

function ProviderPlanStatusIcon({ state }: { state: ProviderHandoverState }) {
  return <span className="ph-plan-icon" data-state={state} aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {state === 'CONFIRMED' ? <>
        <path d="M12 2.5 20 6v5.5c0 4.8-3.4 8-8 10-4.6-2-8-5.2-8-10V6z" />
        <path d="m8.3 12 2.4 2.5 5-5.2" />
      </> : state === 'DECLINED' ? <>
        <circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" />
      </> : state === 'WAITING' ? <>
        <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
      </> : state === 'HISTORY' ? <>
        <path d="M3 12a9 9 0 1 1 3 6.7M3 6v6h6M12 7v5l3 2" />
      </> : <>
        <rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" />
      </>}
    </svg>
  </span>
}

function ProviderHeroTruck() {
  const [paused, setPaused] = useState(false)
  return <div className="ph-truck-scene" data-paused={paused}>
    <div className="ph-truck-art" aria-hidden="true">
      <div className="ph-road" />
      <div className="ph-road-dashes" />
      <div className="ph-speed-lines"><i /><i /><i /></div>
      <svg className="ph-truck-svg" viewBox="0 0 132 78" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <g className="ph-truck-body">
          <rect x="10" y="13" width="69" height="43" rx="6" fill="#d7f0df" stroke="#b9e1c9" strokeWidth="2" />
          <path d="M79 25h19l19 20v15H79z" fill="#75bc9b" stroke="#d7f0df" strokeWidth="2" />
          <path d="M86 30h11l11 13H86z" fill="#164934" stroke="#c0e4ce" strokeWidth="1.4" />
          <path d="M13 56h104v7H13z" fill="#a9d9bf" stroke="#d7f0df" strokeWidth="1.4" />
          <path d="M111 51h6" stroke="#f5db95" strokeWidth="4" />
          <path d="M11 48h5" stroke="#f2ab98" strokeWidth="3" />
          <path d="M24 21h42M24 48h42" stroke="#8bbda1" strokeWidth="1.2" opacity=".7" />
          <path d="m32 34 8 8 15-17" stroke="#176740" strokeWidth="3.7" />
        </g>
        {[31, 97].map(x => <g className="ph-wheel" key={x}>
          <circle cx={x} cy="64" r="9.5" fill="#123b2d" stroke="#b9e1c9" strokeWidth="2" />
          <circle cx={x} cy="64" r="4.2" fill="#c3e5d0" />
          <path d={`M${x} 58v12M${x-6} 64h12`} stroke="#6b9e85" strokeWidth="1.4" />
        </g>)}
      </svg>
    </div>
    <button type="button" className="ph-motion-toggle" aria-label="Tạm dừng hiệu ứng xe" aria-pressed={paused} title={paused ? 'Tiếp tục hiệu ứng' : 'Tạm dừng hiệu ứng'} onClick={() => setPaused(value => !value)}>
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{paused ? <path d="M5 3v10l8-5z" /> : <><rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" /></>}</svg>
    </button>
  </div>
}

export function ProviderHandoversPage() {
  const query = useCallback(() => apiRequest<{ plans: Final[] }>(carrierPath), [])
  const result = useDssQuery(query)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('ALL')
  const [date, setDate] = useState('')
  const plans = result.data?.plans ?? []
  const stateOf = (plan: Final): ProviderHandoverState => !plan.current ? 'HISTORY' : !plan.handover ? 'UNSENT' :
    plan.handover.response?.outcome === 'CONFIRM' ? 'CONFIRMED' :
      plan.handover.response?.outcome === 'DECLINE' ? 'DECLINED' : 'WAITING'
  const labels: Record<string, string> = { ALL: 'Tất cả trạng thái', WAITING: 'Chờ xác nhận', CONFIRMED: 'Đã xác nhận', DECLINED: 'Đã từ chối', HISTORY: 'Đã thay thế', UNSENT: 'Chưa bàn giao' }
  const count = (state: string) => plans.filter(plan => stateOf(plan) === state).length
  const rows = plans.filter(plan => (filter === 'ALL' || stateOf(plan) === filter) &&
    (!date || plan.service_date === date) &&
    [plan.code, plan.provider_code, 'FinalPlan v' + plan.version, 'Phiên bản ' + plan.version].join(' ').toLocaleLowerCase('vi').includes(search.trim().toLocaleLowerCase('vi')))
    .sort((a, b) => Number(stateOf(b) === 'WAITING') - Number(stateOf(a) === 'WAITING') || a.service_date.localeCompare(b.service_date))
  return <main className="dssr-page delivery-page provider-handover-console">
    <header className="ph-heading"><div><p className="ph-eyebrow">COLOGI / TRANSPORT WORKSPACE</p><h1>Xác nhận kế hoạch vận chuyển</h1><p>Tiếp nhận, kiểm tra và phản hồi các kế hoạch được Manager bàn giao.</p></div>
      <button type="button" className="dssr-secondary-button" onClick={result.reload} disabled={result.loading}>↻ Làm mới</button></header>
    {result.loading && <p role="status">Đang tải kế hoạch…</p>}
    {result.error != null && <p role="alert" className="dssr-alert">{message(result.error)}</p>}
    {result.data && !result.loading && result.error == null && <>
      <section className="ph-hero" aria-label="Tổng quan bàn giao">
        <div className="ph-hero-intro"><div><p className="ph-eyebrow">TRUNG TÂM BÀN GIAO</p><h2>{count('WAITING') ? `${count('WAITING')} kế hoạch cần phản hồi` : 'Không có kế hoạch chờ phản hồi'}</h2><p>Kiểm tra lịch trình và điều kiện vận chuyển trước khi xác nhận.</p></div><ProviderHeroTruck /></div>
        <dl className="ph-metrics">{[['Tổng phiên bản', plans.length], ['Chờ xác nhận', count('WAITING')], ['Hiện hành · Đã xác nhận', count('CONFIRMED')], ['Hiện hành · Đã từ chối', count('DECLINED')]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>
      <section className="dssr-panel delivery-section ph-list"><header className="ph-section-head"><div><h2>Kế hoạch được bàn giao</h2><p>{rows.length} / {plans.length} phiên bản · Ưu tiên kế hoạch chờ phản hồi</p></div><button type="button" className="dssr-secondary-button" disabled={!search && !date && filter === 'ALL'} onClick={() => { setSearch(''); setDate(''); setFilter('ALL') }}>Xóa bộ lọc</button></header>
        <div className="ph-filters"><label>Tìm kiếm<input type="search" placeholder="Mã kế hoạch, phiên bản, đơn vị" value={search} onChange={event => setSearch(event.target.value)} /></label><label>Ngày giao nhận<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label>Trạng thái<select className="ph-status-select" value={filter} onChange={event => setFilter(event.target.value)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
        {!rows.length && <p className="ph-empty">{plans.length ? 'Không có kế hoạch phù hợp bộ lọc.' : 'Chưa có kế hoạch gửi đến đơn vị của bạn.'}</p>}
        <ul className="ph-plans">{rows.map(plan => {
          const state = stateOf(plan)
          const reply = plan.handover?.response
          const href = '/provider/handovers/' + encodeURIComponent(plan.code)
          return <li key={plan.code} data-state={state}><header className="ph-card-head"><div className="ph-card-id"><ProviderPlanStatusIcon state={state} /><div><small>KẾ HOẠCH VẬN CHUYỂN</small><Link to={href}>FinalPlan v{plan.version}</Link></div></div><span className="ph-state" data-state={state}>{labels[state]}</span></header>
            <dl className="ph-facts"><div><dt>Ngày giao nhận</dt><dd>{deliveryDate(plan.service_date)}</dd></div><div><dt>Đơn vị vận chuyển</dt><dd>{plan.provider_code || '—'}</dd></div><div><dt>Bàn giao</dt><dd>{plan.handover ? runTime(plan.handover.sent_at) : '—'}</dd></div></dl>
            {reply?.outcome === 'DECLINE' && reply.reason && <p className="ph-decline-reason"><strong>Lý do từ chối:</strong> {reply.reason}</p>}
            <div className="ph-card-foot"><div><small>{reply ? 'Phản hồi lúc ' + runTime(reply.responded_at) : state === 'WAITING' ? 'Đang chờ đơn vị vận chuyển phản hồi' : labels[state]}</small><details className="ph-reference"><summary>Mã kế hoạch</summary><code>{plan.code}</code></details></div><Link className="dssr-primary-button ph-open" to={href}>{state === 'WAITING' ? 'Kiểm tra và phản hồi' : 'Xem chi tiết kế hoạch'} <span aria-hidden="true">→</span></Link></div>
          </li>
        })}</ul>
      </section>
    </>}
  </main>
}

// ============================================================================
// 5. TRANG KẾ HOẠCH CUỐI CÙNG — MỞ THẲNG CHI TIẾT KẾ HOẠCH HIỆU LỰC MỚI NHẤT
// ============================================================================
type ListedFinal = Final & {
  run_number: number
  group_number: number
  actor_name: string
  demand_count: number
  wave_count: number
  weight: string
  cost: string | number
  currency: string
}

export function FinalPlanIndexPage() {
  const query = useCallback(() => apiRequest<{ plans: ListedFinal[] }>(finalPath), [])
  const result = useDssQuery(query)
  const [selectedCode, setSelectedCode] = useState<string>('')

  const plans = useMemo(() => result.data?.plans ?? [], [result.data])
  const activePlan = useMemo(() => {
    if (!plans.length) return null
    if (selectedCode) {
      const found = plans.find(p => p.code === selectedCode)
      if (found) return found
    }
    return plans.find(p => p.current) ?? plans[0]
  }, [plans, selectedCode])

  if (result.loading) {
    return (
      <main className="dssr-page delivery-page manager-workspace">
        <WorkspaceHeading
          title="Kế hoạch cuối cùng"
          detail="Đây là kế hoạch vận chuyển cuối cùng đã được phê duyệt, sẵn sàng bàn giao và triển khai thực hiện."
        />
        <p role="status">Đang tải kế hoạch cuối cùng mới nhất…</p>
      </main>
    )
  }

  if (result.error != null) {
    return (
      <main className="dssr-page delivery-page manager-workspace">
        <WorkspaceHeading
          title="Kế hoạch cuối cùng"
          detail="Đây là kế hoạch vận chuyển cuối cùng đã được phê duyệt, sẵn sàng bàn giao và triển khai thực hiện."
        />
        <WorkspaceError error={result.error} retry={result.reload} />
      </main>
    )
  }

  if (!activePlan) {
    return (
      <main className="dssr-page delivery-page manager-workspace">
        <WorkspaceHeading
          title="Kế hoạch cuối cùng"
          detail="Đây là kế hoạch vận chuyển cuối cùng đã được phê duyệt, sẵn sàng bàn giao và triển khai thực hiện."
        />
        <section className="dssr-panel delivery-section">
          <p className="delivery-empty">
            Chưa có kế hoạch vận chuyển nào được phê duyệt. Hãy vào mục{' '}
            <Link to="/dss/decisions">Phê duyệt phương án</Link> để duyệt phương án.
          </p>
        </section>
      </main>
    )
  }

  return (
    <FinalPlanView
      planCode={activePlan.code}
      provider={false}
      allPlans={plans}
      onSelectPlanCode={setSelectedCode}
    />
  )
}

// ============================================================================
// 6. COMPONENT SƠ ĐỒ LỘ TRÌNH GIAO HÀNG (TỔNG QUAN) — TỐI ƯU KHÔNG TRÀN
// ============================================================================
function RouteOverviewMap({
  waves,
  stops,
}: {
  waves: F4Wave[]
  stops: Detail['delivery']['stops']
}) {
  const [selectedWaveNo, setSelectedWaveNo] = useState<number | 'ALL'>('ALL')
  const [zoom, setZoom] = useState<number>(1)

  const addressMap = useMemo(
    () => new Map(stops.map(s => [s.key, s.address || s.key])),
    [stops]
  )

  return (
    <section className="dssr-panel delivery-section fp-route-overview-card no-print">
      <div className="fp-route-overview-head">
        <h2>LỘ TRÌNH GIAO HÀNG (TỔNG QUAN)</h2>
        <div className="fp-map-legend">
          <span>
            <i className="fp-dot fp-dot-solid" /> Điểm lấy hàng
          </span>
          <span>
            <i className="fp-dot fp-dot-hollow" /> Điểm giao hàng
          </span>
          <span>
            <i className="fp-line-sample" /> Tuyến giao
          </span>
        </div>
      </div>

      <div className="fp-route-overview-grid">
        <div className="fp-map-viewport">
          <svg
            viewBox="0 0 380 220"
            className="fp-map-svg"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
          >
            <rect width="380" height="220" fill="#eef4ef" />
            <path
              d="M0,44 L380,44 M0,110 L380,110 M0,176 L380,176 M95,0 L95,220 M190,0 L190,220 M285,0 L285,220"
              stroke="#dce7df"
              strokeWidth="1"
            />
            <path
              d="M45,10 Q150,90 140,145 T310,210"
              fill="none"
              stroke="#cde0d4"
              strokeWidth="11"
              strokeLinecap="round"
            />

            {waves.map((wave, idx) => {
              const isHighlighted = selectedWaveNo === 'ALL' || selectedWaveNo === wave.wave_no
              const yStart = 46 + (idx % 3) * 54
              const xStart = 54 + (idx % 2) * 26
              const xEnd = 320 - (idx % 2) * 24
              const yEnd = yStart + 18
              const xMid = (xStart + xEnd) / 2
              const yMid = yStart - 16

              return (
                <g
                  key={wave.wave_no}
                  style={{
                    opacity: isHighlighted ? 1 : 0.25,
                    cursor: 'pointer',
                    transition: 'opacity 0.2s ease',
                  }}
                  onClick={() =>
                    setSelectedWaveNo(prev => (prev === wave.wave_no ? 'ALL' : wave.wave_no))
                  }
                >
                  <path
                    d={`M ${xStart},${yStart} Q ${xMid},${yMid} ${xEnd},${yEnd}`}
                    fill="none"
                    stroke="#217a4b"
                    strokeWidth="3"
                    strokeDasharray={idx % 2 === 1 ? '5,3' : undefined}
                  />
                  {wave.stops.length > 2 && (
                    <circle
                      cx={xMid}
                      cy={(yStart + yEnd) / 2 - 6}
                      r="4.5"
                      fill="#ffffff"
                      stroke="#195937"
                      strokeWidth="2"
                    />
                  )}
                  <circle cx={xStart} cy={yStart} r="5.5" fill="#195937" />
                  <circle
                    cx={xEnd}
                    cy={yEnd}
                    r="5.5"
                    fill="#ffffff"
                    stroke="#195937"
                    strokeWidth="2.5"
                  />
                  <rect x={xMid - 56} y={yMid - 13} width="112" height="19" rx="5" fill="#195937" />
                  <text
                    x={xMid}
                    y={yMid}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize="8.8"
                    fontWeight="700"
                  >
                    {`Xe ${String(wave.wave_no).padStart(2, '0')} · ${wave.vehicle.vehicle_code}`}
                  </text>
                </g>
              )
            })}
          </svg>

          <div className="fp-map-zoom">
            <button
              type="button"
              aria-label="Phóng to lộ trình"
              onClick={() => setZoom(z => Math.min(z + 0.15, 1.45))}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Thu nhỏ lộ trình"
              onClick={() => setZoom(z => Math.max(z - 0.15, 0.85))}
            >
              −
            </button>
          </div>
        </div>

        <div className="fp-sequence-panel">
          <div className="fp-sequence-title">THỨ TỰ GIAO HÀNG</div>
          <div className="fp-sequence-list">
            {waves.map(wave => {
              const uniqueStops = wave.stops.map(
                s => addressMap.get(s.stop) || s.name || s.code || s.stop
              )
              const routeSummary = uniqueStops.join(' → ')

              return (
                <div
                  key={wave.wave_no}
                  className={`fp-sequence-row ${selectedWaveNo === wave.wave_no ? 'active' : ''}`}
                  onClick={() =>
                    setSelectedWaveNo(prev => (prev === wave.wave_no ? 'ALL' : wave.wave_no))
                  }
                >
                  <div className="fp-sequence-row-top">
                    <span className="fp-vehicle-pill">
                      Xe {String(wave.wave_no).padStart(2, '0')} · {wave.vehicle.vehicle_code}
                    </span>
                    <span className="fp-sequence-time">
                      {shortTime(wave.start)} – {shortTime(wave.end)}
                    </span>
                  </div>
                  <div className="fp-sequence-path">{routeSummary}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

// ============================================================================
// 7. DANH SÁCH THẺ TUYẾN GIAO — ĐÃ FIX CHỒNG CHÉO CỘT GIỜ & ĐỊA CHỈ
// ============================================================================
function DispatchWaveCards({
  waves,
  stops,
}: {
  waves: F4Wave[]
  stops: Detail['delivery']['stops']
}) {
  const addressMap = useMemo(
    () => new Map(stops.map(s => [s.key, s.address])),
    [stops]
  )

  return (
    <div className="fp-wave-card-list">
      {waves.map(wave => (
        <article key={wave.wave_no} className="fp-wave-card">
          <div className="fp-wave-vehicle-box">
            <div className="fp-wave-vehicle-title">
              <span aria-hidden="true">🚚</span>
              <strong>Xe {String(wave.wave_no).padStart(2, '0')}</strong>
            </div>
            <div className="fp-wave-vehicle-code">{wave.vehicle.vehicle_code}</div>
            <div className="fp-wave-vehicle-sub">{wave.vehicle.vehicle_name}</div>
            <div className="fp-wave-vehicle-badges">
              <span className="fp-stop-count-pill">{wave.stops.length} chặng</span>
              <span className="fp-phase-pill">
                {wave.phase === 'DIRECT' ? 'Giao thẳng' : 'Trung chuyển'}
              </span>
            </div>
            <div className="fp-wave-total-weight">
              <small>Tổng tải trọng</small>
              <strong>{weight(wave.weight_kg)}</strong>
            </div>
          </div>

          <div className="fp-wave-stops-col">
            {wave.stops.map((stop, idx) => {
              const isPickup =
                stop.stop.toLowerCase().includes('pickup') ||
                stop.stop.toLowerCase().includes('sup') ||
                idx === 0
              const address = addressMap.get(stop.stop)
              const titleText = stop.name || address || stop.code || stop.stop

              return (
                <div key={stop.sequence} className="fp-wave-stop-item">
                  <div className="fp-stop-marker-col">
                    <span className={isPickup ? 'fp-dot fp-dot-solid' : 'fp-dot fp-dot-hollow'} />
                    {idx < wave.stops.length - 1 && <span className="fp-stop-connector" />}
                  </div>

                  <div className="fp-stop-content-row">
                    <div className="fp-stop-info">
                      <div className="fp-stop-header-line">
                        <span className={isPickup ? 'fp-role-tag pickup' : 'fp-role-tag dropoff'}>
                          {isPickup ? 'Lấy hàng' : 'Giao hàng'}
                        </span>
                        <strong>{titleText}</strong>
                      </div>
                      {address && address !== titleText && <small>{address}</small>}
                      {stop.demand_codes.length > 0 && (
                        <span className="fp-stop-demands">
                          Đơn hàng: {stop.demand_codes.join(', ')}
                        </span>
                      )}
                    </div>

                    <div className="fp-stop-time-badge">
                      🕒 {shortTime(stop.arrival)} – {shortTime(stop.service_end)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </article>
      ))}
    </div>
  )
}

// ============================================================================
// 8. CHI TIẾT KẾ HOẠCH CUỐI CÙNG + FORM XUẤT PDF CHUẨN A4
// ============================================================================
function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// CP20.3: dedicated read-only plan presentation and carrier response controls.
const providerDetailStates: Record<ProviderHandoverState, string> = {
  WAITING: 'Chờ xác nhận', CONFIRMED: 'Đã xác nhận', DECLINED: 'Đã từ chối', HISTORY: 'Đã thay thế', UNSENT: 'Chưa bàn giao',
}
const pdRoles = { SUPPLIER_PICKUP: 'Lấy hàng', OUTLET_DELIVERY: 'Giao hàng', HUB_RECEIVE: 'Nhập Hub', HUB_DISPATCH: 'Xuất Hub' }
const pdPhases: Record<string, string> = { DIRECT: 'Giao trực tiếp', INBOUND: 'Vào Hub', OUTBOUND: 'Ra Hub' }
type PdStop = {
  sequence: number; role: keyof typeof pdRoles; code: string; name?: string | null; address?: string | null;
  arrival: string | null; start: string | null; end: string | null; departure: string | null; wait: number | null;
  weight: string; loads: { code: string; weight: string | null; items: PublishedPlan['demands'][number]['items'] | null }[]
}
type PdWave = { number: number; phase: string; vehicle: { code: string; name: string }; weight: string | null; start: string | null; stops: PdStop[] }

const providerFeedbackReasons: Record<CarrierOutcome, readonly string[]> = {
  CONFIRM: [
    'Phù hợp năng lực vận chuyển',
    'Đáp ứng lịch trình giao nhận',
    'Đủ tải trọng và phương tiện',
    'Đáp ứng yêu cầu bảo quản hàng hóa',
    'Đồng ý với phương án vận chuyển',
    'Đã kiểm tra và đáp ứng đầy đủ điều kiện',
  ],
  DECLINE: [
    'Không đủ phương tiện khả dụng',
    'Không đáp ứng khung giờ giao nhận',
    'Khối lượng vượt năng lực vận chuyển',
    'Không đáp ứng điều kiện bảo quản',
    'Lộ trình vận chuyển chưa phù hợp',
    'Chi phí vận chuyển chưa phù hợp',
    'Phát sinh sự cố vận hành',
  ],
}

function ProviderFeedbackForm({ plan, reason, setReason, busy, loading, submit }: {
  plan: Detail; reason: string; setReason: (value: string) => void;
  busy: boolean; loading: boolean; submit: (outcome: CarrierOutcome) => Promise<void>
}) {
  const [outcome, setOutcome] = useState<CarrierOutcome | null>(null)
  const [review, setReview] = useState(false)
  const [selectedReason, setSelectedReason] = useState('')
  const disabled = busy || loading
  const valid = outcome !== null && selectedReason !== '' && reason.trim().length > 0 && reason.length <= 2000 &&
    (selectedReason === 'OTHER' || (providerFeedbackReasons[outcome].includes(selectedReason) && reason === selectedReason))
  const decline = outcome === 'DECLINE'
  const choices = [
    { value: 'CONFIRM' as const, title: 'Xác nhận kế hoạch', detail: 'Lịch trình và năng lực vận chuyển phù hợp.' },
    { value: 'DECLINE' as const, title: 'Từ chối kế hoạch', detail: 'Không đáp ứng điều kiện thực hiện; cần Manager xem xét lại.' },
  ]

  function chooseOutcome(value: CarrierOutcome) {
    if (value === outcome) return
    setOutcome(value)
    setSelectedReason('')
    setReason('')
    setReview(false)
  }

  function chooseReason(value: string) {
    setSelectedReason(value)
    setReason(value === 'OTHER' ? '' : value)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !valid || !outcome) return
    if (!review) { setReview(true); return }
    void submit(outcome)
  }

  return <form className="pd-response-form pd-feedback" data-decision={outcome ?? 'NONE'} onSubmit={handleSubmit}>
    <header className="pd-feedback-head">
      <div><p className="pd-feedback-kicker">QUYẾT ĐỊNH VẬN CHUYỂN</p><h3>Phản hồi kế hoạch</h3><p>Kiểm tra thông tin trước khi gửi phản hồi cho Manager.</p></div>
      <span className="pd-feedback-step">Bước {review ? '2' : '1'} / 2</span>
    </header>
    <div className="pd-feedback-steps" aria-label={review ? 'Bước 2: Kiểm tra phản hồi' : 'Bước 1: Chọn quyết định'}>
      <span data-active={!review} data-complete={review}><b aria-hidden="true">{review ? '✓' : '1'}</b> Chọn và nhập phản hồi</span>
      <span data-active={review}><b aria-hidden="true">2</b> Kiểm tra và gửi</span>
    </div>
    {!review ? <fieldset className="pd-feedback-fields" disabled={disabled}>
      <legend>Quyết định của đơn vị vận chuyển</legend>
      <div className="pd-feedback-choices">
        {choices.map(choice => <label className="pd-feedback-choice" key={choice.value} data-outcome={choice.value} data-selected={outcome === choice.value}>
          <input type="radio" name="provider-feedback-outcome" value={choice.value} checked={outcome === choice.value} onChange={() => chooseOutcome(choice.value)} required />
          <span className="pd-feedback-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/>{choice.value === 'CONFIRM' ? <path d="m8 12 2.6 2.6L16.5 9"/> : <path d="m9 9 6 6m0-6-6 6"/>}</svg></span>
          <span className="pd-feedback-choice-copy"><strong>{choice.title}</strong><span>{choice.detail}</span></span>
        </label>)}
      </div>
      {outcome ? <div className="pd-feedback-reason-area">
        <label className="pd-feedback-reason" htmlFor="pd-feedback-reason-select"><span>{decline ? 'Lý do từ chối' : 'Nội dung xác nhận'} <span className="pd-feedback-required">*</span></span>
          <select id="pd-feedback-reason-select" value={selectedReason} required onChange={event => chooseReason(event.target.value)}>
            <option value="" disabled>Chọn nội dung phản hồi</option>
            {providerFeedbackReasons[outcome].map(option => <option key={option} value={option}>{option}</option>)}
            <option value="OTHER">Khác</option>
          </select>
        </label>
        {selectedReason === 'OTHER' ? <>
          <label className="pd-feedback-reason" htmlFor="pd-feedback-reason-other"><span>Nội dung khác <span className="pd-feedback-required">*</span></span>
            <textarea id="pd-feedback-reason-other" value={reason} maxLength={2000} required rows={3} placeholder={decline ? 'Nêu rõ lý do từ chối hoặc điều kiện cần điều chỉnh…' : 'Nhập nội dung xác nhận cụ thể…'} onChange={event => setReason(event.target.value)} />
          </label>
          <div className="pd-feedback-hint"><span>Nội dung bắt buộc · Tối đa 2.000 ký tự</span><span>{reason.length.toLocaleString('vi-VN')}/2.000</span></div>
        </> : <p className="pd-feedback-reason-help">Chọn nội dung phù hợp nhất. Nếu không có trong danh sách, chọn Khác để nhập nội dung riêng.</p>}
      </div> : <p className="pd-feedback-reason-help">Chọn xác nhận hoặc từ chối để xem danh sách nội dung phản hồi.</p>}
    </fieldset> : <section className="pd-feedback-review" aria-label="Kiểm tra phản hồi">
      <div className="pd-feedback-review-title"><span className="pd-feedback-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/>{decline ? <path d="m9 9 6 6m0-6-6 6"/> : <path d="m8 12 2.6 2.6L16.5 9"/>}</svg></span><div><strong>{decline ? 'Từ chối kế hoạch' : 'Xác nhận kế hoạch'}</strong><p>FinalPlan v{plan.version} · {plan.provider_code} · {deliveryDate(plan.service_date)}</p></div></div>
      <div className="pd-feedback-review-note"><span>{decline ? 'Lý do từ chối' : 'Nội dung xác nhận'}</span><p>{reason.trim()}</p></div>
      <p className="pd-feedback-consequence">{decline ? 'Phản hồi từ chối sẽ được ghi nhận để Manager xem xét lại kế hoạch.' : 'Xác nhận này được ghi nhận cho đúng phiên bản kế hoạch. Điều phối chuyến vẫn phải tuân thủ các điều kiện thực hiện.'}</p>
    </section>}
    <footer className="pd-feedback-footer">
      <p>{review ? 'Hãy kiểm tra kỹ trước khi gửi quyết định.' : 'Phản hồi được lưu cho phiên bản kế hoạch hiện tại.'}</p>
      <div className="pd-feedback-actions">
        {review && <button type="button" className="dssr-secondary-button" disabled={disabled} onClick={() => setReview(false)}>Quay lại</button>}
        <button type="submit" className="dssr-primary-button pd-feedback-submit" disabled={disabled || !valid}>{busy ? 'Đang lưu…' : !review ? 'Kiểm tra phản hồi →' : decline ? 'Gửi từ chối' : 'Xác nhận phiên bản'}</button>
      </div>
    </footer>
  </form>
}

function ProviderPlanDetail({ plan, loading, queryError, reload, reason, setReason, busy, error, submit }: {
  plan: Detail | null; loading: boolean; queryError: unknown; reload: () => void; reason: string; setReason: (value: string) => void;
  busy: boolean; error: string; submit: (outcome: CarrierOutcome) => Promise<void>
}) {
  const [sort, setSort] = useState<'wave' | 'weight' | 'time'>('wave')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const pub = plan?.publication && 'waves' in plan.publication ? plan.publication : undefined
  const state: ProviderHandoverState = !plan?.current ? 'HISTORY' : !plan.handover ? 'UNSENT' :
    plan.handover.response?.outcome === 'CONFIRM' ? 'CONFIRMED' : plan.handover.response?.outcome === 'DECLINE' ? 'DECLINED' : 'WAITING'
  const reply = plan?.handover?.response
  const time = (value: string | null) => {
    if (!value) return '—'
    if (pub?.timezone) {
      try { return new Intl.DateTimeFormat('vi-VN', { timeZone: pub.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(value)) } catch { /* fallback to existing formatter */ }
    }
    return shortTime(value)
  }
  const windowTime = (start: string | null, end: string | null) => start && end ? `${time(start)}–${time(end)}` : '—'
  const waves: PdWave[] = pub ? pub.waves.map(w => ({
    number: w.number, phase: w.phase, vehicle: w.vehicle, weight: w.weight_kg, start: w.stops[0]?.arrival ?? null,
    stops: w.stops.map(s => {
      const ds = s.loads.map(load => pub.demands.find(d => d.id === load.demand_id)).filter(d => d !== undefined)
      const parties = ds.map(d => s.role === 'SUPPLIER_PICKUP' ? d.supplier : s.role === 'OUTLET_DELIVERY' ? d.outlet : pub.hub).filter(p => p !== null)
      const unique = [...new Set(parties.map(p => p.id))]
      const party = unique.length === 1 ? parties[0] : undefined
      return { sequence:s.sequence, role:s.role, code:s.code || party?.code || `Điểm ${s.sequence}`, name:party?.name, address:s.address,
        arrival:s.arrival, start:s.start, end:s.end, departure:s.departure, wait:s.wait_minutes ?? null, weight:s.weight_kg,
        loads:s.loads.map(l => ({code:pub.demands.find(d=>d.id===l.demand_id)?.code ?? `Demand #${l.demand_id}`, weight:l.weight_kg, items:l.items})) }
    })
  })) : (plan?.delivery.timeline ?? []).map(w => ({
    number:w.wave_no, phase:w.phase, vehicle:{code:w.vehicle.vehicle_code,name:w.vehicle.vehicle_name}, weight:w.weight_kg, start:w.start,
    stops:w.stops.map(s => ({sequence:s.sequence, role:s.role, code:s.code || s.stop, name:s.name, address:plan?.delivery.stops.find(a=>a.key===s.stop)?.address,
      arrival:s.arrival,start:s.service_start,end:s.service_end,departure:s.departure,wait:s.wait_minutes,weight:s.weight_kg,
      loads:s.demand_codes.map(code=>({code,weight:null,items:null}))}))
  }))
  waves.sort((a,b)=>sort==='weight' ? Number(b.weight ?? 0)-Number(a.weight ?? 0) || a.number-b.number : sort==='time' ? (a.start ?? '\uffff').localeCompare(b.start ?? '\uffff') || a.number-b.number : a.number-b.number)
  const stopCount = waves.reduce((sum,w)=>sum+w.stops.length,0)
  const keyOf = (w: PdWave,s: PdStop) => `${w.number}-${s.sequence}`
  const openStop = (w: PdWave,s: PdStop) => {
    const key = keyOf(w,s)
    setExpanded(prev=>({...prev,[key]:true}))
    document.getElementById(`pd-stop-${key}`)?.scrollIntoView({block:'nearest'})
  }
  const sourceLabel = (source: string) => source === 'INTERNAL_PLANNING' ? 'Giả định nội bộ' : source
  return <main className="dssr-page delivery-page provider-handover-console provider-plan-detail">
    <header className="ph-heading"><div><Link className="pd-back" to="/provider/handovers">← Danh sách kế hoạch</Link><p className="ph-eyebrow">COLOGI / TRANSPORT WORKSPACE</p><h1>Chi tiết kế hoạch vận chuyển</h1><p>Kiểm tra lịch trình và hàng hóa trước khi phản hồi bàn giao.</p></div><button type="button" className="dssr-secondary-button" onClick={reload} disabled={loading || busy}>↻ Làm mới</button></header>
    {loading && <p role="status">Đang tải kế hoạch…</p>}
    {queryError != null && <WorkspaceError error={queryError} retry={reload} />}
    {plan && !loading && queryError == null && <>
      <section className="pd-hero" aria-label="Tổng quan kế hoạch"><div className="pd-hero-head"><div className="pd-hero-title"><ProviderPlanStatusIcon state={state}/><div><p className="ph-eyebrow">KẾ HOẠCH ĐƯỢC PHÊ DUYỆT</p><h2>FinalPlan v{plan.version}</h2><p>{deliveryDate(plan.service_date)} · {plan.provider_code || '—'}</p></div></div><span className="ph-state" data-state={state}>{providerDetailStates[state]}</span></div>
        <dl className="pd-kpis">{[['Nhu cầu',pub?.demands.length ?? plan.delivery.demands.length],['Khối lượng kế hoạch',weight(plan.delivery.total_weight_kg)],['Wave vận chuyển',waves.length],['Điểm dừng',stopCount]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <div className="pd-hero-foot"><span>{reply ? `Phản hồi lúc ${runTime(reply.responded_at)}` : state==='WAITING' ? 'Cần kiểm tra và phản hồi phiên bản này' : providerDetailStates[state]}</span>{state==='CONFIRMED' && <Link className="pd-light-link" to={'/provider/trips/'+encodeURIComponent(plan.code)}>Mở điều phối chuyến →</Link>}{state==='WAITING' && <a className="pd-light-link" href="#pd-response">Kiểm tra và phản hồi ↓</a>}</div>
      </section>
      <section className="pd-panel" aria-label="Lịch trình vận chuyển"><header className="pd-section-head"><div><h2>Lộ trình và điểm dừng</h2><p>Lịch dự kiến · Không phải theo dõi vị trí GPS</p></div><label className="pd-sort">Sắp xếp Wave<select value={sort} onChange={e=>setSort(e.target.value as typeof sort)}><option value="wave">Thứ tự Wave</option><option value="weight">Khối lượng cao nhất</option><option value="time">Giờ bắt đầu sớm nhất</option></select></label></header>
        {!waves.length && <p>Chưa có lịch trình trong bản kế hoạch.</p>}
        {waves.map(w=><article className="pd-wave" key={w.number}><header className="pd-wave-head"><div className="pd-wave-id"><span className="pd-wave-num">{String(w.number).padStart(2,'0')}</span><div><h3>Wave {w.number} · {pdPhases[w.phase] ?? w.phase}</h3><p>{w.vehicle.code} · {w.vehicle.name}</p></div></div><div className="pd-wave-weight"><strong>{w.weight == null ? '—' : weight(w.weight)}</strong><small>{w.stops.length} điểm dừng</small></div></header>
          <nav className="pd-journey" aria-label={`Trình tự Wave ${w.number}`}>{w.stops.map(s=><button type="button" key={s.sequence} data-role={s.role} onClick={()=>openStop(w,s)}><span className="pd-journey-head"><span className="pd-marker">{s.sequence}</span>{pdRoles[s.role]}</span><strong>{s.code}</strong><span className="pd-journey-time">{time(s.arrival)}</span></button>)}</nav>
          <div className="pd-wave-tools"><small>Chi tiết điểm dừng và phần tải được phân bổ</small><button type="button" className="pd-text-button" onClick={()=>setExpanded(prev=>({...prev,...Object.fromEntries(w.stops.map(s=>[keyOf(w,s),!w.stops.every(x=>expanded[keyOf(w,x)]===true)]))}))}>{w.stops.every(s=>expanded[keyOf(w,s)]===true) ? 'Thu gọn tất cả' : 'Mở tất cả'}</button></div>
          <div className="pd-stops">{w.stops.map(s=>{const key=keyOf(w,s);const open=expanded[key]===true;return <section className="pd-stop" id={`pd-stop-${key}`} data-role={s.role} key={key}><button className="pd-stop-toggle" type="button" aria-expanded={open} aria-controls={`pd-body-${key}`} onClick={()=>setExpanded(prev=>({...prev,[key]:!open}))}><span className="pd-marker">{s.sequence}</span><span className="pd-stop-title"><small>{pdRoles[s.role]}</small><strong>{s.code}{s.name && s.name!==s.code ? ` · ${s.name}` : ''}</strong></span><span className="pd-stop-brief"><strong>{windowTime(s.start,s.end)}</strong><small>{weight(s.weight)}</small></span><span className="pd-chevron" aria-hidden="true"/></button><div id={`pd-body-${key}`} hidden={!open} className="pd-stop-body">{s.address && <p className="pd-address">{s.address}</p>}<dl className="pd-times">{[['Dự kiến đến',time(s.arrival)],['Chờ',s.wait==null?'—':`${s.wait} phút`],['Phục vụ',windowTime(s.start,s.end)],['Rời điểm',time(s.departure)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          {s.loads.map(l=><div className="pd-load" key={l.code}><div className="pd-load-head"><strong>{l.code}</strong>{l.weight!=null && <strong>{weight(l.weight)}</strong>}</div>{l.items?.length ? <div className="pd-table-wrap" tabIndex={0} aria-label="Bảng SKU tại điểm dừng"><table><thead><tr><th scope="col">SKU / Mặt hàng</th><th scope="col">Đơn vị gốc</th><th scope="col">Khối lượng</th></tr></thead><tbody>{l.items.map(i=><tr key={i.id}><td><small>{i.code ?? `SKU #${i.id}`}</small><strong>{i.name ?? '—'}</strong></td><td>{i.unit ?? '—'}</td><td>{weight(i.weight_kg)}</td></tr>)}</tbody></table></div>:<p>Chưa có phân bổ SKU cho phần tải này trong snapshot.</p>}</div>)}{!s.loads.length && <p>Chưa có thông tin Demand tại điểm này.</p>}</div></section>})}</div>
        </article>)}
      </section>
      <section className="pd-panel"><header className="pd-section-head"><div><h2>Nhu cầu và SKU</h2><p>Danh mục hàng hóa theo từng Demand trong kế hoạch</p></div><span className="pd-count">{pub?.demands.length ?? plan.delivery.demands.length} nhu cầu</span></header>
        <div className="pd-demands">{pub ? pub.demands.map(d=><details key={d.id}><summary><span className="pd-demand-title"><strong>{d.code}</strong><small>{d.supplier.code ?? d.supplier.name ?? `NCC #${d.supplier.id}`} → {d.outlet.code ?? d.outlet.name ?? `Outlet #${d.outlet.id}`}</small></span><strong>{weight(d.weight_kg)}</strong></summary><div className="pd-table-wrap" tabIndex={0} aria-label="SKU của Demand"><table><thead><tr><th scope="col">SKU / Mặt hàng</th><th scope="col">Đơn vị gốc</th><th scope="col">Yêu cầu</th><th scope="col">Đã xác nhận cung ứng</th></tr></thead><tbody>{d.items.map(i=>{const sealed=plan.delivery.demands.find(row=>row.id===d.id)?.items?.find(item=>item.item_id===i.id);return <tr key={i.id}><td><small>{i.code ?? `SKU #${i.id}`}</small><strong>{i.name ?? '—'}</strong></td><td>{i.unit ?? '—'}</td><td>{weight(i.weight_kg)}</td><td>{sealed ? weight(sealed.confirmed_weight_kg) : '—'}</td></tr>})}</tbody></table></div>{!d.items.length&&<p>Chưa có thông tin SKU.</p>}</details>) : plan.delivery.demands.map(d=><details key={d.id}><summary><span className="pd-demand-title"><strong>{d.code}</strong><small>{d.supplier_code ?? `NCC #${d.supplier_id}`} → {d.outlet_code}</small></span><strong>{weight(d.required_weight_kg)}</strong></summary><div className="pd-table-wrap" tabIndex={0} aria-label="SKU của Demand"><table><thead><tr><th scope="col">SKU</th><th scope="col">Yêu cầu</th><th scope="col">Xác nhận</th></tr></thead><tbody>{d.items?.map(i=><tr key={i.item_id}><td>{i.item_code ?? i.sku ?? `SKU #${i.item_id}`}</td><td>{weight(i.required_weight_kg)}</td><td>{weight(i.confirmed_weight_kg)}</td></tr>)}</tbody></table></div>{!d.items?.length&&<p>Chưa có thông tin SKU.</p>}</details>)}</div>
      </section>
      <section className="pd-panel pd-response" id="pd-response"><header className="pd-section-head"><div><h2>Bàn giao và phản hồi</h2><p>Thông tin phê duyệt và kết quả xác nhận phiên bản</p></div><span className="ph-state" data-state={state}>{providerDetailStates[state]}</span></header>
        <ol className="pd-milestones"><li data-done="true"><span>✓</span><div><strong>Manager phê duyệt</strong><small>{runTime(plan.approved_at)}</small></div></li><li data-done={Boolean(plan.handover)}><span>{plan.handover?'✓':'2'}</span><div><strong>Bàn giao vận chuyển</strong><small>{plan.handover?runTime(plan.handover.sent_at):'Chưa bàn giao'}</small></div></li><li data-done={reply?.outcome==='CONFIRM'} data-declined={reply?.outcome==='DECLINE'}><span>{reply?.outcome==='CONFIRM'?'✓':reply?.outcome==='DECLINE'?'×':'3'}</span><div><strong>{reply?.outcome==='CONFIRM'?'Transport đã xác nhận':reply?.outcome==='DECLINE'?'Transport đã từ chối':'Chờ phản hồi'}</strong><small>{reply?runTime(reply.responded_at):'Chưa ghi nhận'}</small></div></li></ol>
        <dl className="pd-meta">{[['Đơn vị vận chuyển',plan.provider_code],['Người phê duyệt',plan.approved_by || 'Quản lý điều phối'],['Ngày thực hiện',deliveryDate(plan.service_date)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <div className="pd-notes"><p><strong>Nguồn lập kế hoạch:</strong> Lịch {sourceLabel(plan.provenance.time_source)} · Chi phí {sourceLabel(plan.provenance.price_source)}{plan.provenance.internal_sources[0]?.version && ` (${plan.provenance.internal_sources[0].version})`}</p>{plan.reason&&<p><strong>Ghi chú duyệt:</strong> {plan.reason}</p>}{reply&&<p><strong>Phản hồi {plan.provider_code}:</strong> {reply.reason}</p>}</div>
        {state==='WAITING' && <ProviderFeedbackForm key={plan.code} plan={plan} reason={reason} setReason={setReason} busy={busy} loading={loading} submit={submit} />}
        {error&&<p className="dssr-alert" role="alert">{error}</p>}
      </section>
    </>}
  </main>
}

function FinalPlanView({
  planCode,
  provider = false,
  allPlans,
  onSelectPlanCode,
}: {
  planCode: string
  provider?: boolean
  allPlans?: ListedFinal[]
  onSelectPlanCode?: (code: string) => void
}) {
  const path = (provider ? carrierPath : finalPath) + planCode + '/'
  const query = useCallback(() => apiRequest<Detail>(path), [path])
  const result = useDssQuery(query)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sortBy, setSortBy] = useState<'wave' | 'weight' | 'time'>('wave')
  const plan = result.data

  const sortedWaves = useMemo(() => {
    if (!plan) return []
    const list = [...plan.delivery.timeline]
    if (sortBy === 'weight') {
      return list.sort((a, b) => Number(b.weight_kg) - Number(a.weight_kg))
    }
    if (sortBy === 'time') {
      return list.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
    }
    return list.sort((a, b) => a.wave_no - b.wave_no)
  }, [plan, sortBy])

  function handleExportSnapshot() {
    if (!plan) return
    downloadTextFile(
      `CoLogi_Snapshot_${plan.code}_v${plan.version}.json`,
      JSON.stringify(plan, null, 2),
      'application/json;charset=utf-8'
    )
  }

  function handleExportOperationNote() {
    if (!plan) return
    const lines = [
      `PHIẾU GHI CHÚ VẬN HÀNH - COLOGI LOGISTICS WORKSPACE`,
      `Mã kế hoạch: ${plan.code} (Phiên bản v${plan.version})`,
      `Ngày thực hiện: ${deliveryDate(plan.service_date)}`,
      `Đơn vị vận chuyển: ${plan.provider_code}`,
      `Tổng khối lượng: ${weight(plan.delivery.total_weight_kg)} | Tổng chi phí: ${money(plan.delivery.cost, plan.delivery.currency)}`,
      `------------------------------------------------------------`,
      `Ghi chú phê duyệt: ${plan.reason || 'Không có'}`,
      plan.handover?.response
        ? `Phản hồi vận tải (${plan.provider_code}): ${plan.handover.response.outcome} - ${plan.handover.response.reason}`
        : `Trạng thái bàn giao: ${publicationStatus(plan)}`,
    ]
    downloadTextFile(
      `CoLogi_GhiChuVanHanh_${plan.code}_v${plan.version}.txt`,
      lines.join('\n'),
      'text/plain;charset=utf-8'
    )
  }

  async function submit(outcome?: CarrierOutcome) {
    if (busy || !plan?.current || (provider && (!outcome || !reason.trim()))) return
    if (
      !provider &&
      !window.confirm(
        'Công bố phiên bản ' +
          plan.version +
          ' cho đơn vị vận chuyển, nhà cung cấp và bộ phận mua hàng liên quan?'
      )
    )
      return
    setError('')
    setBusy(true)
    try {
      await apiRequest<Detail>(path + (provider ? 'response/' : 'handover/'), {
        method: 'POST',
        body: JSON.stringify(provider ? { outcome, reason: reason.trim() } : {}),
      })
      result.reload()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const reply = plan?.handover?.response
  const vehicleSummary = plan
    ? plan.delivery.timeline
        .map(w => `Xe ${String(w.wave_no).padStart(2, '0')} (${w.vehicle.vehicle_code})`)
        .join(', ')
    : ''

  if (provider) return <ProviderPlanDetail key={planCode} plan={plan} loading={result.loading} queryError={result.error} reload={result.reload} reason={reason} setReason={setReason} busy={busy} error={error} submit={submit} />

  return (
    <main className={'dssr-page delivery-page' + (!provider ? ' manager-workspace manager-print' : '')}>
      {plan && (
        <section className="fp-print-document" aria-hidden="true">
          <div className="fp-print-banner">
            <div>
              <div className="fp-print-brand">COLOGI LOGISTICS WORKSPACE</div>
              <h1>PHIẾU KẾ HOẠCH VẬN CHUYỂN CUỐI CÙNG</h1>
              <p>Tài liệu điều phối & bàn giao thực hiện vận tải chính thức</p>
            </div>
            <div className="fp-print-code-box">
              <div>
                <span>Mã kế hoạch:</span> <strong>{plan.code}</strong>
              </div>
              <div>
                <span>Phiên bản:</span> <strong>v{plan.version}</strong>
              </div>
              <div>
                <span>Ngày giao hàng:</span> <strong>{deliveryDate(plan.service_date)}</strong>
              </div>
              <div>
                <span>Trạng thái:</span> <strong>{publicationStatus(plan)}</strong>
              </div>
            </div>
          </div>

          <table className="fp-print-meta-table">
            <tbody>
              <tr>
                <th>Đơn vị vận chuyển</th>
                <td>{plan.provider_code}</td>
                <th>Người phê duyệt</th>
                <td>{plan.approved_by || 'Quản lý điều phối'}</td>
              </tr>
              <tr>
                <th>Thời gian phê duyệt</th>
                <td>{runTime(plan.approved_at)}</td>
                <th>Tổng số tuyến / xe</th>
                <td>{plan.delivery.timeline.length} tuyến</td>
              </tr>
              <tr>
                <th>Tổng khối lượng</th>
                <td>{weight(plan.delivery.total_weight_kg)}</td>
                <th>Tổng chi phí cuối cùng</th>
                <td>
                  <strong>{money(plan.delivery.cost, plan.delivery.currency)}</strong>
                </td>
              </tr>
              <tr>
                <th>Ghi chú phê duyệt</th>
                <td colSpan={3}>{plan.reason || 'Không có'}</td>
              </tr>
            </tbody>
          </table>

          <h2>I. CHI TIẾT PHÂN BỔ PHƯƠNG TIỆN & LỘ TRÌNH TUYẾN GIAO</h2>
          <table className="fp-print-data-table">
            <thead>
              <tr>
                <th style={{ width: '16%' }}>Tuyến / Xe</th>
                <th style={{ width: '12%' }}>Tải trọng</th>
                <th style={{ width: '50%' }}>Lộ trình điểm lấy – điểm giao & Đơn hàng</th>
                <th style={{ width: '22%' }}>Khung giờ dự kiến</th>
              </tr>
            </thead>
            <tbody>
              {sortedWaves.map(wave => (
                <tr key={wave.wave_no}>
                  <td>
                    <strong>Xe {String(wave.wave_no).padStart(2, '0')}</strong>
                    <br />
                    {wave.vehicle.vehicle_code}
                    <br />
                    <small>{wave.vehicle.vehicle_name}</small>
                  </td>
                  <td>{weight(wave.weight_kg)}</td>
                  <td>
                    {wave.stops.map((s, idx) => {
                      const stopAddr = plan.delivery.stops.find(st => st.key === s.stop)?.address
                      return (
                        <div key={s.sequence} style={{ marginBottom: 4 }}>
                          <strong>
                            {idx + 1}. {idx === 0 ? '[Lấy hàng]' : '[Giao hàng]'}{' '}
                            {s.name || s.code || s.stop}
                          </strong>
                          {stopAddr ? ` (${stopAddr})` : ''}
                          {s.demand_codes.length > 0 ? ` — Đơn: ${s.demand_codes.join(', ')}` : ''}
                        </div>
                      )
                    })}
                  </td>
                  <td>
                    {runTime(wave.start)} → {runTime(wave.end)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>II. DANH SÁCH NHU CẦU & CHI TIẾT MẶT HÀNG (SKU)</h2>
          <table className="fp-print-data-table">
            <thead>
              <tr>
                <th style={{ width: '20%' }}>Mã nhu cầu</th>
                <th style={{ width: '22%' }}>Tuyến NCC → Điểm bán</th>
                <th style={{ width: '44%' }}>Chi tiết SKU</th>
                <th style={{ width: '14%' }}>Khối lượng</th>
              </tr>
            </thead>
            <tbody>
              {plan.delivery.demands.map(d => (
                <tr key={d.id}>
                  <td>
                    <strong>{d.code}</strong>
                  </td>
                  <td>
                    {d.supplier_code ?? `NCC #${d.supplier_id}`} → {d.outlet_code}
                  </td>
                  <td>
                    {d.items && d.items.length > 0
                      ? d.items
                          .map(
                            it =>
                              `${it.item_code ?? 'SKU #' + it.item_id} (${weight(
                                it.confirmed_weight_kg
                              )})`
                          )
                          .join('; ')
                      : 'Theo bảng kê nhu cầu'}
                  </td>
                  <td>{weight(d.required_weight_kg)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="fp-print-signatures">
            <div>
              <strong>NGƯỜI PHÊ DUYỆT KẾ HOẠCH</strong>
              <small>(Ký, ghi rõ họ tên)</small>
              <div className="fp-sign-space">{plan.approved_by || ''}</div>
            </div>
            <div>
              <strong>ĐIỀU PHỐI VIÊN VẬN TẢI</strong>
              <small>(Ký, ghi rõ họ tên)</small>
              <div className="fp-sign-space" />
            </div>
            <div>
              <strong>ĐẠI DIỆN ĐƠN VỊ VẬN CHUYỂN ({plan.provider_code})</strong>
              <small>(Xác nhận nhận bàn giao)</small>
              <div className="fp-sign-space">
                {reply?.outcome === 'CONFIRM' ? `Đã xác nhận (${runTime(reply.responded_at)})` : ''}
              </div>
            </div>
          </div>

          <div className="fp-print-footer">
            <span>Mã truy vết SHA-256: {plan.snapshot_hash}</span>
            <span>In từ hệ thống CoLogi DSS</span>
          </div>
        </section>
      )}

      <header className="dssr-header fp-page-header no-print">
        <div>
          {provider && <Link to="/provider/handovers">← Danh sách kế hoạch</Link>}
          <p className="dssr-eyebrow">{provider ? 'COLOGI · CP10' : 'COLOGI WORKSPACE'}</p>
          <h1>
            {plan
              ? provider
                ? `Kế hoạch cuối cùng · v${plan.version}`
                : 'Kế hoạch cuối cùng'
              : 'Kế hoạch cuối cùng'}
          </h1>
          <p>
            Đây là kế hoạch vận chuyển cuối cùng đã được phê duyệt, sẵn sàng bàn giao và triển khai thực hiện.
          </p>
        </div>

        {!provider && allPlans && allPlans.length > 1 && onSelectPlanCode && (
          <div className="fp-plan-switcher">
            <label htmlFor="fp-plan-select">Phiên bản kế hoạch:</label>
            <select
              id="fp-plan-select"
              value={planCode}
              onChange={e => onSelectPlanCode(e.target.value)}
            >
              {allPlans.map(p => (
                <option key={p.code} value={p.code}>
                  {`Run #${p.run_number} · Nhóm #${p.group_number} · v${p.version} (${deliveryDate(
                    p.service_date
                  )})${p.current ? ' — Hiệu lực' : ''}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      {result.loading && <p role="status" className="no-print">Đang tải kế hoạch…</p>}
      {result.error != null && <WorkspaceError error={result.error} retry={result.reload} />}

      {plan && (
        <>
          {!provider && (
            <div className="no-print">
              <WorkspaceMetrics
                metrics={[
                  {
                    label: 'Tuyến giao',
                    value: plan.delivery.timeline.length,
                    note: 'tuyến (xe)',
                  },
                  {
                    label: 'Tổng nhu cầu',
                    value: plan.delivery.demands.length,
                    note: 'nhu cầu giao',
                  },
                  {
                    label: 'Phương tiện phân bổ',
                    value: `${plan.delivery.timeline.length} xe`,
                    note: vehicleSummary || weight(plan.delivery.total_weight_kg),
                    tone: 'amber',
                  },
                  {
                    label: 'Chi phí cuối cùng',
                    value: money(plan.delivery.cost, plan.delivery.currency),
                    note: 'Tổng chi phí vận chuyển',
                    tone: 'amber',
                  },
                ]}
              />
            </div>
          )}

          <div
            className={
              (provider ? 'delivery-page' : 'manager-columns manager-final-columns') + ' no-print'
            }
          >
            <div style={{ display: 'grid', gap: '1rem', minWidth: 0 }}>
              <section className="dssr-panel delivery-section">
                <div className="fp-section-head">
                  <div>
                    <h2>KẾ HOẠCH ĐIỀU PHỐI & TUYẾN GIAO</h2>
                    <p style={{ margin: 0, color: '#50665a', fontSize: '0.88rem' }}>
                      Chi tiết phân bổ phương tiện, tuyến, điểm lấy – giao và khối lượng vận chuyển.
                    </p>
                  </div>
                  <select
                    className="fp-sort-select"
                    aria-label="Sắp xếp tuyến giao"
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value as 'wave' | 'weight' | 'time')}
                  >
                    <option value="wave">Sắp xếp theo xe</option>
                    <option value="weight">Tải trọng cao nhất</option>
                    <option value="time">Giờ xuất phát sớm nhất</option>
                  </select>
                </div>

                {provider && plan.publication && 'waves' in plan.publication ? (
                  <PublicationSchedule plan={plan.publication} />
                ) : (
                  <DispatchWaveCards waves={sortedWaves} stops={plan.delivery.stops} />
                )}
              </section>

              <RouteOverviewMap waves={sortedWaves} stops={plan.delivery.stops} />

              <section className="dssr-panel delivery-section">
                <h2>Nhu cầu và SKU ({plan.delivery.demands.length})</h2>
                <ul className="delivery-records">
                  {plan.delivery.demands.map(row => (
                    <li key={row.id}>
                      <details>
                        <summary>
                          <strong>{row.code}</strong> · {row.supplier_code ?? 'Supplier #' + row.supplier_id} &rarr;{' '}
                          {row.outlet_code} · <strong>{weight(row.required_weight_kg)}</strong>
                        </summary>
                        <ul>
                          {row.items?.map(item => (
                            <li key={item.item_id}>
                              {item.item_code ?? 'SKU #' + item.item_id} · Yêu cầu{' '}
                              {weight(item.required_weight_kg)} · Xác nhận {weight(item.confirmed_weight_kg)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

          
                 {/* CỘT PHẢI: THU GỌN 2-GRID GIỐNG MẪU ĐỂ KHÔNG PHẢI SCROLL NHIỀU */}
            {/* CỘT PHẢI: THU GỌN 2-GRID GIỐNG MẪU ĐỂ KHÔNG PHẢI SCROLL NHIỀU */}
            <div style={{ display: 'grid', gap: '1rem', minWidth: 0, alignContent: 'start' }}>
              <section className="dssr-panel delivery-section fp-compact-handover">
                <div className="fp-section-head">
                  <h2>{provider ? 'BÀN GIAO VÀ PHẢN HỒI' : 'THÔNG TIN BÀN GIAO'}</h2>
                  <span className="manager-badge">{publicationStatus(plan)}</span>
                </div>

                <dl className="fp-handover-grid">
                  <div>
                    <dt>Mã phương án</dt>
                    <dd>
                      <code>{plan.code.slice(0, 8).toUpperCase()}</code> (v{plan.version})
                    </dd>
                  </div>
                  <div>
                    <dt>Đơn vị vận chuyển</dt>
                    <dd>{plan.provider_code}</dd>
                  </div>
                  <div>
                    <dt>Người phê duyệt</dt>
                    <dd>{plan.approved_by || 'Quản lý điều phối'}</dd>
                  </div>
                  <div>
                    <dt>Ngày thực hiện</dt>
                    <dd>{deliveryDate(plan.service_date)}</dd>
                  </div>
                  <div>
                    <dt>Thời gian phê duyệt</dt>
                    <dd>{runTime(plan.approved_at)}</dd>
                  </div>
                  <div>
                    <dt>Thời điểm bàn giao</dt>
                    <dd>
                      {plan.handover
                        ? `${runTime(plan.handover.sent_at)} · #${plan.handover.sent_by}`
                        : 'Chờ bàn giao'}
                    </dd>
                  </div>
                </dl>

                <div className="fp-compact-notes">
                  <div>
                    <strong>Nguồn lập kế hoạch:</strong>{' '}
                    <span>
                      Lịch {plan.provenance.time_source} · Chi phí {plan.provenance.price_source}
                      {plan.provenance.internal_sources[0]?.version
                        ? ` (${plan.provenance.internal_sources[0].version})`
                        : ''}
                    </span>
                  </div>
                  {plan.reason && (
                    <div>
                      <strong>Ghi chú duyệt:</strong> <span>{plan.reason}</span>
                    </div>
                  )}
                  {reply && (
                    <div className="fp-reply-inline">
                      <strong>Phản hồi {plan.provider_code}:</strong> {reply.reason} (
                      {runTime(reply.responded_at)})
                    </div>
                  )}
                </div>

                {!provider && plan.publication && 'outlets' in plan.publication && (
                  <details className="fp-publication-accordion">
                    <summary>
                      <span>Công bố kế hoạch đa bên & Lịch sử thông báo</span>
                      <span className="fp-pub-pill">
                        {plan.publication.events?.length ?? 0} thông báo
                      </span>
                    </summary>
                    <div className="fp-publication-accordion-body">
                      <ManagerPublication publication={plan.publication} />
                    </div>
                  </details>
                )}

                {!provider && (
                  <div className="fp-attachments-box">
                    <h3>📎 TÀI LIỆU & ĐÍNH KÈM (3)</h3>
                    <div className="fp-attachment-list">
                      <button type="button" className="fp-attachment-item" onClick={() => window.print()}>
                        <span className="fp-file-badge fp-file-pdf">PDF</span>
                        <div className="fp-file-meta">
                          <strong>Phiếu điều phối</strong>
                          <small>Kế hoạch điều phối chi tiết theo xe, tuyến và thời gian</small>
                        </div>
                        <span className="fp-file-action">In / PDF</span>
                      </button>

                      <button type="button" className="fp-attachment-item" onClick={handleExportSnapshot}>
                        <span className="fp-file-badge fp-file-json">JSON</span>
                        <div className="fp-file-meta">
                          <strong>Snapshot DSS</strong>
                          <small>Kết quả tối ưu từ hệ thống DSS (phương án cuối cùng)</small>
                        </div>
                        <span className="fp-file-action">Tải về</span>
                      </button>

                      <button type="button" className="fp-attachment-item" onClick={handleExportOperationNote}>
                        <span className="fp-file-badge fp-file-txt">TXT</span>
                        <div className="fp-file-meta">
                          <strong>Ghi chú vận hành</strong>
                          <small>Lưu ý vận hành, ghi chú phê duyệt và phản hồi bàn giao</small>
                        </div>
                        <span className="fp-file-action">Tải về</span>
                      </button>
                    </div>
                  </div>
                )}

                {!provider && (
                  <div className="fp-bottom-action-bar">
                    <button
                      type="button"
                      className="dssr-primary-button"
                      onClick={() => window.print()}
                    >
                      ↓ Xuất kế hoạch
                    </button>

                    {!plan.handover && plan.current && plan.provider_code === 'TP001' ? (
                      <button
                        type="button"
                        className="dssr-secondary-button"
                        disabled={busy || result.loading}
                        onClick={() => void submit()}
                      >
                        ➤ Gửi cho vận chuyển
                      </button>
                    ) : (
                      <Link
                        className="dssr-secondary-button"
                        to={reviewRoute(plan.run_code, plan.group_code)}
                      >
                        {reply?.outcome === 'DECLINE' ? 'Mở nhóm tính lại' : 'Quyết định nhóm'}
                      </Link>
                    )}

                    <button
                      type="button"
                      className="dssr-secondary-button"
                      onClick={() => window.print()}
                    >
                      🖨 In
                    </button>
                  </div>
                )}

                {provider && plan.current && !reply && (
                  <div>
                    <label className="delivery-reason">
                      Lý do hoặc nội dung xác nhận
                      <textarea
                        value={reason}
                        disabled={busy}
                        maxLength={2000}
                        onChange={event => setReason(event.target.value)}
                      />
                    </label>
                    <div className="delivery-actions" style={{ marginTop: 10 }}>
                      <button
                        className="dssr-primary-button"
                        disabled={!reason.trim() || busy || result.loading}
                        onClick={() => void submit('CONFIRM')}
                      >
                        Xác nhận phiên bản
                      </button>
                      <button
                        className="dssr-secondary-button"
                        disabled={!reason.trim() || busy || result.loading}
                        onClick={() => void submit('DECLINE')}
                      >
                        Từ chối
                      </button>
                    </div>
                  </div>
                )}

                {error && (
                  <p className="dssr-alert" role="alert">
                    {error}
                  </p>
                )}

                <Trace
                  values={{
                    FinalPlan: plan.code,
                    Run: plan.run_code,
                    Candidate: plan.group_code,
                    'Thay thế': plan.supersedes_code ?? undefined,
                    'SHA-256': plan.snapshot_hash,
                  }}
                />
              </section>
            </div>
          </div>
        </>
      )}
    </main>
  )
}

export function FinalPlanPage({ provider = false }: { provider?: boolean }) {
  const { code } = useParams()
  if (!code) return <FinalPlanIndexPage />
  return <FinalPlanView planCode={code} provider={provider} />
}

export default FinalPlanPage