import { useCallback, useState } from 'react'
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import CandidateTable from '../../components/dss/CandidateTable'
import DemandResultTable from '../../components/dss/DemandResultTable'
import ExclusionReasonList from '../../components/dss/ExclusionReasonList'
import SnapshotViewer from '../../components/dss/SnapshotViewer'
import RunSummaryStats from '../../components/dss/RunSummaryStats'
import { f1Label, runTime } from '../../components/dss/f1Display'
import { dssErrorMessage, dssService } from '../../services/dss/dssService'
import { useDssQuery } from '../../services/dss/useDssQuery'
import { planningSearch } from '../../components/dss/planningSearch'
import CloseUnplannedForm from '../foundation/CloseUnplannedForm'
import type { DSSOutletContext } from './ManagerRoute'
import './DSSRunDetailPage.css'
import './F1Presentation.css'

export default function DSSRunDetailPage() {
  const { runId = '' } = useParams()
  const { scope } = useOutletContext<DSSOutletContext>()
  const navigate = useNavigate()
  const loadRun = useCallback(() => dssService.getRun(runId), [runId])
  const { data: run, error, loading, reload } = useDssQuery(loadRun)
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'groups' ? 'groups' : 'demands'
  const scenario = params.get('scenario')
  const [showCloseUnplanned, setShowCloseUnplanned] = useState(false)
  if (!run) {
    return (
      <main className="dssr-page">
        <button className="dssr-back-link" onClick={() => navigate('/dss')}>← Tổng quan DSS</button>
        {loading ? <div className="dssr-loading" role="status">Đang tải PlanningRun…</div> : (
          <div className="dssr-alert" role="alert">{dssErrorMessage(error)}</div>
        )}
      </main>
    )
  }

  return (
    <main className="dssr-page">
      <header className="dssr-header">
        <div className="dssr-header-main">
          <button className="dssr-back-link" onClick={() => navigate('/dss')}>← Tổng quan DSS</button>
          <p className="dssr-eyebrow">COLOGI · DSS F1</p>
          <h1>Kết quả PlanningRun</h1>
          <p className="dssr-description">{runTime(run.started_at)} · {run.demand_count ?? '—'} nhu cầu ghi nhận</p>
          <div className="dssr-header-tags">
            <span className={`dssr-run-badge is-${run.status === 'IN_PROGRESS' ? 'running' : run.status.toLowerCase()}`}>{f1Label(run.status)}</span>
            {run.matching_outcome && <span className="dssr-run-badge">{f1Label(run.matching_outcome)}</span>}
          </div>
        </div>

        <div className="dssr-header-action-column">
          <div className="dssr-header-actions">
            <button
              className="dssr-secondary-button"
              onClick={reload}
            >
              ↻ Làm mới
            </button>

            <button
              className="dssr-secondary-button"
              onClick={() => navigate('/dss/scenarios/new')}
            >
              Tạo lần chạy F1
            </button>
          </div>

          {scope.unplanned_closure_enabled &&
            run.status === 'COMPLETED' &&
            run.demand_results.length > 0 && (
              <button
                type="button"
                className="dssr-close-unplanned-button"
                onClick={() => setShowCloseUnplanned(true)}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="5" y="4" width="14" height="17" rx="2" />
                  <path d="m9 11 6 6m0-6-6 6" />
                </svg>

                Kết thúc nhu cầu
              </button>
            )}
        </div>

      </header>

      {run.status === 'IN_PROGRESS' && <div className="dssr-alert" role="status">F1 đang được xử lý. Chọn Làm mới để kiểm tra lại.</div>}
      {run.status === 'FAILED' && (
        <section className="dssr-alert" role="alert">
          <strong>Thực thi F1 thất bại</strong>
          <ExclusionReasonList diagnostics={run.failure_diagnostics} />
        </section>
      )}
      <section className="dssr-panel">
        <div className="dssr-panel-heading"><div><h2>Thông tin lần chạy</h2></div></div>
        <SnapshotViewer run={run} />
      </section>

      <RunSummaryStats run={run} />

      <section className="dssr-panel dssr-results-panel">
        <div className="dssr-panel-heading"><div><h2>Kết quả F1</h2></div></div>
        <div className="dssr-tabs" aria-label="Nội dung kết quả">
          <button type="button" className={tab === 'demands' ? 'is-active' : ''} aria-pressed={tab === 'demands'}
            onClick={() => setParams(planningSearch(scenario), { replace: true })}>Đánh giá nhu cầu</button>
          <button type="button" className={tab === 'groups' ? 'is-active' : ''} aria-pressed={tab === 'groups'}
            onClick={() => setParams(planningSearch(scenario, { tab: 'groups' }), { replace: true })}>Nhóm ứng viên</button>
        </div>
        <div className="dssr-tab-content">
          {tab === 'demands' ? <DemandResultTable results={run.demand_results} labels={run.display_labels} /> : (
            <CandidateTable groups={run.candidate_groups} results={run.demand_results} labels={run.display_labels} at={run.started_at}
              openGroup={(group) => navigate({ pathname: `/dss/runs/${run.run_code}/options/${group}`,
                search: planningSearch(scenario) })} />
          )}
        </div>
      </section>

      {showCloseUnplanned &&
        scope.unplanned_closure_enabled &&
        run.status === 'COMPLETED' && (
          <div className="dssr-modal-overlay">
            <section
              className="dssr-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="close-unplanned-title"
            >
              <div className="dssr-modal-header">
                <h2 id="close-unplanned-title">
                  Kết thúc nhu cầu không lập được kế hoạch
                </h2>

                <button
                  type="button"
                  className="dssr-modal-close"
                  aria-label="Đóng biểu mẫu"
                  onClick={() => setShowCloseUnplanned(false)}
                >
                  ×
                </button>
              </div>

              <CloseUnplannedForm
                runCode={run.run_code}
                demands={run.demand_results.map(row => ({
                  id: row.demand_id,
                  label: `Nhu cầu #${row.demand_id}`
                }))}
                embedded
              />

              <div className="dssr-modal-footer">
                <button
                  type="button"
                  className="dssr-secondary-button"
                  onClick={() => {
                    setShowCloseUnplanned(false)
                    reload()
                  }}
                >
                  Đóng
                </button>
              </div>
            </section>
          </div>
        )}

    </main>
  )
}
