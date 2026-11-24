import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, FocusEvent, PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { deliveryDate } from './f1Display'
import { kg, phases, planName } from './f3Display'
import { duration, localTime, statuses, stopIdentity, stopLabel } from './f4Display'
import type { StopNames } from './f4Display'
import { F4Diagnostics, F4StatusBadge, F4StopDetails } from './F4ScheduleDetails'
import type { F4Evaluation, F4Stop, F4Wave } from '../../types/f4'
import { outletWindows, snapshotClock, windowLabels } from './f4GanttWindows'
import type { OutletWindows } from './f4GanttWindows'
import './F4GanttChart.css'

const segmentLabels = {
  travel: 'Di chuyển', wait: 'Chờ', pickup: 'Lấy hàng', hub: 'Xử lý / bàn giao Hub', delivery: 'Giao hàng',
}
const serviceKind = {
  SUPPLIER_PICKUP: 'pickup', HUB_RECEIVE: 'hub', HUB_DISPATCH: 'hub', OUTLET_DELIVERY: 'delivery',
} as const
const rowHeight = 46
const minute = 60_000
const stamp = (value?: string | null) => value ? Date.parse(value) : NaN

function timeScale(evaluations: F4Evaluation[], windows: OutletWindows[]) {
  const scheduled = evaluations.flatMap(evaluation => evaluation.waves.flatMap(wave =>
    wave.stops.flatMap(stop => [stop.arrival, stop.service_start, stop.service_end, stop.departure].map(stamp)),
  )).filter(Number.isFinite)
  const bands = windows.flatMap(window => window.bands)
  const requested = bands.filter(band => band.kind === 'requested')
  const visibleWindows = scheduled.length || requested.length ? requested : bands
  const times = [...scheduled, ...visibleWindows.flatMap(band => [band.start, band.end])]
  if (!times.length) return null
  const first = Math.min(...times)
  const last = Math.max(...times)
  const step = ([15, 30, 60, 120, 240].find(value => (last - first) / minute <= value * 8) ?? 480) * minute
  const start = Math.floor(first / step) * step
  const end = Math.max(start + step, Math.ceil(last / step) * step)
  const position = (time: number) => 100 * (time - start) / (end - start)
  return { start, end, position, ticks: Array.from({ length: (end - start) / step + 1 }, (_, index) => start + index * step) }
}

function segments(stop: F4Stop, previous?: F4Stop) {
  const arrival = stamp(stop.arrival)
  const start = stamp(stop.service_start)
  const end = stamp(stop.service_end)
  const parts = [
    { kind: 'travel', start: stamp(previous?.departure), end: stop.travel_from_previous ? arrival : NaN },
    { kind: 'wait', start: arrival, end: start },
    { kind: serviceKind[stop.role], start, end },
  ] as const
  return parts.filter(part => Number.isFinite(part.start) && Number.isFinite(part.end) && part.end > part.start)
}

type PlotRow = { wave: F4Wave; stop?: F4Stop; previous?: F4Stop }

function hubConnections(rows: PlotRow[]) {
  return rows.flatMap(({ stop, wave }, index) => {
    const release = stop?.evidence.inbound_released_at
    if (stop?.role !== 'HUB_DISPATCH' || !release || !stop.service_start) return []
    return rows.flatMap((inbound, from) => {
      if (inbound.stop?.role !== 'HUB_RECEIVE' || !inbound.stop.service_end) return []
      const ready = inbound.stop.service_end
      if (!inbound.stop.demand_ids.some(id => release[id] === ready)) return []
      return [{ from, to: index, start: ready, end: stop.service_start,
        inboundWave: inbound.wave.wave_no, outboundWave: wave.wave_no }]
    })
  })
}

