import type { F1RunSummary } from '../../types/f1'
import { f1Label } from './f1Display'

const modules = ['Phối hợp nhu cầu', 'Xây dựng phương án', 'Phân bổ phương tiện', 'Kiểm tra thời gian', 'Đánh giá kinh tế']
const downstreamLabels = ['Xem từ nhóm ứng viên', 'Đánh giá từ bản nháp F2', 'Kiểm tra từ kết quả F3 đã lưu', 'Xem trước từ F4 đã lưu']

export default function DSSProgressSteps({ status }: { status: F1RunSummary['status'] }) {
  return (
    <div className="dssr-progress">
      {modules.map((label, index) => (
        <div key={label} className={`dssr-progress-step ${index === 0 ? 'is-active' : ''}`}>
          <span className="dssr-progress-number">F{index + 1}</span>
          <span className="dssr-progress-copy">
            <strong>{label}</strong>
            <small>{index === 0 ? f1Label(status) : downstreamLabels[index - 1]}</small>
          </span>
          <span className="dssr-progress-indicator" aria-hidden="true">
            {index !== 0 ? '–' : status === 'COMPLETED' ? '✓' : status === 'FAILED' ? '!' : '…'}
          </span>
        </div>
      ))}
    </div>
  )
}
