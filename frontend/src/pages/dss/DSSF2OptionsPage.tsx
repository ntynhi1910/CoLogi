import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { planningSearch } from '../../components/dss/planningSearch'
import { deliveryDate, deliveryWarning, masterdataLabel, missing, runTime, skuName, timeWindow, weight as formatWeight } from '../../components/dss/f1Display'
import { dssService } from '../../services/dss/dssService'
import { f2ErrorMessage, f2Service } from '../../services/dss/f2Service'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F1DemandDisplayLabels, F1DemandEvidence } from '../../types/f1'
import type { F2Demand, F2Option, F2Options, F2PlanSummary, F2Stop } from '../../types/f2'
import './DSSRunDetailPage.css'
import './F1Presentation.css'
import './DSSF2OptionsPage.css'

const diagnosticLabels: Record<string, string> = {
  HUB_SELECTION_REQUIRED: 'Chọn một Hub để tạo cấu trúc qua Hub.',
  NO_USABLE_HUB: 'Masterdata chưa có Hub đang hoạt động với địa chỉ hợp lệ.',
  HUB_NOT_FOUND: 'Hub đã chọn không tồn tại.',
  HUB_INACTIVE: 'Hub đã chọn đã ngừng hoạt động.',
  HUB_ADDRESS_MISSING: 'Hub đã chọn thiếu địa chỉ sử dụng.',
  HUB_SOURCE_UNAVAILABLE: 'Tạm thời chưa đọc được nguồn Hub.',
  PINNED_CONFIGURATION_INCOMPLETE: 'Thiếu cấu hình đã chốt của lần chạy F1.',
  CANDIDATE_SNAPSHOT_INCOMPLETE: 'Snapshot của nhóm thiếu dữ liệu hoặc chưa nhất quán.',
  CANDIDATE_SNAPSHOT_IDENTITY_MISMATCH: 'Snapshot không khớp với thành viên nhóm.',
  CANDIDATE_SNAPSHOT_BASIS_MISMATCH: 'Ngày, khung giờ, Outlet hoặc nhóm hàng không khớp với snapshot.',
  DEMAND_SNAPSHOT_INCOMPLETE: 'Snapshot nhu cầu thiếu dữ liệu nguồn.',
  REQUIRED_WEIGHT_INCONSISTENT: 'Khối lượng tổng không khớp với các dòng hàng.',
  CONFIRMED_FULFILLMENT_INCOMPLETE: 'Chưa có đủ khối lượng được xác nhận trong snapshot.',
  PICKUP_ADDRESS_MISSING: 'Snapshot thiếu địa chỉ lấy hàng đã xác nhận.',
  PICKUP_WINDOW_INCOMPLETE: 'Snapshot thiếu ngày hoặc khung giờ sẵn sàng lấy hàng hợp lệ.',
  STOP_REFERENCE_INCOMPLETE: 'Snapshot thiếu mã điểm nhận hàng hoặc mã nhóm hàng.',
}

const optionLabels = { DIRECT_CONSOLIDATED: 'Direct Consolidated', HUB_BASED: 'Hub-based' }
const completeLabel = 'Đủ dữ liệu'
const pendingCriteria = [
  'F3 · Phương tiện, tải trọng và số chuyến',
  'F4 · Thời gian và khả thi của lịch lấy/giao',
  'F5 · Chi phí và hiệu quả kinh tế',
]

type SnapshotEvidence = ReadonlyMap<number, { snapshot: F1DemandEvidence | null; labels?: F1DemandDisplayLabels }>
type Template = F2Option['template_type']
type SaveTarget = { option: F2Option; latest?: F2PlanSummary; isSaved: boolean }
type SaveOutcome = { template: Template } & (
  | { status: 'saved' | 'existing'; plan: F2PlanSummary }
  | { status: 'failed'; message: string }
)

