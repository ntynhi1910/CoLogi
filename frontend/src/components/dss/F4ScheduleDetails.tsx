import { Fragment, useId, useState } from 'react'
import { timeWindow } from './f1Display'
import { kg, phases, planName } from './f3Display'
import { duration, elapsedMinutes, issues, kilometres, localTime, noValue, roles, statuses, stopIdentity, stopLabel } from './f4Display'
import type { StopNames } from './f4Display'
import { outletWindows, snapshotClock, windowLabels } from './f4GanttWindows'
import type { OutletWindows } from './f4GanttWindows'
import type { F4Diagnostic, F4Evaluation, F4Status, F4Stop, F4Wave } from '../../types/f4'

export function F4StatusBadge({ status }: { status: F4Status }) {
  return <span className={`f4-status f4-status--${status.toLowerCase()}`}>{statuses[status]}</span>
}

export function F4Diagnostics({ rows }: { rows: F4Diagnostic[] }) {
  if (!rows.length) return null
  return <ul className="f4-diagnostics">
    {rows.map((row, index) => <li key={index}>
      {issues[row.code] ?? row.code}
      {row.rules && ` ${row.rules.join(', ')}`}
      {row.from_stop && ` · ${row.from_stop} → ${row.to_stop}`}
      {row.offer_id && ` · Offer #${row.offer_id}`}
    </li>)}
  </ul>
}

export function F4AlternateSlots({ stop, timezone }: { stop: F4Stop; timezone: string }) {
  if (!stop.alternate_slots?.length) return null
  return <section className="dssf-notice f4-alternates" aria-label="Đề xuất slot thay thế">
    <strong>Đề xuất slot thay thế</strong>
    {stop.alternate_slots.map(slot => <div key={slot.start}>
      <p>{localTime(slot.start, timezone)} – {localTime(slot.end, timezone)} · {duration(slot.duration_minutes)} · Chờ xác nhận</p>
      <p>{slot.requires_demand_window_change
        ? 'Slot trống trong lịch nhận nhưng nằm ngoài khung Demand hiện tại. Cần xác nhận khung giao mới và chạy lại F4.'
        : 'Slot nằm trong khung Demand và lịch nhận. Cần Manager chọn và chạy lại F4 cho toàn bộ phương án.'}</p>
    </div>)}
  </section>
}

export function F4StopDetails({ stop, label, timezone, fromCatalog, windows }: {
  stop: F4Stop; label: string; timezone: string; fromCatalog?: boolean; windows?: OutletWindows
}) {
  const requested = stop.requested_window
  const receive = stop.evidence.receiving_calendar?.windows ?? stop.receiving_windows
  const demandWindows = stop.evidence.requested_windows ?? []
  return <div className="f4-stop-detail">
    <div className="f4-card-heading">
      <strong>{label} · {roles[stop.role]}</strong>
      <F4StatusBadge status={stop.status} />
    </div>
    {fromCatalog && <p className="f4-stop-provenance">Tên điểm theo danh mục hiện hành.</p>}
    <div className="f4-stop-detail-grid">
      <section><h3>Điểm dừng và hàng hóa</h3><dl className="f4-stop-times">
        <div><dt>Demand</dt><dd>{stop.demand_codes.join(', ') || noValue}</dd></div>
        <div><dt>Khối lượng</dt><dd>{kg(stop.weight_kg)}</dd></div>
        <div><dt>Di chuyển · Quãng đường</dt><dd>{stop.arrival && stop.travel_from_previous
          ? `${duration(stop.travel_from_previous.minutes)} · ${kilometres(stop.travel_from_previous.distance_km)}` : noValue}</dd></div>
      </dl></section>
      <section><h3>Mốc thời gian</h3><dl className="f4-stop-times">
        <div><dt>Đến</dt><dd>{localTime(stop.arrival, timezone)}</dd></div>
        <div><dt>Chờ</dt><dd>{duration(stop.wait_minutes)}</dd></div>
        <div><dt>Bắt đầu xử lý</dt><dd>{localTime(stop.service_start, timezone)}</dd></div>
        <div><dt>Kết thúc xử lý</dt><dd>{localTime(stop.service_end, timezone)}</dd></div>
        <div><dt>Rời điểm</dt><dd>{localTime(stop.departure, timezone)}</dd></div>
      </dl></section>
      <section><h3>Khung giờ và kiểm tra</h3><dl className="f4-stop-times">
        <div><dt>{stop.role === 'SUPPLIER_PICKUP' ? 'Khung lấy hàng' : 'Khung Demand tại điểm'}</dt>
          <dd>{requested ? timeWindow(requested.start_time, requested.end_time) : noValue}</dd></div>
        {stop.role === 'OUTLET_DELIVERY' && <div><dt>Lịch nhận Outlet</dt><dd>{receive?.map(row =>
          timeWindow(row.start_time, row.end_time)).join(' / ') || noValue}</dd></div>}
      </dl>
        {demandWindows.length > 1 && <ul className="f4-window-sources">
          {demandWindows.map(row => <li key={row.id}>{stop.demand_codes[stop.demand_ids.indexOf(row.id)] ?? `#${row.id}`}
            {' · '}{timeWindow(row.requested_start_time, row.requested_end_time)}</li>)}
        </ul>}
        {windows?.warning && <p className="f4-stop-reason">{windows.warning}</p>}
        {windows && windows.bands.length > 0 && <details>
          <summary>Nguồn từng khung giờ</summary>
          <ul className="f4-window-sources">{windows.bands.map((band, index) => <li key={index}>
            <strong>{windowLabels[band.kind]}</strong>{' · '}
            {localTime(new Date(band.start).toISOString(), timezone)}–{localTime(new Date(band.end).toISOString(), timezone)}
            {' · '}{band.source}
          </li>)}</ul>
        </details>}
        <F4Diagnostics rows={stop.diagnostics} />
        {stop.status === 'NOT_EVALUATED' && !stop.diagnostics.length && <p className="dssf-help">Xem nguyên nhân trong kiểm tra của wave hoặc phương án.</p>}
      </section>
    </div>
    <F4AlternateSlots stop={stop} timezone={timezone} />
  </div>
}

