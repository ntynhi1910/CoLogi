
import { lazy, Suspense } from 'react'
import {
  Navigate,
  Outlet,
  Route,
  Routes,
} from 'react-router-dom'

import { useAuth } from './contexts/useAuth'
import AppLayout from './components/layout/AppLayout'

// Common pages
import LoginPage from './pages/LoginPage'
import HomePage from './pages/HomePage'
import ProfilePage from './pages/ProfilePage'

// Purchasing pages
import DemandsPage from './pages/DemandsPage'
import DemandFormPage from './pages/DemandFormPage'
import DemandDetailPage from './pages/DemandDetailPage'

// Supplier pages
import SupplierInboxPage from './pages/SupplierInboxPage'
import SupplierRequestDetailPage from './pages/SupplierRequestDetailPage'
import SupplierCatalogPage from './pages/SupplierCatalogPage'

// Transport provider pages
import VehicleOffersPage from './pages/VehicleOffersPage'
import ProviderAvailabilityPage from './pages/ProviderAvailabilityPage'
import ProviderCapabilityPage from './pages/ProviderCapabilityPage'

// DSS pages - CP8
import DSSDashboardPage from './pages/dss/DSSDashboardPage'
import DSSScenarioPage from './pages/dss/DSSScenarioPage'
import DSSRunDetailPage from './pages/dss/DSSRunDetailPage'
import DSSOptionDetailPage from './pages/dss/DSSOptionDetailPage'
import ManagerRoute from './pages/dss/ManagerRoute'
import OperationalSourcesPage from './pages/dss/OperationalSourcesPage'

const DSSF2OptionsPage = lazy(() => import('./pages/dss/DSSF2OptionsPage'))
const DSSF3Page = lazy(() => import('./pages/dss/DSSF3Page'))
const DSSF4Page = lazy(() => import('./pages/dss/DSSF4Page'))
const DSSF5Page = lazy(() => import('./pages/dss/DSSF5Page'))
const DecisionIndexPage = lazy(() => import('./pages/dss/PlanDeliveryPage').then(module => ({ default: module.DecisionIndexPage })))
const DecisionHistoryPage = lazy(() => import('./pages/dss/PlanDeliveryPage').then(module => ({ default: module.DecisionHistoryPage })))
const FinalPlanIndexPage = lazy(() => import('./pages/dss/PlanDeliveryPage').then(module => ({ default: module.FinalPlanIndexPage })))
const AccountWorkspacePage = lazy(() => import('./pages/dss/AccountWorkspacePage'))
const OutletWorkspacePage = lazy(() => import('./pages/OutletWorkspacePage'))
const PlanPublicationPage = lazy(() => import('./pages/PlanPublicationPage'))
const InventoryWorkspace = lazy(() => import('./pages/ExecutionWorkspace').then(module => ({ default: module.InventoryWorkspace })))
const ExecutionWorkspace = lazy(() => import('./pages/ExecutionWorkspace').then(module => ({ default: module.ExecutionWorkspace })))
const ReconciliationWorkspace = lazy(() => import('./pages/ReconciliationWorkspace'))
const DecisionPage = lazy(() => import('./pages/dss/PlanDeliveryPage').then(module => ({ default: module.DecisionPage })))
const FinalPlanPage = lazy(() => import('./pages/dss/PlanDeliveryPage').then(module => ({ default: module.FinalPlanPage })))
const ProviderHandoversPage = lazy(() => import('./pages/dss/PlanDeliveryPage').then(module => ({ default: module.ProviderHandoversPage })))
/* =========================================
   AUTHENTICATION
========================================= */

function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <main className="loading-page">
        Đang kiểm tra phiên đăng nhập...
      </main>
    )
  }

  return isAuthenticated
    ? <Outlet />
    : <Navigate to="/login" replace />
}

/* =========================================
   ROLE GUARDS
========================================= */

function PurchasingRoute() {
  const { user } = useAuth()

  return user?.roles.some(
    (role) =>
      role === 'PURCHASING_STAFF' ||
      role === 'MANAGER'
  )
    ? <Outlet />
    : <Navigate to="/" replace />
}

