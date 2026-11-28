
import { Link } from 'react-router-dom'
import './ProviderReconciliationPage.css'

export default function ProviderReconciliationPage() {
  return (
    <main className="provider-reconciliation">
      <header className="provider-reconciliation-header">
        <div>
          <span className="provider-reconciliation-eyebrow">
            COLOGI · TRANSPORT PROVIDER
          </span>

          <h1>Lịch sử vận chuyển & Đối soát</h1>

          <p>
            Theo dõi kết quả vận chuyển, tiến độ giao nhận,
            chi phí thực hiện và các vấn đề cần xử lý.
          </p>
        </div>

        <Link
          to="/provider"
          className="provider-reconciliation-back"
        >
          ← Trang tổng quan
        </Link>
      </header>

      <section className="provider-reconciliation-panel">
        <h2>Không gian đối soát vận chuyển</h2>

        <p>
          Đây là khu vực giao diện riêng dành cho
          Đơn vị vận chuyển.
        </p>

        <p>
          Các chức năng hiệu suất vận chuyển, đối soát
          giao nhận, chi phí và báo cáo sẽ được chuyển
          từ ReconciliationWorkspaceLegacy sang đây.
        </p>
      </section>
    </main>
  )
}
