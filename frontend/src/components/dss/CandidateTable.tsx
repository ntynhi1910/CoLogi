
import { useState } from 'react'
import type {
  F1CandidateGroup,
  F1CandidateWindow,
  F1DisplayLabels,
} from '../../types/f1'
import {
  candidateFacts,
  commonDuration,
  deliveryDate,
  deliveryWarning,
  demandCode,
  groupIds,
  groupLabel,
  missing,
  timeWindow,
  weight,
} from './f1Display'
import type { DemandResult } from './f1Display'

const PAGE_SIZE = 10

export default function CandidateTable({
  groups,
  results,
  labels,
  at,
  openGroup,
}: {
  groups: (F1CandidateWindow | F1CandidateGroup)[]
  results: DemandResult[]
  labels?: F1DisplayLabels
  at?: string
  openGroup?: (code: string) => void
}) {
  const [search, setSearch] = useState('')
  const [dateFilter, setDateFilter] = useState('all')
  const [sort, setSort] = useState('default')
  const [page, setPage] = useState(1)

  const memberships = groups.flatMap(groupIds)

  const byId = new Map(
    results.map(item => [item.demand_id, item])
  )

  const rows = groups.map((group, index) => {
    const facts = candidateFacts(group, byId, labels)

    const code =
      'group_code' in group ? group.group_code : null

    return {
      ...facts,
      code,
      index,
      name: groupLabel(index),
      warning: deliveryWarning(
        facts.window?.requested_date,
        at
      ),
    }
  })

  const keyword = search.trim().toLowerCase()

  const filtered = rows.filter(row => {
    const text = [
      row.name,
      row.code,
      row.window?.requested_date,
      deliveryDate(row.window?.requested_date),
      ...row.categoryCodes,
      ...row.outletNames,
      ...row.members.map(demandCode),
    ].join(' ').toLowerCase()

    const matchesSearch = text.includes(keyword)

    const matchesDate =
      dateFilter === 'all' ||
      (dateFilter === 'expired'
        ? Boolean(row.warning)
        : !row.warning && Boolean(row.window?.requested_date))

    return matchesSearch && matchesDate
  })

  if (sort === 'weight') {
    filtered.sort(
      (a, b) =>
        Number(b.totalKg ?? 0) -
        Number(a.totalKg ?? 0)
    )
  }

  if (sort === 'count') {
    filtered.sort(
      (a, b) => b.ids.length - a.ids.length
    )
  }

  if (sort === 'date') {
    filtered.sort((a, b) =>
      String(a.window?.requested_date ?? '9999-12-31')
        .localeCompare(
          String(b.window?.requested_date ?? '9999-12-31')
        )
    )
  }

  const totalPages = Math.max(
    1,
    Math.ceil(filtered.length / PAGE_SIZE)
  )

  const currentPage = Math.min(page, totalPages)

  const startIndex = (currentPage - 1) * PAGE_SIZE

  const visible = filtered.slice(
    startIndex,
    startIndex + PAGE_SIZE
  )

  if (!groups.length) {
    return (
      <div className="dssr-empty-small">
        Không có nhóm ứng viên.
      </div>
    )
  }

  return (
    <div className="dssf-group-workspace">

      {/* Thống kê tổng quan */}

      <div className="dssf-group-overview">

        <div className="dssf-group-metrics">
          <div>
            <strong>{groups.length}</strong>
            <span>Nhóm ứng viên</span>
          </div>

          <div>
            <strong>{new Set(memberships).size}</strong>
            <span>Nhu cầu duy nhất</span>
          </div>

          <div>
            <strong>{memberships.length}</strong>
            <span>Lượt tham gia nhóm</span>
          </div>
        </div>

        <details className="dssf-group-info">
          <summary>
            <span className="dssf-info-icon">i</span>
            Cơ chế ghép nhóm F1
          </summary>

          <p>
            F1 tìm các nhóm tương thích tối đại trong
            giới hạn số nhu cầu mỗi nhóm. Một nhu cầu
            có thể xuất hiện trong nhiều nhóm.
          </p>
        </details>

      </div>

      {/* Tìm kiếm và bộ lọc */}

      <div className="dssf-group-toolbar">

        <div className="dssf-group-search">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>

          <input
            value={search}
            placeholder="Tìm nhóm, nhu cầu, Outlet..."
            aria-label="Tìm kiếm nhóm ứng viên"
            onChange={event => {
              setSearch(event.target.value)
              setPage(1)
            }}
          />
        </div>

        <select
          value={dateFilter}
          aria-label="Lọc theo ngày giao"
          onChange={event => {
            setDateFilter(event.target.value)
            setPage(1)
          }}
        >
          <option value="all">Tất cả ngày giao</option>
          <option value="current">Ngày giao chưa qua</option>
          <option value="expired">Ngày giao đã qua</option>
        </select>

        <select
          value={sort}
          aria-label="Sắp xếp nhóm ứng viên"
          onChange={event => {
            setSort(event.target.value)
            setPage(1)
          }}
        >
          <option value="default">Sắp xếp mặc định</option>
          <option value="weight">Khối lượng giảm dần</option>
          <option value="count">Số nhu cầu giảm dần</option>
          <option value="date">Ngày giao tăng dần</option>
        </select>

      </div>

      {/* Bảng danh sách nhóm */}

      <div className="dssf-group-table-wrap">

        <table className="dssf-group-table">
          <thead>
            <tr>
              <th>Nhóm ứng viên</th>
              <th>Thành viên</th>
              <th>Ngày giao</th>
              <th>Khung giờ chung</th>
              <th className="dssf-group-number">
                Khối lượng
              </th>
              <th>Chi tiết</th>
            </tr>
          </thead>

          <tbody>
            {visible.map(row => (
              <tr
                key={row.code ?? `${row.index}-${row.ids.join(',')}`}
              >

                <td>
                  <strong className="dssf-group-name">
                    {row.name}
                  </strong>

                  <small className="dssf-group-category">
                    {row.categoryCodes.join(', ')}
                  </small>
                </td>

                <td>
                  <strong>{row.ids.length} nhu cầu</strong>

                  <small>
                    {row.outletCount ?? missing} Outlet
                  </small>
                </td>

                <td>
                  <strong>
                    {deliveryDate(row.window?.requested_date)}
                  </strong>

                  {row.warning && (
                    <small className="dssf-group-expired">
                      {row.warning}
                    </small>
                  )}
                </td>

                <td>
                  <strong>
                    {timeWindow(
                      row.window?.common_start_time,
                      row.window?.common_end_time
                    )}
                  </strong>

                  <small>
                    {commonDuration(row.window)}
                  </small>
                </td>

                <td className="dssf-group-number">
                  <strong className="dssf-group-weight">
                    {weight(row.totalKg)}
                  </strong>
                </td>

                <td>
                  {row.code && openGroup ? (
                    <button
                      type="button"
                      className="dssf-group-open"
                      aria-label={`Xem ${row.name}`}
                      title="Xem chi tiết nhóm"
                      onClick={() => openGroup(row.code!)}
                    >
                      <svg
                        width="19"
                        height="19"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M4 12h16m-6-6 6 6-6 6" />
                      </svg>
                    </button>
                  ) : (
                    <span title="Nhóm trong bản xem trước">
                      —
                    </span>
                  )}
                </td>

              </tr>
            ))}

            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="dssf-group-empty">
                  Không tìm thấy nhóm phù hợp.
                </td>
              </tr>
            )}
          </tbody>
        </table>

      </div>

      {/* Phân trang */}

      <div className="dssf-group-pagination">

        <span>
          Hiển thị {filtered.length ? startIndex + 1 : 0}
          –{Math.min(
            startIndex + PAGE_SIZE,
            filtered.length
          )} / {filtered.length} nhóm
        </span>

        <div className="dssf-group-page-buttons">

          <button
            type="button"
            aria-label="Trang trước"
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            ‹
          </button>

          {currentPage > 2 && (
            <>
              <button type="button" onClick={() => setPage(1)}>
                1
              </button>
              {currentPage > 3 && <span>…</span>}
            </>
          )}

          {Array.from(
            { length: totalPages },
            (_, index) => index + 1
          )
            .filter(number =>
              Math.abs(number - currentPage) <= 1
            )
            .map(number => (
              <button
                type="button"
                key={number}
                aria-current={
                  currentPage === number ? 'page' : undefined
                }
                className={
                  currentPage === number ? 'is-active' : ''
                }
                onClick={() => setPage(number)}
              >
                {number}
              </button>
            ))}

          {currentPage < totalPages - 1 && (
            <>
              {currentPage < totalPages - 2 && <span>…</span>}
              <button
                type="button"
                onClick={() => setPage(totalPages)}
              >
                {totalPages}
              </button>
            </>
          )}

          <button
            type="button"
            aria-label="Trang tiếp theo"
            disabled={currentPage === totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            ›
          </button>

        </div>
      </div>

    </div>
  )
}
