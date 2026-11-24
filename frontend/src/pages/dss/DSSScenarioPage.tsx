import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import CandidateTable from '../../components/dss/CandidateTable'
import DemandResultTable from '../../components/dss/DemandResultTable'
import { deliveryDate, f1BusinessDate, f1Label, runTime, timeWindow, weight } from '../../components/dss/f1Display'
import { ApiError } from '../../services/api/client'
import { dssErrorMessage, dssService } from '../../services/dss/dssService'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F1Preview } from '../../types/f1'
import type { DSSOutletContext } from './ManagerRoute'
import './DSSScenarioPage.css'
import './DSSRunDetailPage.css'
import './F1Presentation.css'

const dateReasons = new Map([
  ['F1_DEMAND_DATE_IN_PAST', 'Ngày giao yêu cầu đã qua'],
  ['F1_DELIVERY_WINDOW_EXPIRED', 'Khung giờ giao yêu cầu đã kết thúc'],
  ['F1_DELIVERY_END_MISSING', 'Thiếu giờ kết thúc giao yêu cầu'],
  ['F1_SUPPLIER_READY_DATE_IN_PAST', 'Ngày nhà cung cấp sẵn sàng lấy hàng đã qua'],
  ['F1_DATE_SEQUENCE_INVALID', 'Ngày nhà cung cấp sẵn sàng muộn hơn ngày giao yêu cầu'],
  ['F1_SUPPLIER_READY_DATE_MISSING', 'Thiếu ngày sẵn sàng hợp lệ trên phản hồi mới nhất của nhà cung cấp'],
])

interface DateDiagnostic {
  code: string
  demand_id: number
  supplier_id?: number
  supplier_code?: string
  supplier_request_id?: number | null
  f1_date: string
  requested_date: string
  ready_date: string | null
}

function dateDiagnostics(error: unknown): DateDiagnostic[] {
  if (!(error instanceof ApiError) || error.status !== 400
      || !error.data || typeof error.data !== 'object' || !('diagnostics' in error.data)
      || !Array.isArray(error.data.diagnostics)) return []
  return error.data.diagnostics.filter((row): row is DateDiagnostic =>
    row && typeof row.demand_id === 'number' && dateReasons.has(row.code)
      && typeof row.f1_date === 'string' && typeof row.requested_date === 'string'
      && (row.supplier_id === undefined || typeof row.supplier_id === 'number')
      && (row.supplier_code === undefined || typeof row.supplier_code === 'string')
      && (row.supplier_request_id == null || typeof row.supplier_request_id === 'number')
      && (row.ready_date === null || typeof row.ready_date === 'string'),
  )
}

