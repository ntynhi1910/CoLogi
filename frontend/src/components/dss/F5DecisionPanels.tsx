import { Fragment, useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { kg, phases, planName } from './f3Display'
import { statuses as f4Status } from './f4Display'
import { dash, decimal, diagnostic, money, number, percent } from './f5Display'
import { getF4Evaluation } from '../../services/dss/f4Service'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F5Component, F5Configuration, F5Issue, F5Option, F5Preview } from '../../types/f5'

export function Savings({ value }: { value: string | null | undefined }) {
  const amount = number(value)
  return <span className={amount === null || amount === 0 ? undefined : amount > 0 ? 'f5-positive' : 'f5-negative'}>
    {money(value, true)}
  </span>
}

const state = { BLOCKED: 'Bị chặn tại F4', NOT_EVALUATED: 'Chưa đủ bằng chứng', EVALUATED: 'Đã tính chi phí' }
const categories = { TRANSPORT: 'Vận chuyển', HUB_HANDLING: 'Xử lý Hub', HANDLING: 'Xử lý tại điểm', OTHER: 'Phụ phí / chờ' }
type Category = keyof typeof categories
const categoryKeys = Object.keys(categories) as Category[]
function outletLabels(data: Pick<F5Preview, 'demands' | 'options'>) {
  const labels = new Map(data.demands.map(row => [row.outlet_id, row.outlet_code || 'Outlet chưa có mã']))
  for (const option of data.options) {
    for (const row of option.allocations) {
      if (row.outlet_code || !labels.has(row.outlet_id)) labels.set(row.outlet_id, row.outlet_code || 'Outlet chưa có mã')
    }
  }
  return labels
}

export function Issues({ issues, outlets }: { issues: F5Issue[]; outlets?: Map<number, string> }) {
  if (!issues.length) return null
  return <ul className="f5-issues">{issues.map((issue, i) => <li key={i}>
    {diagnostic[issue.code] ?? issue.code}{issue.wave_no && ' · Wave ' + issue.wave_no}
    {issue.demand_codes?.length ? ' · ' + issue.demand_codes.join(', ') : ''}
    {issue.outlet_id != null && ' · ' + (outlets?.get(issue.outlet_id) ?? 'Outlet chưa có mã')}
    {issue.scope && ' · ' + issue.scope}
  </li>)}</ul>
}

export function Table({ label, columns, children }: { label: string; columns: string[]; children: ReactNode }) {
  return <div className="f5-table-scroll" tabIndex={0} role="region" aria-label={label}>
    <table className="f5-table" aria-label={label}>
      <thead><tr>{columns.map(title => <th key={title} scope="col">{title}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>
}

export function Rank({ rank }: { rank: number | null | undefined }) {
  return rank == null ? dash : <span className={'f5-badge f5-rank' + (rank === 1 ? ' f5-rank--first' : '')}>Hạng {rank}</span>
}

function evaluated(options: F5Option[]) {
  return options.filter(option => option.status === 'EVALUATED' && number(option.collaborative_cost) !== null)
}

function sum(values: (string | number | null | undefined)[], places = 2) {
  const amounts = values.map(number)
  if (!amounts.length || amounts.some(amount => amount === null)) return null
  const factor = 10 ** places
  return amounts.reduce<number>((total, amount) => total + Math.round(Number(amount) * factor), 0) / factor
}

function axisStep(max: number) {
  if (max <= 0) return 0
  const raw = max / 5
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 2.5, 5, 10].find(value => value >= raw / magnitude) ?? 10) * magnitude
}

function Axis({ steps }: { steps: number[] }) {
  const format = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 })
  return <div className="f5-axis"><div className="f5-axis-ticks">
    {steps.map((tick, index) => <span key={index}>{format.format(tick)}</span>)}
  </div><span>VND</span></div>
}

function benefit(option: F5Option) {
  const savings = option.allocations.map(row => number(row.participant_saving)).filter(value => value !== null)
  return { total: savings.length, positive: savings.filter(value => value > 0).length, negative: savings.filter(value => value < 0).length }
}

function OnTimeStops({ data, code }: { data: F5Preview; code: string | undefined }) {
  const load = useCallback(() => code ? getF4Evaluation(data.run_code, data.group_code, code) : Promise.resolve(null),
    [data.run_code, data.group_code, code])
  const { data: saved, loading } = useDssQuery(load)
  const metrics = saved?.evaluation_code === code && saved?.status === 'PASS' ? saved.result.metrics : null
  return metrics && metrics.delivery_stop_count > 0
    ? metrics.on_time_stops + '/' + metrics.delivery_stop_count + ' điểm giao'
    : loading && code ? 'Đang đọc F4…' : dash
}