function OutletWorkspaceRoute() {
  const { user } = useAuth()
  return user?.roles.includes('PURCHASING_STAFF') && !user.capstone_scenario
    ? <Outlet /> : <Navigate to="/" replace />
}

function PurchasingScheduleRoute() {
  const { user } = useAuth()
  return user?.roles.includes('PURCHASING_STAFF') ? <Outlet /> : <Navigate to="/" replace />
}

function SupplierRoute() {
  const { user } = useAuth()

  return user?.roles.includes('SUPPLIER')
    ? <Outlet />
    : <Navigate to="/" replace />
}

function ProviderRoute() {
  const { user } = useAuth()

  return user?.roles.includes('TRANSPORT_PROVIDER')
    ? <Outlet />
    : <Navigate to="/" replace />
}

/* =========================================
   APP ROUTES
========================================= */

export default function App() {
  return (
    <Routes>
      {/* PUBLIC */}
      <Route
        path="/login"
        element={<LoginPage />}
      />

      {/* AUTHENTICATED */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          {/* COMMON */}
          <Route
            path="/"
            element={<HomePage />}
          />

          <Route
            path="/profile"
            element={<ProfilePage />}
          />

          {/* PURCHASING + MANAGER */}
          <Route element={<OutletWorkspaceRoute />}>
            <Route path="/purchasing/outlets" element={<Suspense fallback={<p>Đang tải điểm giao nhận…</p>}><OutletWorkspacePage /></Suspense>} />
          </Route>
          <Route element={<PurchasingScheduleRoute />}>
            <Route path="/purchasing/receipts/:code?" element={<Suspense fallback={<p>Đang tải lịch nhận…</p>}><PlanPublicationPage audience="purchasing" /></Suspense>} />
            <Route path="/purchasing/reconciliation/:code?" element={<Suspense fallback={<p>Đang tải đối soát…</p>}><ReconciliationWorkspace audience="purchasing" /></Suspense>} />
          </Route>
          <Route element={<PurchasingRoute />}>
            <Route
              path="/demands"
              element={<DemandsPage />}
            />

            <Route
              path="/demands/new"
              element={<DemandFormPage />}
            />

            <Route
              path="/demands/:id/edit"
              element={<DemandFormPage />}
            />

            <Route
              path="/demands/:id"
              element={<DemandDetailPage />}
            />
          </Route>

          {/* SUPPLIER */}
          <Route element={<SupplierRoute />}>
            <Route path="/supplier/reconciliation/:code?" element={<Suspense fallback={<p>Đang tải đối soát…</p>}><ReconciliationWorkspace audience="supplier" /></Suspense>} />
            <Route path="/supplier/inventory" element={<Suspense fallback={<p>Đang tải tồn kho…</p>}><InventoryWorkspace /></Suspense>} />
            <Route path="/supplier/shipments/:code?" element={<Suspense fallback={<p>Đang tải lịch xuất…</p>}><PlanPublicationPage audience="supplier" /></Suspense>} />
            <Route
              path="/supplier/requests"
              element={<SupplierInboxPage />}
            />

            <Route
              path="/supplier/requests/:id"
              element={<SupplierRequestDetailPage />}
            />

            <Route
              path="/supplier/items"
              element={<SupplierCatalogPage />}
            />
          </Route>

          {/* TRANSPORT PROVIDER */}
          <Route element={<ProviderRoute />}>
            <Route path="/provider/trips/:code?" element={<Suspense fallback={<p>Đang tải chuyến…</p>}><ExecutionWorkspace audience="provider" /></Suspense>} />
            <Route path="/provider/reconciliation/:code?" element={<Suspense fallback={<p>Đang tải đối soát…</p>}><ReconciliationWorkspace audience="provider" /></Suspense>} />
            <Route path="/provider/handovers" element={<Suspense fallback={<p>Đang tải bàn giao…</p>}><ProviderHandoversPage /></Suspense>} />
            <Route path="/provider/handovers/:code" element={<Suspense fallback={<p>Đang tải kế hoạch…</p>}><FinalPlanPage provider /></Suspense>} />
            <Route path="/provider/dss-sources" element={<OperationalSourcesPage />} />
            <Route
              path="/provider/capability"
              element={<ProviderCapabilityPage />}
            />

            <Route
              path="/provider/vehicle-offers"
              element={<VehicleOffersPage />}
            />

            <Route
              path="/provider/availability"
              element={<ProviderAvailabilityPage />}
            />
          </Route>

          <Route element={<ManagerRoute />}>
            <Route path="/dss/execution/:code?" element={<Suspense fallback={<p>Đang tải tiến độ…</p>}><ExecutionWorkspace audience="manager" /></Suspense>} />
            <Route path="/dss/reconciliation/:code?" element={<Suspense fallback={<p>Đang tải đối soát…</p>}><ReconciliationWorkspace audience="manager" /></Suspense>} />
            <Route path="/dss/decisions" element={<Suspense fallback={<p>Đang tải quyết định…</p>}><DecisionIndexPage /></Suspense>} />
            <Route path="/dss/decision-history" element={<Suspense fallback={<p>Đang tải lịch sử…</p>}><DecisionHistoryPage /></Suspense>} />
            <Route path="/dss/final-plans" element={<Suspense fallback={<p>Đang tải kế hoạch…</p>}><FinalPlanIndexPage /></Suspense>} />
            <Route path="/dss/accounts" element={<Suspense fallback={<p>Đang tải tài khoản…</p>}><AccountWorkspacePage /></Suspense>} />
            <Route path="/dss/decisions/:runId/:optionId" element={<Suspense fallback={<p>Đang tải phương án…</p>}><DecisionPage /></Suspense>} />
            <Route path="/dss/final-plans/:code" element={<Suspense fallback={<p>Đang tải kế hoạch…</p>}><FinalPlanPage /></Suspense>} />
            <Route path="/dss/data" element={<OperationalSourcesPage />} />
            <Route
              path="/dss"
              element={<DSSDashboardPage />}
            />

            <Route
              path="/dss/scenarios/new"
              element={<DSSScenarioPage />}
            />

            <Route
              path="/dss/scenarios/:scenarioId"
              element={<DSSScenarioPage />}
            />

            <Route
              path="/dss/runs/:runId"
              element={<DSSRunDetailPage />}
            />
            <Route
              path="/dss/runs/:runId/options/:optionId"
              element={<DSSOptionDetailPage />}
            />
            <Route
              path="/dss/runs/:runId/options/:optionId/f2"
              element={
                <Suspense fallback={<div className="dssr-loading" role="status">Đang tải phương án F2…</div>}>
                  <DSSF2OptionsPage />
                </Suspense>
              }
            />
            <Route
              path="/dss/runs/:runId/options/:optionId/f3/:planCode?"
              element={
                <Suspense fallback={<div className="dssr-loading" role="status">Đang tải phân bổ phương tiện…</div>}>
                  <DSSF3Page />
                </Suspense>
              }
            />
            <Route
              path="/dss/runs/:runId/options/:optionId/f4/:evaluationCode?"
              element={
                <Suspense fallback={<div className="dssr-loading" role="status">Đang tải kiểm tra thời gian…</div>}>
                  <DSSF4Page />
                </Suspense>
              }
            />
            <Route
              path="/dss/runs/:runId/options/:optionId/f5/:evaluationCode"
              element={
                <Suspense fallback={<div className="dssr-loading" role="status">Đang tải đánh giá kinh tế…</div>}>
                  <DSSF5Page />
                </Suspense>
              }
            />
          </Route>
        </Route>
        {/* Đóng AppLayout */}

      </Route>
      {/* Đóng ProtectedRoute */}

      {/* FALLBACK */}
      <Route
        path="*"
        element={<Navigate to="/" replace />}
      />
    </Routes>
  )
}
