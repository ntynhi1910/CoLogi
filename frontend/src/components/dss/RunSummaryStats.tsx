import type { F1RunSummary } from '../../types/f1'

export default function RunSummaryStats({ run }: { run: F1RunSummary }) {
  const metrics = [
    ['Đã đánh giá', run.evaluated_count],
    ['Đủ điều kiện', run.eligible_count],
    ['Không đủ điều kiện', run.excluded_count],
    ['Được ghép nhóm', run.matched_count],
    ['Chưa tìm được nhóm', run.unmatched_count],
    ['Nhóm ứng viên', run.candidate_count],
  ] as const

  return <dl className="dssf-run-stats">{metrics.map(([label, count]) => (
    <div key={label}><dt>{label}</dt><dd>{count ?? '—'}</dd></div>
  ))}</dl>
}
