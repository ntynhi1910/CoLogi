import { useCallback } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { planningSearch } from '../../components/dss/planningSearch'
import DemandResultTable from '../../components/dss/DemandResultTable'
import SnapshotViewer from '../../components/dss/SnapshotViewer'
import {
  candidateFacts, clockSeconds, commonDuration, deliveryDate, deliveryWarning,
  demandCode, f1Label, groupLabel, missing, timeWindow, weight,
} from '../../components/dss/f1Display'
import type { DemandResult } from '../../components/dss/f1Display'
import { dssErrorMessage, dssService } from '../../services/dss/dssService'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F1CandidateWindow } from '../../types/f1'
import './DSSOptionDetailPage.css'
import './DSSRunDetailPage.css'
import './F1Presentation.css'

function RequestedWindows({ window, members }: { window: F1CandidateWindow; members: DemandResult[] }) {
  const lines = members.flatMap((member) => {
    const start = member.evidence?.requested_start_time
    const end = member.evidence?.requested_end_time
    return start && end ? [{ label: demandCode(member), start, end }] : []
  })
  if (!lines.length || lines.length !== members.length) return null

  const intersection = { label: 'Khung giờ chung', start: window.common_start_time, end: window.common_end_time }
  const starts = lines.map((entry) => clockSeconds(entry.start))
  const ends = lines.map((entry) => clockSeconds(entry.end))
  const axisStart = Math.min(...starts)
  const axisEnd = Math.max(...ends)
  if (!Number.isFinite(axisStart + axisEnd) || axisEnd <= axisStart) return null

  return (
    <section className="dss-option-card">
      <div className="dss-option-card-heading"><h2>Khung giờ giao yêu cầu</h2></div>
      <div className="dssf-timeline">
        {[intersection, ...lines].map((entry, index) => {
          const start = clockSeconds(entry.start)
          const end = clockSeconds(entry.end)
          const scale = 100 / (axisEnd - axisStart)
          return <div className="dssf-timeline-row" key={index}>
            <strong>{entry.label}</strong>
            <span className="dssf-timeline-track" aria-hidden="true">
              <span className={index === 0 ? 'is-intersection' : ''} style={{
                left: `${(start - axisStart) * scale}%`, width: `${(end - start) * scale}%`,
              }} />
            </span>
            <span>{timeWindow(entry.start, entry.end)}</span>
          </div>
        })}
      </div>
    </section>
  )
}

export default function DSSOptionDetailPage() {
  const { runId = '', optionId } = useParams()
  const [query] = useSearchParams()
  const scenario = query.get('scenario')
  const loadRun = useCallback(() => dssService.getRun(runId), [runId])
  const { data: run, error, loading } = useDssQuery(loadRun)
  const groupIndex = run?.candidate_groups.findIndex((item) => item.group_code === optionId) ?? -1
  const group = run && groupIndex >= 0 ? run.candidate_groups[groupIndex] : null
  const facts = group && run
    ? candidateFacts(group, new Map(run.demand_results.map((result) => [result.demand_id, result])), run.display_labels)
    : null
  const memberResults = facts?.members.filter((item): item is DemandResult => Boolean(item)) ?? []
  const runPath = `/dss/runs/${runId}`
  const warning = deliveryWarning(facts?.window?.requested_date, run?.started_at)

  return (
    <main className="dss-option-page dssf-candidate-detail">
      <header className="dss-option-header">
        <nav className="dss-option-breadcrumb" aria-label="Điều hướng nhóm">
          <Link to="/dss">DSS</Link>
          <span aria-hidden="true">/</span>
          <Link to={{ pathname: runPath, search: planningSearch(scenario, { tab: 'groups' }) }}>Kết quả F1</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{group ? groupLabel(groupIndex) : 'Chi tiết nhóm'}</span>
        </nav>
        <div className="dss-option-heading">
          <div><h1>{group ? groupLabel(groupIndex) : 'Chi tiết nhóm ứng viên'}</h1></div>
          {group && <div className="dss-option-actions">
            <span className="dss-option-status feasible">{f1Label(group.status)}</span>
            {group.status === 'CANDIDATE' && run?.status === 'COMPLETED' && (
              <Link className="dssr-primary-button dss-option-f2-link" to={{
                pathname: `${runPath}/options/${group.group_code}/f2`,
                search: planningSearch(scenario, { plan: query.get('plan') ?? undefined }),
              }}>
                Xây dựng phương án F2 →
              </Link>
            )}
          </div>}
        </div>
      </header>

      {loading ? <div className="dssr-loading" role="status">Đang tải nhóm ứng viên…</div> : !run || !group || !facts ? (
        <div className="dssr-alert" role="alert">
          {error ? dssErrorMessage(error) : '404 · Không tìm thấy nhóm ứng viên trong lần chạy này.'}
        </div>
      ) : (
        <div className="dssf-detail-stack">
          {warning && <div className="dssf-notice" role="status">{warning}</div>}
          <div className="dss-option-summary dssf-group-summary">
            <article><span>Nhu cầu</span><strong>{facts.ids.length}</strong></article>
            <article><span>Outlet phân biệt</span><strong>{facts.outletCount ?? missing}</strong></article>
            <article><span>Ngày giao</span><strong>{deliveryDate(facts.window?.requested_date)}</strong></article>
            <article><span>Khung giờ chung</span><strong>{timeWindow(facts.window?.common_start_time, facts.window?.common_end_time)}</strong><small>{commonDuration(facts.window)}</small></article>
            <article><span>Tổng khối lượng yêu cầu</span><strong>{weight(facts.totalKg)}</strong></article>
          </div>
          <section className="dss-option-card">
            <div className="dss-option-card-heading"><h2>Căn cứ ghép nhóm F1</h2></div>
            <p>F1 ghi nhận các nhu cầu này đủ điều kiện và đạt kiểm tra xung đột kế hoạch. Nhóm gồm ít nhất hai Outlet, cùng ngày giao và có khung giờ giao chung.</p>
            <p>Nhóm hàng tương thích theo ma trận được chốt cho lần chạy. Nhóm hàng đã lưu: {facts.categoryCodes.join(', ')}.</p>
          </section>
          {facts.window && memberResults.length === facts.ids.length && <RequestedWindows window={facts.window} members={memberResults} />}
          <section className="dss-option-card">
            <div className="dss-option-card-heading"><h2>Nhu cầu trong nhóm</h2></div>
            <DemandResultTable results={memberResults} labels={run.display_labels} showMembers />
          </section>
          <details className="dss-option-card dssf-technical">
            <summary>RuleSet và nguồn dữ liệu lịch sử</summary>
            <p>Mã nhóm <code>{group.group_code}</code></p>
            <p>Trạng thái <code>{group.status}</code></p>
            <SnapshotViewer run={run} />
          </details>
        </div>
      )}
      <footer className="dss-option-footer">
        <Link className="dss-option-btn secondary" to={`${runPath}?tab=groups`}>← Quay lại kết quả F1</Link>
      </footer>
    </main>
  )
}