function Recommendation({ data, options }: { data: F5Preview; options: F5Option[] }) {
  const recommended = data.recommendation.plan_codes
    .map(code => options.find(option => option.plan.plan_code === code))
    .filter(option => option !== undefined)
  const plan = recommended[0]
  const other = options.find(option => option.rank === 2 && option.plan.plan_code !== plan?.plan.plan_code)
  const distance = plan ? sum(plan.waves.map(wave => wave.distance_km), 6) : null
  const counts = plan ? benefit(plan) : null
  const comparable = data.recommendation.status === 'RECOMMENDED'
  const difference = comparable && plan && other ? sum([other.collaborative_cost, -(number(plan.collaborative_cost) ?? 0)]) : null
  return <section className="dssr-panel f5-panel f5-recommendation" aria-label="Phương án đề xuất">
    <div className="f5-badges">
      <span className="f5-badge f5-rank--first">{data.recommendation.status === 'TIE' ? 'Đồng hạng'
        : data.recommendation.status === 'SINGLE_EVALUATED' ? 'Phương án duy nhất đã tính'
          : comparable && plan ? 'Phương án đề xuất' : 'Đề xuất'}</span>
      {plan?.rank != null && <Rank rank={plan.rank} />}
    </div>
    <h2>{recommended.length ? recommended.map(option => planName(option.plan)).join(' / ') : 'Chờ bằng chứng chi phí'}</h2>
    {data.recommendation.status === 'TIE' ? <p>Các phương án đủ điều kiện này có cùng chi phí thấp nhất.</p>
      : difference !== null && difference > 0 && other
        ? <p>Chi phí thấp hơn <strong>{planName(other.plan)}</strong> {money(difference)}.</p>
        : data.recommendation.status === 'SINGLE_EVALUATED' && plan
          ? <p>Chờ thêm phương án đủ dữ liệu để đối chiếu chi phí.</p>
          : comparable && plan && <p>Chi phí thấp nhất trong các phương án có cùng cơ sở so sánh.</p>}
    {recommended.length === 1 && plan && <dl className="f5-recommendation-metrics">
      <div><dt>Quãng đường F4</dt><dd>{distance === null ? dash : decimal.format(distance) + ' km'}</dd></div>
      <div><dt>Giao đúng giờ</dt><dd><OnTimeStops data={data} code={plan.lineage?.f4_evaluation_code} /></dd></div>
      <div><dt>Luồng hàng</dt><dd>{plan.waves.length ? plan.waves.length + ' wave' : dash}</dd></div>
      <div><dt>Outlet tiết kiệm chi phí</dt><dd>{counts?.total ? counts.positive + '/' + counts.total + ' Outlet' : dash}</dd></div>
    </dl>}
  </section>
}

function TotalChart({ data }: { data: F5Preview }) {
  const rows = [
    { label: 'Giao độc lập', value: number(data.baseline_cost), tone: 'baseline', status: 'Chưa có chi phí', rank: null, key: 'baseline' },
    ...data.options.map(option => ({
      label: planName(option.plan), value: option.status === 'EVALUATED' ? number(option.collaborative_cost) : null,
      status: option.status === 'EVALUATED' ? 'Chưa có chi phí' : state[option.status], key: option.plan.plan_code,
      tone: option.rank === 1 ? 'best' : 'other', rank: option.rank,
    })),
  ]
  const step = axisStep(Math.max(0, ...rows.map(row => row.value ?? 0)))
  return <section className="dssr-panel f5-panel f5-total-chart" aria-label="So sánh tổng chi phí">
    <h2>So sánh tổng chi phí</h2>
    <div className="f5-chart-rows">{rows.map(row => <div className="f5-chart-row" key={row.key}>
      <div className="f5-chart-label"><strong>{row.label}</strong>
        {row.value === null ? <span className="f5-badge">{row.status}</span>
          : <span className="f5-chart-total">{money(row.value)}{row.rank !== null && <Rank rank={row.rank} />}</span>}
      </div>
      {row.value !== null && <div className="f5-total-track" aria-hidden="true">
        <span className={'f5-total-fill f5-total-fill--' + row.tone} style={{ width: (step ? row.value / (5 * step) * 100 : 0) + '%' }} />
      </div>}
    </div>)}</div>
    {step > 0 && <Axis steps={Array.from({length: 6}, (_, i) => i * step)} />}
  </section>
}

