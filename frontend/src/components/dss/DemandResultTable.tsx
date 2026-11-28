import { useEffect, useRef, useState } from 'react'
import ExclusionReasonList from './ExclusionReasonList'
import { deliveryDate, demandCode, f1Label, isMatched, masterdataLabel, missing, outletName, runTime, skuName, timeWindow, weight } from './f1Display'
import type { DemandResult } from './f1Display'
import type { F1DemandDisplayLabels, F1DisplayLabels } from '../../types/f1'

const filters = [
  ['all', 'Tất cả'],
  ['ELIGIBLE', 'Đủ điều kiện'],
  ['EXCLUDED', 'Không đủ điều kiện'],
  ['matched', 'Được ghép nhóm'],
  ['unmatched', 'Chưa ghép nhóm'],
]

function DemandEvidence({ result, labels }: { result: DemandResult; labels?: F1DemandDisplayLabels }) {
  const evidence = result.evidence
  const preview = 'capacity_results' in result ? result : null
  const capacity = preview
    ? preview.capacity_results
    : result.diagnostics.flatMap((item) => typeof item !== 'string' && item.stage === 'CAPACITY' && item.item_id !== undefined
      ? [{ item_id: item.item_id, status: item.code }]
      : [])
  const diagnostics = preview
    ? [
      ...[...new Set([...preview.blockers, ...preview.reason_codes])].map((code) => ({ code, severity: 'BLOCKER' })),
      ...preview.warnings.map((code) => ({ code, severity: 'WARNING' })),
    ]
    : result.diagnostics.filter((item) => typeof item === 'string' || item.stage !== 'CAPACITY' || item.item_id === undefined)
  const hasShortfall = result.primary_reason_code === 'PROMISE_INSUFFICIENT' ||
    diagnostics.some((item) => typeof item === 'string' ? item === 'PROMISE_INSUFFICIENT' : item.code === 'PROMISE_INSUFFICIENT')

  const demandItems = evidence?.items ?? []

  const unmatchedCapacity = capacity.filter(
    entry => !demandItems.some(
      item =>
        item.item_id != null &&
        String(item.item_id) === String(entry.item_id)
    )
  )
  return (
    <div className="dssf-demand-evidence">
      <dl className="dssf-facts">
        <div><dt>Outlet</dt><dd>{outletName(evidence, labels?.outlet)}</dd></div>
        <div><dt>Nhà cung cấp</dt><dd>{masterdataLabel(evidence?.supplier_code, evidence?.supplier_name, labels?.supplier, missing)}</dd></div>
        <div><dt>Ngày và khung giờ yêu cầu</dt><dd>{deliveryDate(evidence?.requested_date)} · {timeWindow(evidence?.requested_start_time, evidence?.requested_end_time)}</dd></div>
        <div><dt>Khối lượng yêu cầu</dt><dd>{weight(evidence?.quantity_kg)}</dd></div>
        <div><dt>Nhóm hàng</dt><dd>{evidence?.cargo_category_code ?? missing}</dd></div>
        <div><dt>Kiểm tra xung đột kế hoạch</dt><dd>{f1Label(result.plan_guard_status)}</dd></div>

      </dl>

      <section className="dssf-supply-section">

        <div className="dssf-supply-heading">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m12 3 9 5-9 5-9-5 9-5Z" />
            <path d="M3 8v8l9 5 9-5V8" />
            <path d="M12 13v8" />
          </svg>

          <h3>Chi tiết mặt hàng và năng lực cung ứng</h3>

          <span className="dssf-supply-count">
            {demandItems.length} mặt hàng
          </span>
        </div>

        {demandItems.length > 0 || unmatchedCapacity.length > 0 ? (
          <div className="dssf-supply-table-wrap">

            <table className="dssf-supply-table">

              <thead>
                <tr>
                  <th>Mặt hàng</th>
                  <th>Khối lượng yêu cầu</th>
                  <th>Năng lực cung ứng</th>
                </tr>
              </thead>

              <tbody>
                {demandItems.map(item => {

                  const itemCapacity = capacity.filter(
                    entry =>
                      item.item_id != null &&
                      String(entry.item_id) === String(item.item_id)
                  )

                  return (
                    <tr key={item.demand_item_id}>

                      <td>
                        <span className="dssf-supply-item-name">
                          {skuName(item.item_id, evidence, labels)}
                        </span>
                      </td>

                      <td className="dssf-supply-weight">
                        {weight(item.required_weight_kg)}
                      </td>

                      <td>
                        <div className="dssf-supply-status-list">

                          {itemCapacity.length ? (
                            itemCapacity.map((entry, index) => (
                              <span
                                key={`${entry.item_id}-${entry.status}-${index}`}
                                className={`dssf-supply-status ${
                                  entry.status === 'VERIFIED'
                                    ? 'is-verified'
                                    : 'is-other'
                                }`}
                              >
                                {entry.status === 'VERIFIED' && (
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                  >
                                    <circle cx="12" cy="12" r="9" />
                                    <path d="m8 12 3 3 5-6" />
                                  </svg>
                                )}

                                {f1Label(entry.status)}
                              </span>
                            ))
                          ) : (
                            <span className="dssf-supply-status is-other">
                              {missing}
                            </span>
                          )}

                        </div>
                      </td>

                    </tr>
                  )
                })}

                {unmatchedCapacity.map((entry, index) => (
                  <tr key={`capacity-${entry.item_id}-${index}`}>

                    <td>
                      <span className="dssf-supply-item-name">
                        {skuName(entry.item_id, evidence, labels)}
                      </span>
                    </td>

                    <td className="dssf-supply-weight">
                      {missing}
                    </td>

                    <td>
                      <span
                        className={`dssf-supply-status ${
                          entry.status === 'VERIFIED'
                            ? 'is-verified'
                            : 'is-other'
                        }`}
                      >
                        {f1Label(entry.status)}
                      </span>
                    </td>

                  </tr>
                ))}

              </tbody>

              <tfoot>
                <tr>
                  <td>Tổng khối lượng</td>
                  <td className="dssf-supply-total">
                    {weight(evidence?.quantity_kg)}
                  </td>
                  <td />
                </tr>
              </tfoot>

            </table>

          </div>
        ) : (
          <p>{missing}</p>
        )}

      </section>

      {hasShortfall && <div className="dssf-notice">
        <strong>Khối lượng xác nhận chưa đủ</strong>
        {evidence?.promise_shortfalls?.length ? <ul className="dssf-lines">{evidence.promise_shortfalls.map((line) => {
          const item = evidence.items?.find((entry) => entry.demand_item_id === line.demand_item_id)
          return <li key={line.demand_item_id}>
            <strong>{skuName(item?.item_id, evidence, labels)}</strong>
            <span className="dssf-evidence-line">Yêu cầu {weight(line.required_weight_kg)} · Xác nhận đủ điều kiện {weight(line.confirmed_weight_kg)} · Còn thiếu {weight(line.shortfall_weight_kg)}</span>
          </li>
        })}</ul> : <p>Chưa có số liệu theo mặt hàng trong snapshot.</p>}
      </div>}
      <ExclusionReasonList diagnostics={diagnostics} />
      <details className="dssf-technical">
        <summary>Mã trạng thái và nguồn dữ liệu</summary>
        <p><code>#{result.demand_id} · {result.eligibility_status} · {result.plan_guard_status} · {result.matching_status}</code></p>
        {result.primary_reason_code && <p>Lý do chính <code>{result.primary_reason_code}</code></p>}
        {capacity.map((item) => <p key={item.item_id}>Năng lực #{item.item_id} <code>{item.status}</code></p>)}
        <p>Snapshot {evidence?.snapshot_version ?? missing} · {runTime(evidence?.captured_at)}</p>
      </details>
    </div>
  )
}


function DemandDetailDrawer({
  result,
  labels,
  onClose,
}: {
  result: DemandResult
  labels?: F1DemandDisplayLabels
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current

    if (!dialog) return

    dialog.showModal()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      dialog.close()
      document.body.style.overflow = previousOverflow
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="dssf-demand-drawer"
      aria-labelledby="dssf-drawer-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="dssf-drawer-content">

        <header className="dssf-drawer-header">
          <div>
            <p className="dssf-drawer-eyebrow">
              COLOGI · CHI TIẾT NHU CẦU
            </p>

            <h2 id="dssf-drawer-title">
              {demandCode(result)}
            </h2>

            <p className="dssf-drawer-subtitle">
              {outletName(
                result.evidence,
                labels?.outlet
              )}
            </p>
          </div>

          <button
            type="button"
            className="dssf-drawer-close"
            aria-label="Đóng chi tiết nhu cầu"
            onClick={onClose}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="dssf-drawer-body">

          <div className="dssf-drawer-status">
            <span
              className={`dssr-option-status ${
                result.eligibility_status === 'ELIGIBLE'
                  ? 'is-feasible'
                  : result.eligibility_status === 'EXCLUDED'
                    ? 'is-excluded'
                    : 'is-blocked'
              }`}
            >
              {f1Label(result.eligibility_status)}
            </span>

            <small>
              {f1Label(result.matching_status)}
            </small>
          </div>

          <DemandEvidence
            result={result}
            labels={labels}
          />

        </div>

      </div>
    </dialog>
  )
}


export default function DemandResultTable({
  results,
  labels,
  previewMatchedIds,
  showMembers = false,
}: {
  results: DemandResult[]
  labels?: F1DisplayLabels
  previewMatchedIds?: Set<number>
  showMembers?: boolean
}) {
  const [filter, setFilter] = useState('all')
  const [selectedDemand, setSelectedDemand] =
    useState<DemandResult | null>(null)
  const visible = results.filter((result) => {
    if (showMembers || filter === 'all') return true
    if (filter === 'matched') return isMatched(result, previewMatchedIds)
    if (filter === 'unmatched') return result.matching_status === 'UNMATCHED'
    return result.eligibility_status === filter
  })

  if (showMembers) {
    return (
      <>
        <div className="dssf-group-table-wrap">

          <table className="dssf-group-table dssf-member-table">

            <thead>
              <tr>
                <th>Mã nhu cầu</th>
                <th>Outlet / Nhà cung cấp</th>
                <th>Khung giờ yêu cầu</th>
                <th className="dssf-group-number">
                  Khối lượng
                </th>
                <th>Trạng thái</th>
                <th>Chi tiết</th>
              </tr>
            </thead>

            <tbody>
              {results.map(result => {

                const evidence = result.evidence
                const displayLabels = labels?.[result.demand_id]

                return (
                  <tr key={result.demand_id}>

                    <td>
                      <strong className="dssf-group-name">
                        {demandCode(result)}
                      </strong>
                    </td>

                    <td>
                      <strong>
                        {outletName(
                          evidence,
                          displayLabels?.outlet
                        )}
                      </strong>

                      <small>
                        {masterdataLabel(
                          evidence?.supplier_code,
                          evidence?.supplier_name,
                          displayLabels?.supplier,
                          missing
                        )}
                      </small>
                    </td>

                    <td>
                      <strong>
                        {timeWindow(
                          evidence?.requested_start_time,
                          evidence?.requested_end_time
                        )}
                      </strong>

                      <small>
                        {deliveryDate(evidence?.requested_date)}
                      </small>
                    </td>

                    <td className="dssf-group-number">
                      <strong className="dssf-group-weight">
                        {weight(evidence?.quantity_kg)}
                      </strong>
                    </td>

                    <td>
                      <span
                        className={`dssr-option-status ${
                          result.eligibility_status === 'ELIGIBLE'
                            ? 'is-feasible'
                            : result.eligibility_status === 'EXCLUDED'
                              ? 'is-excluded'
                              : 'is-blocked'
                        }`}
                      >
                        {f1Label(result.eligibility_status)}
                      </span>

                      <small>
                        {f1Label(result.matching_status)}
                      </small>
                    </td>

                    <td>
                      <button
                        type="button"
                        className="dssf-group-open"
                        aria-label={`Xem ${demandCode(result)}`}
                        onClick={() => setSelectedDemand(result)}
                      >
                        <svg
                          width="19"
                          height="19"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M4 12h16m-6-6 6 6-6 6" />
                        </svg>
                      </button>
                    </td>

                  </tr>
                )
              })}

              {!results.length && (
                <tr>
                  <td colSpan={6} className="dssf-group-empty">
                    Chưa có dữ liệu nhu cầu trong nhóm.
                  </td>
                </tr>
              )}
            </tbody>

          </table>

        </div>

        {selectedDemand && (
          <DemandDetailDrawer
            result={selectedDemand}
            labels={labels?.[selectedDemand.demand_id]}
            onClose={() => setSelectedDemand(null)}
          />
        )}
      </>
    )
  }

  return (
    <>
      {!showMembers && <label className="dssf-filter">
        <span>Lọc kết quả đánh giá</span>
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          {filters.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
      </label>}
      {visible.length === 0 && <div className="dssr-empty-small">
        {results.length ? 'Không có nhu cầu phù hợp với bộ lọc.' : 'Chưa có kết quả đánh giá nhu cầu.'}
      </div>}
      <div className="dssf-results-list">

        {visible.map((result) => (
          <article className="dssf-result-row" key={result.demand_id}>

            <div className={`dssf-result-summary ${!showMembers ? 'dssf-result-summary--with-action' : ''}`}>

              <div>
                <strong>{demandCode(result)}</strong>
                <small>
                  {outletName(
                    result.evidence,
                    labels?.[result.demand_id]?.outlet
                  )}
                </small>
              </div>

              <div>
                <span
                  className={`dssr-option-status ${
                    result.eligibility_status === 'ELIGIBLE'
                      ? 'is-feasible'
                      : result.eligibility_status === 'EXCLUDED'
                        ? 'is-excluded'
                        : 'is-blocked'
                  }`}
                >
                  {f1Label(result.eligibility_status)}
                </span>

                <small>
                  {previewMatchedIds?.has(result.demand_id)
                    ? 'Có nhóm trong bản xem trước'
                    : f1Label(result.matching_status)}
                </small>
              </div>

              <div>
                <small>Lý do chính</small>
                <span>
                  {result.primary_reason_code
                    ? f1Label(result.primary_reason_code)
                    : '—'}
                </span>
              </div>

              {!showMembers && (
                <div className="dssf-result-action">
                  <button
                    type="button"
                    className="dssf-open-drawer"
                    onClick={() => setSelectedDemand(result)}
                  >
                    <span>Xem chi tiết nhu cầu</span>

                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 12h16m-6-6 6 6-6 6" />
                    </svg>
                  </button>
                </div>
              )}

            </div>

            {showMembers && (
              <DemandEvidence
                result={result}
                labels={labels?.[result.demand_id]}
              />
            )}

          </article>
        ))}

      </div>

      {selectedDemand && (
        <DemandDetailDrawer
          result={selectedDemand}
          labels={labels?.[selectedDemand.demand_id]}
          onClose={() => setSelectedDemand(null)}
        />
      )}
    </>
  )
}
