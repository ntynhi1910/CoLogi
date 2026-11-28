
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/useAuth'
import { apiRequest } from '../../services/api/client'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { BusinessRole } from '../../types/auth'
import './AppLayout.css'
type MenuIcon =
  | 'home' | 'clipboard' | 'plus' | 'box' | 'truck'
  | 'calendar' | 'layers' | 'shield' | 'user' | 'menu'
  | 'chevron' | 'check' | 'route' | 'chart' | 'clock'
  | 'users' | 'pin' | 'play'

const iconArt: Record<MenuIcon, ReactNode> = {
  home: <>
    <path d="m3 10 9-7 9 7v10H3z" />
    <path d="M9 20v-7h6v7" />
  </>,
  clipboard: <>
    <rect x="5" y="5" width="14" height="17" rx="2" />
    <path d="M9 5V3h6v2M9 12h6m-6 4h6" />
  </>,
  plus: <path d="M12 4v16M4 12h16" />,
  box: <>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="M3 8v8l9 5 9-5V8M12 13v8" />
  </>,
  truck: <>
    <path d="M3 6h11v11H3zM14 10h4l3 4v3h-7" />
    <circle cx="7" cy="18" r="2" />
    <circle cx="18" cy="18" r="2" />
  </>,
  calendar: <>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M7 3v4M17 3v4M3 10h18" />
  </>,
  layers: <>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
  </>,
  shield: <>
    <path d="m12 2 9 4v6c0 5-3.6 8-9 10-5.4-2-9-5-9-10V6z" />
    <path d="m8 12 3 3 5-5" />
  </>,
  user: <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
  </>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  check: <path d="m4 12 5 5L20 6" />,
  route: <>
    <circle cx="5" cy="5" r="2" />
    <circle cx="19" cy="19" r="2" />
    <path d="M7 5h9a4 4 0 0 1 0 8H8a4 4 0 0 0 0 6h9" />
  </>,
  chart: <>
    <path d="M3 3v18h18" />
    <path d="m7 16 4-5 4 2 5-7" />
  </>,
  clock: <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
  users: <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c0-3.6 2.9-5.5 6.5-5.5s6.5 1.9 6.5 5.5" />
    <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2.2.6 3.5 2.3 3.5 5.2" />
  </>,
  pin: <>
    <path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </>,
  play: <>
    <circle cx="12" cy="12" r="9" />
    <path d="m10 8.5 5 3.5-5 3.5z" />
  </>,
}

function SideIcon({
  name,
  size = 19,
}: {
  name: MenuIcon
  size?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconArt[name]}
    </svg>
  )
}

const roleLabels: Record<BusinessRole, string> = {
  MANAGER: 'Quản lý',
  PURCHASING_STAFF: 'Nhân viên mua hàng',
  SUPPLIER: 'Nhà cung cấp',
  TRANSPORT_PROVIDER: 'Đơn vị vận chuyển',
}

type MenuLink = {
  path: string
  label: string
  /** Shown as a tooltip; the sidebar keeps one line per item */
  hint: string
  icon: MenuIcon
  /** Exact match only (NavLink `end`) */
  exact?: boolean
  /** Custom active check for links that own a whole route family */
  isActive?: (pathname: string, search: string) => boolean
  /** Renders the DSS run progress under this link */
  withRunProgress?: boolean
}

type MenuSection = {
  heading: string
  links: MenuLink[]
}

/* Năm chức năng DSS theo báo cáo */
const dssSteps = [
  { code: 'F1', label: 'Phối hợp nhu cầu' },
  { code: 'F2', label: 'Xây dựng phương án' },
  { code: 'F3', label: 'Phân bổ phương tiện' },
  { code: 'F4', label: 'Kiểm tra thời gian' },
  { code: 'F5', label: 'Đánh giá kinh tế' },
] as const

type DssStepCode = (typeof dssSteps)[number]['code']

/* Where each step lives for the run/option currently open. F5 needs an
   evaluation code that only F4 knows, so it is never a direct link. */
function stepHref(code: DssStepCode, runId?: string, optionId?: string) {
  if (!runId) return undefined
  if (code === 'F1') return `/dss/runs/${runId}`
  if (!optionId || code === 'F5') return undefined
  return `/dss/runs/${runId}/options/${optionId}/${code.toLowerCase()}`
}

