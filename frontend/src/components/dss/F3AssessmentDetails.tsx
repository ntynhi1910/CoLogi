import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { F3Evaluation, ValidF3Evaluation } from '../../types/f3'
import { kg, utilization } from './f3Display'
import VehicleLoadMeter from './VehicleLoadMeter'

const f3StatusVi = (status: string): string => {
  const labels: Record<string, string> = {
    ELIGIBLE: 'Đủ điều kiện F3',
    NOT_ELIGIBLE: 'Không đủ điều kiện F3',
    INVALID_PLAN: 'Phương án không hợp lệ',
    UNVERIFIED: 'Chưa xác minh',
    PENDING: 'Chờ đánh giá',
  }

  return labels[status] ?? status
}

type ResultProps = { result: F3Evaluation }
type EvidenceProps = ResultProps & { presentation?: unknown }

const num = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const percent = (weight: number, capacity: number) =>
  capacity > 0 ? Math.round((weight / capacity) * 100) : null
const percentage = (value: number | null) => (value === null ? '—' : `${value}%`)
const text = (value: unknown): string =>
  value === undefined || value === null || value === '' ? '—' : String(value)

/** Xây dựng từ điển ánh xạ F2Stop.key (pickup-1, hub-1, outlet-1...) -> code & địa chỉ thực tế */
function buildStopDirectory(result: ValidF3Evaluation): Map<string, string> {
  const dir = new Map<string, string>()

  if (result.plan.hub) {
    const hub = result.plan.hub
    const hubLabel = hub.code && hub.name ? `${hub.code} · ${hub.name}` : hub.name || hub.code
    dir.set(`hub-${hub.id}`, hubLabel)
    dir.set(String(hub.code).toLowerCase(), hubLabel)
  }

  if (Array.isArray(result.stops)) {
    for (const stop of result.stops) {
      const stopKey = String(stop.key ?? '').trim().toLowerCase()
      const code = String(stop.code ?? '').trim()
      const address = String(stop.address ?? '').trim()

      let displayLabel = ''
      if (stop.kind === 'HUB' && result.plan.hub) {
        const hub = result.plan.hub
        displayLabel = hub.code && hub.name ? `${hub.code} · ${hub.name}` : code || hub.name
      } else if (code && address) {
        displayLabel = `${code} · ${address}`
      } else {
        displayLabel = code || address
      }

      if (stopKey && displayLabel) {
        dir.set(stopKey, displayLabel)
      }
    }
  }

  return dir
}

function resolveStopName(rawStop: unknown, directory: Map<string, string>): string {
  const raw = String(rawStop ?? '').trim()
  if (!raw) return '—'
  return directory.get(raw.toLowerCase()) ?? raw
}

export function getF3CapacityMetrics(result: F3Evaluation) {
  if (result.status === 'INVALID_PLAN') {
    return {
      requiredKg: 0,
      capacityKg: 0,
      usedPercent: null as number | null,
      backendPercent: null as number | null,
      waveCount: 0,
      vehicleCount: 0,
    }
  }

  const requiredKg = num(result.total_required_weight_kg)

  const capacityKg = result.waves.reduce(
    (total, wave) => total + num(wave.vehicle.capacity_kg),
    0
  )

  const usedPercent =
    capacityKg > 0 ? Math.round((requiredKg / capacityKg) * 100) : null

  const rawBackendPercent = Number(result.utilization_pct)

  return {
    requiredKg,
    capacityKg,
    usedPercent,
    backendPercent: Number.isFinite(rawBackendPercent) ? rawBackendPercent : null,
    waveCount: result.waves.length,
    vehicleCount: result.vehicles_required,
  }
}

function useF3Metrics(result: F3Evaluation) {
  return useMemo(() => {
    const metrics = getF3CapacityMetrics(result)

    return {
      capacity: metrics.capacityKg,
      required: metrics.requiredKg,
      planPercent: metrics.usedPercent,
    }
  }, [result])
}

