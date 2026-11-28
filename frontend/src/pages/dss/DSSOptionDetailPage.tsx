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



function RequestedWindows({
  window,
  members,
}: {
  window: F1CandidateWindow
  members: DemandResult[]
}) {
  const lines = members.flatMap(member => {
    const start = member.evidence?.requested_start_time
    const end = member.evidence?.requested_end_time

    return start && end
      ? [{ label: demandCode(member), start, end }]
      : []
  })

  if (!lines.length || lines.length !== members.length) {
    return null
  }

  const starts = lines.map(entry => clockSeconds(entry.start))
  const ends = lines.map(entry => clockSeconds(entry.end))

  const axisStart = Math.min(...starts)
  const axisEnd = Math.max(...ends)

  const commonStart = clockSeconds(window.common_start_time)
  const commonEnd = clockSeconds(window.common_end_time)

  if (
    !Number.isFinite(axisStart + axisEnd) ||
    !Number.isFinite(commonStart + commonEnd) ||
    axisEnd <= axisStart ||
    commonEnd < commonStart ||
    commonStart < axisStart ||
    commonEnd > axisEnd ||
    lines.some(entry =>
      clockSeconds(entry.end) <= clockSeconds(entry.start)
    )
  ) {
    return null
  }

  const range = axisEnd - axisStart

  const position = (seconds: number) =>
    ((seconds - axisStart) / range) * 100

  const formatClock = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const remainder = Math.floor(seconds % 60)

    const text =
      String(hours).padStart(2, '0') +
      ':' +
      String(minutes).padStart(2, '0')

    return remainder
      ? `${text}:${String(remainder).padStart(2, '0')}`
      : text
  }

  const tickStep =
    range <= 3600 ? 900 :
    range <= 10800 ? 1800 :
    range <= 21600 ? 3600 :
    7200

  const ticks: number[] = [axisStart]

  for (
    let tick = Math.ceil(axisStart / tickStep) * tickStep;
    tick < axisEnd;
    tick += tickStep
  ) {
    if (
      tick - axisStart >= tickStep * 0.5 &&
      axisEnd - tick >= tickStep * 0.5
    ) {
      ticks.push(tick)
    }
  }

  ticks.push(axisEnd)

  const chartLines = [
    {
      label: 'Khung giờ chung',
      start: window.common_start_time,
      end: window.common_end_time,
    },
    ...lines,
  ]

  return (
    <section className="dss-option-card dssf-window-card">

      <div className="dssf-window-card-header">
        <h2>Khả năng phối hợp giao nhận</h2>

        <p>
          {deliveryDate(window.requested_date)}
          {' · '}
          {commonDuration(window)} giao nhau
        </p>
      </div>

      <div className="dssf-window-chart">

        <div className="dssf-window-axis">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className={
                index === 0
                  ? 'is-first'
                  : index === ticks.length - 1
                    ? 'is-last'
                    : ''
              }
              style={{ left: `${position(tick)}%` }}
            >
              {formatClock(tick)}
            </span>
          ))}
        </div>

        <div className="dssf-window-bars">

          {/* Vùng thời gian giao nhau */}

          <span
            className="dssf-window-overlap"
            aria-hidden="true"
            style={{
              left: `${position(commonStart)}%`,
              width: `${((commonEnd - commonStart) / range) * 100}%`,
            }}
          />

          {/* Thanh khung giờ chung và từng nhu cầu */}

          {chartLines.map((entry, index) => {
            const start = clockSeconds(entry.start)
            const end = clockSeconds(entry.end)

            return (
              <div
                className="dssf-window-row"
                key={`${entry.label}-${index}`}
                title={`${entry.label}: ${timeWindow(entry.start, entry.end)}`}
              >
                
                <span
                  className={`dssf-window-bar ${
                    index === 0 ? 'is-dark' : ''
                  }`}
                  style={{
                    left: `${position(start)}%`,
                    width: `${((end - start) / range) * 100}%`,
                  }}
                  title={`${entry.label}: ${timeWindow(entry.start, entry.end)}`}
                  aria-label={`${entry.label}: ${timeWindow(entry.start, entry.end)}`}
                >
                  {index !== 0 && (
                    <span className="dssf-window-bar-label">
                      {entry.label}
                    </span>
                  )}
                </span>

              </div>
            )
          })}

        </div>
        
        <div className="dssf-window-legend">
          <span>
            <i className="is-common" />
            Khung giờ chung
          </span>

          <span>
            <i className="is-request" />
            Khung giờ nhu cầu
          </span>
        </div>

        <p className="dssf-window-common">
          Khung giờ chung:{' '}
          <strong>
            {timeWindow(
              window.common_start_time,
              window.common_end_time
            )}
          </strong>
        </p>

      </div>

    </section>
  )
}