export default function F4GanttChart({ evaluations, visible, timezone, names }: {
  evaluations: F4Evaluation[]
  visible: F4Evaluation[]
  timezone: string
  names: StopNames
}) {
  const detailsId = useId()
  const canvasRef = useRef<HTMLDivElement>(null)
  const axisRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const detailsRef = useRef<HTMLElement>(null)
  const [wideNames, setWideNames] = useState(false)
  const [tip, setTip] = useState<{ text: string; left: number; top: number; above: boolean }>()
  const [chosen, setChosen] = useState<{ plan: string; wave: number; sequence: number }>()
  const chosenPlan = visible.find(evaluation => evaluation.plan.plan_code === chosen?.plan)
  const chosenStop = chosenPlan?.waves.find(wave => wave.wave_no === chosen?.wave)
    ?.stops.find(stop => stop.sequence === chosen?.sequence)
  const windows = new Map(evaluations.flatMap(evaluation => {
    const clock = snapshotClock(evaluation.service_date, evaluation.configuration?.timezone ?? timezone)
    return evaluation.waves.flatMap(wave => wave.stops.map(stop => [stop, outletWindows(stop, clock)] as const))
  }))
  const scale = timeScale(evaluations, [...windows.values()])
  const calendarBeyondAxis = scale && visible.some(evaluation => evaluation.waves.some(wave => wave.stops.some(stop =>
    windows.get(stop)?.bands.some(band => band.kind === 'receiving' && (band.start < scale.start || band.end > scale.end)),
  )))
  const clock = (time: number) => localTime(new Date(time).toISOString(), timezone)

  useEffect(() => {
    const canvas = canvasRef.current
    const header = canvas?.closest('.app-main')?.querySelector('.app-header')
    if (!canvas || !header) return
    const resize = new ResizeObserver(() => {
      canvas.style.setProperty('--f4-sticky-top', `${header.getBoundingClientRect().height}px`)
    })
    resize.observe(header)
    return () => resize.disconnect()
  }, [])

  useEffect(() => {
    if (!tip) return
    const dismiss = () => setTip(undefined)
    window.addEventListener('scroll', dismiss, { capture: true, passive: true })
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [tip])

  function describe(text: string) {
    function show(event: FocusEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) {
      const rect = event.currentTarget.getBoundingClientRect()
      const above = rect.bottom > window.innerHeight * .7
      setTip({ text, left: Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - 364)),
        top: above ? rect.top - 6 : rect.bottom + 6, above })
    }
    return { onFocus: show, onPointerEnter: show, onBlur: () => setTip(undefined),
      onPointerLeave: () => setTip(undefined) }
  }

  function syncAxis() {
    if (axisRef.current && scrollRef.current) axisRef.current.scrollLeft = scrollRef.current.scrollLeft
  }

  function inspect(evaluation: F4Evaluation, wave: F4Wave, stop: F4Stop) {
    setTip(undefined)
    setChosen({ plan: evaluation.plan.plan_code, wave: wave.wave_no, sequence: stop.sequence })
    detailsRef.current?.focus()
  }

  const chosenIdentity = chosenPlan && chosenStop && stopIdentity(chosenStop, chosenPlan, names)
  return <section className="dssr-panel f4-card f4-gantt" aria-label="Biểu đồ Gantt F4">
    <header className="f4-card-heading">
      <div><h2>Biểu đồ Gantt</h2><p className="dssf-help">Giờ địa phương · {timezone}</p></div>
      <button type="button" className="dssr-secondary-button f4-gantt-name-toggle" aria-pressed={wideNames}
        onClick={() => setWideNames(open => !open)}>{wideNames ? 'Thu gọn tên điểm' : 'Mở rộng tên điểm'}</button>
    </header>
    <ul className="f4-gantt-legend" aria-label="Chú giải biểu đồ">
      {Object.entries(segmentLabels).map(([key, label]) =>
        <li key={key}><span className={`f4-gantt-swatch f4-gantt--${key}`} aria-hidden="true" />{label}</li>)}
      <li><span className="f4-gantt-swatch f4-gantt--conflict" aria-hidden="true">!</span>Xung đột</li>
      <li><span className="f4-gantt-swatch f4-gantt--unknown" aria-hidden="true">–</span>Chưa đánh giá</li>
      <li><span className="f4-gantt-swatch f4-gantt--release" aria-hidden="true" />Phụ thuộc Hub</li>
      {Object.entries(windowLabels).map(([kind, label]) =>
        <li key={kind}><span className={`f4-gantt-swatch f4-gantt-window--${kind}`} aria-hidden="true" />{label}</li>)}
    </ul>
    {calendarBeyondAxis && <p className="dssf-help f4-gantt-window-note">Xem chi tiết điểm dừng để đọc phần lịch nhận nằm ngoài trục giờ.</p>}
    <div ref={canvasRef} className={`f4-gantt-canvas${wideNames ? ' f4-gantt-canvas--wide' : ''}`}
      style={{ '--f4-row-height': `${rowHeight}px` } as CSSProperties}>
      <div className="f4-gantt-sticky">
        <div className="f4-gantt-axis-scroll" ref={axisRef}>
          <div className="f4-gantt-grid f4-gantt-row f4-gantt-axis">
            <span className="f4-gantt-fixed">Điểm dừng</span>
            <div className="f4-gantt-track">
              {scale ? scale.ticks.map(tick => <time key={tick} dateTime={new Date(tick).toISOString()}
                style={{ left: `${scale.position(tick)}%` }}>{clock(tick)}</time>)
                : <span>Chưa có mốc thời gian</span>}
            </div>
          </div>
        </div>
      </div>
      <div className="f4-gantt-scroll" ref={scrollRef} onScroll={syncAxis} tabIndex={0} role="region" aria-label="Lịch theo trục thời gian">
        <div className="f4-gantt-grid">
        {visible.map(evaluation => {
          const rows: PlotRow[] = evaluation.waves.flatMap(wave => [
            { wave }, ...wave.stops.map((stop, index) => ({ wave, stop, previous: wave.stops[index - 1] })),
          ])
          const connections = hubConnections(rows)
          const finish = stamp(evaluation.metrics?.completed_at)
          return <section key={evaluation.plan.plan_code} className="f4-gantt-option" aria-label={planName(evaluation.plan)}>
            <div className="f4-gantt-option-heading">
              <strong>{planName(evaluation.plan)}</strong><F4StatusBadge status={evaluation.status} />
              {Number.isFinite(finish) && <span>Hoàn thành <strong>{clock(finish)}</strong></span>}
              {evaluation.service_date && <span>{deliveryDate(evaluation.service_date)}</span>}
            </div>
            {rows.length > 0 ? <>
              <div className="f4-gantt-plot">
                {scale && <div className="f4-gantt-gridlines" aria-hidden="true">
                  {scale.ticks.map(tick => <i key={tick} style={{ left: `${scale.position(tick)}%` }} />)}
                  {Number.isFinite(finish) && <i className="f4-gantt-finish" style={{ left: `${scale.position(finish)}%` }} />}
                </div>}
                {scale && connections.length > 0 && <svg className="f4-gantt-connectors" aria-hidden="true"
                  viewBox={`0 0 1000 ${rows.length * rowHeight}`} preserveAspectRatio="none">
                  {connections.map(({ from, to, start, end }) => {
                    const x1 = scale.position(stamp(start)) * 10
                    const x2 = scale.position(stamp(end)) * 10
                    return <path key={`${from}/${to}`} vectorEffect="non-scaling-stroke"
                      d={`M ${x1} ${(from + .5) * rowHeight} V ${(to + .5) * rowHeight} H ${x2}`} />
                  })}
                </svg>}
                {rows.map(({ wave, stop, previous }) => {
                  if (!stop) return <div key={`wave-${wave.wave_no}`} className="f4-gantt-row f4-gantt-wave">
                    <strong className="f4-gantt-fixed" title={phases[wave.phase]}>Wave {wave.wave_no} · {phases[wave.phase]}</strong>
                    <div><F4StatusBadge status={wave.status} /></div>
                  </div>
                  const key = `${wave.wave_no}/${stop.sequence}`
                  const label = stopLabel(stop, evaluation, names)
                  const identity = stopIdentity(stop, evaluation, names)
                  const description = `${label}${identity.fromCatalog ? ' (tên theo danh mục hiện hành)' : ''}`
                  const intervals = windows.get(stop)
                  const selected = stop === chosenStop
                  const arrival = stamp(stop.arrival)
                  const conflict = stop.status === 'HARD_CONFLICT' || stop.status === 'SOFT_CONFLICT'
                  const deadline = intervals?.deadline
                  const late = conflict && deadline != null && arrival > deadline
                  return <div key={key} className="f4-gantt-row" data-wave={wave.wave_no} data-stop={stop.sequence}>
                    <button type="button" className="f4-gantt-stop f4-gantt-fixed" aria-label={description} aria-controls={detailsId} {...describe(description)}
                      aria-pressed={selected} onClick={() => inspect(evaluation, wave, stop)}>
                      <strong>{stop.sequence}. {identity.code}</strong>
                      {identity.name && identity.name !== identity.code && <span>{identity.name}</span>}
                    </button>
                    <div className="f4-gantt-track">
                      {scale && intervals?.bands.map((band, index) => {
                        const start = Math.max(band.start, scale.start)
                        const end = Math.min(band.end, scale.end)
                        if (end <= start) return null
                        const text = `${label} · ${windowLabels[band.kind]} ${clock(band.start)}–${clock(band.end)} · ${band.source}`
                        return <button key={`${band.kind}/${index}`} type="button" className={`f4-gantt-band f4-gantt-window--${band.kind}`}
                          data-band={band.kind} data-start={band.start} data-end={band.end} aria-label={text} aria-controls={detailsId}
                          {...describe(text)} onClick={() => inspect(evaluation, wave, stop)}
                          style={{ left: `${scale.position(start)}%`, width: `${scale.position(end) - scale.position(start)}%` }} />
                      })}
                      {scale && segments(stop, previous).map(part =>
                        <button key={part.kind} type="button" className={`f4-gantt-bar f4-gantt--${part.kind}`}
                          data-kind={part.kind} data-start={part.start} data-end={part.end}
                          style={{ left: `${scale.position(part.start)}%`, width: `${scale.position(part.end) - scale.position(part.start)}%` }}
                          aria-label={`${label} · ${segmentLabels[part.kind]} · ${clock(part.start)} – ${clock(part.end)}`}
                          aria-controls={detailsId} aria-pressed={selected} onClick={() => inspect(evaluation, wave, stop)} />)}
                      {scale && conflict && Number.isFinite(arrival) &&
                        <button type="button" className="f4-gantt-marker f4-gantt--conflict"
                          data-arrival={arrival}
                          style={{ left: `${scale.position(arrival)}%` }}
                          aria-label={`${label} · ${statuses[stop.status]} · ${clock(arrival)}`} aria-controls={detailsId}
                          onClick={() => inspect(evaluation, wave, stop)}>!</button>}
                      {scale && late && <>
                        <span className="f4-gantt-deadline" data-deadline={deadline}
                          style={{ left: `${scale.position(deadline)}%` }}>Hạn {clock(deadline)}</span>
                        <span className="f4-gantt-arrival-time" style={{ left: `${scale.position(arrival)}%` }}>Đến {clock(arrival)}</span>
                      </>}
                      {(!Number.isFinite(arrival) || stop.status === 'NOT_EVALUATED') &&
                        <span className={`f4-gantt-unplaced ${conflict ? 'f4-gantt--conflict' : 'f4-gantt--unknown'}`}>
                          {stop.status === 'NOT_EVALUATED' ? 'Chưa đánh giá' : statuses[stop.status]}
                        </span>}
                      {intervals?.warning && <button type="button" className="f4-gantt-window-warning"
                        aria-label={intervals.warning} aria-controls={detailsId} {...describe(intervals.warning)}
                        onClick={() => inspect(evaluation, wave, stop)}>Thiếu khung giờ</button>}
                    </div>
                  </div>
                })}
              </div>
              {!!connections.length && <ul className="f4-gantt-dependencies">
                {connections.map(({ from, to, start, end, inboundWave, outboundWave }) =>
                  <li key={`${from}/${to}`}>Wave {inboundWave} sẵn hàng {localTime(start, timezone)}
                    {' → '}Wave {outboundWave} bắt đầu bàn giao {localTime(end, timezone)}</li>)}
              </ul>}
              {evaluation.metrics && <dl className="f4-gantt-totals">
                <div><dt>Di chuyển</dt><dd>{duration(evaluation.metrics.travel_minutes)}</dd></div>
                <div><dt>Chờ</dt><dd>{duration(evaluation.metrics.wait_minutes)}</dd></div>
                {evaluation.plan.hub && <div><dt>Xử lý tại Hub</dt><dd>{duration(evaluation.metrics.hub_handling_minutes)}</dd></div>}
                {evaluation.demand_weight_kg && <div><dt>Khối lượng nhu cầu</dt><dd>{kg(evaluation.demand_weight_kg)}</dd></div>}
              </dl>}
            </> : <F4Diagnostics rows={evaluation.diagnostics} />}
          </section>
        })}
        </div>
      </div>
    </div>
    <section id={detailsId} ref={detailsRef} tabIndex={-1} className="f4-gantt-detail" aria-label="Chi tiết điểm trên biểu đồ">
      {chosenPlan && chosenStop
        ? <F4StopDetails stop={chosenStop} label={stopLabel(chosenStop, chosenPlan, names)} timezone={timezone}
          fromCatalog={chosenIdentity ? chosenIdentity.fromCatalog : false} windows={windows.get(chosenStop)} />
        : <p className="dssf-help">Chọn một thanh hoặc điểm dừng để xem chi tiết.</p>}
    </section>
    {tip && createPortal(<div className="f4-gantt-tooltip" aria-hidden="true"
      style={{ left: tip.left, top: tip.top, transform: tip.above ? 'translateY(-100%)' : undefined }}>{tip.text}</div>, document.body)}
  </section>
}
