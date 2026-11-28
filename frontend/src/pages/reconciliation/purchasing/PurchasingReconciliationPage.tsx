
import { Link } from 'react-router-dom'
import './PurchasingReconciliationPage.css'

export default function PurchasingReconciliationPage() {
  return (
    <main className="purchasing-reconciliation">
      <header className="purchasing-reconciliation-header">
        <div>
          <span className="purchasing-reconciliation-eyebrow">
            COLOGI · PURCHASING
          </span>

          <h1>Lịch sử giao nhận & Đối soát</h1>

          <p>
            Theo dõi kết quả nhận hàng, kiểm nhận
            theo SKU và những chênh lệch cần xử lý.
          </p>
        </div>

        <Link
          to="/purchasing"
          className="purchasing-reconciliation-back"
        >
          ← Trang tổng quan
        </Link>
      </header>

      <section className="purchasing-reconciliation-panel">
        <h2>Không gian đối soát nhận hàng</h2>

        <p>
          Đây là khu vực giao diện riêng dành cho
          Nhân viên mua hàng.
        </p>

        <p>
          Các chức năng theo dõi hiệu suất,
          đối soát giao nhận và báo cáo sẽ được chuyển
          từ ReconciliationWorkspaceLegacy sang đây.
        </p>
      </section>
    </main>
  )
}
