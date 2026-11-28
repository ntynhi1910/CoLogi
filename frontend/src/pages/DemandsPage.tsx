import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../services/api/client'
import { listDemands } from '../services/api/demands'
import type { DeliveryDemand, DemandStatus } from '../types/demand'
import './DemandsPage.css'
import { CoStatusBadge } from './foundation'
import { hasEffectiveFinalPlan, publicationLabels, receiptLink } from '../types/planPublication'
import { useDssQuery } from '../services/dss/useDssQuery'

const statusLabels: Record<DemandStatus, string> = {
  DRAFT: 'Bản nháp',
  SUBMITTED: 'Đã gửi',
  PLANNING: 'Đang lập kế hoạch',
  PLANNED: 'Đã lên kế hoạch',
  CANCELLED: 'Đã hủy',
}

function formatDate(value: string): string {
  if (!value) return '—'
  const date = new Date(`${value}T00:00:00`)
  return new Intl.DateTimeFormat('vi-VN').format(date)
}

function formatWeight(value: string): string {
  return `${Number(value).toLocaleString('vi-VN', {
    maximumFractionDigits: 3,
  })} kg`
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
    if (error.status === 403) return 'Bạn không có quyền xem danh sách nhu cầu.'
    return error.message
  }
  return error instanceof Error ? error.message : 'Không thể tải danh sách nhu cầu.'
}

function buildPageNumbers(currentPage: number, totalPages: number): (number | '...')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, idx) => idx + 1)
  }
  const pages: (number | '...')[] = [1]
  if (currentPage > 3) pages.push('...')

  const start = Math.max(2, currentPage - 1)
  const end = Math.min(totalPages - 1, currentPage + 1)
  for (let i = start; i <= end; i += 1) {
    pages.push(i)
  }

  if (currentPage < totalPages - 2) pages.push('...')
  pages.push(totalPages)
  return pages
}

const noDemands: DeliveryDemand[] = []