function weight(value: string | null | undefined) {
  return formatWeight(value?.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'))
}

function partyName(code: string | null | undefined, name: string | null | undefined, fallback: string) {
  return [...new Set([code, name].filter(Boolean))].join(' · ') || fallback
}

function optionIdentity(template: Template, hubId: number | null) {
  return `${template}:${hubId ?? ''}`
}

function stopName(stop: F2Stop | undefined, evidence: SnapshotEvidence) {
  if (!stop) return missing
  const rows = stop.demand_ids.map((id) => evidence.get(id))
  const snapshots = rows.map((row) => row?.snapshot)
  if (stop.kind === 'SUPPLIER') {
    const code = snapshots.find((entry) => entry?.supplier_code)?.supplier_code ?? stop.code
    const name = snapshots.find((entry) => entry?.supplier_name)?.supplier_name
    const current = rows.find((row) => row?.labels?.supplier)?.labels?.supplier
    return masterdataLabel(code, name, current, `Nhà cung cấp #${stop.entity_id}`)
  }
  if (stop.kind === 'OUTLET') {
    const code = snapshots.find((entry) => entry?.outlet_code)?.outlet_code ?? stop.code
    const name = snapshots.find((entry) => entry?.outlet_name)?.outlet_name
    const current = rows.find((row) => row?.labels?.outlet)?.labels?.outlet
    return masterdataLabel(code, name, current, `Outlet #${stop.entity_id}`)
  }
  return `Hub ${stop.code || `#${stop.entity_id}`}`
}

function TransportFlowDiagram({
  option,
  demands,
  evidence,
}: {
  option: F2Option
  demands: Map<number, F2Demand>
  evidence: SnapshotEvidence
}) {
  const [selection, setSelection] = useState<{
    optionKey: string
    stopKey: string
  } | null>(null)

  const viaHub = option.template_type === 'HUB_BASED'

  const kinds: F2Stop['kind'][] = viaHub
    ? ['SUPPLIER', 'HUB', 'OUTLET']
    : ['SUPPLIER', 'OUTLET']

  const columns = kinds.map(kind => ({
    kind,
    stops: option.stops.filter(stop => stop.kind === kind),
  }))

  const height =
    Math.max(1, ...columns.map(column => column.stops.length))
    * 84 + 18

  const labels = {
    SUPPLIER: 'Nhà cung cấp',
    HUB: 'Hub',
    OUTLET: 'Outlet',
  }

  const roles = {
    SUPPLIER: 'Điểm lấy hàng',
    HUB: 'Điểm trung chuyển',
    OUTLET: 'Điểm nhận hàng',
  }

  const nodes = columns.flatMap(
    ({ stops }, columnIndex) =>
      stops.map((stop, index) => ({
        stop,
        x: columns.length === 2
          ? (columnIndex === 0 ? 3 : 71)
          : 3 + columnIndex * 34,
        y: (height - stops.length * 84) / 2
          + index * 84 + 8,
      }))
  )

  const byKey = new Map(
    nodes.map(node => [node.stop.key, node])
  )

  const selected =
    selection?.optionKey === option.option_key
      ? byKey.get(selection.stopKey)?.stop
      : undefined

  
  
  const stopCode = (stop: F2Stop) => {
    const fullName = stopName(stop, evidence)

    if (stop.kind === 'SUPPLIER') {
      const supplierCode = fullName.match(/\bSUP\d+\b/i)?.[0]

      return supplierCode || stop.code || `#${stop.entity_id}`
    }

    if (stop.kind === 'OUTLET') {
      const outletCode = fullName.match(/\bOUT\d+\b/i)?.[0]

      return outletCode || stop.code || `#${stop.entity_id}`
    }

    return stop.code || `#${stop.entity_id}`
  }



  const links = option.legs.flatMap(leg => {
    const from = byKey.get(leg.from_stop)
    const to = byKey.get(leg.to_stop)

    return from && to
      ? [{ leg, from, to }]
      : []
  })

  if (!nodes.length) {
    return (
      <p className="dssf-help">
        Chưa có điểm giao nhận để hiển thị.
      </p>
    )
  }

  return (
    <div className="f2-network">

      <div className="f2-network-scroll">

        <div className="f2-network-inner">

          {/* Tiêu đề các cột */}

          <div className="f2-network-headings">
            {columns.map(({ kind }, index) => (
              <span
                key={kind}
                style={{
                  left: `${
                    columns.length === 2
                      ? (index === 0 ? 3 : 71)
                      : 3 + index * 34
                  }%`,
                }}
              >
                {labels[kind]}
              </span>
            ))}
          </div>

          {/* Sơ đồ luồng hàng */}

          <div
            className="f2-network-canvas"
            style={{ height }}
          >

            {/* Đường nối giữa các điểm */}

            <svg
              className="f2-network-links"
              viewBox={`0 0 1000 ${height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {links.map(({ leg, from, to }, index) => {

                const x1 = (from.x + 26) * 10
                const x2 = to.x * 10

                const y1 = from.y + 34
                const y2 = to.y + 34

                const mid = (x1 + x2) / 2

                const active =
                  selected?.key === from.stop.key ||
                  selected?.key === to.stop.key

                return (
                  <g
                    key={`${leg.phase}-${leg.from_stop}-${leg.to_stop}-${index}`}
                    className={active ? 'is-active' : ''}
                  >
                    <path
                      d={`M${x1} ${y1}
                          C${mid} ${y1},
                           ${mid} ${y2},
                           ${x2 - 5} ${y2}`}
                    />

                    <path
                      d={`M${x2 - 19} ${y2 - 5}
                          L${x2 - 5} ${y2}
                          L${x2 - 19} ${y2 + 5}`}
                    />
                  </g>
                )
              })}
            </svg>

            {/* Các điểm Supplier, Hub và Outlet */}

            {nodes.map(({ stop, x, y }) => (
              <button
                key={stop.key}
                type="button"
                className={`f2-network-node ${
                  stop.kind === 'HUB'
                    ? 'is-hub'
                    : stop.kind === 'OUTLET'
                      ? 'is-outlet'
                      : ''
                } ${
                  selected?.key === stop.key
                    ? 'is-selected'
                    : ''
                }`}
                style={{
                  left: `${x}%`,
                  top: y,
                }}
                aria-expanded={selected?.key === stop.key}
                title={stopName(stop, evidence)}
                onClick={() =>
                  setSelection(
                    selected?.key === stop.key
                      ? null
                      : {
                          optionKey: option.option_key,
                          stopKey: stop.key,
                        }
                  )
                }
              >

                <strong>{stopCode(stop)}</strong>

                <small>{weight(stop.load_kg)}</small>

                <span aria-hidden="true">
                  {selected?.key === stop.key ? '⌃' : '⌄'}
                </span>

              </button>
            ))}

          </div>

        </div>

      </div>

      {/* Thông tin của điểm được chọn */}

      {selected ? (
        <section
          className="f2-network-detail"
          aria-label={roles[selected.kind]}
        >

          <header>
            <div>
              <small>{roles[selected.kind]}</small>
              <strong>
                {stopName(selected, evidence)}
              </strong>
            </div>

            <button
              type="button"
              aria-label="Đóng thông tin điểm"
              onClick={() => setSelection(null)}
            >
              ×
            </button>
          </header>

          <dl>

            <div>
              <dt>Địa chỉ</dt>
              <dd>{selected.address || missing}</dd>
            </div>

            <div>
              <dt>Khối lượng</dt>
              <dd>{weight(selected.load_kg)}</dd>
            </div>

            <div>
              <dt>Nhu cầu liên quan</dt>
              <dd>
                {selected.demand_ids.length
                  ? selected.demand_ids.map(
                      id => demands.get(id)?.code ?? `#${id}`
                    ).join(', ')
                  : missing}
              </dd>
            </div>

          </dl>

          {selected.kind === 'HUB' && option.hub && (
            <small className="dssf-help">
              {option.hub.name}
            </small>
          )}

        </section>
      ) : (
        <p className="f2-network-hint">
          Nhấn vào một điểm để xem địa chỉ và nhu cầu liên quan.
        </p>
      )}

    </div>
  )
}