function F1Selection() {
  const navigate = useNavigate()
  const { scope } = useOutletContext<DSSOutletContext>()
  const [params] = useSearchParams()
  const [ruleSetId, setRuleSetId] = useState(() => Number(params.get('rule_set_id')) || 0)
  const [selected, setSelected] = useState<number[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({ outlet: '', supplier: '', date: '' })
  const [preview, setPreview] = useState<F1Preview | null>(null)
  const [previewStale, setPreviewStale] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'execute' | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const rules = useDssQuery(dssService.listRuleSets)
  const { data: eligibility, loading: demandsLoading, error: demandsError, reload: reloadDemands } = useDssQuery(dssService.selectableDemands)
  const [lastEligibility, setLastEligibility] = useState(eligibility)

  useEffect(() => {
    window.addEventListener('focus', reloadDemands)
    return () => window.removeEventListener('focus', reloadDemands)
  }, [reloadDemands])

  useEffect(() => {
    if (!eligibility?.next_expiry_at) return
    const delay = Date.parse(eligibility.next_expiry_at) - Date.parse(eligibility.evaluated_at)
    const timer = window.setTimeout(reloadDemands, Math.min(2_147_000_000, Math.max(0, delay)))
    return () => window.clearTimeout(timer)
  }, [eligibility, reloadDemands])

  if (eligibility && eligibility !== lastEligibility) {
    setLastEligibility(eligibility)
    const allowed = new Set(eligibility.demands.map(row => row.id))
    if (selected.some(id => !allowed.has(id))) {
      setSelected(selected.filter(id => allowed.has(id)))
      setPreviewStale(true)
    }
  }

  const ruleSet = rules.data?.find((rule) => rule.id === ruleSetId)
  const available = eligibility?.demands ?? []
  const dateIssues = dateDiagnostics(actionError)
  const serverDate = dateIssues[0]?.f1_date
  const availableIds = new Set(available.map(demand => demand.id))
  const validSelection = !!ruleSet && selected.length > 0 && selected.every((id) => availableIds.has(id))
  const searchTerm = search.trim().toLocaleLowerCase()
  const visibleDemands = available.filter((demand) =>
    (!filters.outlet || String(demand.outlet_id) === filters.outlet) &&
    (!filters.supplier || String(demand.supplier_id) === filters.supplier) &&
    (!filters.date || demand.requested_date === filters.date) &&
    [demand.demand_code, demand.outlet_name, demand.outlet_code, demand.supplier_name, demand.supplier_code]
      .join(' ').toLocaleLowerCase().includes(searchTerm),
  )
  const selectedIds = new Set(selected)
  const visibleIds = new Set(visibleDemands.map(demand => demand.id))
  const allVisibleSelected = visibleIds.size > 0 && [...visibleIds].every((id) => selectedIds.has(id))
  const visibleRowIds = new Set(visibleDemands.map((demand) => demand.id))
  const selectedDemands = available.filter((demand) => selectedIds.has(demand.id))
  const selectedOutletCount = new Set(selectedDemands.map((demand) => demand.outlet_id)).size
  const hiddenSelectionCount = selected.filter((id) => !visibleRowIds.has(id)).length
  const outlets = new Map(available.map((demand) => [demand.outlet_id, demand.outlet_name]))
  const suppliers = new Map(available.map((demand) => [demand.supplier_id, demand.supplier_name]))
  const error = actionError ?? rules.error ?? demandsError
  const stalePreview = previewStale || (preview !== null && eligibility !== null &&
    f1BusinessDate(new Date(preview.captured_at)) !== f1BusinessDate(new Date(eligibility.evaluated_at)))

  function invalidatePreview() {
    if (preview) setPreviewStale(true)
    setActionError(null)
  }

  function selectVisibleDemands() {
    setSelected((ids) => [...new Set([...ids, ...visibleIds])])
    invalidatePreview()
  }

  async function submit(action: 'preview' | 'execute') {
    if (busy || !ruleSet || !validSelection) return
    setBusy(action)
    setActionError(null)
    if (action === 'preview') setPreview(null)
    const input = { demand_ids: selected, rule_set_id: ruleSet.id }
    try {
      if (action === 'preview') {
        setPreview(await dssService.preview(input))
        setPreviewStale(false)
      } else {
        const run = await dssService.execute(input)
        navigate(`/dss/runs/${run.run_code}`)
      }
    } catch (error) {
      setActionError(error)
      if (error instanceof ApiError && error.status === 400) reloadDemands()
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="dssc-page">
      <header className="dssc-header">
        <button className="dssc-back-link" onClick={() => navigate('/dss')}>← Tổng quan DSS</button>
        <p className="dssc-eyebrow">COLOGI · DSS F1</p>
        <h1>Chuẩn bị lần chạy F1</h1>
        <p className="dssc-description">Chọn RuleSet và nhu cầu để xem trước hoặc thực thi F1.</p>
        {scope.internal_planning && <p className="dssf-notice">
          Nguồn lập kế hoạch nội bộ đã duyệt · {scope.internal_planning.version} · {deliveryDate(scope.internal_planning.valid_from)} đến {deliveryDate(scope.internal_planning.valid_to)}.
          {' '}Lịch xe Supplement bắt đầu {deliveryDate(scope.internal_planning.first_fleet_date)}.
        </p>}
      </header>

      {dateIssues.length > 0 ? (
        <div className="dssc-alert is-error" role="alert">
          F1 đã chặn toàn bộ lựa chọn. Ngày thực hiện F1 tại Việt Nam là {deliveryDate(serverDate)}.
          <ul>{dateIssues.map((issue) => {
            const demand = available.find((row) => row.id === issue.demand_id)
            const supplierCode = issue.supplier_code ?? demand?.supplier_code
            const supplierId = issue.supplier_id ?? demand?.supplier_id
            return (
              <li key={`${issue.demand_id}-${issue.code}`}>
                Nhu cầu #{issue.demand_id}{demand?.demand_code && ` (${demand.demand_code})`}
                {(supplierCode || supplierId) && ` · Nhà cung cấp ${supplierCode ?? ''}${supplierId ? ` #${supplierId}` : ''}`}
                {issue.supplier_request_id != null && ` · SupplierRequest #${issue.supplier_request_id}`}
                {' · '}{dateReasons.get(issue.code)} ({issue.code})
                {' · '}Ngày giao {deliveryDate(issue.requested_date)}
                {issue.ready_date && ` · Ngày sẵn sàng ${deliveryDate(issue.ready_date)}`}
              </li>
            )
          })}</ul>
        </div>
      ) : error !== null && <div className="dssc-alert is-error" role="alert">{dssErrorMessage(error)}</div>}
      {(rules.loading || demandsLoading) && <div className="dssc-loading" role="status">Đang tải nhu cầu và RuleSet…</div>}

      <section className="dssd-stats" aria-label="Điều kiện lập kế hoạch">
        <article className="dssd-stat"><span>Đủ điều kiện</span><strong>{eligibility?.counts.eligible ?? '—'}</strong></article>
        <article className="dssd-stat"><span>Đã có FinalPlan</span><strong>{eligibility?.counts.final_plan ?? '—'}</strong></article>
        <article className="dssd-stat"><span>Quá hạn</span><strong>{eligibility?.counts.past_due ?? '—'}</strong></article>
      </section>

      <div className="dssc-layout">
        <section className="dssc-panel">
          <div className="dssc-panel-heading"><h2>RuleSet và nhu cầu</h2></div>
          <form className="dssc-form" onSubmit={(event) => { event.preventDefault(); void submit('preview') }}>
            <label className="dssc-field">
              <span>RuleSet</span>
              <select value={ruleSet?.id ?? ''} disabled={busy !== null || !rules.data?.length}
                onChange={(event) => { setRuleSetId(Number(event.target.value)); invalidatePreview() }}>
                <option value="">Chọn RuleSet</option>
                {rules.data?.map((rule) => (
                  <option key={rule.id} value={rule.id}>{rule.rule_set_name} · {rule.rule_set_code} · v{rule.version_no}</option>
                ))}
              </select>
            </label>
            {rules.data?.length === 0 && <div className="dssc-info-note">Chưa có RuleSet ACTIVE hợp lệ cho F1.</div>}

            <div className="dssc-type-section">
              <div className="dssc-demand-heading">
                <div className="dssc-type-heading">
                  <strong>Nhu cầu</strong><small>Đã chọn {selected.length} nhu cầu · {selectedOutletCount} Outlet</small>
                </div>
                <div className="dssf-selection-actions">
                  <button type="button" className="dssc-button dssc-button-secondary"
                    disabled={visibleIds.size === 0 || allVisibleSelected || busy !== null}
                    onClick={selectVisibleDemands}>Chọn tất cả kết quả lọc</button>
                  <button type="button" className="dssc-button dssc-button-secondary"
                    disabled={selected.length === 0 || busy !== null}
                    onClick={() => { setSelected([]); invalidatePreview() }}>Bỏ chọn tất cả</button>
                </div>
              </div>
              <p className="dssf-help">Chỉ hiển thị nhu cầu đủ điều kiện lập kế hoạch. Nhu cầu đã có FinalPlan hiệu lực hoặc quá hạn được loại khỏi danh sách.</p>
              {available.length ? (
                <>
                  <label className="dssc-field">
                    <span>Tìm nhu cầu đủ điều kiện</span>
                    <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Mã nhu cầu, Outlet, nhà cung cấp…" />
                  </label>
                  <div className="dssf-selection-filters">
                    <label className="dssc-field"><span>Outlet</span>
                      <select value={filters.outlet} onChange={(event) => setFilters({ ...filters, outlet: event.target.value })}>
                        <option value="">Tất cả Outlet</option>
                        {[...outlets].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                      </select>
                    </label>
                    <label className="dssc-field"><span>Nhà cung cấp</span>
                      <select value={filters.supplier} onChange={(event) => setFilters({ ...filters, supplier: event.target.value })}>
                        <option value="">Tất cả nhà cung cấp</option>
                        {[...suppliers].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                      </select>
                    </label>
                    <label className="dssc-field"><span>Ngày giao yêu cầu</span>
                      <input type="date" value={filters.date} onChange={(event) => setFilters({ ...filters, date: event.target.value })} />
                    </label>
                  </div>
                  <p className="dssf-help" role="status">
                    {visibleIds.size}/{visibleDemands.length} nhu cầu trong bộ lọc có thể chọn.
                    {hiddenSelectionCount > 0 && ` ${hiddenSelectionCount} nhu cầu đã chọn đang nằm ngoài bộ lọc và vẫn được gửi khi thực thi.`}
                  </p>
                  <div className="dssc-type-list dssc-demand-list">
                    {visibleDemands.length === 0 && <div className="dssc-empty">Không tìm thấy nhu cầu phù hợp.</div>}
                    {visibleDemands.map((demand) => {
                      const checked = selectedIds.has(demand.id)
                      return (
                        <label key={demand.id} className={`dssc-type-card ${checked ? 'is-selected' : ''}`}>
                          <input type="checkbox" checked={checked} disabled={busy !== null}
                            onChange={() => {
                              setSelected((ids) => checked ? ids.filter((id) => id !== demand.id) : [...ids, demand.id])
                              invalidatePreview()
                            }} />
                          <span className="dssc-type-copy">
                            <strong>{demand.demand_code} · {demand.outlet_name}</strong>
                            <small>{demand.supplier_name} · {deliveryDate(demand.requested_date)} · {timeWindow(demand.requested_start_time, demand.requested_end_time)}</small>
                            <small>{weight(demand.quantity_kg)} · {f1Label(demand.status)}</small>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </>
              ) : eligibility && <div className="dssc-empty">Chưa có nhu cầu đủ điều kiện trong phạm vi được cấp quyền.</div>}
            </div>

            <div className="dssc-form-actions">
              <button type="submit" className="dssc-button dssc-button-secondary" disabled={!validSelection || busy !== null}>
                {busy === 'preview' ? 'Đang xem trước…' : 'Xem trước'}
              </button>
              <button type="button" className="dssc-button dssc-button-primary" disabled={!validSelection || busy !== null}
                onClick={() => void submit('execute')}>
                {busy === 'execute' ? 'Đang thực thi F1…' : 'Thực thi F1'}
              </button>
            </div>
            {busy && <p className="dssc-info-note" role="status">
              {busy === 'preview' ? 'Đang đánh giá dữ liệu xem trước.' : 'Đang chờ kết quả từ backend.'}
            </p>}
          </form>
        </section>

        <aside className="dssc-side-panel">
          <section className="dssc-panel">
            <div className="dssc-panel-heading"><h2>Tóm tắt đầu vào</h2></div>
            <div className="dssc-preview">
              <div><span>Outlet được cấp quyền</span><strong>{scope.outlet_ids.length}</strong></div>
              <div><span>RuleSet</span><strong>{ruleSet ? `${ruleSet.rule_set_code} · v${ruleSet.version_no}` : '—'}</strong></div>
              <div><span>Nhu cầu đã chọn</span><strong>{selected.length}</strong></div>
              <div><span>Outlet đã chọn</span><strong>{selectedOutletCount}</strong></div>
            </div>
            <div className="dssc-info-note"><p>Khi thực thi, backend ghi nhận đầu vào và đánh giá lại trước khi lưu PlanningRun.</p></div>
          </section>
        </aside>
      </div>

      {preview && stalePreview && <div className="dssf-notice dssc-preview-results" role="status">
        Bản xem trước đã hết hiệu lực vì đầu vào hoặc ngày thực hiện F1 thay đổi. Chọn Xem trước để đánh giá lại.
      </div>}
      {preview && !stalePreview && (
        <section className="dssc-panel dssc-preview-results" aria-label="Kết quả xem trước">
          <div className="dssc-panel-heading"><h2>Kết quả xem trước</h2></div>
          <div className="dssc-detail-summary">
            <div><span>RuleSet</span><strong>{preview.rule_set_code} · v{preview.rule_set_version}</strong></div>
            <div><span>Kiểm tra xung đột kế hoạch</span><strong>{f1Label(preview.plan_guard_status)}</strong></div>
            <div><span>Kết quả ghép nhóm chính thức</span><strong>{f1Label(preview.matching_status)}</strong></div>
            <div><span>Thời điểm đánh giá</span><strong>{runTime(preview.captured_at)}</strong></div>
          </div>
          <h3>Kết quả đánh giá nhu cầu</h3>
          <DemandResultTable results={preview.demand_results} labels={preview.display_labels} previewMatchedIds={new Set(preview.candidate_groups.flatMap((group) => group.demand_ids))} />
          <h3>Nhóm ứng viên xem trước</h3>
          <CandidateTable groups={preview.candidate_groups} results={preview.demand_results} labels={preview.display_labels} at={preview.captured_at} />
        </section>
      )}
    </main>
  )
}

export default function DSSScenarioPage() {
  const { scenarioId } = useParams()
  const navigate = useNavigate()

  if (!scenarioId) return <F1Selection />

  return (
    <main className="dssc-page">
      <div className="dssc-alert is-error" role="alert">404 · Kịch bản này không tồn tại trong F1.</div>
      <button className="dssc-button dssc-button-primary" onClick={() => navigate('/dss/scenarios/new')}>Tạo lần chạy F1</button>
    </main>
  )
}
