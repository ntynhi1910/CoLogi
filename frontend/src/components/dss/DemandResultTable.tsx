import { useState } from 'react'
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

  return (
    <div className="dssf-demand-evidence">
      <dl className="dssf-facts">
        <div><dt>Outlet</dt><dd>{outletName(evidence, labels?.outlet)}</dd></div>
        <div><dt>Nhà cung cấp</dt><dd>{masterdataLabel(evidence?.supplier_code, evidence?.supplier_name, labels?.supplier, missing)}</dd></div>
        <div><dt>Ngày và khung giờ yêu cầu</dt><dd>{deliveryDate(evidence?.requested_date)} · {timeWindow(evidence?.requested_start_time, evidence?.requested_end_time)}</dd></div>
        <div><dt>Khối lượng yêu cầu</dt><dd>{weight(evidence?.quantity_kg)}</dd></div>
        <div><dt>Nhóm hàng</dt><dd>{evidence?.cargo_category_code ?? missing}</dd></div>
        <div><dt>Kiểm tra xung đột kế hoạch</dt><dd>{f1Label(result.plan_guard_status)}</dd></div>
        <div><dt>Năng lực cung ứng</dt><dd>{capacity.length ? capacity.map((item) => (
          <span className="dssf-evidence-line" key={item.item_id}>{skuName(item.item_id, evidence, labels)} · {f1Label(item.status)}</span>
        )) : missing}</dd></div>
      </dl>
      <div>
        <strong>Mặt hàng</strong>
        {evidence?.items?.length ? <ul className="dssf-lines">{evidence.items.map((item) => (
          <li key={item.demand_item_id}>
            {skuName(item.item_id, evidence, labels)} · {weight(item.required_weight_kg)}
          </li>
        ))}</ul> : <p>{missing}</p>}
      </div>
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
  const visible = results.filter((result) => {
    if (showMembers || filter === 'all') return true
    if (filter === 'matched') return isMatched(result, previewMatchedIds)
    if (filter === 'unmatched') return result.matching_status === 'UNMATCHED'
    return result.eligibility_status === filter
  })

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
            <div className="dssf-result-summary">
              <div><strong>{demandCode(result)}</strong><small>{outletName(result.evidence, labels?.[result.demand_id]?.outlet)}</small></div>
              <div><span className={`dssr-option-status ${result.eligibility_status === 'ELIGIBLE' ? 'is-feasible' : result.eligibility_status === 'EXCLUDED' ? 'is-excluded' : 'is-blocked'}`}>{f1Label(result.eligibility_status)}</span>
                <small>{previewMatchedIds?.has(result.demand_id) ? 'Có nhóm trong bản xem trước' : f1Label(result.matching_status)}</small></div>
              <div><small>Lý do chính</small><span>{result.primary_reason_code ? f1Label(result.primary_reason_code) : '—'}</span></div>
            </div>
            {showMembers ? <DemandEvidence result={result} labels={labels?.[result.demand_id]} /> : (
              <details className="dssf-result-details">
                <summary>Xem chi tiết nhu cầu</summary>
                <DemandEvidence result={result} labels={labels?.[result.demand_id]} />
              </details>
            )}
          </article>
        ))}
      </div>
    </>
  )
}