function OptionCard({ option, demands, evidence, saved, children }: {
  option: F2Option
  demands: Map<number, F2Demand>
  evidence: SnapshotEvidence
  saved?: boolean
  children?: ReactNode
}) {
  const viaHub = option.template_type === 'HUB_BASED'
  const complete = option.structural_status === 'COMPLETE'

  return (
    <article className="dssr-panel f2-option">
      <header className="f2-option-header">
        <div>
          <p className="dssr-eyebrow">{viaHub ? 'HUB-BASED' : 'DIRECT CONSOLIDATED'}</p>
          <h2>{viaHub ? 'Gom hàng qua Hub' : 'Gom hàng trực tiếp'}</h2>
        </div>
        <span className={`dssr-option-status ${complete ? 'is-feasible' : 'is-blocked'}`}>
          {saved ? 'Đã lưu · DRAFT' : complete ? completeLabel : 'Thiếu dữ liệu'}
        </span>
      </header>

      <TransportFlowDiagram
        option={option}
        demands={demands}
        evidence={evidence}
      />

      <div className="f2-network-metrics">

        <div>
          <small>
            {viaHub ? 'Luồng vào Hub' : 'Luồng trực tiếp'}
          </small>

          <strong>
            {complete
              ? option.legs.filter(
                  leg =>
                    leg.phase === (viaHub ? 'INBOUND' : 'DIRECT')
                ).length
              : missing}
          </strong>
        </div>

        <div>
          <small>
            {viaHub ? 'Luồng ra Hub' : 'Điểm tập kết'}
          </small>

          <strong>
            {viaHub
              ? (
                  complete
                    ? option.legs.filter(
                        leg => leg.phase === 'OUTBOUND'
                      ).length
                    : missing
                )
              : 'Không qua Hub'}
          </strong>
        </div>

      </div>
      {option.diagnostics.length > 0 && <ul className="dssf-notice f2-diagnostics">
        {option.diagnostics.map((issue, index) => <li key={`${issue.code}-${index}`}>
          {issue.demand_id && <strong>{demands.get(issue.demand_id)?.code ?? `#${issue.demand_id}`} · </strong>}
          {diagnosticLabels[issue.code] ?? issue.code}
        </li>)}
      </ul>}
      {children}
    </article>
  )
}

function evidenceNumber(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ''
  ) {
    return null
  }

  const result = Number(value)

  return Number.isFinite(result) && result >= 0
    ? result
    : null
}

function evidenceSum(values: unknown[]): number | null {
  if (!values.length) return null

  const numbers = values.map(evidenceNumber)

  if (numbers.some(value => value === null)) {
    return null
  }

  return numbers.reduce<number>(
    (total, value) => total + (value ?? 0),
    0
  )
}

function evidenceWeight(value: number | null) {
  return value === null
    ? missing
    : weight(value.toFixed(3))
}

function evidencePercent(
  required: unknown,
  confirmed: unknown
): number | null {
  const requested = evidenceNumber(required)
  const accepted = evidenceNumber(confirmed)

  if (
    requested === null ||
    accepted === null ||
    requested <= 0
  ) {
    return null
  }

  return accepted / requested * 100
}

function EvidenceFulfillmentBar({
  required,
  confirmed,
}: {
  required: unknown
  confirmed: unknown
}) {
  const percent = evidencePercent(required, confirmed)

  if (percent === null) {
    return (
      <span className="f2-evidence-muted">
        {missing}
      </span>
    )
  }

  const fulfilled = percent >= 100

  return (
    <div
      className={`f2-evidence-fulfillment ${
        fulfilled ? 'is-complete' : 'is-partial'
      }`}
    >
      <strong>
        {percent.toLocaleString('vi-VN', {
          maximumFractionDigits: 1,
        })}%
      </strong>

      <div
        className="f2-evidence-progress"
        role="progressbar"
        aria-label="Mức đáp ứng cung ứng"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
      >
        <span
          style={{
            width: `${Math.min(100, percent)}%`,
          }}
        />
      </div>
    </div>
  )
}

function evidenceTimestamp(
  date: string | null | undefined,
  time: string | null | undefined
): number | null {
  if (!date || !time) return null

  const value = Date.parse(`${date}T${time}Z`)

  return Number.isFinite(value) ? value : null
}