export function F4StopTables({ evaluation, timezone, names }: {
  evaluation: F4Evaluation; timezone: string; names: StopNames
}) {
  if (!evaluation.waves.length) return <section className="dssr-panel f4-card">
    <h2>Chi tiết điểm dừng</h2><F4Diagnostics rows={evaluation.diagnostics} />
  </section>
  const clock = snapshotClock(evaluation.service_date, timezone)
  return <section className="dssr-panel f4-card">
    <h2>Chi tiết điểm dừng</h2>
    {evaluation.waves.map(wave => <WaveStops key={wave.wave_no}
      wave={wave} evaluation={evaluation} timezone={timezone} names={names} clock={clock} />)}
  </section>
}

const stopColumns = ['STT', 'Điểm dừng', 'Đến', 'Chờ', 'Bắt đầu', 'Xử lý', 'Kết thúc', 'Rời điểm', 'Trạng thái']

function WaveStops({ wave, evaluation, timezone, names, clock }: {
  wave: F4Wave; evaluation: F4Evaluation; timezone: string; names: StopNames; clock: (time: string) => number
}) {
  const tableId = useId()
  const [wavesOpen, setWaveOpen] = useState(true)
  const [expanded, setExpanded] = useState<number[]>([])
  const serviceTotal = (accept: (stop: F4Stop) => boolean) => {
    const times = wave.stops.filter(accept).map(stop => elapsedMinutes(stop.service_start, stop.service_end))
    return times.some(time => time === null) ? null : times.reduce<number>((sum, time) => sum + (time ?? 0), 0)
  }
  const pickup = serviceTotal(stop => stop.role === 'SUPPLIER_PICKUP')
  const delivery = serviceTotal(stop => stop.role === 'OUTLET_DELIVERY')
  const hub = serviceTotal(stop => stop.role === 'HUB_RECEIVE' || stop.role === 'HUB_DISPATCH')
  return <section className="f4-wave-table">
    <button type="button" className="f4-wave-toggle" aria-expanded={wavesOpen} aria-controls={tableId}
      onClick={() => setWaveOpen(open => !open)}>
      <span aria-hidden="true">{wavesOpen ? '▾' : '▸'}</span>
      <strong>Wave {wave.wave_no} · {phases[wave.phase]}</strong><F4StatusBadge status={wave.status} />
    </button>
    <div id={tableId} hidden={!wavesOpen}>
      <p className="f4-wave-meta">{wave.vehicle.vehicle_code} · {kg(wave.weight_kg)} trên wave
        {' · '}Lịch wave {localTime(wave.start, timezone)} – {localTime(wave.end, timezone)}
        {' · '}Giờ hoạt động xe {timeWindow(wave.operating_hours.start_time, wave.operating_hours.end_time)}</p>
      <p className="f4-wave-meta">Lấy hàng {duration(pickup)} · Giao hàng {duration(delivery)} · Xử lý tại Hub {duration(hub)}</p>
      <F4Diagnostics rows={wave.diagnostics} />
      <div className="f4-table-scroll f4-stop-table-scroll" tabIndex={0} role="region" aria-label={`Điểm dừng wave ${wave.wave_no}`}>
        <table className="f4-table f4-stops">
          <colgroup><col className="f4-col-sequence" /><col className="f4-col-location" />
            <col span={6} className="f4-col-time" /><col className="f4-col-status" /></colgroup>
          <thead><tr>{stopColumns.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{wave.stops.map(stop => {
            const label = stopLabel(stop, evaluation, names)
            const open = expanded.includes(stop.sequence)
            const detailsId = `${tableId}-stop-${stop.sequence}`
            return <Fragment key={stop.sequence}>
              <tr className="f4-stop-row">
                <td>{stop.sequence}</td>
                <th scope="row">
                  <button type="button" className="f4-stop-toggle" aria-expanded={open} aria-controls={detailsId}
                    onClick={() => setExpanded(rows => open ? rows.filter(row => row !== stop.sequence) : [...rows, stop.sequence])}>
                    <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
                  </button>
                  <small>{roles[stop.role]}</small>
                </th>
                <td>{localTime(stop.arrival, timezone)}</td>
                <td>{duration(stop.wait_minutes)}</td>
                <td>{localTime(stop.service_start, timezone)}</td>
                <td>{duration(elapsedMinutes(stop.service_start, stop.service_end))}</td>
                <td>{localTime(stop.service_end, timezone)}</td>
                <td>{localTime(stop.departure, timezone)}</td>
                <td><F4StatusBadge status={stop.status} />
                  {stop.status !== 'PASS' && <p className="f4-stop-reason">{stop.diagnostics[0]
                    ? issues[stop.diagnostics[0].code] ?? stop.diagnostics[0].code
                    : 'Xem nguyên nhân tại wave hoặc phương án.'}</p>}
                </td>
              </tr>
              <tr id={detailsId} className="f4-stop-expanded" hidden={!open}>
                <td colSpan={stopColumns.length}>{open && <F4StopDetails stop={stop} label={label} timezone={timezone}
                  fromCatalog={stopIdentity(stop, evaluation, names).fromCatalog}
                  windows={outletWindows(stop, clock)} />}</td>
              </tr>
            </Fragment>
          })}</tbody>
        </table>
      </div>
    </div>
  </section>
}

export function F4ComparisonTables({ evaluations, timezone, names }: {
  evaluations: F4Evaluation[]; timezone: string; names: StopNames
}) {
  const id = useId()
  const [opened, setOpened] = useState<string[]>([])
  return <section className="f4-stack f4-comparison-tables" aria-label="Bảng điểm dừng theo phương án">
    <div className="f4-card-heading f4-comparison-actions">
      <h2>Bảng điểm dừng</h2>
      <button type="button" className="dssr-secondary-button" disabled={opened.length === evaluations.length}
        onClick={() => setOpened(evaluations.map(row => row.plan.plan_code))}>Mở tất cả</button>
      <button type="button" className="dssr-secondary-button" disabled={!opened.length}
        onClick={() => setOpened([])}>Thu gọn tất cả</button>
    </div>
    {evaluations.map(row => {
      const code = row.plan.plan_code
      const open = opened.includes(code)
      const metrics = row.metrics
      const panelId = `${id}-${code}`
      return <article key={code} className="dssr-panel f4-card f4-comparison-option">
        <button type="button" className="f4-compare-toggle" aria-expanded={open} aria-controls={panelId}
          onClick={() => setOpened(plans => open ? plans.filter(plan => plan !== code) : [...plans, code])}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span><strong>{planName(row.plan)}</strong>
          <F4StatusBadge status={row.status} />
          <span className="f4-compare-counts">
            <span>{row.waves.length} wave</span>
            <span>Đúng giờ {metrics ? `${metrics.on_time_stops}/${metrics.delivery_stop_count}` : noValue}</span>
            <span>Xung đột {metrics?.conflict_stops ?? noValue}</span>
            <span>Chưa đánh giá {metrics?.not_evaluated_stops ?? noValue}</span>
          </span>
        </button>
        <div id={panelId} hidden={!open}>
          <F4StopTables evaluation={row} timezone={row.configuration?.timezone ?? timezone} names={names} />
        </div>
      </article>
    })}
  </section>
}
