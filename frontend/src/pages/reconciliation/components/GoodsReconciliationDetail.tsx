
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './GoodsReconciliationDetail.css'

type Audience =
  | 'manager'
  | 'supplier'
  | 'provider'
  | 'purchasing'

type Entity = {
  id: number
  code: string | null
  name: string | null
}

type GoodsLine = {
  id: number
  code: string
  name: string
  demand_id: number
  demand_code: string
  supplier: Entity
  outlet: Entity
} & Record<string, unknown>

type GoodsIssue = {
  key: string
  demand_id: number
  item_id: number | null
  codes: string[]
  unresolved_kg: number | string | null
  status: string
}

type Props = {
  audience: Audience
  lines: GoodsLine[]
  issues: GoodsIssue[]
}

type Filter = 'all' | 'variance' | 'unreconciled'

const quantityFields = [
  { key: 'planned_kg', label: 'Kế hoạch' },
  { key: 'supplier_handover_kg', label: 'Bàn giao NCC' },
  { key: 'carrier_pickup_kg', label: 'ĐVVC nhận' },
  { key: 'shipped_kg', label: 'Đã xuất' },
  { key: 'hub_received_kg', label: 'Hub nhận' },
  { key: 'hub_dispatched_kg', label: 'Hub xuất' },
  { key: 'delivered_kg', label: 'Đã giao Outlet' },
  { key: 'received_kg', label: 'Đã kiểm nhận' },
  { key: 'shortage_kg', label: 'Thiếu hàng' },
  { key: 'excess_kg', label: 'Thừa hàng' },
  { key: 'damaged_kg', label: 'Hàng hỏng' },
  { key: 'refused_kg', label: 'Từ chối nhận' },
  { key: 'returned_kg', label: 'Hoàn trả' },
  { key: 'unreconciled_kg', label: 'Chưa đối soát' },
] as const

const varianceFields = [
  'shortage_kg',
  'excess_kg',
  'damaged_kg',
  'refused_kg',
  'returned_kg',
  'unreconciled_kg',
] as const

const issueNames: Record<string, string> = {
  SHORTAGE: 'Thiếu hàng',
  SHORT_PICKUP: 'Lấy thiếu',
  SURPLUS: 'Thừa hàng',
  CUSTODY_MISMATCH: 'Lệch bàn giao',
  PICKUP_QUANTITY_MISMATCH: 'Lệch lượng lấy',
  DAMAGED: 'Hàng hỏng',
  WRONG_SKU: 'Sai SKU',
  PICKUP_LATE: 'Lấy hàng trễ',
  DELIVERY_LATE: 'Giao hàng trễ',
}

const issueStatuses: Record<string, string> = {
  OPEN: 'Chờ xử lý',
  EVIDENCE_REQUESTED: 'Chờ bổ sung bằng chứng',
  RESOLVED: 'Đã xử lý',
}

const numberFormatter = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 3,
})

function toNumber(input: unknown): number | null {
  if (
    input === null ||
    input === undefined ||
    input === '' ||
    typeof input === 'boolean'
  ) {
    return null
  }

  if (
    typeof input !== 'number' &&
    typeof input !== 'string'
  ) {
    return null
  }

  const result = Number(input)

  return Number.isFinite(result) ? result : null
}

function formatQuantity(
  input: unknown,
  suffix = ''
): string {
  const value = toNumber(input)

  if (value === null) return '—'

  return numberFormatter.format(value) + suffix
}

function sumAvailable(
  lines: GoodsLine[],
  field: string
): number | null {
  const numbers = lines
    .map(line => toNumber(line[field]))
    .filter(
      (value): value is number => value !== null
    )

  if (numbers.length === 0) return null

  return numbers.reduce(
    (total, current) => total + current,
    0
  )
}

function entityName(entity: Entity | null | undefined) {
  return (
    entity?.name ||
    entity?.code ||
    'Chưa xác định'
  )
}

function hasVariance(line: GoodsLine): boolean {
  return varianceFields.some(
    field => (toNumber(line[field]) ?? 0) > 0
  )
}

function hasUnreconciled(line: GoodsLine): boolean {
  return (
    (toNumber(line.unreconciled_kg) ?? 0) > 0
  )
}

function relatedIssuesFor(
  line: GoodsLine,
  issues: GoodsIssue[]
): GoodsIssue[] {
  return issues.filter(
    issue =>
      issue.demand_id === line.demand_id &&
      (
        issue.item_id === null ||
        issue.item_id === line.id
      )
  )
}