export function Overview({ data, actions, saved, eligible }: {
  data: F5Preview; actions: (option: F5Option) => ReactNode; saved: number; eligible: number
}) {
  const priced = evaluated(data.options).slice().sort((a, b) => Number(a.collaborative_cost) - Number(b.collaborative_cost))
  const pricedSavings = priced.filter(option => number(option.cost_saving) !== null)
  const maxSaving = pricedSavings.reduce<F5Option | undefined>((max, option) =>
    max && Number(max.cost_saving) >= Number(option.cost_saving) ? max : option, undefined)
  const outlets = outletLabels(data)
  return <>
    <dl className="f5-kpis f5-kpis--overview">
      <div><dt>Chi phí giao độc lập</dt><dd>{money(data.baseline_cost)}</dd></div>
      <div><dt>Chi phí phối hợp thấp nhất</dt><dd>{money(priced[0]?.collaborative_cost)}</dd></div>
      <div><dt>Tiết kiệm tối đa</dt><dd><Savings value={maxSaving?.cost_saving} /></dd>
        <small>{maxSaving?.saving_rate_pct != null ? percent(maxSaving.saving_rate_pct, true) + ' so với giao riêng' : 'Chưa có tỷ lệ đối chiếu'}</small></div>
      <div><dt>Phương án đã tính</dt><dd>{priced.length}/{data.options.length}</dd>
        <small>{data.persistence_available ? 'Đã lưu ' + saved + '/' + eligible + ' kết quả đủ điều kiện' : 'Đang ở chế độ xem trước'}</small></div>
    </dl>
    <div className="f5-decision-grid"><Recommendation data={data} options={priced} /><TotalChart data={data} /></div>
    <section className="dssr-panel f5-panel">
      <h2>Chi tiết so sánh</h2>
      <Table label="So sánh chi phí F5" columns={['Phương án', 'Trạng thái F4 / F5', 'Tổng chi phí', 'Tiết kiệm', 'Tỷ lệ', 'Thứ hạng']}>
        {data.options.map(option => {
          const ready = option.status === 'EVALUATED' && number(option.collaborative_cost) !== null
          return <tr key={option.plan.plan_code}><th scope="row">{planName(option.plan)}{ready && actions(option)}</th>
            <td>{option.f4_status ? f4Status[option.f4_status] : dash}
              <span className={'f5-badge f5-badge--' + option.status.toLowerCase()}>{state[option.status]}</span>
              {option.status !== 'EVALUATED' && <Issues issues={option.diagnostics} outlets={outlets} />}
              {option.f4_diagnostics.includes('F4_SEQUENCE_NOT_EXHAUSTIVE') && <p>{diagnostic.F4_SEQUENCE_NOT_EXHAUSTIVE}</p>}</td>
            <td>{ready ? money(option.collaborative_cost) : dash}</td>
            <td><Savings value={ready ? option.cost_saving : null} /></td>
            <td>{ready ? percent(option.saving_rate_pct, true) : dash}</td><td>{ready ? <Rank rank={option.rank} /> : dash}</td>
          </tr>
        })}
      </Table>
      <Issues issues={data.diagnostics} outlets={outlets} />
    </section>
  </>
}

const unitLabels: Record<string, string> = { KM: 'km', KG: 'kg', ORDER: 'đơn', MIN: 'phút' }
const distanceLabels: Record<string, string> = {
  FIRST_SERVICE_TO_LAST_SERVICE: 'Từ điểm phục vụ đầu tiên đến điểm phục vụ cuối cùng, không gồm depot hoặc chặng quay về.',
  INCLUDING_DEPOT: 'Bao gồm chặng từ depot đến điểm lấy hàng đầu tiên và chặng quay về.',
}
function formula(item: F5Component) {
  const count = number(item.quantity)
  const unit = unitLabels[item.unit_code]
  const rate = number(item.unit_rate)
  if (count === null || rate === null) return dash
  return decimal.format(count) + (unit ? ' ' + unit : '') + ' × ' +
    decimal.format(rate) + ' VND' + (unit ? '/' + unit : '')
}

export function Components({ items, waves = [] }: { items: F5Component[]; waves?: F5Option['waves'] }) {
  return <Table label="Cấu phần tính giá" columns={['Khoản phí', 'Phạm vi', 'Cách tính', 'Thành tiền']}>
    {items.map((item, i) => {
      const wave = waves.find(row => row.wave_no === item.wave_no)
      const scope = item.wave_no != null
        ? 'Wave ' + item.wave_no + (wave ? ' · ' + phases[wave.phase] : '')
        : item.scope.startsWith('DEMAND/') ? item.scope.slice(7) : 'Cấp phương án'
      return <tr key={i}>
        <th scope="row">{categories[item.component_type]}</th>
        <td>{scope}</td>
        <td>{formula(item)}</td>
        <td><strong>{money(item.amount)}</strong></td>
      </tr>
    })}
  </Table>
}

