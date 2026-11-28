import type { F1RunSummary } from '../../types/f1'
import { f1Label, missing, runTime } from './f1Display'

export default function SnapshotViewer({ run }: { run: F1RunSummary }) {
  return (
    <>
      <div className="dssr-run-info">
        <div><span>RuleSet tại thời điểm chạy</span><strong>{run.rule_set_code ?? missing}{run.rule_set_version != null && ` · v${run.rule_set_version}`}</strong></div>
        <div><span>Giới hạn mỗi nhóm / mỗi lần chạy</span><strong>{run.max_group_size ?? (run.max_candidates_per_run != null ? 'Không giới hạn' : '—')} / {run.max_candidates_per_run ?? '—'}</strong></div>
        <div><span>Bắt đầu</span><strong>{runTime(run.started_at)}</strong></div>
        <div><span>Kết thúc</span><strong>{runTime(run.completed_at)}</strong></div>
      </div>
      <details className="dssf-technical">
        <summary>Nguồn cấu hình và mã kỹ thuật</summary>
        <dl className="dssf-facts">
          <div><dt>PlanningRun</dt><dd><code>{run.run_code}</code></dd></div>
          <div><dt>Nguồn</dt><dd>{f1Label(run.source_mode)} · <code>{run.source_mode}</code></dd></div>
          <div><dt>Thời điểm chốt cấu hình</dt><dd>{runTime(run.configuration_captured_at)}</dd></div>
          <div><dt>Ma trận tương thích hàng hóa</dt><dd>{run.cargo_matrix_source ?? missing}{run.cargo_matrix_sheet && ` · ${run.cargo_matrix_sheet}`}</dd></div>
          <div><dt>Trạng thái lần chạy</dt><dd><code>{run.status}{run.matching_outcome && ` · ${run.matching_outcome}`}</code></dd></div>
        </dl>
      </details>
    </>
  )
}