function performanceLink(roles: BusinessRole[]): MenuLink {
  const root = roles.includes('MANAGER') ? '/dss/reconciliation'
    : roles.includes('TRANSPORT_PROVIDER') ? '/provider/reconciliation'
      : roles.includes('PURCHASING_STAFF') ? '/purchasing/reconciliation' : '/supplier/reconciliation'
  const label = roles.includes('MANAGER') ? 'Hiệu suất logistics'
    : roles.includes('TRANSPORT_PROVIDER') ? 'Hiệu suất vận chuyển'
      : roles.includes('SUPPLIER') ? 'Hiệu suất cung ứng' : 'Hiệu suất giao nhận'
  return {
    path: `${root}?tab=performance`,
    label,
    hint: 'KPI, đối soát và chi phí thực tế',
    icon: 'chart',
    isActive: (pathname, search) => pathname === root
      && (new URLSearchParams(search).get('tab') ?? 'performance') === 'performance',
  }
}

/* Điều hướng theo quyền và route đang có, xếp theo luồng công việc */
function buildSections(
  roles: BusinessRole[],
  isCapstone: boolean,
  executionEnabled: boolean,
  reconciliationEnabled: boolean,
): MenuSection[] {
  const isManager = roles.includes('MANAGER')
  const isStaff = roles.includes('PURCHASING_STAFF')
  const isSupplier = roles.includes('SUPPLIER')
  const isTransport = roles.includes('TRANSPORT_PROVIDER')

  const sections: MenuSection[] = [{
    heading: 'Tổng quan',
    links: [{ path: '/', label: 'Bảng điều khiển', hint: 'Tổng quan vận hành', icon: 'home', exact: true }],
  }]

  if (isManager || isStaff) {
    sections.push({
      heading: 'Nhu cầu',
      links: [
        {
          path: '/demands',
          label: 'Danh sách nhu cầu',
          hint: isManager ? 'Giám sát, chỉ xem' : 'Theo dõi và quản lý nhu cầu',
          icon: 'clipboard',
          exact: true,
        },
        ...(isStaff && !isCapstone ? [{
          path: '/purchasing/outlets', label: 'Điểm giao nhận', hint: 'Địa chỉ và lịch nhận hàng', icon: 'pin' as const,
        }] : []),
        ...(isStaff ? [{
          path: '/purchasing/receipts', label: 'Lịch nhận hàng', hint: 'Kế hoạch giao theo Outlet', icon: 'calendar' as const,
        }] : []),
      ],
    })
  }

  if (isSupplier) {
    sections.push({
      heading: 'Cung ứng',
      links: [
        { path: '/supplier/requests', label: 'Yêu cầu cung ứng', hint: 'Xác nhận hàng và giờ lấy', icon: 'layers' },
        { path: '/supplier/items', label: 'Danh mục mặt hàng', hint: 'Thông tin hàng cung ứng', icon: 'box' },
        { path: '/supplier/shipments', label: 'Lịch xuất hàng', hint: 'Kế hoạch lấy hàng đã công bố', icon: 'calendar' },
        ...(executionEnabled ? [{
          path: '/supplier/inventory', label: 'Tồn kho', hint: 'Tồn thực tế và giữ chỗ', icon: 'box' as const,
        }] : []),
      ],
    })
  }

  if (isTransport) {
    sections.push({
      heading: 'Năng lực vận chuyển',
      links: [
        { path: '/provider/capability', label: 'Tổng quan năng lực', hint: 'Phương tiện và phạm vi phục vụ', icon: 'truck' },
        { path: '/provider/vehicle-offers', label: 'Xe và báo giá', hint: 'Số lượng, loại xe và chi phí', icon: 'box' },
        { path: '/provider/availability', label: 'Lịch khả dụng', hint: 'Ngày, giờ và năng lực xe', icon: 'calendar' },
      ],
    }, {
      heading: 'Chuyến hàng',
      links: [
        { path: '/provider/handovers', label: 'Xác nhận chuyến', hint: 'Bàn giao và phản hồi kế hoạch', icon: 'check' },
        ...(executionEnabled ? [{
          path: '/provider/trips', label: 'Điều phối chuyến', hint: 'Điểm dừng và giao nhận', icon: 'truck' as const,
        }] : []),
      ],
    })
  }

  if (isManager) {
    sections.push({
      heading: 'Lập kế hoạch',
      links: [{
        path: '/dss',
        label: 'Lập kế hoạch F1–F5',
        hint: 'Chạy F1, xem phương án và lịch sử kết quả',
        icon: 'play',
        withRunProgress: true,
        isActive: (pathname) => pathname === '/dss' || /^\/dss\/(runs|scenarios)\//.test(pathname),
      }],
    }, {
      heading: 'Quyết định',
      links: [
        { path: '/dss/decisions', label: 'Phê duyệt phương án', hint: 'Xem và ghi quyết định', icon: 'shield' },
        { path: '/dss/final-plans', label: 'Kế hoạch cuối cùng', hint: 'Phiên bản và bàn giao', icon: 'route' },
        { path: '/dss/decision-history', label: 'Lịch sử quyết định', hint: 'Nhật ký và so sánh phiên bản', icon: 'clock' },
      ],
    })
  }

  const followUp: MenuLink[] = [
    ...(isManager && executionEnabled ? [{
      path: '/dss/execution', label: 'Theo dõi thực hiện', hint: 'Kế hoạch và giao nhận thực tế', icon: 'truck' as const,
    }] : []),
    ...(reconciliationEnabled ? [performanceLink(roles)] : []),
  ]
  if (followUp.length) sections.push({ heading: 'Thực hiện & đối soát', links: followUp })

  if (isManager && !isCapstone) {
    sections.push({
      heading: 'Quản trị',
      links: [{ path: '/dss/accounts', label: 'Tài khoản & phân quyền', hint: 'Vai trò và phạm vi truy cập', icon: 'users' }],
    })
  }

  return sections
}

