import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/useAuth'
import { dssErrorMessage, dssService } from '../../services/dss/dssService'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F1Scope } from '../../types/f1'
import './DSSDashboardPage.css'

export interface DSSOutletContext {
  scope: F1Scope
  reloadScope: () => void
}

function ScopedDSSRoute() {
  const scope = useDssQuery(dssService.getScope)

  if (scope.data?.outlet_ids.length) {
    const context: DSSOutletContext = { scope: scope.data, reloadScope: scope.reload }
    return <Outlet context={context} />
  }

  return (
    <main className="dssd-page">
      {scope.loading ? (
        <div className="dssd-loading" role="status">Đang kiểm tra quyền Outlet…</div>
      ) : (
        <div className="dssd-alert dssd-alert-error" role="alert">
          <span>{scope.error ? dssErrorMessage(scope.error) : '403 · Tài khoản chưa được cấp Outlet cho F1.'}</span>
          <button type="button" onClick={scope.reload}>Thử lại</button>
          <Link to="/">Về trang chủ</Link>
        </div>
      )}
    </main>
  )
}

export default function ManagerRoute() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  if (user?.roles.includes('MANAGER')) {
    return <ScopedDSSRoute key={`${user.id}:${pathname}`} />
  }

  return (
    <main className="dssd-page">
      <div className="dssd-alert dssd-alert-error" role="alert">
        <span>403 · Tài khoản chưa có vai trò sử dụng DSS F1.</span>
        <Link to="/">Về trang chủ</Link>
      </div>
    </main>
  )
}