function GroupWeightComposition({
  members,
}: {
  members: DemandResult[]
}) {
  const rows = members.map(member => {

    const rawWeight = member.evidence?.quantity_kg

    return {
      id: member.demand_id,
      code: demandCode(member),
      outlet: member.evidence?.outlet_code || demandCode(member),
      rawWeight,
      value: Number(rawWeight),
    }
  })

  if (
    !rows.length ||
    rows.some(row =>
      !row.rawWeight ||
      !Number.isFinite(row.value) ||
      row.value <= 0
    )
  ) {
    return null
  }

  const total = rows.reduce(
    (sum, row) => sum + row.value,
    0
  )

  const colors = [
    '#23754a',
    '#82b393',
    '#c0d8c5',
    '#56866b',
    '#a6c7b1',
  ]

  return (
    <section className="dss-option-card dssf-weight-card">

      <div className="dss-option-card-heading">
        <h2>Cơ cấu khối lượng nhu cầu</h2>
      </div>

      <div className="dssf-weight-composition-bar">
        {rows.map((row, index) => {

          const percent = row.value / total * 100

          return (
            <div
              key={row.id}
              title={`${row.code}: ${weight(row.rawWeight)} (${percent.toFixed(1)}%)`}
              style={{
                width: `${percent}%`,
                background: colors[index % colors.length],
                color:
                  index % colors.length === 0 ||
                  index % colors.length === 3
                    ? '#ffffff'
                    : '#183b29',
              }}
            >
              {percent >= 12
                ? `${percent.toFixed(1)}%`
                : ''}
            </div>
          )
        })}
      </div>

      <div className="dssf-weight-legend">
        {rows.map((row, index) => (
          <div key={row.id}>

            <i
              style={{
                background: colors[index % colors.length],
              }}
            />

            <span>{row.outlet}</span>

            <strong>{weight(row.rawWeight)}</strong>

            {row.value / total * 100 < 12 && (
              <small>
                {(row.value / total * 100).toFixed(1)}%
              </small>
            )}

          </div>
        ))}
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
        <Link
          className="dssf-back-to-results"
          to={{
            pathname: runPath,
            search: planningSearch(scenario, { tab: 'groups' })
          }}
        >
          ← Quay lại kết quả F1
        </Link>
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

          <div className="dss-option-summary dssf-group-summary dssf-group-kpis">

            <article>
              <div className="dssf-group-kpi-label">
                <span>Nhu cầu trong nhóm</span>
                <span className="dssf-group-kpi-icon">≡</span>
              </div>

              <strong>{facts.ids.length}</strong>

              <small>Nhu cầu mua hàng</small>
            </article>

            <article>
              <div className="dssf-group-kpi-label">
                <span>Outlet phân biệt</span>
                <span className="dssf-group-kpi-icon">⌂</span>
              </div>

              <strong>{facts.outletCount ?? missing}</strong>

              <small>Điểm nhận hàng</small>
            </article>

            <article>
              <div className="dssf-group-kpi-label">
                <span>Tổng khối lượng</span>
                <span className="dssf-group-kpi-icon">◇</span>
              </div>

              <strong>{weight(facts.totalKg)}</strong>

              <small>Khối lượng yêu cầu</small>
            </article>

            <article>
              <div className="dssf-group-kpi-label">
                <span>Thời lượng chung</span>
                <span className="dssf-group-kpi-icon">◷</span>
              </div>

              <strong>{commonDuration(facts.window)}</strong>

              <small>
                {timeWindow(
                  facts.window?.common_start_time,
                  facts.window?.common_end_time
                )}
              </small>
            </article>

          </div>


          <div className="dssf-group-analysis-grid">

            {facts.window &&
              memberResults.length === facts.ids.length && (
                <RequestedWindows
                  window={facts.window}
                  members={memberResults}
                />
              )}

            <section className="dss-option-card dssf-group-check-card">

              <div className="dss-option-card-heading">
                <h2>Căn cứ ghép nhóm F1</h2>
              </div>

              <div className="dssf-group-checklist">

                {[
                  {
                    label: 'Điều kiện nhu cầu',
                    value: `${memberResults.filter(
                      item => item.eligibility_status === 'ELIGIBLE'
                    ).length}/${facts.ids.length} nhu cầu đủ điều kiện`,
                    passed:
                      memberResults.length > 0 &&
                      memberResults.length === facts.ids.length &&
                      memberResults.every(
                        item => item.eligibility_status === 'ELIGIBLE'
                      ),
                  },
                  {
                    label: 'Xung đột kế hoạch',
                    value:
                      memberResults.length > 0 &&
                      memberResults.length === facts.ids.length &&
                      memberResults.every(
                        item => item.plan_guard_status === 'PASS'
                      )
                        ? 'Đạt kiểm tra'
                        : 'Chưa xác nhận đạt',
                    passed:
                      memberResults.length > 0 &&
                      memberResults.length === facts.ids.length &&
                      memberResults.every(
                        item => item.plan_guard_status === 'PASS'
                      ),
                  },
                  {
                    label: 'Outlet phân biệt',
                    value: `${facts.outletCount ?? missing} điểm nhận`,
                    passed:
                      facts.outletCount !== null &&
                      facts.outletCount >= 2,
                  },
                  {
                    label: 'Ngày giao',
                    value:
                      Boolean(facts.window?.requested_date) &&
                      memberResults.length > 0 &&
                      memberResults.length === facts.ids.length &&
                      memberResults.every(
                        item =>
                          item.evidence?.requested_date ===
                          facts.window?.requested_date
                      )
                        ? 'Cùng ngày giao'
                        : deliveryDate(facts.window?.requested_date),
                    passed:
                      Boolean(facts.window?.requested_date) &&
                      memberResults.length > 0 &&
                      memberResults.length === facts.ids.length &&
                      memberResults.every(
                        item =>
                          item.evidence?.requested_date ===
                          facts.window?.requested_date
                      ),
                  },
                  {
                    label: 'Khung giờ chung',
                    value: commonDuration(facts.window),
                    passed:
                      Boolean(facts.window) &&
                      clockSeconds(facts.window!.common_end_time) >
                      clockSeconds(facts.window!.common_start_time),
                  },
                ].map(item => (
                  <div className="dssf-group-check-item" key={item.label}>

                    <span
                      className={`dssf-group-check-icon ${
                        item.passed ? 'is-passed' : 'is-unknown'
                      }`}
                    >
                      {item.passed ? '✓' : '—'}
                    </span>

                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.value}</small>
                    </div>

                  </div>
                ))}

                <div
                  className="dssf-group-check-item dssf-group-category-info"
                  title="Nhóm hàng tương thích theo ma trận được lưu tại lần chạy F1"
                >
                  <span className="dssf-group-check-icon is-unknown">
                    i
                  </span>

                  <div>
                    <span>{facts.categoryCodes.join(', ') || missing}</span>
                  </div>
                </div>

              </div>

            </section>

          </div>

          <section className="dss-option-card">
            <div className="dss-option-card-heading"><h2>Nhu cầu trong nhóm</h2></div>
            {memberResults.length === facts.ids.length && (
              <GroupWeightComposition members={memberResults} />
            )}
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
    </main>
  )
}