export function WaveCosts({ option }: { option: F5Option }) {
  return <>
    {option.waves.length > 0 && <Table label="Chi phí theo wave F4" columns={['Wave', 'Chiều', 'Offer', 'Quãng đường F4', 'Chi phí wave']}>
      {option.waves.map(wave => <tr key={wave.wave_no}><th scope="row">{wave.wave_no}</th><td>{phases[wave.phase]}</td>
        <td>#{wave.offer_id}</td><td>{number(wave.distance_km) === null ? dash : decimal.format(Number(wave.distance_km)) + ' km'}</td>
        <td>{money(wave.cost)}</td></tr>)}
    </Table>}
    {!!option.components.length && <Components items={option.components} waves={option.waves} />}
    {!option.waves.length && !option.components.length && <p>Chưa có cấu phần đủ bằng chứng.</p>}
  </>
}

function componentTotals(option: F5Option) {
  return categoryKeys.flatMap(category => {
    const items = option.components.filter(item => item.component_type === category)
    const total = sum(items.map(item => item.amount))
    return total === null ? [] : [{ category, total, items }]
  })
}

function StackedCosts({ options }: { options: F5Option[] }) {
  const [hover, setHover] = useState<string>()
  const [focus, setFocus] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const rows = options.map(option => ({ option, parts: componentTotals(option) }))
  const step = axisStep(Math.max(0, ...rows.map(({ option }) => Number(option.collaborative_cost))))
  const totalWidth = step * 5
  const detail = rows.flatMap(({ option, parts }) => parts.map(part => ({ option, ...part })))
    .find(({ option, category }) => option.plan.plan_code + '/' + category === (hover ?? focus ?? selected))
  const shown = categoryKeys.filter(category => rows.some(row => row.parts.some(part => part.category === category)))
  return <section className="dssr-panel f5-panel">
    <h2>So sánh cấu phần chi phí</h2>
    {!rows.length ? <p>Chưa có phương án đủ bằng chứng để vẽ biểu đồ.</p> : <>
      <ul className="f5-legend">{shown.map(key => <li key={key}><span className={'f5-segment--' + key} />{categories[key]}</li>)}</ul>
      <div className="f5-chart-rows">{rows.map(({ option, parts }) =>
        <div key={option.plan.plan_code} className="f5-chart-row">
          <div className="f5-chart-label"><strong>{planName(option.plan)}</strong><strong>{money(option.collaborative_cost)}</strong></div>
          {parts.some(part => part.total > 0) && <div className="f5-stacked-track">
            {parts.filter(part => part.total > 0).map(part => {
              const key = option.plan.plan_code + '/' + part.category
              const width = totalWidth ? part.total / totalWidth * 100 : 0
              return <button key={key} type="button" className={'f5-segment f5-segment--' + part.category}
                aria-label={planName(option.plan) + ' · ' + categories[part.category] + ' · ' + money(part.total)}
                aria-pressed={selected === key} style={{ width: width + '%' }}
                onPointerEnter={event => { if (event.pointerType !== 'touch') setHover(key) }}
                onPointerLeave={() => setHover(undefined)} onFocus={() => setFocus(key)} onBlur={() => setFocus(undefined)}
                onKeyDown={event => { if (event.key === 'Escape') { setSelected(undefined); setFocus(undefined); setHover(undefined) } }}
                onClick={() => setSelected(current => current === key ? undefined : key)}>
                {width >= 15 ? money(part.total) : ''}
              </button>
            })}
          </div>}
          {!parts.length && (
  <p className="dssf-help">Chưa có cấu phần chi tiết.</p>
)}
          {!!parts.length && sum(parts.map(part => part.total)) !== number(option.collaborative_cost) &&
            <p>Chưa đủ cấu phần để đối chiếu với tổng chi phí.</p>}
        </div>)}</div>
      {step > 0 && <Axis steps={Array.from({ length: 6 }, (_, i) => i * step)} />}
      <div className="f5-chart-inspector" role="status">
        {detail ? <><strong>{planName(detail.option.plan)} · {categories[detail.category]}</strong>
          <span>{money(detail.total)}</span>
          <span>{detail.items.map(item => formula(item)).join(' + ')}</span></>
          : 'Chọn một đoạn thanh để xem khoản phí và cách tính.'}
      </div>
      
    </>}
  </section>
}



