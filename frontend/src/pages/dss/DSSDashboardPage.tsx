import { useCallback, useState } from 'react'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import { f1Label, missing, runTime } from '../../components/dss/f1Display'
import RunSummaryStats from '../../components/dss/RunSummaryStats'
import { dssErrorMessage, dssService } from '../../services/dss/dssService'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { DSSOutletContext } from './ManagerRoute'
import './DSSDashboardPage.css'
import './F1Presentation.css'

const firstPage = () => dssService.listRuns(1)

export default function DSSDashboardPage() {
  const navigate = useNavigate()
  const { scope, reloadScope } = useOutletContext<DSSOutletContext>()
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<number>()
  const rules = useDssQuery(dssService.listRuleSets)
  const loadDemands = useCallback(() => dssService.listDemands(scope), [scope])
  const demands = useDssQuery(loadDemands)
  const selectable = useDssQuery(dssService.selectableDemands)
  const recentHistory = useDssQuery(firstPage)
  const loadHistory = useCallback(() => page === 1 ? Promise.resolve(null) : dssService.listRuns(page), [page])
  const olderHistory = useDssQuery(loadHistory)
  const history = page === 1 ? recentHistory : olderHistory
  const latest = recentHistory.data?.results[0]
  const selected = rules.data?.find((rule) => rule.id === selectedId) ?? rules.data?.[0]
  const error = rules.error ?? demands.error
  const pageSize = 10

  const totalPages = Math.max(
    1,
    Math.ceil((recentHistory.data?.count ?? 0) / pageSize)
  )

  const startPage = Math.max(
    1,
    Math.min(page - 1, totalPages - 2)
  )

  const visiblePages = Array.from(
    { length: Math.min(3, totalPages) },
    (_, index) => startPage + index
  )

  return (
    <main className="dssd-page dssf-dashboard">
      <header className="dssd-header">
        <div className="dssd-header-copy">
          <p className="dssd-eyebrow">COLOGI · DSS F1</p>
          <h1>Hỗ trợ lập kế hoạch vận chuyển</h1>
          {scope.environment === 'UAT' && <span className="dssf-environment">Môi trường UAT</span>}
          {scope.environment === 'CAPSTONE' && <span className="dssf-environment">SYNTHETIC/CAPSTONE · {scope.scenario}</span>}
        </div>
        <div className="dssd-header-actions">
          <button className="dssd-button dssd-button-secondary" onClick={reloadScope}>↻ Làm mới</button>
          <button className="dssd-button dssd-button-primary" disabled={!selected}
            onClick={() => navigate(`/dss/scenarios/new?rule_set_id=${selected?.id}`)}>
            + Tạo lần chạy F1
          </button>
        </div>
      </header>

      {error !== null && <div className="dssd-alert dssd-alert-error" role="alert">{dssErrorMessage(error)}</div>}
      <section className="dssd-stats dssf-scope-stats" aria-label="Tổng quan phạm vi F1">
        <article className="dssd-stat"><span>OUTLET ĐƯỢC CẤP QUYỀN</span><strong>{scope.outlet_ids.length}</strong></article>
        <article className="dssd-stat"><span>NHU CẦU THUỘC PHẠM VI</span><strong>{demands.data?.length ?? '—'}</strong><small>Danh sách hiện tại, gồm mọi trạng thái</small></article>
        <article className="dssd-stat dssd-stat-green"><span>SẴN SÀNG CHẠY F1</span><strong>{selectable.data?.counts.eligible ?? '—'}</strong><small>Có thể lựa chọn để chạy F1</small></article>
        <article className="dssd-stat"><span>BỊ LOẠI KHỎI F1</span><strong>{selectable.data?.counts.excluded ?? '—'}</strong><small>Không đáp ứng điều kiện lựa chọn</small></article>
      </section>

      <div className="dssd-workspace dssf-dashboard-workspace">
        <section className="dssd-panel">
          <div className="dssd-panel-heading"><div><h2>RuleSet khả dụng</h2></div></div>
          {rules.loading && <div className="dssd-loading" role="status">Đang tải RuleSet…</div>}
          {rules.data?.length === 0 && <div className="dssd-empty">Chưa có RuleSet hợp lệ cho F1.</div>}
          {!!rules.data?.length && <label className="dssf-filter">
            <span>RuleSet cho lần chạy mới</span>
            <select value={selected?.id ?? ''} onChange={(event) => setSelectedId(Number(event.target.value))}>
              {rules.data.map((rule) => <option key={rule.id} value={rule.id}>{rule.rule_set_code} · v{rule.version_no}</option>)}
            </select>
          </label>}
          {selected && <dl className="dssf-facts">
            <div><dt>Tên</dt><dd>{selected.rule_set_name}</dd></div>
            <div><dt>Số nhu cầu tối đa mỗi nhóm</dt><dd>{selected.max_group_size ?? 'Không giới hạn'}</dd></div>
            <div><dt>Số nhóm tối đa mỗi lần chạy</dt><dd>{selected.max_candidates_per_run ?? missing}</dd></div>
          </dl>}
        </section>


<div className="dssf-run-column">

  {/* Tổng số lần chạy F1 - Khung độc lập */}
  <article className="dssf-total-runs">
    <span>Tổng số lần chạy F1</span>
    <strong>{recentHistory.data?.count ?? '—'}</strong>
  </article>

  {/* Lần chạy mới nhất */}
  <section className="dssd-panel">
    <div className="dssd-panel-heading">
      <div>
        <h2>Lần chạy mới nhất</h2>

        {latest && (
          <p>
            {runTime(latest.started_at)} · {f1Label(latest.status)}
            {latest.matching_outcome &&
              ` · ${f1Label(latest.matching_outcome)}`}
          </p>
        )}
      </div>

      {latest && (
        <Link
          className="dssf-link"
          to={`/dss/runs/${latest.run_code}`}
        >
          Xem chi tiết →
        </Link>
      )}
    </div>

    {latest && <RunSummaryStats run={latest} />}

    {recentHistory.loading && (
      <div role="status">
        Đang tải kết quả mới nhất…
      </div>
    )}

    {recentHistory.data?.count === 0 && (
      <div className="dssd-empty">
        Chưa có lần chạy F1.
      </div>
    )}
  </section>

</div>

      </div>

      <section className="dssd-panel dssd-history">
        <div className="dssd-panel-heading">
          <div><h2>Lịch sử PlanningRun</h2></div>
        </div>
        {history.loading && <div className="dssd-loading" role="status">Đang tải lịch sử…</div>}
        {history.error !== null && <div className="dssd-alert dssd-alert-error" role="alert">{dssErrorMessage(history.error)}</div>}
        {history.data?.results.length === 0 && <div className="dssd-empty dssd-empty-history">Chưa có lần chạy F1.</div>}
        {!!history.data?.results.length && (
          <>
            <div className="dssd-table-wrap">
              <table className="dssd-table dssf-history-table">
                <thead><tr><th>LẦN CHẠY</th><th>RULESET</th><th>BẮT ĐẦU</th><th>TRẠNG THÁI</th><th>NHU CẦU</th><th>NHÓM ỨNG VIÊN</th><th>THAO TÁC</th></tr></thead>
                <tbody>
                  {history.data.results.map((run) => (
                    <tr key={run.run_code}>
                      <td><strong title={run.run_code}>{run.run_code.slice(0, 8)}</strong></td>
                      <td>{run.rule_set_code ?? missing}{run.rule_set_version != null && ` · v${run.rule_set_version}`}</td>
                      <td>{runTime(run.started_at)}</td>
                      <td><span className={`dssd-run-status ${run.status === 'IN_PROGRESS' ? 'running' : run.status.toLowerCase()}`}>{f1Label(run.status)}</span>
                      </td>
                      <td>{run.demand_count ?? '—'}</td>
                      <td>{run.candidate_count ?? '—'}</td>
                      <td><Link className="dssf-link" to={`/dss/runs/${run.run_code}`}>Chi tiết →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <nav
                className="dssd-pagination dssf-history-pagination"
                aria-label="Phân trang lịch sử PlanningRun"
              >
                <button
                  type="button"
                  className="dssf-page-arrow"
                  disabled={page === 1 || history.loading}
                  onClick={() => setPage(page - 1)}
                  aria-label="Trang trước"
                  title="Trang trước"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>

                {startPage > 1 && (
                  <span className="dssf-page-ellipsis">…</span>
                )}

                {visiblePages.map((pageNumber) => (
                  <button
                    key={pageNumber}
                    type="button"
                    className={`dssf-page-number ${
                      page === pageNumber ? 'is-active' : ''
                    }`}
                    onClick={() => setPage(pageNumber)}
                    disabled={history.loading}
                    aria-current={page === pageNumber ? 'page' : undefined}
                    aria-label={`Trang ${pageNumber}`}
                  >
                    {pageNumber}
                  </button>
                ))}

                {visiblePages[visiblePages.length - 1] < totalPages && (
                  <span className="dssf-page-ellipsis">…</span>
                )}

                <button
                  type="button"
                  className="dssf-page-arrow"
                  disabled={page >= totalPages || history.loading}
                  onClick={() => setPage(page + 1)}
                  aria-label="Trang sau"
                  title="Trang sau"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </nav>
            )}

          </>
        )}
      </section>
    </main>
  )
}