export default function DemandsPage() {
  const result = useDssQuery(listDemands)
  const demands = result.data ?? noDemands
  const isLoading = result.loading
  const error = result.error != null ? getErrorMessage(result.error) : ''
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | DemandStatus>('ALL')
  const [supplierFilter, setSupplierFilter] = useState('ALL')
  const [outletFilter, setOutletFilter] = useState('ALL')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const filteredDemands = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('vi')

    return demands.filter((demand) => {
      const matchesStatus =
        statusFilter === 'ALL' || demand.status === statusFilter

      const matchesSupplier =
        supplierFilter === 'ALL' ||
        String(demand.supplier_id) === supplierFilter

      const matchesOutlet =
        outletFilter === 'ALL' ||
        String(demand.outlet_id) === outletFilter

      const searchable = [
        demand.demand_code,
        demand.supplier_name,
        demand.supplier_code,
        demand.outlet_name,
        demand.outlet_code,
      ]
        .join(' ')
        .toLocaleLowerCase('vi')

      const matchesSearch =
        !keyword || searchable.includes(keyword)

      return (
        matchesStatus &&
        matchesSupplier &&
        matchesOutlet &&
        matchesSearch
      )
    })
  }, [
    demands,
    search,
    statusFilter,
    supplierFilter,
    outletFilter,
  ])

  const totalPages = Math.max(1, Math.ceil(filteredDemands.length / pageSize))
  const safePage = Math.min(currentPage, totalPages)

  const paginatedDemands = useMemo(() => {
    const startIndex = (safePage - 1) * pageSize
    return filteredDemands.slice(startIndex, startIndex + pageSize)
  }, [filteredDemands, safePage, pageSize])

  const pageNumbers = useMemo(
    () => buildPageNumbers(safePage, totalPages),
    [safePage, totalPages]
  )

  const draftCount = demands.filter((demand) => demand.status === 'DRAFT').length
  const plannedCount = demands.filter((row) => hasEffectiveFinalPlan(row.logistics_status)).length

  const startItem = filteredDemands.length === 0 ? 0 : (safePage - 1) * pageSize + 1
  const endItem = Math.min(safePage * pageSize, filteredDemands.length)

  return (
    <div className="demands-page">
      <section className="demands-heading">
        <div>
          <p className="demands-eyebrow">PURCHASING WORKSPACE</p>
          <h1>Quản lý nhu cầu</h1>
          <p className="demands-description">
            Theo dõi và quản lý các yêu cầu giao hàng từ cửa hàng.
          </p>
        </div>
      </section>

      <section className="demand-summary-grid" aria-label="Tổng quan nhu cầu">
        <article className="demand-summary-card demand-kpi--primary">
          <div className="demand-summary-top">
            <span>TỔNG SỐ NHU CẦU</span>
            <em className="demand-summary-pill">Toàn bộ</em>
          </div>
          <strong>{isLoading ? '—' : demands.length}</strong>
          <small>yêu cầu giao hàng đã ghi nhận</small>
        </article>

        <article className="demand-summary-card demand-kpi--amber">
          <div className="demand-summary-top">
            <span>BẢN NHÁP</span>
            <em className="demand-summary-pill">Chờ gửi</em>
          </div>
          <strong>{isLoading ? '—' : draftCount}</strong>
          <small>nhu cầu đang soạn thảo</small>
        </article>

        <article className="demand-summary-card demand-kpi--teal">
          <div className="demand-summary-top">
            <span>ĐÃ LẬP KẾ HOẠCH</span>
            <em className="demand-summary-pill">Chốt phương án</em>
          </div>
          <strong>{isLoading || error ? '—' : plannedCount}</strong>
          <small>đã có kế hoạch vận chuyển</small>
        </article>

        <article className="demand-summary-card demand-kpi--blue">
          <div className="demand-summary-top">
            <span>KẾT QUẢ HIỂN THỊ</span>
            <em className="demand-summary-pill">Theo bộ lọc</em>
          </div>
          <strong>{isLoading ? '—' : filteredDemands.length}</strong>
          <small>trang {safePage}/{totalPages} ({pageSize} dòng/trang)</small>
        </article>
      </section>

      <section className="demand-list-section">
        <div className="demand-list-heading">
          <div>
            <h2>Danh sách nhu cầu</h2>
            <p>Các nhu cầu trong phạm vi dữ liệu bạn được phép truy cập.</p>
          </div>
          <button
            type="button"
            className="demand-refresh-button"
            onClick={result.reload}
            disabled={isLoading}
          >
            ↻ Làm mới
          </button>
        </div>

        <div className="demand-filters">
          <label className="demand-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={search}
              onChange={(event) => { setSearch(event.target.value); setCurrentPage(1) }}
              placeholder="Tìm mã nhu cầu, nhà cung cấp, cửa hàng..."
              aria-label="Tìm kiếm nhu cầu"
            />
          </label>
          <select
            value={statusFilter}
            onChange={(event) =>
              { setStatusFilter(event.target.value as 'ALL' | DemandStatus); setCurrentPage(1) }
            }
            aria-label="Lọc theo trạng thái"
          >
            <option value="ALL">Tất cả trạng thái</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            value={supplierFilter}
            onChange={(event) => { setSupplierFilter(event.target.value); setCurrentPage(1) }}
            aria-label="Lọc theo nhà cung cấp"
          >
            <option value="ALL">Tất cả nhà cung cấp</option>

            {Array.from(
              new Map(
                demands.map((demand) => [
                  demand.supplier_id,
                  demand.supplier_name,
                ])
              ).entries()
            )
              .sort((a, b) => a[1].localeCompare(b[1], 'vi'))
              .map(([id, name]) => (
                <option key={id} value={String(id)}>
                  {name}
                </option>
              ))}
          </select>
          <select
            value={outletFilter}
            onChange={(event) => { setOutletFilter(event.target.value); setCurrentPage(1) }}
            aria-label="Lọc theo cửa hàng"
          >
            <option value="ALL">Tất cả cửa hàng</option>

            {Array.from(
              new Map(
                demands.map((demand) => [
                  demand.outlet_id,
                  demand.outlet_name,
                ])
              ).entries()
            )
              .sort((a, b) => a[1].localeCompare(b[1], 'vi'))
              .map(([id, name]) => (
                <option key={id} value={String(id)}>
                  {name}
                </option>
              ))}
          </select>
        </div>

        {error && (
          <div className="demand-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={result.reload}>
              Thử lại
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="demand-state">Đang tải danh sách nhu cầu...</div>
        ) : !error && filteredDemands.length === 0 ? (
          <div className="demand-state">
            <div className="demand-empty-icon">▤</div>
            <strong>
              {demands.length === 0
                ? 'Chưa có nhu cầu nào'
                : 'Không tìm thấy nhu cầu phù hợp'}
            </strong>
            <p>
              {demands.length === 0
                ? 'Tạo nhu cầu đầu tiên để bắt đầu quy trình mua hàng.'
                : 'Thử thay đổi từ khóa hoặc bộ lọc trạng thái.'}
            </p>
          </div>
        ) : !error ? (
          <>
            <div className="demand-table-wrapper">
              <table className="demand-table">
                <thead>
                  <tr>
                    <th>MÃ NHU CẦU</th>
                    <th>NHÀ CUNG CẤP</th>
                    <th>CỬA HÀNG</th>
                    <th>KHỐI LƯỢNG</th>
                    <th>NGÀY YÊU CẦU</th>
                    <th>TRẠNG THÁI</th>
                    <th>LẬP KẾ HOẠCH LOGISTICS</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedDemands.map((demand) => (
                    <tr key={demand.id}>
                      <td>
                        <Link
                          className="demand-code-link"
                          to={`/demands/${demand.id}`}
                        >
                          {demand.demand_code}
                        </Link>
                      </td>
                      <td>
                        <strong>{demand.supplier_name}</strong>
                        <small>{demand.supplier_code}</small>
                      </td>
                      <td>
                        <strong>{demand.outlet_name}</strong>
                        <small>{demand.outlet_code}</small>
                      </td>
                      <td className="demand-weight">
                        {formatWeight(demand.quantity_kg)}
                      </td>
                      <td>{formatDate(demand.requested_date)}</td>
                      <td><CoStatusBadge status={demand.status} /></td>
                      <td>
                        {hasEffectiveFinalPlan(demand.logistics_status) && <strong>Đã lập kế hoạch</strong>}
                        {demand.logistics_status ? <small>{publicationLabels[demand.logistics_status]}</small> : '—'}
                        {demand.receipt_plan_code && (
                          <Link className="demand-code-link" to={receiptLink(demand.receipt_plan_code, demand.id)}>
                            Mở lịch nhận hàng
                          </Link>
                        )}
                      </td>
                      <td>
                        <Link
                          className="demand-view-link"
                          to={`/demands/${demand.id}`}
                          aria-label={`Xem ${demand.demand_code}`}
                        >
                          Xem →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="demand-pagination" aria-label="Phân trang danh sách nhu cầu">
              <div className="demand-pagination-info">
                <span>
                  Hiển thị <strong>{startItem}–{endItem}</strong> trên tổng số{' '}
                  <strong>{filteredDemands.length}</strong> nhu cầu
                </span>
                <select
                  className="demand-page-size"
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1) }}
                  aria-label="Số dòng mỗi trang"
                >
                  <option value={10}>10 / trang</option>
                  <option value={20}>20 / trang</option>
                  <option value={50}>50 / trang</option>
                </select>
              </div>

              <div className="demand-pagination-controls">
                <button
                  type="button"
                  className="demand-page-btn"
                  disabled={safePage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                >
                  ← Trước
                </button>

                {pageNumbers.map((page, idx) =>
                  page === '...' ? (
                    <span key={`ellipsis-${idx}`} className="demand-page-ellipsis">
                      …
                    </span>
                  ) : (
                    <button
                      key={page}
                      type="button"
                      className={`demand-page-btn ${safePage === page ? 'is-active' : ''}`}
                      aria-current={safePage === page ? 'page' : undefined}
                      onClick={() => setCurrentPage(page)}
                    >
                      {page}
                    </button>
                  )
                )}

                <button
                  type="button"
                  className="demand-page-btn"
                  disabled={safePage >= totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                >
                  Sau →
                </button>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  )
}