/** Thẻ KPI ở đầu tab Phân bổ. Bằng chứng CP7 chi tiết nằm ở tab riêng. */
export function F3AllocationDashboard({ result }: ResultProps) {
  const { capacity, required, planPercent } = useF3Metrics(result)
  if (result.status === 'INVALID_PLAN') {
    return <p className="dssf-notice">Phương án không hợp lệ, chưa thể phân bổ phương tiện.</p>
  }
  const fleet = result.presentation?.fleet
  const available = fleet?.available_count
  const backendPercent = num(result.utilization_pct)
  const hasDifferentBackendMetric =
    planPercent !== null && Math.abs(backendPercent - planPercent) >= 1

  return (
    <section className="f3x-dashboard" aria-label="Tổng quan phân bổ F3">
      <div className="f3x-kpis">
        <article className="f3x-kpi">
          <div className="f3x-kpi-label">
            <span aria-hidden="true">◈</span> Wave vận hành
          </div>
          <strong>{result.waves.length}</strong>
          <small>
            {result.plan.hub ? `Phương án qua ${result.plan.hub.code}` : 'Phương án giao trực tiếp'}
          </small>
        </article>
        <article className="f3x-kpi">
          <div className="f3x-kpi-label">
            <span aria-hidden="true">🚚</span> Phương tiện cần
          </div>
          <strong>{result.vehicles_required}</strong>
          <small>Khả dụng theo CP7: {available ?? 'Chưa có dữ liệu'} xe</small>
        </article>
        <article className="f3x-kpi f3x-kpi-util">
          <div className="f3x-kpi-label">
            <span aria-hidden="true">◉</span> Mức sử dụng công suất wave
          </div>
          <div className="f3x-util-line">
            <div>
              <strong>{percentage(planPercent)}</strong>
              <small>
                {kg(String(required))} / {capacity > 0 ? kg(String(capacity)) : 'Chưa có sức chứa'}
              </small>
            </div>
            <div
              className="f3x-ring"
              style={
                {
                  '--f3x-progress': `${Math.max(0, Math.min(planPercent ?? 0, 100))}%`,
                } as CSSProperties
              }
            >
              {percentage(planPercent)}
            </div>
          </div>
        </article>
      </div>
      <div className="f3x-summary">
        <div className="f3x-summary-header">
          <div>
            <h3>Đánh giá nhanh</h3>
            <p>Chỉ số quan trọng để quyết định phương án phân bổ</p>
          </div>
          <span className="f3x-soft-label">F3 · CP7</span>
        </div>
        <div className="f3x-facts">
          <div>
            <span>📦</span>
            <small>Nhu cầu cần chở</small>
            <strong>{kg(String(required))}</strong>
          </div>
          <div>
            <span>🚛</span>
            <small>Công suất các wave</small>
            <strong>{capacity > 0 ? kg(String(capacity)) : 'Chưa có'}</strong>
          </div>
          <div>
            <span>📅</span>
            <small>Nguồn xe khả dụng</small>
            <strong>{available === undefined ? 'Chưa có' : `${available} xe`}</strong>
          </div>
          <div>
            <span>🛡️</span>
            <small>Trạng thái đánh giá</small>
            <strong>{text(f3StatusVi(result.gate_status))}</strong>
          </div>
        </div>

        {hasDifferentBackendMetric && (
          <details className="f3x-metric-details">
            <summary>ⓘ Giải thích cách tính hiệu suất tải trọng</summary>

            <p>
              Hiệu suất theo công suất các wave: {percentage(planPercent)} ({kg(String(required))} /{' '}
              {kg(String(capacity))}).
            </p>

            <p>
              Chỉ số do backend tính: {utilization(String(result.utilization_pct))}. Hai chỉ số có
              thể sử dụng mẫu số khác nhau.
            </p>
          </details>
        )}

        {capacity <= 0 && (
          <p className="f3x-metric-note">Chưa có sức chứa hợp lệ nên không thể tính hiệu suất.</p>
        )}
      </div>
    </section>
  )
}