function EvidenceTimeline({
  demand,
  requestedDate,
}: {
  demand: F2Demand
  requestedDate: string | null | undefined
}) {
  const windows = [
    {
      label: 'Sẵn sàng lấy hàng',
      kind: 'pickup',
      date: demand.pickup_ready_date,
      start: demand.pickup_ready_start_time,
      end: demand.pickup_ready_end_time,
    },
    {
      label: 'Yêu cầu nhận hàng',
      kind: 'delivery',
      date: requestedDate,
      start: demand.requested_start_time,
      end: demand.requested_end_time,
    },
  ].map(entry => ({
    ...entry,
    startValue: evidenceTimestamp(
      entry.date,
      entry.start
    ),
    endValue: evidenceTimestamp(
      entry.date,
      entry.end
    ),
  }))

  const valid = windows.flatMap(entry => {
    if (
      entry.startValue === null ||
      entry.endValue === null ||
      entry.endValue <= entry.startValue
    ) {
      return []
    }

    return [{
      ...entry,
      from: entry.startValue,
      to: entry.endValue,
    }]
  })

  const hour = 60 * 60 * 1000

  const axisStart = valid.length
    ? Math.floor(
        Math.min(...valid.map(entry => entry.from))
        / hour
      ) * hour
    : 0

  const axisEnd = valid.length
    ? Math.ceil(
        Math.max(...valid.map(entry => entry.to))
        / hour
      ) * hour
    : 0

  const range = axisEnd - axisStart

  const position = (value: number) =>
    range > 0
      ? (value - axisStart) / range * 100
      : 0

  const step = range <= 6 * hour
    ? hour
    : range <= 12 * hour
      ? 2 * hour
      : range <= 24 * hour
        ? 4 * hour
        : range <= 48 * hour
          ? 8 * hour
          : Math.ceil(range / (6 * hour)) * hour

  const ticks: number[] = []

  if (range > 0) {
    ticks.push(axisStart)

    for (
      let tick = axisStart + step;
      tick < axisEnd;
      tick += step
    ) {
      if (axisEnd - tick >= step / 2) {
        ticks.push(tick)
      }
    }

    ticks.push(axisEnd)
  }

  const spansDays =
    new Date(axisStart).toISOString().slice(0, 10) !==
    new Date(axisEnd).toISOString().slice(0, 10)

  const formatTick = (value: number) => {
    const date = new Date(value)

    const clock = date.toISOString().slice(11, 16)

    return spansDays
      ? `${date.toISOString().slice(8, 10)}/${date.toISOString().slice(5, 7)} ${clock}`
      : clock
  }

  return (
    <section className="f2-evidence-timeline">

      <h4>Khung giờ giao nhận</h4>

      <div className="f2-evidence-window-cards">
        {windows.map(entry => (
          <div
            className={`f2-evidence-window is-${entry.kind}`}
            key={entry.kind}
          >
            <small>{entry.label}</small>

            <strong>
              {timeWindow(entry.start, entry.end)}
            </strong>

            <span>
              {deliveryDate(entry.date)}
            </span>
          </div>
        ))}
      </div>

      {valid.length === windows.length &&
       range > 0 ? (
        <div className="f2-evidence-chart-scroll">

          <div className="f2-evidence-chart">

            <div className="f2-evidence-axis">
              {ticks.map((tick, index) => (
                <span
                  key={tick}
                  className={
                    index === 0
                      ? 'is-first'
                      : index === ticks.length - 1
                        ? 'is-last'
                        : ''
                  }
                  style={{
                    left: `${position(tick)}%`,
                  }}
                >
                  {formatTick(tick)}
                </span>
              ))}
            </div>

            <div className="f2-evidence-tracks">

              {ticks.map(tick => (
                <i
                  className="f2-evidence-gridline"
                  aria-hidden="true"
                  key={tick}
                  style={{
                    left: `${position(tick)}%`,
                  }}
                />
              ))}

              {valid.map(entry => (
                <div
                  className="f2-evidence-track"
                  key={entry.kind}
                >
                  <span
                    className={`f2-evidence-timebar is-${entry.kind}`}
                    title={`${entry.label}: ${deliveryDate(entry.date)} · ${timeWindow(entry.start, entry.end)}`}
                    style={{
                      left: `${position(entry.from)}%`,
                      width: `${
                        (entry.to - entry.from)
                        / range * 100
                      }%`,
                    }}
                  />
                </div>
              ))}

            </div>

          </div>

        </div>
      ) : (
        <p className="f2-evidence-muted">
          Chưa đủ dữ liệu để dựng biểu đồ thời gian.
        </p>
      )}

      <div className="f2-evidence-legend">
        <span>
          <i className="is-pickup" />
          Sẵn sàng lấy hàng
        </span>

        <span>
          <i className="is-delivery" />
          Yêu cầu nhận hàng
        </span>
      </div>

      <p className="f2-evidence-timeline-note">
        Khung giờ đầu vào từ F1, chưa phải lịch trình
        vận chuyển được đánh giá tại F4.
      </p>

    </section>
  )
}