export function CostBreakdown({ data }: { data: F5Preview }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  const rows = data.options.map(option => ({
    option,
    parts: componentTotals(option),
  }))

  const componentValue = (
    parts: ReturnType<typeof componentTotals>,
    category: Category
  ) => {
    const part = parts.find(item => item.category === category)
    return part ? money(part.total) : dash
  }

  return (
    <>
      <StackedCosts options={evaluated(data.options)} />

      <section className="dssr-panel f5-panel f5-cost-comparison">
        <div className="f5-cost-comparison-heading">
          <h2>Chi phí theo wave và khoản phí</h2>
          <p>
            So sánh các phương án và chọn xem chi tiết
            để kiểm tra chi phí từng wave.
          </p>
        </div>

        <div className="f5-table-scroll" role="region"
          tabIndex={0} aria-label="So sánh chi phí phương án">
          <table className="f5-table f5-cost-expand-table">
            <thead>
              <tr>
                <th scope="col">Phương án</th>
                <th scope="col">Vận chuyển</th>
                <th scope="col">Xử lý Hub</th>
                <th scope="col">Phí khác</th>
                <th scope="col">Tổng chi phí</th>
                <th scope="col">Chi tiết</th>
              </tr>
            </thead>

            <tbody>
              {rows.map(({ option, parts }) => {
                const code = option.plan.plan_code
                const isOpen = expanded === code
                const isEvaluated = option.status === 'EVALUATED'

                const transport = componentValue(parts, 'TRANSPORT')
                const hub = componentValue(parts, 'HUB_HANDLING')

                const otherParts = parts.filter(part =>
                  part.category !== 'TRANSPORT' &&
                  part.category !== 'HUB_HANDLING'
                )

                const otherTotal = otherParts.length
                  ? sum(otherParts.map(part => part.total))
                  : 0

                return (
                  <Fragment key={code}>
                    <tr className={isOpen ? 'f5-cost-row--active' : ''}>
                      <th scope="row">
                        <strong>{planName(option.plan)}</strong>

                        {!isEvaluated && (
                          <span className="f5-cost-status">
                            {state[option.status]}
                          </span>
                        )}
                      </th>

                      <td>{isEvaluated ? transport : dash}</td>
                      <td>{isEvaluated ? hub : dash}</td>
                      <td>
                        {isEvaluated
                          ? money(otherTotal)
                          : dash}
                      </td>

                      <td className="f5-cost-total">
                        {isEvaluated
                          ? money(option.collaborative_cost)
                          : dash}
                      </td>

                      <td>
                        <button
                          type="button"
                          className="f5-cost-detail-button"
                          aria-expanded={isOpen}
                          onClick={() =>
                            setExpanded(current =>
                              current === code ? null : code
                            )
                          }
                        >
                          {isOpen ? 'Thu gọn ▲' : 'Xem chi tiết ▼'}
                        </button>
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className="f5-cost-expanded-row">
                        <td colSpan={6}>
                          <div className="f5-cost-expanded-content">
                            <div className="f5-cost-expanded-heading">
                              <h3>
                                {planName(option.plan)}
                              </h3>

                              <span>
                                {isEvaluated
                                  ? money(option.collaborative_cost)
                                  : state[option.status]}
                              </span>
                            </div>

                            <Issues
                              issues={option.diagnostics}
                              outlets={outletLabels(data)}
                            />

                            {isEvaluated ? (
                              <WaveCosts option={option} />
                            ) : (
                              <p className="dssf-help">
                                Phương án chưa đủ điều kiện
                                để tính chi phí.
                              </p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}


type AllocationData = Pick<F5Preview, 'configuration' | 'options' | 'total_weight_kg' | 'demands' | 'baseline_cost' | 'baseline_inputs'>

function weight(value: string | number | null | undefined) {
  const amount = number(value)
  return amount === null ? dash : kg(String(amount))
}

function allocationRows(data: AllocationData, options: F5Option[]) {
  return Array.from(outletLabels(data), ([id, label]) => {
    const allocations = options.map(option => option.allocations.find(outlet => outlet.outlet_id === id))
    const reference = allocations.find(value => value !== undefined)
    return { id, label, allocations, share: reference?.share_pct,
      baseline: reference?.baseline_cost, weight: reference?.weight_kg ??
        sum(data.demands.filter(demand => demand.outlet_id === id).map(demand => demand.required_weight_kg), 3) }
  })
}
type OutletRow = ReturnType<typeof allocationRows>[number]

function OutletChart({ rows, options }: { rows: OutletRow[]; options: F5Option[] }) {
  const amounts = rows.flatMap(row => row.allocations.map(outlet => number(outlet?.participant_saving))).filter(value => value !== null)
  if (!amounts.length) return <p>Chưa có kết quả tiết kiệm theo Outlet.</p>
  const max = Math.max(0, ...amounts)
  const min = Math.min(0, ...amounts)
  const step = axisStep(Math.max(max, -min)) || 1
  const positiveLimit = Math.max(step, Math.ceil(max / step) * step)
  const negativeLimit = Math.max(step, Math.ceil(-min / step) * step)
  const size = positiveLimit + negativeLimit
  const zero = 100 * negativeLimit / size
  return <section className="f5-outlet-chart" aria-label="Biểu đồ tiết kiệm theo Outlet">
    <div className="f5-chart-label">
  <h3>Mức tiết kiệm theo Outlet</h3>
</div>
    
<div className="f5-benefit-summary">
  {options.map(option => {
    const counts = benefit(option)
    const total = rows.length
    const missing = Math.max(0, total - counts.total)

    return (
      <div
        className="f5-benefit-line"
        key={option.plan.plan_code}
      >
        <strong className="f5-benefit-plan">
          {planName(option.plan)}
        </strong>

        <div className="f5-benefit-stats">
          <span className="f5-benefit-positive">
            <strong>{counts.positive}/{total}</strong>
            {' '}Outlet hưởng lợi
          </span>

          <span className="f5-benefit-negative">
            <strong>{counts.negative}/{total}</strong>
            {' '}Outlet tăng chi phí
          </span>

          {missing > 0 && (
            <span className="f5-benefit-missing">
              {missing} Outlet chưa có dữ liệu
            </span>
          )}
        </div>
      </div>
    )
  })}
</div>

    <div className="f5-diverging" style={{ '--f5-zero': zero + '%' } as React.CSSProperties}>
<div
  className="f5-diverging-axis"
  aria-hidden="true"
  style={{ ['--f5-zero' as string]: `${zero}%` }}
>
  <span className="f5-axis-negative">Tăng chi phí</span>
  <span className="f5-axis-positive">Tiết kiệm</span>
  <strong className="f5-axis-zero">0</strong>
</div>
      {rows.map(row => <div key={row.id} className="f5-diverging-group">
        <strong>{row.label}</strong>
        {options.map((option, index) => {
          const value = number(row.allocations[index]?.participant_saving)
          return <div className="f5-diverging-row" key={option.plan.plan_code}>
            <span className="f5-diverging-label">{option.plan.hub?.code ?? planName(option.plan)}</span>
            <div className="f5-diverging-track" aria-hidden="true">
              {value !== null && value !== 0 && <span className={value < 0 ? 'f5-impact--negative'
                : option.plan.hub ? 'f5-impact--hub' : 'f5-impact--direct'}
                style={{ left: (value < 0 ? zero + value / size * 100 : zero) + '%', width: Math.abs(value) / size * 100 + '%' }} />}
            </div>
            <div className="f5-diverging-value"><Savings value={row.allocations[index]?.participant_saving} /></div>
          </div>
        })}
      </div>)}
    </div>
  </section>
}

function AllocationPolicy({ config }: { config: F5Configuration | null }) {
  if (!config) return <p>Chờ phương pháp phân bổ và nguồn giá được duyệt.</p>
  return <div className="f5-policy">
    <p>{config.allocation_method === 'WEIGHT'
      ? 'Chi phí phối hợp được chia theo tỷ trọng khối lượng của từng Outlet trong tổng khối lượng nhu cầu.'
      : 'Chi phí phối hợp được chia theo tỷ trọng số đơn của từng Outlet trong tổng số đơn.'}</p>
    <p>{config.rounding_mode === 'HALF_UP' && config.rounding_unit_vnd != null
      ? 'Làm tròn nửa lên đến ' + decimal.format(config.rounding_unit_vnd) + ' VND.' : 'Chưa có thông tin làm tròn.'}
      {config.allocation_residual === 'LARGEST_REMAINDER_OUTLET_ID' &&
        ' Phần dư được chia theo phần lẻ lớn nhất. Khi bằng nhau, Outlet có ID nhỏ hơn được ưu tiên.'}</p>
  </div>
}

export function Allocations({ data }: { data: AllocationData }) {
  const [filter, setFilter] = useState('')
  const options = evaluated(data.options).filter(option => option.allocations.length)
  const selected = options.filter(option => !filter || option.plan.plan_code === filter)
  const rows = allocationRows(data, selected)
 const shortPlanName = (option: F5Option) =>
    planName(option.plan).replace(/^[A-Z0-9_-]+\s*[·\-–:]\s*/i, '').trim()

  const columns = [
    'Outlet',
    'Khối lượng',
    'Tỷ trọng',
    'Chi phí giao độc lập',
    ...selected.map(option => shortPlanName(option)),
  ]
  const shareTotal = sum(rows.map(row => row.share), 4)

  return <section className="dssr-panel f5-panel">
    <div className="f5-panel-heading">
      <h2>Phân bổ chi phí theo Outlet</h2>
      {options.length > 1 && <label className="f5-filter">Phương án
        <select value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="">Tất cả phương án</option>
          {options.map(option => (
            <option key={option.plan.plan_code} value={option.plan.plan_code}>
              {shortPlanName(option)}
            </option>
          ))}
        </select>
      </label>}
    </div>

    <details className="f5-disclosure f5-allocation-method">
      <summary>Phương pháp phân bổ chi phí</summary>
      <AllocationPolicy config={data.configuration} />
    </details>

    {selected.length > 0 && <>
      <OutletChart rows={rows} options={selected} />
      <h3>Đối chiếu phân bổ</h3>
      <p className="f5-mobile-table-hint">Vuốt ngang bảng để xem phân bổ và tiết kiệm của từng phương án.</p>
      <Table label="Đối chiếu phân bổ theo Outlet" columns={columns}>
        {rows.map(row => (
          <tr key={row.id}>
            <th scope="row">{row.label}</th>
            <td>{weight(row.weight)}</td>
            <td>{percent(row.share)}</td>
            <td>{money(row.baseline)}</td>
            {row.allocations.map((allocation, index) => (
  <td key={index} className="f5-plan-cell">
    <div className="f5-plan-metric">
      <span className="f5-plan-label">Phân bổ</span>
      <strong className="f5-plan-value">{money(allocation?.allocated_cost)}</strong>
    </div>
    <div className="f5-plan-metric">
      <span className="f5-plan-label">Tiết kiệm</span>
      <span className="f5-plan-value">
        <Savings value={allocation?.participant_saving} />
      </span>
    </div>
  </td>
))}
          </tr>
        ))}
        <tr className="f5-total-row">
          <th scope="row">Tổng</th>
          <td>{weight(data.total_weight_kg)}</td>
          <td>{percent(shareTotal?.toString())}</td>
          <td>{money(data.baseline_cost)}</td>
          {selected.map((option, index) => {
  const totalCost = sum(rows.map(row => row.allocations[index]?.allocated_cost))
  const totalSaving = sum(rows.map(row => row.allocations[index]?.participant_saving))
  return (
    <td key={option.plan.plan_code} className="f5-plan-cell f5-plan-cell--total">
      <div className="f5-plan-metric">
        <span className="f5-plan-label">Tổng phân bổ</span>
        <strong className="f5-plan-value">{money(totalCost)}</strong>
      </div>
      <div className="f5-plan-metric">
        <span className="f5-plan-label">Tổng tiết kiệm</span>
        <span className="f5-plan-value">
          <Savings value={totalSaving?.toString()} />
        </span>
      </div>
    </td>
  )
})}
        </tr>
      </Table>
    </>}
    {selected.length === 0 && <p>Chưa có kết quả phân bổ.</p>}
    <details className="f5-disclosure"><summary>Tập Demand và chi phí giao độc lập</summary>
      <Table label="Đầu vào giao độc lập" columns={['Demand', 'Outlet', 'Khối lượng', 'Cự ly giao riêng', 'Chi phí giao độc lập']}>
        {data.demands.map(demand => {
          const input = data.baseline_inputs.find(row => row.demand_id === demand.id)
          const rawDistance = input?.distance_evidence?.distance_km
          const km = typeof rawDistance === 'string' || typeof rawDistance === 'number' ? number(rawDistance) : null
          return <tr key={demand.id}><th scope="row">{demand.code}</th><td>{demand.outlet_code || dash}</td>
            <td>{weight(demand.required_weight_kg)}</td>
            <td>{km === null ? dash : decimal.format(km) + ' km'}</td>
            <td>{money(input?.amount)}</td></tr>
        })}
      </Table>
    </details>
  </section>
}



export function Sources({ data }: { data: F5Preview }) {
  const config = data.configuration
  const outlets = outletLabels(data)

  const allComponents = [
    ...data.baseline_inputs.flatMap(row => row.components),
    ...data.options.flatMap(row => row.components),
  ]

  const rates = [
    ...new Set(
      allComponents
        .filter(item => item.pricing_basis === 'PER_KM')
        .map(item => item.unit_rate)
        .filter(Boolean),
    ),
  ]

  const hubFees = data.options.flatMap(option =>
    option.status === 'EVALUATED'
      ? option.components
          .filter(item =>
            item.component_type === 'HUB_HANDLING' &&
            item.wave_no == null
          )
          .map(item => ({ option, item }))
      : [],
  )

  return (
    <div className="f5-sources-layout">
      <section className="dssr-panel f5-panel f5-method-panel">
        <h2>Phương pháp tính chi phí</h2>

        <div className="f5-method-grid">
          <article className="f5-method-card">
            <div className="f5-method-icon" aria-hidden="true">🚚</div>
            <div>
              <h3>Chi phí giao độc lập</h3>
              <p>Tổng chi phí khi giao riêng từng nhu cầu.</p>
            </div>
          </article>

          <article className="f5-method-card">
            <div className="f5-method-icon" aria-hidden="true">🤝</div>
            <div>
              <h3>Chi phí phối hợp</h3>
              <p>Tổng các khoản phí hợp lệ của phương án.</p>
            </div>
          </article>

          <article className="f5-method-card">
            <div className="f5-method-icon" aria-hidden="true">💰</div>
            <div>
              <h3>Mức tiết kiệm</h3>
              <p>Chi phí giao độc lập trừ chi phí phối hợp.</p>
            </div>
          </article>

          <article className="f5-method-card">
            <div className="f5-method-icon" aria-hidden="true">📊</div>
            <div>
              <h3>Tỷ lệ tiết kiệm</h3>
              <p>Mức tiết kiệm chia cho chi phí giao độc lập, nhân 100 nếu baseline lớn hơn 0.</p>
            </div>
          </article>
        </div>
      </section>
      <section className="dssr-panel f5-panel f5-sources-hero">
        <div className="f5-sources-head">
          <div>
            <h2>Nguồn giá thực sự sử dụng</h2>
            <p>Thông tin đơn giá được sử dụng để đánh giá chi phí vận chuyển.</p>
          </div>
        </div>

        {!data.price_evidence ? (
          <p className="dssr-alert" role="alert">
            Chưa có nguồn giá hợp lệ cho lần đánh giá này.
          </p>
        ) : (
          <>
            <div className="f5-source-kpis">
              <article className="f5-source-kpi f5-source-kpi--primary">
                <span className="f5-source-kpi-label">Đơn giá vận chuyển</span>
                <strong className="f5-source-kpi-value">
                  {rates.length
                    ? rates.map(rate => decimal.format(Number(rate))).join(' · ')
                    : dash}
                  {rates.length > 0 && <small> VND/km</small>}
                </strong>
              </article>

              <article className="f5-source-kpi">
                <span className="f5-source-kpi-label">Chi phí giao độc lập</span>
                <strong className="f5-source-kpi-value">{money(data.baseline_cost)}</strong>
              </article>

              <article className="f5-source-kpi">
                <span className="f5-source-kpi-label">Tổng nhu cầu</span>
                <strong className="f5-source-kpi-value">{data.demands.length}</strong>
              </article>
            </div>

            <div className="f5-source-sections">
              <section className="f5-source-card">
                <h3>Phạm vi tính quãng đường</h3>
                <p>
                  {config?.distance_basis
                    ? distanceLabels[config.distance_basis] ?? dash
                    : dash}
                </p>
              </section>

              <section className="f5-source-card">
                <h3>Phí xử lý tại Hub</h3>
                {hubFees.length > 0 ? (
                  <div className="f5-source-list">
                    {hubFees.map(({ option, item }, index) => (
                      <div
                        className="f5-source-row"
                        key={`${option.plan.plan_code}/${index}`}
                      >
                        <span>{planName(option.plan)}</span>
                        <strong>{money(item.amount)}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>Không phát sinh phí xử lý tại Hub.</p>
                )}
              </section>

              <section className="f5-source-card f5-source-card--full">
                <h3>Chi phí giao độc lập theo nhu cầu</h3>
                {data.baseline_inputs.length > 0 ? (
                  <div className="f5-source-list">
                    {data.baseline_inputs.map(row => (
                      <div className="f5-source-row" key={row.demand_id}>
                        <span>{row.demand_code}</span>
                        <strong>{money(row.amount)}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>Chưa có dữ liệu chi phí giao độc lập.</p>
                )}
              </section>
            </div>
          </>
        )}

        <Issues issues={data.diagnostics} outlets={outlets} />
      </section>

      
    </div>
  )
}


