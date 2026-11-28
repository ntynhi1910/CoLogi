
import { Link } from 'react-router-dom'
import './ManagerReconciliationPage.css'

export default function ManagerReconciliationPage() {
  return (
    <main className="manager-reconciliation">
      <header className="manager-reconciliation-header">
        <div>
          <span>COLOGI · LOGISTICS CONTROL CENTER</span>

          <h1>Hiệu suất & Đối soát logistics</h1>

          <p>
            Theo dõi hiệu suất vận hành, kết quả giao nhận,
            chi phí và những vấn đề cần xử lý.
          </p>
        </div>

        <Link to="/dss">
          Quay lại quản lý DSS
        </Link>
      </header>

      <section className="manager-reconciliation-panel">
        <h2>Không gian quản lý logistics</h2>
        <p>
          Giao diện Manager sẽ được chuyển từ
          ReconciliationWorkspaceLegacy sang đây.
        </p>
      </section>
    </main>
  )
}