/** Danh sách wave: thông tin xe và nhu cầu; không lặp bảng bằng chứng CP7. */
export function F3Waves({ result }: ResultProps) {
  const stopDirectory = useMemo(() => {
    if (result.status === 'INVALID_PLAN') return new Map<string, string>()
    return buildStopDirectory(result)
  }, [result])

  if (result.status === 'INVALID_PLAN') {
    return <p className="dssf-notice">Phương án chưa hợp lệ, không có phân bổ phương tiện.</p>
  }

  if (!result.waves.length) {
    return <p className="dssf-notice">Chưa có wave được phân bổ.</p>
  }

  return (
    <section className="f3x-wave-list" aria-label="Các wave phân bổ">
      {result.waves.map((wave, index) => {
        const capacity = num(wave.vehicle.capacity_kg)
        const allocated = num(wave.allocated_weight_kg)
        const allocations = wave.allocations

        return (
          <article key={`${index}-${wave.vehicle.vehicle_code}`} className="f3x-wave">
            <div className="f3x-wave-head">
              <div>
                <div className="f3x-badges">
                  <span className="f3x-wave-index">Wave {index + 1}</span>
                  <span className="f3x-soft-label">{text(wave.phase)}</span>
                </div>

                <h3>{text(wave.vehicle.vehicle_code)}</h3>

                <small>Offer #{text(wave.vehicle.offer_id)}</small>
              </div>

              <span className="f3x-wave-total">📦 {allocations.length} luồng hàng</span>
            </div>

            <VehicleLoadMeter allocatedKg={allocated} capacityKg={capacity} />

            <div className="f3x-wave-detail">
              <div className="f3x-section-heading">
                <h4>Luồng hàng được phân bổ</h4>
                <span>{allocations.length} nhu cầu</span>
              </div>

              <div className="f3x-table-scroll">
                <table className="f3x-table">
                  <thead>
                    <tr>
                      <th>Điểm lấy</th>
                      <th>Điểm giao</th>
                      <th>Khối lượng</th>
                      <th>Tỷ trọng sức chứa</th>
                    </tr>
                  </thead>

                  <tbody>
                    {allocations.map((allocation, rowIndex) => {
                      const row = allocation as unknown as Record<string, unknown>

                      const weight = num(
                        row.allocated_weight_kg ?? row.weight_kg ?? row.weight
                      )

                      const fromLabel = resolveStopName(allocation.from_stop, stopDirectory)
                      const toLabel = resolveStopName(allocation.to_stop, stopDirectory)

                      return (
                        <tr key={rowIndex}>
                          <td>{fromLabel}</td>
                          <td>{toLabel}</td>
                          <td>{weight > 0 ? kg(String(weight)) : 'Chưa có'}</td>
                          <td>{weight > 0 ? percentage(percent(weight, capacity)) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </article>
        )
      })}
    </section>
  )
}

/** Tab bằng chứng: chỉ có chi tiết CP7 và ràng buộc, tránh lặp với dashboard. */
export function F3Evidence({ result, presentation }: EvidenceProps) {
  if (result.status === 'INVALID_PLAN') {
    return <F3Diagnostics rows={result.diagnostics} />
  }

  const extra = (
    presentation && typeof presentation === 'object' ? presentation : {}
  ) as Record<string, unknown>

  const extraFleet = (
    extra.fleet && typeof extra.fleet === 'object' ? extra.fleet : null
  ) as Record<string, unknown> | null

  const fleet = result.presentation?.fleet

  const sources =
    fleet?.sources ??
    (Array.isArray(extraFleet?.sources)
      ? (extraFleet.sources as Array<Record<string, unknown>>)
      : [])

  const available = fleet?.available_count ?? extraFleet?.available_count
  const capacity = fleet?.available_capacity_kg ?? extraFleet?.available_capacity_kg

  const gateName: Record<string, string> = {
    ELIGIBLE: 'Đủ điều kiện F3',
    NOT_ELIGIBLE: 'Không đủ điều kiện F3',
    UNVERIFIED: 'Chưa xác minh',
    PENDING: 'Chờ đánh giá',
  }

  return (
    <section className="f3x-evidence">
      <div className="f3x-evidence-title">
        <div>
          <h2>🗓 Bằng chứng nguồn xe CP7</h2>
          <p>Khả dụng, sức chứa và mức độ xác minh phương tiện</p>
        </div>
        <span className="f3x-soft-label">
          {sources.length ? `${sources.length} nguồn` : 'Chưa có danh sách nguồn'}
        </span>
      </div>

      <div className="f3x-evidence-cards">
        <article>
          <span>🚚 Xe khả dụng</span>
          <strong>{available == null ? '—' : String(available)}</strong>
        </article>

        <article>
          <span>📦 Sức chứa nguồn xe</span>
          <strong>{capacity == null ? '—' : kg(String(capacity))}</strong>
        </article>

        <article>
          <span>🛡️ Kết quả đánh giá</span>
          <strong>{gateName[result.gate_status] ?? result.gate_status}</strong>
        </article>
      </div>

      {sources.length > 0 ? (
        <details className="f3x-compact-details">
          <summary>
            <span>🚛 Danh sách nguồn phương tiện</span>
            <span>{sources.length} nguồn</span>
          </summary>

          <div className="f3x-table-scroll">
            <table className="f3x-table">
              <thead>
                <tr>
                  <th>Offer</th>
                  <th>Mã xe</th>
                  <th>Trạng thái nguồn</th>
                </tr>
              </thead>

              <tbody>
                {sources.map((source, index) => {
                  const item = source as Record<string, unknown>

                  const status = String(item.status ?? item.availability_status ?? '—')

                  return (
                    <tr key={index}>
                      <td>{String(item.offer_id ?? index + 1)}</td>
                      <td>{String(item.vehicle_code ?? '—')}</td>
                      <td>
                        {status === 'VERIFIED'
                          ? 'Đã xác minh'
                          : status === 'UNVERIFIED'
                          ? 'Chưa xác minh'
                          : status}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      ) : (
        <p className="f3x-evidence-empty">
          Chưa có danh sách chi tiết nguồn phương tiện trong dữ liệu trình bày này. Kết quả đánh
          giá F3 vẫn được giữ theo backend.
        </p>
      )}

      <div className="f3x-evidence-diagnostics">
        <div className="f3x-section-heading">
          <h3>🔎 Ràng buộc và chẩn đoán</h3>
          <span>{result.diagnostics.length} kết quả</span>
        </div>

        <F3Diagnostics rows={result.diagnostics} />
      </div>
    </section>
  )
}

const diagnosticLabels: Record<string, string> = {
  LOW_UTILIZATION: 'Hiệu suất tải trọng thấp',
  CAPACITY_EXCEEDED: 'Vượt quá tải trọng cho phép',
  INSUFFICIENT_VEHICLES: 'Không đủ phương tiện',
  VEHICLE_UNAVAILABLE: 'Phương tiện không khả dụng',
  INCOMPATIBLE_GOODS: 'Nhóm hàng không tương thích',
  TIME_WINDOW_CONFLICT: 'Xung đột khung giờ',
}

export function F3Diagnostics({ rows }: { rows: F3Evaluation['diagnostics'] }) {
  const uniqueRows = rows.filter((row, index, all) => {
    const current = row as unknown as Record<string, unknown>
    return (
      all.findIndex((item) => {
        const other = item as unknown as Record<string, unknown>
        return (
          other.code === current.code &&
          other.message === current.message &&
          other.detail === current.detail
        )
      }) === index
    )
  })

  if (!uniqueRows.length) {
    return <p className="f3x-muted">Không phát hiện cảnh báo hoặc ràng buộc bổ sung.</p>
  }

  return (
    <div className="f3x-diagnostic-list">
      {uniqueRows.map((row, index) => {
        const item = row as unknown as Record<string, unknown>

        const code = String(item.code ?? '')
        const title = diagnosticLabels[code] ?? String(item.message ?? item.title ?? code)

        const detail = item.detail ?? item.description ?? item.reason

        const isInfo = code === 'LOW_UTILIZATION'

        return (
          <div className="f3x-diagnostic-card" key={`${code}-${index}`}>
            <span className="f3x-diagnostic-icon" aria-hidden="true">
              {isInfo ? 'ⓘ' : '⚠'}
            </span>

            <div>
              <strong>{title}</strong>

              {isInfo && (
                <p>
                  Phương tiện còn dư tải trọng. Có thể cân nhắc phương án gom hàng để tối ưu công
                  suất.
                </p>
              )}

              {!isInfo && detail != null && <p>{String(detail)}</p>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default F3AllocationDashboard