function InputEvidence({
  options,
  evidence,
}: {
  options: F2Options
  evidence: SnapshotEvidence
}) {
  const { basis } = options

  const cargoCategories = [
    ...new Set(
      basis.demands
        .map(demand => demand.cargo_category_code)
        .filter(Boolean)
    ),
  ]

  const commonCargoCategory =
    cargoCategories.length === 1 &&
    basis.demands.every(
      demand => Boolean(demand.cargo_category_code)
    )
      ? cargoCategories[0]
      : cargoCategories.length > 1
        ? 'Nhiều nhóm hàng'
        : missing

  const [expanded, setExpanded] = useState<number[]>([])

  const totalRequired = evidenceNumber(
    basis.total_required_weight_kg
  )

  const totalConfirmed = basis.demands.every(
    demand => demand.items.length > 0
  )
    ? evidenceSum(
        basis.demands.flatMap(
          demand => demand.items.map(
            item => item.confirmed_weight_kg
          )
        )
      )
    : null

  function toggleDemand(demandId: number) {
    setExpanded(current =>
      current.includes(demandId)
        ? current.filter(id => id !== demandId)
        : [...current, demandId]
    )
  }

  return (
    <section
      className="dssr-panel f2-input-evidence"
      aria-labelledby="f2-input-title"
    >

      {/* Tiêu đề */}

      <header className="f2-evidence-heading">
        <h2 id="f2-input-title">
          Nhu cầu và xác nhận cung ứng
        </h2>

        <p>
          Dữ liệu đầu vào được ghi nhận tại lần chạy F1
        </p>
      </header>

      {/* KPI tổng quan */}

      
      <div className="f2-evidence-stats">

        <div className="f2-evidence-category">
          <small>Nhóm hàng</small>
          <strong>{commonCargoCategory}</strong>
        </div>

        <div>
          <small>Tổng nhu cầu</small>
          <strong>{basis.demand_ids.length}</strong>
        </div>

        <div>
          <small>Khối lượng yêu cầu</small>
          <strong>{evidenceWeight(totalRequired)}</strong>
        </div>

        <div>
          <small>Khối lượng xác nhận</small>
          <strong>{evidenceWeight(totalConfirmed)}</strong>
        </div>

      </div>


      {/* Bảng nhu cầu */}

      <div className="f2-evidence-table-wrap">

        <table className="f2-evidence-table">

          <thead>
            <tr>
              <th scope="col">Mã nhu cầu</th>
              <th scope="col">Nhà cung cấp</th>
              <th scope="col">Outlet</th>
              <th scope="col">Khối lượng</th>
              <th scope="col">Chi tiết</th>
            </tr>
          </thead>

          <tbody>

            {basis.demands.map(demand => {

              const row = evidence.get(demand.id)
              const snapshot = row?.snapshot

              const isExpanded = expanded.includes(
                demand.id
              )

              const detailId =
                `f2-evidence-detail-${demand.id}`

              const supplierCode =
                snapshot?.supplier_code ||
                row?.labels?.supplier?.code ||
                `#${demand.supplier_id}`

              const outletCode =
                snapshot?.outlet_code ||
                demand.outlet_code ||
                row?.labels?.outlet?.code ||
                `#${demand.outlet_id}`

              const supplier = masterdataLabel(
                snapshot?.supplier_code,
                snapshot?.supplier_name,
                row?.labels?.supplier,
                `Nhà cung cấp #${demand.supplier_id}`
              )

              const outlet = masterdataLabel(
                snapshot?.outlet_code ||
                  demand.outlet_code,
                snapshot?.outlet_name,
                row?.labels?.outlet,
                `Outlet #${demand.outlet_id}`
              )

              const required = evidenceSum(
                demand.items.map(
                  item => item.required_weight_kg
                )
              )

              const confirmed = evidenceSum(
                demand.items.map(
                  item => item.confirmed_weight_kg
                )
              )

              return (
                <Fragment key={demand.id}>

                  {/* Dòng nhu cầu chính */}

                  <tr
                    className={`f2-evidence-main-row ${
                      isExpanded ? 'is-expanded' : ''
                    }`}
                    onClick={() => toggleDemand(demand.id)}
                  >

                    <td>
                      <button
                        type="button"
                        className="f2-evidence-demand-code"
                        aria-expanded={isExpanded}
                        aria-controls={
                          isExpanded ? detailId : undefined
                        }
                        onClick={event => {
                          event.stopPropagation()
                          toggleDemand(demand.id)
                        }}
                      >
                        {demand.code}
                      </button>

                      <small>
                        {demand.items.length} mặt hàng
                      </small>
                    </td>

                    <td>
                      <strong>{supplierCode}</strong>
                    </td>

                    <td>
                      <strong>{outletCode}</strong>
                    </td>

                    <td>
                      <strong>
                        {weight(demand.required_weight_kg)}
                      </strong>
                    </td>

                    <td>
                      <button
                        type="button"
                        className="f2-evidence-toggle"
                        aria-label={
                          isExpanded
                            ? `Thu gọn ${demand.code}`
                            : `Xem chi tiết ${demand.code}`
                        }
                        aria-expanded={isExpanded}
                        aria-controls={
                          isExpanded ? detailId : undefined
                        }
                        onClick={event => {
                          event.stopPropagation()
                          toggleDemand(demand.id)
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path
                            d={
                              isExpanded
                                ? 'M6 15l6-6 6 6'
                                : 'M6 9l6 6 6-6'
                            }
                          />
                        </svg>
                      </button>
                    </td>

                  </tr>

                  {/* Nội dung mở rộng */}

                  {isExpanded && (
                    <tr className="f2-evidence-expanded-row">

                      <td colSpan={5}>

                        <div
                          className="f2-evidence-expanded"
                          id={detailId}
                        >

                          {/* Thông tin giao nhận */}

                          <div className="f2-evidence-parties">

                            <div>
                              <small>Điểm lấy hàng</small>

                              <strong>{supplier}</strong>

                              <p>
                                {demand.pickup_address ||
                                  missing}
                              </p>
                            </div>

                            <div>
                              <small>Điểm nhận hàng</small>

                              <strong>{outlet}</strong>

                              <p>
                                Ngày nhận yêu cầu:{' '}
                                {deliveryDate(
                                  demand.requested_date
                                )}
                              </p>
                            </div>

                          </div>

                          {/* Timeline */}

                          <EvidenceTimeline
                            demand={demand}
                            requestedDate={
                              demand.requested_date
                            }
                          />

                          {/* Bảng xác nhận cung ứng */}

                          <section className="f2-evidence-supply">

                            <header>
                              <h4>
                                Chi tiết xác nhận cung ứng
                              </h4>

                              <small>
                                {demand.items.length} mặt hàng
                              </small>
                            </header>

                            <div className="f2-evidence-items-wrap">

                              <table className="f2-evidence-items">

                                <thead>
                                  <tr>
                                    <th scope="col">
                                      SKU / Mặt hàng
                                    </th>
                                    <th scope="col">
                                      Yêu cầu
                                    </th>
                                    <th scope="col">
                                      Xác nhận
                                    </th>
                                    <th scope="col">
                                      Mức đáp ứng
                                    </th>
                                  </tr>
                                </thead>

                                <tbody>

                                  {demand.items.map(item => (
                                    <tr key={item.item_id}>

                                      <td>
                                        {skuName(
                                          item.item_id,
                                          snapshot,
                                          row?.labels
                                        )}
                                      </td>

                                      <td>
                                        {weight(
                                          item.required_weight_kg
                                        )}
                                      </td>

                                      <td>
                                        {weight(
                                          item.confirmed_weight_kg
                                        )}
                                      </td>

                                      <td>
                                        <EvidenceFulfillmentBar
                                          required={
                                            item.required_weight_kg
                                          }
                                          confirmed={
                                            item.confirmed_weight_kg
                                          }
                                        />
                                      </td>

                                    </tr>
                                  ))}

                                  {demand.items.length === 0 && (
                                    <tr>
                                      <td colSpan={4}>
                                        Chưa có dữ liệu mặt hàng.
                                      </td>
                                    </tr>
                                  )}

                                </tbody>

                                <tfoot>
                                  <tr>

                                    <th scope="row">
                                      Tổng cộng
                                    </th>

                                    <td>
                                      {evidenceWeight(required)}
                                    </td>

                                    <td>
                                      {evidenceWeight(confirmed)}
                                    </td>

                                    <td>
                                      <EvidenceFulfillmentBar
                                        required={required}
                                        confirmed={confirmed}
                                      />
                                    </td>

                                  </tr>
                                </tfoot>

                              </table>

                            </div>

                          </section>

                          {/* Thông tin snapshot */}

                          <p className="f2-evidence-snapshot">
                            Snapshot v{demand.snapshot_version}
                            {' · '}
                            {runTime(
                              demand.snapshot_captured_at
                            )}
                          </p>

                        </div>

                      </td>

                    </tr>
                  )}

                </Fragment>
              )
            })}

            {basis.demands.length === 0 && (
              <tr>
                <td colSpan={5}>
                  Chưa có dữ liệu nhu cầu.
                </td>
              </tr>
            )}

          </tbody>

        </table>

      </div>

      <p className="f2-evidence-count">
        Hiển thị {basis.demands.length} nhu cầu
      </p>

    </section>
  )
}


function flowCount(option: F2Option) {
  if (option.structural_status !== 'COMPLETE') return 'Chưa tạo'
  if (option.template_type === 'DIRECT_CONSOLIDATED') return `${option.legs.length} trực tiếp`
  const inbound = option.legs.filter((leg) => leg.phase === 'INBOUND').length
  const outbound = option.legs.filter((leg) => leg.phase === 'OUTBOUND').length
  return `${inbound} vào Hub · ${outbound} ra Hub`
}

function ComparisonOverview({ targets, allowSave, saving, onSave }: {
  targets: SaveTarget[]; allowSave: boolean; saving: boolean; onSave: () => void
}) {
  const hasBoth = targets.length === 2
  const complete = hasBoth && targets.every(({ option }) => option.structural_status === 'COMPLETE')
  const allSaved = complete && targets.every(({ isSaved }) => isSaved)
  const disabled = !complete || !allowSave || allSaved || saving
  return (
    <section className="dssr-panel f2-overview" aria-labelledby="f2-overview-title">
      <div className="f2-overview-heading">
        <div>
          <h2 id="f2-overview-title">So sánh tổng hợp</h2>
          <p>Hai phương án dùng cùng tập nhu cầu, khối lượng và khung giờ đã chốt ở F1.</p>
        </div>
        <div className="f2-batch-action">
          <button type="button" className="dssr-primary-button" disabled={disabled}
            onClick={onSave} aria-describedby="f2-batch-hint">
            Lưu cả hai phương án để đánh giá tiếp
          </button>
          <small id="f2-batch-hint">
            {saving ? 'Đang lưu phương án…' : !allowSave ? 'Môi trường này chưa hỗ trợ lưu phương án.'
              : allSaved ? 'Cả hai phương án hiện đã có bản nháp.'
              : !complete ? 'Cần đủ dữ liệu cho cả hai phương án, gồm Hub đã chọn.'
              : 'Mỗi phương án được lưu thành một bản nháp DRAFT riêng.'}
          </small>
        </div>
      </div>
      <div className="f2-table-wrap" role="region" aria-labelledby="f2-overview-title" tabIndex={0}>
        <table className="f2-table">
          <thead><tr>
            <th scope="col">Tiêu chí</th>
            {targets.map(({ option }) => <th scope="col" key={option.template_type}>{optionLabels[option.template_type]}</th>)}
          </tr></thead>
          <tbody>
            <tr><th scope="row">Cấu trúc F2</th>{targets.map(({ option }) => (
              <td key={option.template_type}>{option.structural_status === 'COMPLETE' ? completeLabel : 'Thiếu dữ liệu'}</td>
            ))}</tr>
            <tr><th scope="row">Khối lượng nhu cầu</th>{targets.map(({ option }) => (
              <td key={option.template_type}>{weight(option.total_required_weight_kg)}</td>
            ))}</tr>
            <tr><th scope="row">Điểm tập kết</th>{targets.map(({ option }) => (
              <td key={option.template_type}>{option.template_type === 'DIRECT_CONSOLIDATED'
                ? 'Giao thẳng đến Outlet' : partyName(option.hub?.code, option.hub?.name, 'Chưa chọn Hub')}</td>
            ))}</tr>
            <tr><th scope="row">Luồng hàng</th>{targets.map(({ option }) => (
              <td key={option.template_type}>{flowCount(option)}</td>
            ))}</tr>
            {pendingCriteria.map((criterion) => (
              <tr key={criterion}><th scope="row">{criterion}</th>{targets.map(({ option }) => (
                <td key={option.template_type}><span className="f2-unassessed">Chưa đánh giá</span></td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
      
    </section>
  )
}

function SaveResults({ results, reload }: { results: SaveOutcome[]; reload: () => void }) {
  const anyFailed = results.some((result) => result.status === 'failed')
  return (
    <section className={`f2-save-results ${anyFailed ? 'dssr-alert' : 'dssf-notice'}`} role={anyFailed ? 'alert' : 'status'}>
      <strong>{results.length === 2
        ? anyFailed ? 'Chưa lưu xong cả hai phương án.' : 'Cả hai phương án đã có bản nháp.'
        : 'Kết quả lưu phương án'}</strong>
      <ul>
        {results.map((result) => <li key={result.template}>
          <strong>{optionLabels[result.template]}</strong>
          {' · '}{result.status === 'failed' ? `Không lưu được. ${result.message}` : <>
            {result.status === 'existing' ? 'Đã có bản nháp' : 'Đã lưu'} <code>{result.plan.plan_code}</code>
            {' · '}Phiên bản {result.plan.revision} · {result.plan.status}
          </>}
        </li>)}
      </ul>
      {anyFailed && <button type="button" className="dssr-secondary-button" onClick={reload}>Tải lại phương án</button>}
    </section>
  )
}


function SavedOptions({
  plans,
  allocationPath,
  scenario,
}: {
  plans: F2PlanSummary[][]
  allocationPath: string
  scenario: string | null
}) {
  if (plans.length === 0) return null

  const directCount = plans.filter(
    history =>
      history.at(-1)?.template_type === 'DIRECT_CONSOLIDATED'
  ).length

  const hubCount = plans.length - directCount

  return (
    <section
      className="dssr-panel f2-saved-options"
      aria-labelledby="f2-saved-title"
    >
      <div className="f2-saved-heading">
        <div>
          <h2 id="f2-saved-title">
            Phương án đã lưu
          </h2>

          <p>
            {plans.length} phương án
            {' · '}
            {directCount} trực tiếp
            {' · '}
            {hubCount} qua Hub
          </p>
        </div>

        <Link
          className="dssr-primary-button f2-allocation-link"
          to={{
            pathname: allocationPath,
            search: planningSearch(scenario),
          }}
        >
          Đánh giá F3 tất cả phương án →
        </Link>
      </div>

      <div className="f2-saved-table-wrap">
        <table className="f2-saved-table">

          <thead>
            <tr>
              <th scope="col">Phương án</th>
              <th scope="col">Điểm tập kết</th>
              <th scope="col">Trạng thái</th>
              <th scope="col">Phân bổ phương tiện</th>
            </tr>
          </thead>

          <tbody>
            {plans.map(history => {
              const latest = history.at(-1)!

              const isDirect =
                latest.template_type ===
                'DIRECT_CONSOLIDATED'

              const identity = optionIdentity(
                latest.template_type,
                latest.hub_id
              )

              return (
                <tr key={identity}>

                  {/* Phương án */}

                  <td>
                    <div className="f2-saved-type">

                      <span
                        className={`f2-saved-icon ${
                          isDirect
                            ? 'is-direct'
                            : 'is-hub'
                        }`}
                        aria-hidden="true"
                      >
                        {isDirect ? (
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M2 4h13v13H2z" />
                            <path d="M15 9h4l3 4v4h-7" />
                            <circle cx="6" cy="18" r="2" />
                            <circle cx="18" cy="18" r="2" />
                          </svg>
                        ) : (
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M3 10l9-6 9 6v11H3z" />
                            <path d="M8 21v-9h8v9" />
                            <path d="M8 15h8M8 18h8" />
                          </svg>
                        )}
                      </span>

                      <div>
                        <strong>
                          {optionLabels[latest.template_type]}
                        </strong>

                        <small>
                          {isDirect
                            ? 'Gom hàng trực tiếp'
                            : 'Gom hàng qua Hub'}
                        </small>
                      </div>
                    </div>
                  </td>

                  {/* Điểm tập kết */}

                  <td>
                    {isDirect ? (
                      <span className="f2-saved-muted">
                        Không qua Hub
                      </span>
                    ) : (
                      <div className="f2-saved-hub">
                        <strong>
                          {latest.hub?.code ||
                            `Hub #${latest.hub_id}`}
                        </strong>

                        {latest.hub?.name && (
                          <small>{latest.hub.name}</small>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Trạng thái */}

                  <td>
                    <span className="f2-saved-status">
                      {latest.status === 'DRAFT'
                        ? 'Nháp'
                        : latest.status}
                    </span>
                  </td>

                  {/* Phân bổ phương tiện F3 */}

                  <td>
                    <Link
                      className="f2-saved-f3-link"
                      to={{
                        pathname:
                          `${allocationPath}/${encodeURIComponent(latest.plan_code)}`,
                        search: planningSearch(scenario),
                      }}
                    >
                      Phân bổ F3
                      <span aria-hidden="true">→</span>
                    </Link>
                  </td>

                </tr>
              )
            })}
          </tbody>

        </table>
      </div>

      <p className="f2-saved-count">
        Hiển thị {plans.length} phương án
      </p>

    </section>
  )
}


export default function DSSF2OptionsPage() {
  const { runId = '', optionId = '' } = useParams()
  const [query] = useSearchParams()
  const scenario = query.get('scenario')
  const [hubId, setHubId] = useState('')
  const [selectedPlan, setSelectedPlan] = useState<string | undefined>(query.get('plan') ?? undefined)
  const [pending, setPending] = useState<Template[]>([])
  const [saveResults, setSaveResults] = useState<SaveOutcome[]>([])
  const saving = pending.length > 0
  const saveLock = useRef(false)
  const hubs = useDssQuery(f2Service.listHubs)
  
  const hasInitializedHub = useRef(false)

  useEffect(() => {
    const firstHub = hubs.data?.[0]

    if (
      !hasInitializedHub.current &&
      !hubs.loading &&
      firstHub
    ) {
      hasInitializedHub.current = true

      const defaultHubId = String(firstHub.id)

      setHubId(current => current || defaultHubId)
    }
  }, [hubs.loading, hubs.data])

  const loadF1 = useCallback(() => dssService.getRun(runId), [runId])
  const f1 = useDssQuery(loadF1)
  const evidence: SnapshotEvidence = new Map(f1.data?.demand_results.map(({ demand_id, evidence }) => [
    demand_id, { snapshot: evidence, labels: f1.data?.display_labels?.[demand_id] },
  ]))
  const loadOptions = useCallback(() => f2Service.getOptions(runId, optionId, hubId), [runId, optionId, hubId])
  const comparison = useDssQuery(loadOptions)
  const options = comparison.data
  const allowSave = options?.persistence === 'AVAILABLE'
  const savedByIdentity = new Map<string, F2PlanSummary[]>()
  for (const plan of options?.saved_plans ?? []) {
    const identity = optionIdentity(plan.template_type, plan.hub_id)
    const history = savedByIdentity.get(identity) ?? []
    history.push(plan)
    savedByIdentity.set(identity, history)
  }
  const savedOptions = [...savedByIdentity].sort(([first], [second]) => first.localeCompare(second))
  const targets: SaveTarget[] = options?.options.map((option) => {
    const latest = savedByIdentity.get(optionIdentity(option.template_type, option.hub?.id ?? null))?.at(-1)
    return { option, latest, isSaved: latest?.option_key === option.option_key }
  }) ?? []
  const basis = options?.basis
  const demands = new Map(basis?.demands.map((item) => [item.id, item]))
  const dayWarning = deliveryWarning(basis?.requested_date)
  const candidatePath = `/dss/runs/${runId}/options/${optionId}`

  async function savePlans(requested: SaveTarget[]) {
    if (saveLock.current || !allowSave || !requested.length ||
      requested.some(({ option }) => option.structural_status !== 'COMPLETE')) return
    saveLock.current = true
    setPending(requested.map(({ option }) => option.template_type))
    setSaveResults([])
    try {
      const results = await Promise.all(requested.map(async ({ option, latest, isSaved }): Promise<SaveOutcome> => {
        const template = option.template_type
        if (isSaved && latest) return { template, status: 'existing', plan: latest }
        try {
          const plan = await f2Service.savePlan(runId, optionId, option, latest?.plan_code)
          return { template, status: 'saved', plan }
        } catch (error) {
          return { template, status: 'failed', message: f2ErrorMessage(error) }
        }
      }))
      setSaveResults(results)
      comparison.reload()
    } finally {
      saveLock.current = false
      setPending([])
    }
  }

  return (
    <main className="dssr-page f2-page">
      <header className="dssr-header">
        <div>
          <Link className="dssr-back-link" to={{ pathname: candidatePath, search: planningSearch(scenario, { plan: selectedPlan }) }}>
            ← Nhóm ứng viên F1
          </Link>
          <p className="dssr-eyebrow">COLOGI · DSS F2</p>
          <h1>So sánh phương án vận chuyển</h1>
          <p className="dssr-description">F2 xây dựng phương án trực tiếp và qua Hub để đánh giá ở các bước tiếp theo.</p>
        </div>
      </header>

      {comparison.error !== null && <div className="dssr-alert" role="alert">
        {f2ErrorMessage(comparison.error)}
        <button type="button" className="dssr-secondary-button" onClick={comparison.reload}>Thử lại</button>
      </div>}
      {basis && <section aria-label="Thông tin nhóm ứng viên" className="f2-summary">
        <dl className="dssf-run-stats">
          <div><dt>Nhu cầu</dt><dd>{basis.demand_ids.length}</dd></div>
          <div><dt>Outlet phân biệt</dt><dd>{basis.outlet_count ?? missing}</dd></div>
          <div><dt>Tổng khối lượng yêu cầu</dt><dd>{weight(basis.total_required_weight_kg)}</dd></div>          
          <div>
            <dt>Ngày và khung giờ giao chung</dt>

            <dd className="f2-common-window">
              <span>
                {deliveryDate(basis.requested_date)}
              </span>

              <span>
                {timeWindow(
                  basis.common_start_time,
                  basis.common_end_time
                )}
              </span>
            </dd>
          </div>

        </dl>
        {dayWarning && <p className="dssf-notice">{dayWarning}</p>}
      </section>}

      <section className="dssr-panel f2-hub-picker" aria-label="Chọn Hub">
        <label className="dssf-filter">
          <span>Hub cho phương án tập kết</span>
          <select value={hubId} disabled={saving || hubs.loading || !hubs.data?.length} onChange={(event) => {
            setHubId(event.target.value)
            setSelectedPlan(undefined)
            setSaveResults([])
          }}>
            <option value="">Chọn Hub</option>
            {hubs.data?.map((hub) => <option key={hub.id} value={hub.id}>{hub.code} · {hub.name}</option>)}
          </select>
        </label>
        <div>
          {hubs.loading && <p className="dssf-help" role="status">Đang tải danh sách Hub…</p>}
          {hubs.error !== null && <div className="dssf-help" role="alert">{f2ErrorMessage(hubs.error)} <button className="dssr-secondary-button" onClick={hubs.reload}>Tải lại Hub</button></div>}
          {hubs.data?.length === 0 && <p className="dssf-help">Masterdata chưa có Hub hợp lệ.</p>}
          {!!hubs.data?.length && (
            <div className="f2-hub-recommendation">
              <strong>ⓘ Khuyến nghị</strong>

              <p>
                Nên xây dựng phương án lần lượt với cả hai Hub
                để mở rộng phạm vi so sánh và lựa chọn phương án
                vận chuyển tối ưu dựa trên kết quả đánh giá DSS
                (F3–F5).
              </p>
            </div>
          )}
        </div>
      </section>
      {saveResults.length > 0 && <SaveResults results={saveResults} reload={() => {
        comparison.reload()
        hubs.reload()
      }} />}
      {comparison.loading && <div className="dssr-loading" role="status">Đang tải cấu trúc phương án…</div>}
      {options && <>
        {options.persistence === 'MIGRATION_REQUIRED' && <p className="dssf-notice f2-state-note">
          Có thể xem trước và đọc các phương án đã lưu. Cần migration F2 để lưu phương án theo Hub.
        </p>}
        
        <div className="f2-comparison">
          {targets.map((target) => {
            const { option, latest, isSaved } = target
            return (
              <OptionCard key={option.template_type} option={option} demands={demands} evidence={evidence} saved={isSaved}>
                <footer className="f2-plan-actions">
                  {option.structural_status === 'COMPLETE' && !isSaved && (
                    <button type="button" className="dssr-secondary-button f2-save-single" disabled={saving || !allowSave}
                      onClick={() => void savePlans([target])}>
                      {pending.includes(option.template_type) ? 'Đang lưu…' : latest ? 'Lưu phiên bản mới' : 'Lưu phương án'}
                    </button>
                  )}
                </footer>
              </OptionCard>
            )
          })}
        </div>
        <ComparisonOverview targets={targets} allowSave={allowSave} saving={saving} onSave={() => void savePlans(targets)} />
        <SavedOptions
          plans={savedOptions.map(([, plans]) => plans)}
          allocationPath={`${candidatePath}/f3`}
          scenario={scenario}
        />
        
        <InputEvidence options={options} evidence={evidence} />
      </>}
    </main>
  )
}