function initials(name: string) {
  // Only words that start with a letter: "Demo STAFF #2" -> "DS", not "D#"
  const words = name.trim().split(/\s+/).filter((word) => /^\p{L}/u.test(word))
  if (!words.length) return '?'
  const first = [...words[0]][0] ?? ''
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : ''
  return (first + last).toUpperCase()
}

export default function AppLayout() {
  const { pathname, search } = useLocation()
  const runMatch = pathname.match(/^\/dss\/runs\/([^/]+)(?:\/options\/([^/]+))?/)
  const runId = runMatch?.[1]
  const optionId = runMatch?.[2]
  const optionStage = pathname.match(/^\/dss\/runs\/[^/]+\/options\/[^/]+\/(f[2-5])(?:\/|$)/)?.[1]
  const isF1 = /^\/dss\/(?:runs\/[^/]+(?:\/options\/[^/]+)?|scenarios\/[^/]+)\/?$/.test(pathname)
  const currentStep = optionStage?.toUpperCase() ?? (isF1 ? 'F1' : undefined)
  const { user, signOut, error } = useAuth()

  const [mobileOpen, setMobileOpen] = useState(false)
  const { data: execution } = useDssQuery(useCallback(() => user
    ? apiRequest<{ enabled: boolean }>('/planning/execution/availability/')
    : Promise.resolve({ enabled: false }), [user]))
  const { data: reconciliation } = useDssQuery(useCallback(() => user && execution?.enabled
    ? apiRequest<{ enabled: boolean }>('/planning/reconciliation/availability/')
    : Promise.resolve({ enabled: false }), [user, execution?.enabled]))

  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  if (!user) return null

  const isPurchasing = user.roles.includes('PURCHASING_STAFF')
  const isManager = user.roles.includes('MANAGER')
  const executionEnabled = execution?.enabled === true
  const sections = buildSections(
    user.roles, Boolean(user.capstone_scenario), executionEnabled, reconciliation?.enabled === true,
  )

  const roleName = user.roles.length
    ? user.roles
        .map((role) => roleLabels[role])
        .join(' · ')
    : 'Chưa được gán vai trò'

  const close = () => setMobileOpen(false)

  async function handleSignOut() {
    try {
      await signOut()
    } catch {
      // AuthContext chịu trách nhiệm xử lý lỗi đăng xuất.
    }
  }

  function renderRunProgress() {
    if (!currentStep) return null
    const current = dssSteps.find((step) => step.code === currentStep)
    return (
      <div className="sidebar-run">
        <ol className="sidebar-run-steps" aria-label="Tiến trình lần chạy">
          {dssSteps.map((step) => {
            const href = stepHref(step.code, runId, optionId)
            const isCurrent = step.code === currentStep
            return (
              <li key={step.code}>
                {href && !isCurrent ? (
                  <Link to={href} className="sidebar-run-step" title={step.label} onClick={close}>
                    {step.code}
                  </Link>
                ) : (
                  <span
                    className={`sidebar-run-step${isCurrent ? ' is-current' : ' is-locked'}`}
                    title={step.label}
                    aria-current={isCurrent ? 'step' : undefined}
                  >
                    {step.code}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
        {current && <p className="sidebar-run-label">{current.code} · {current.label}</p>}
      </div>
    )
  }

  return (
    <div className="app-layout">

      {mobileOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Đóng menu"
          onClick={close}
        />
      )}

      {/* SIDEBAR */}
      <aside
        className={
          `app-sidebar${mobileOpen ? ' app-sidebar--open' : ''}`
        }
      >

        {/* BRAND */}
        <NavLink
          to="/"
          className="sidebar-brand"
          aria-label="CoLogi - Trang chủ"
          onClick={close}
        >
          <span className="sidebar-brand-mark">
            <img src="/images/logo.png" alt="" />
          </span>

          <span className="sidebar-brand-copy">
            <strong>
              CoLogi<span>.</span>
            </strong>
            <small>{isManager ? 'Quản lý điều phối' : roleName}</small>
          </span>
        </NavLink>

        {isPurchasing && !isManager && (
          <NavLink to="/demands/new" className="sidebar-cta" onClick={close}>
            <SideIcon name="plus" size={18} />
            Tạo nhu cầu mới
          </NavLink>
        )}

        {/* MENU CÓ THỂ CUỘN */}
        <div className="sidebar-scroll">
          <nav className="sidebar-nav" aria-label="Điều hướng chính">
            {sections.map((section) => (
              <section className="sidebar-section" key={section.heading}>
                <p className="sidebar-section-label">{section.heading}</p>

                {section.links.map((item) => {
                  const active = item.isActive?.(pathname, search)
                  const content = (
                    <>
                      <span className="sidebar-link-icon">
                        <SideIcon name={item.icon} />
                      </span>
                      <span className="sidebar-link-label">{item.label}</span>
                    </>
                  )
                  return (
                    <div key={item.path}>
                      {item.isActive ? (
                        <Link
                          to={item.path}
                          title={item.hint}
                          onClick={close}
                          aria-current={active ? 'page' : undefined}
                          className={`sidebar-link${active ? ' active' : ''}`}
                        >
                          {content}
                        </Link>
                      ) : (
                        <NavLink
                          to={item.path}
                          end={item.exact}
                          title={item.hint}
                          onClick={close}
                          className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                        >
                          {content}
                        </NavLink>
                      )}
                      {item.withRunProgress && renderRunProgress()}
                    </div>
                  )
                })}
              </section>
            ))}
          </nav>
        </div>

        {/* HỒ SƠ */}
        <div className="sidebar-footer">
          <NavLink
            to="/profile"
            onClick={close}
            title="Hồ sơ cá nhân"
            className={({ isActive }) => `sidebar-profile${isActive ? ' active' : ''}`}
          >
            <span className="sidebar-avatar" aria-hidden="true">{initials(user.full_name)}</span>
            <span className="sidebar-profile-copy">
              <strong>{user.full_name}</strong>
              <small>{roleName}</small>
            </span>
          </NavLink>
        </div>

      </aside>
      {/* MAIN LAYOUT */}
      <div className="app-main">
        <header className="app-header">
          <div className="app-header-left">
            <button
              type="button"
              className="sidebar-mobile-button"
              aria-label="Mở thanh điều hướng"
              onClick={() => setMobileOpen(true)}
            >
              <SideIcon name="menu" size={22} />
            </button>

            <div>
              <span className="header-label">
                COLOGI WORKSPACE
              </span>

              <span className="header-page-title">
                Quản lý vận hành
              </span>
            </div>
          </div>

          <div className="header-account">
            <div className="header-account-info">
              <strong>{user.full_name}</strong>
              <span>{roleName}</span>
              {user.capstone_scenario && <span>SYNTHETIC/CAPSTONE · {user.capstone_scenario}</span>}
            </div>

            <button
              type="button"
              className="header-logout-button"
              onClick={() => void handleSignOut()}
            >
              Đăng xuất
            </button>
          </div>
        </header>

        {error && (
          <div className="layout-error" role="alert">
            {error}
          </div>
        )}

        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