function lineStatus(
  line: GoodsLine,
  issues: GoodsIssue[]
): {
  kind: 'pending' | 'variance' | 'normal' | 'unknown'
  label: string
} {
  const linkedIssues = relatedIssuesFor(line, issues)

  if (hasUnreconciled(line)) {
    return {
      kind: 'pending',
      label: 'Chưa đối soát hết',
    }
  }

  if (
    hasVariance(line) ||
    linkedIssues.some(
      issue => issue.status !== 'RESOLVED'
    )
  ) {
    return {
      kind: 'variance',
      label: 'Có chênh lệch',
    }
  }

  const hasExecutionData = [
    'supplier_handover_kg',
    'carrier_pickup_kg',
    'shipped_kg',
    'delivered_kg',
    'received_kg',
  ].some(field => toNumber(line[field]) !== null)

  if (!hasExecutionData) {
    return {
      kind: 'unknown',
      label: 'Chưa có dữ liệu',
    }
  }

  return {
    kind: 'normal',
    label: 'Không ghi nhận lệch',
  }
}

export default function GoodsReconciliationDetail({
  audience,
  lines,
  issues,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [selectedLineId, setSelectedLineId] =
    useState<number | null>(null)

  const closeButtonRef =
    useRef<HTMLButtonElement | null>(null)

  const selectedLine = useMemo(
    () =>
      lines.find(line => line.id === selectedLineId) ??
      null,
    [lines, selectedLineId]
  )

  const visibleLines = useMemo(() => {
    const term = search
      .trim()
      .toLocaleLowerCase('vi')

    return lines.filter(line => {
      const status = lineStatus(line, issues)

      if (
        filter === 'variance' &&
        status.kind !== 'variance' &&
        status.kind !== 'pending'
      ) {
        return false
      }

      if (
        filter === 'unreconciled' &&
        !hasUnreconciled(line)
      ) {
        return false
      }

      if (!term) return true

      const searchable = [
        line.code,
        line.name,
        line.demand_code,
        line.supplier?.code,
        line.supplier?.name,
        line.outlet?.code,
        line.outlet?.name,
      ]

      return searchable.some(
        value =>
          value &&
          String(value)
            .toLocaleLowerCase('vi')
            .includes(term)
      )
    })
  }, [lines, issues, filter, search])

  const varianceCount = useMemo(
    () =>
      lines.filter(line => {
        const kind = lineStatus(line, issues).kind
        return kind === 'variance' || kind === 'pending'
      }).length,
    [lines, issues]
  )

  const unreconciledCount = useMemo(
    () => lines.filter(hasUnreconciled).length,
    [lines]
  )

  const selectedIssues = useMemo(
    () =>
      selectedLine
        ? relatedIssuesFor(selectedLine, issues)
        : [],
    [selectedLine, issues]
  )

  const selectedStatus = selectedLine
    ? lineStatus(selectedLine, issues)
    : null

  const availableQuantities = selectedLine
    ? quantityFields.filter(
        field => selectedLine[field.key] !== undefined
      )
    : []

  const stats = [
    {
      label: 'Dòng SKU',
      value: formatQuantity(lines.length),
      detail: 'Tổng dòng trong FinalPlan',
    },
    {
      label: 'Đã kiểm nhận',
      value: formatQuantity(
        sumAvailable(lines, 'received_kg'),
        ' kg'
      ),
      detail: 'Khối lượng được ghi nhận',
    },
    {
      label: 'Có chênh lệch',
      value: formatQuantity(varianceCount),
      detail: 'Dòng có lượng lệch hoặc ngoại lệ',
    },
    {
      label: 'Chưa đối soát',
      value: formatQuantity(
        sumAvailable(lines, 'unreconciled_kg'),
        ' kg'
      ),
      detail: `${unreconciledCount} dòng có lượng tồn`,
    },
  ]

  function closeDetail() {
    setSelectedLineId(null)
  }

  function toggleLine(id: number) {
    setSelectedLineId(current =>
      current === id ? null : id
    )
  }

  useEffect(() => {
    if (!selectedLine) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    closeButtonRef.current?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSelectedLineId(null)
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener(
        'keydown',
        onKeyDown
      )
    }
  }, [selectedLine])

  const filters: {
    key: Filter
    label: string
  }[] = [
    { key: 'all', label: 'Tất cả' },
    { key: 'variance', label: 'Có chênh lệch' },
    {
      key: 'unreconciled',
      label: 'Chưa đối soát',
    },
  ]

  return (
    <section
      className={`grd grd--${audience}`}
      aria-label="Đối soát giao nhận theo Demand và SKU"
    >
      <header className="grd-heading">
        <div>
          <h2>
            Đối soát giao nhận theo Demand / SKU
          </h2>

          <p>
            Đối chiếu kế hoạch, bàn giao, vận chuyển
            và kiểm nhận theo từng dòng hàng.
          </p>
        </div>

        <span className="grd-count">
          {lines.length} dòng SKU
        </span>
      </header>

      <div className="grd-kpis">
        {stats.map(stat => (
          <article
            className="grd-kpi"
            key={stat.label}
          >
            <span>{stat.label}</span>

            <strong>{stat.value}</strong>

            <small>{stat.detail}</small>
          </article>
        ))}
      </div>

      <div className="grd-toolbar">
        <div
          className="grd-filter-buttons"
          role="group"
          aria-label="Lọc trạng thái đối soát"
        >
          {filters.map(item => (
            <button
              key={item.key}
              type="button"
              className={
                filter === item.key
                  ? 'is-active'
                  : ''
              }
              aria-pressed={filter === item.key}
              onClick={() => {
                setFilter(item.key)
                closeDetail()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="grd-search">
          <span className="grd-sr-only">
            Tìm kiếm Demand hoặc SKU
          </span>

          <input
            type="search"
            value={search}
            placeholder="Tìm Demand, SKU, Supplier, Outlet..."
            onChange={event => {
              setSearch(event.target.value)
              closeDetail()
            }}
          />
        </label>
      </div>

      <div className="grd-section-heading">
        <div>
          <h3>Bảng đối soát nhanh</h3>

          <p>
            Chọn “Đối chiếu” để xem đầy đủ
            thông tin trong panel riêng.
          </p>
        </div>

        <span className="grd-count">
          {visibleLines.length}/{lines.length} dòng
        </span>
      </div>

      {visibleLines.length === 0 ? (
        <div className="grd-empty">
          Không có dòng SKU phù hợp với bộ lọc.
        </div>
      ) : (
        <div className="grd-table-scroll">
          <table className="grd-table">
            <thead>
              <tr>
                <th scope="col">
                  Demand / SKU
                </th>
                <th scope="col">
                  Supplier → Outlet
                </th>
                <th scope="col">
                  Kế hoạch
                </th>
                <th scope="col">
                  Bàn giao
                </th>
                <th scope="col">
                  Đã giao
                </th>
                <th scope="col">
                  Đã nhận
                </th>
                <th scope="col">
                  Chưa đối soát
                </th>
                <th scope="col">
                  Tình trạng
                </th>
                <th scope="col">
                  Thao tác
                </th>
              </tr>
            </thead>

            <tbody>
              {visibleLines.map(line => {
                const status = lineStatus(line, issues)

                const isSelected =
                  selectedLineId === line.id

                return (
                  <tr
                    key={line.id}
                    className={
                      isSelected
                        ? 'grd-row is-selected'
                        : 'grd-row'
                    }
                  >
                    <td>
                      <div className="grd-identity">
                        <strong>
                          {line.demand_code}
                        </strong>

                        <span>{line.code}</span>

                        <small>{line.name}</small>
                      </div>
                    </td>

                    <td>
                      <div className="grd-parties">
                        <strong>
                          {entityName(line.supplier)}
                        </strong>

                        <span>
                          {entityName(line.outlet)}
                        </span>
                      </div>
                    </td>

                    <td>
                      {formatQuantity(
                        line.planned_kg,
                        ' kg'
                      )}
                    </td>

                    <td>
                      {formatQuantity(
                        line.supplier_handover_kg,
                        ' kg'
                      )}
                    </td>

                    <td>
                      {formatQuantity(
                        line.delivered_kg,
                        ' kg'
                      )}
                    </td>

                    <td>
                      <strong>
                        {formatQuantity(
                          line.received_kg,
                          ' kg'
                        )}
                      </strong>
                    </td>

                    <td>
                      <strong
                        className={
                          status.kind === 'pending'
                            ? 'grd-alert'
                            : undefined
                        }
                      >
                        {formatQuantity(
                          line.unreconciled_kg,
                          ' kg'
                        )}
                      </strong>
                    </td>

                    <td>
                      <span
                        className="grd-status"
                        data-kind={status.kind}
                      >
                        {status.label}
                      </span>
                    </td>

                    <td>
                      <button
                        type="button"
                        className={
                          isSelected
                            ? 'grd-expand is-active'
                            : 'grd-expand'
                        }
                        aria-pressed={isSelected}
                        onClick={() =>
                          toggleLine(line.id)
                        }
                      >
                        {isSelected
                          ? 'Đang xem'
                          : 'Đối chiếu'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedLine && (
        <div
          className="grd-drawer-overlay"
          onMouseDown={event => {
            if (event.target === event.currentTarget) {
              closeDetail()
            }
          }}
        >
          <aside
            className="grd-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="grd-drawer-title"
          >
            <header className="grd-drawer-header">
              <div>
                <span className="grd-drawer-eyebrow">
                  CHI TIẾT ĐỐI SOÁT
                </span>

                <h3 id="grd-drawer-title">
                  {selectedLine.demand_code}
                </h3>

                <p>
                  {selectedLine.code}
                  {' · '}
                  {selectedLine.name}
                </p>
              </div>

              <button
                ref={closeButtonRef}
                type="button"
                className="grd-close"
                onClick={closeDetail}
                aria-label="Đóng chi tiết đối soát"
              >
                ×
              </button>
            </header>

            <div className="grd-drawer-body">
              <div className="grd-drawer-route">
                <div>
                  <small>SUPPLIER</small>

                  <strong>
                    {entityName(
                      selectedLine.supplier
                    )}
                  </strong>
                </div>

                <span aria-hidden="true">
                  →
                </span>

                <div>
                  <small>OUTLET</small>

                  <strong>
                    {entityName(
                      selectedLine.outlet
                    )}
                  </strong>
                </div>
              </div>

              <div className="grd-drawer-status">
                <span
                  className="grd-status"
                  data-kind={selectedStatus?.kind}
                >
                  {selectedStatus?.label}
                </span>
              </div>

              <section className="grd-drawer-section">
                <h4>
                  Số lượng giao nhận
                </h4>

                <div className="grd-quantity-grid">
                  {availableQuantities.map(
                    field => (
                      <div
                        key={field.key}
                        className="grd-quantity-card"
                      >
                        <span>
                          {field.label}
                        </span>

                        <strong>
                          {formatQuantity(
                            selectedLine[field.key],
                            ' kg'
                          )}
                        </strong>
                      </div>
                    )
                  )}
                </div>

                {availableQuantities.length === 0 && (
                  <p className="grd-muted">
                    Chưa có số liệu giao nhận
                    trong bản ghi này.
                  </p>
                )}
              </section>

              <section className="grd-drawer-section">
                <div className="grd-drawer-section-title">
                  <h4>
                    Ngoại lệ và bằng chứng
                  </h4>

                  <span className="grd-count">
                    {selectedIssues.length}
                  </span>
                </div>

                {selectedIssues.length === 0 ? (
                  <p className="grd-muted">
                    Không có ngoại lệ liên quan
                    được trả về trong dữ liệu.
                  </p>
                ) : (
                  <ul className="grd-issue-list">
                    {selectedIssues.map(issue => (
                      <li key={issue.key}>
                        <strong>
                          {issue.codes
                            .map(
                              code =>
                                issueNames[code] ??
                                code
                            )
                            .join(', ') ||
                            'Ngoại lệ giao nhận'}
                        </strong>

                        <span>
                          {issueStatuses[
                            issue.status
                          ] ?? issue.status}
                        </span>

                        <small>
                          Chưa xử lý:{' '}
                          {formatQuantity(
                            issue.unresolved_kg,
                            ' kg'
                          )}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="grd-drawer-note">
                {audience === 'manager'
                  ? 'Các quyết định xử lý chính thức được thực hiện tại khu vực nghiệp vụ đối soát của FinalPlan.'
                  : 'Các thông tin được hiển thị trong phạm vi dữ liệu mà vai trò này có quyền truy cập.'}
              </div>
            </div>

            <footer className="grd-drawer-footer">
              <button
                type="button"
                className="grd-close-action"
                onClick={closeDetail}
              >
                Đóng chi tiết
              </button>
            </footer>
          </aside>
        </div>
      )}
    </section>
  )
}
