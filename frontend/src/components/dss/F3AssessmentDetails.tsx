import { deliveryDate, missing, timeWindow } from './f1Display'
import { gateLabels, kg, label, phases, planName, providerName, utilization } from './f3Display'
import type { F2PlanSummary, F2Stop } from '../../types/f2'
import type { F3Diagnostic, F3HubCoverage, F3Presentation, F3Wave, ValidF3Evaluation } from '../../types/f3'


function HubCoverage({ coverage, plan, provider }: {
  coverage: F3HubCoverage
  plan: F2PlanSummary
  provider: string | null
}) {
  return (
    <section className="dssf-technical f3-hub-coverage" aria-label="Bằng chứng phạm vi phục vụ Hub">
      <h3>Phạm vi phục vụ Hub</h3>
      <p>{planName(plan)} · {provider || 'Chưa xác định nhà vận chuyển'} · {deliveryDate(coverage.service_date)}</p>
      {coverage.uses_synthetic && <p className="dssf-notice">
        <strong>Dữ liệu mô phỏng</strong> · <code>{
          coverage.context === 'INTERNAL_PLANNING' ? 'Giả định nội bộ đã duyệt' :
            coverage.context === 'CAPSTONE' ? 'SYNTHETIC/CAPSTONE' : 'SYNTHETIC/UAT'
        }</code>
      </p>}
      {(['INBOUND', 'OUTBOUND'] as const).map(phase => (
        <div key={phase}>
          <h4>{phases[phase]}</h4>
          <ul className="f3-list">
            {coverage.routes.filter(route => route.phase === phase).map(route => {
              const inbound = phase === 'INBOUND'
              const endpoint = route.endpoint_code || (inbound ? `NCC #${route.supplier_id}` : `Outlet #${route.outlet_id}`)
              const hub = plan.hub?.code
              const evidence = route.evidence
              return <li key={route.supplier_id ?? route.outlet_id}>
                <strong>{inbound ? `${endpoint} → ${hub}` : `${hub} → ${endpoint}`}</strong>
                {' · '}{route.status === 'VERIFIED' ? 'Đã xác minh tuyến' : 'Chưa xác minh tuyến'}
                {route.reason && <div>{label(route.reason)}</div>}
                {evidence && <div>
                  {label(evidence.source)} · {label(evidence.confirmation_status)} · <code>{evidence.source_reference}</code>
                  {' · '}{deliveryDate(evidence.valid_from)} – {deliveryDate(evidence.valid_through)}
                </div>}
              </li>
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}


function stopName(stop?: F2Stop) {
  if (!stop) return missing
  return stop.code || (stop.kind === 'SUPPLIER' ? `NCC #${stop.entity_id}` : `#${stop.entity_id}`)
}

export function F3Diagnostics({ rows, check }: { rows: F3Diagnostic[]; check?: string }) {
  if (!rows.length) return null
  return (
    <ul className={check ? 'f3-list' : 'dssf-notice f3-diagnostics'} aria-label={check ? `Chẩn đoán ${check}` : 'Chẩn đoán F3'}>
      {rows.map((item, index) => <li key={index}>
        {item.phase ? `${phases[item.phase as keyof typeof phases]} · ` : ''}
        {item.supplier_id ? `NCC #${item.supplier_id} · ` : ''}
        {item.outlet_id ? `Outlet #${item.outlet_id} · ` : ''}
        {item.demand_id ? `Nhu cầu #${item.demand_id} · ` : ''}
        {label(item.code)}{item.reason && ` · ${label(item.reason)}`}
        {item.values && ` · ${item.values.join(', ')}`}
      </li>)}
    </ul>
  )
}

function WaveDetail({ wave, stops, provider, offers }: {
  wave: F3Wave
  stops: Map<string, F2Stop>
  provider: ValidF3Evaluation['provider']
  offers: ValidF3Evaluation['offers']
}) {
  const vehicle = wave.vehicle
  const spare = (Number(vehicle.capacity_kg) - Number(wave.allocated_weight_kg)).toFixed(3)
  const compatible = wave.cargo_compatibility.length > 0 && wave.cargo_compatibility.every(row => row.is_supported)
  const smallerCapacity = Math.max(0, ...offers.filter(offer =>
    offer.available_vehicle_count > 0 && Number(offer.capacity_kg) < Number(wave.allocated_weight_kg)
    && wave.cargo_compatibility.every(group => offer.cargo_compatibility.some(row =>
      row.cargo_category_id === group.cargo_category_id && row.is_supported === true,
    )),
  ).map(offer => Number(offer.capacity_kg)))
  return (
    <article className="f3-wave">
      <header className="f3-wave-heading">
        <div>
          <p className="dssr-eyebrow">Wave {wave.wave_no} · {phases[wave.phase]}</p>
          <h3>{vehicle.vehicle_name}</h3>
          <p><strong>{vehicle.vehicle_code}</strong> · Offer #{vehicle.offer_id} · {providerName(provider)}</p>
        </div>
        <span className="f3-chip">{wave.allocations.length} nhu cầu</span>
      </header>
      <dl className="dssf-facts f3-wave-facts">
        <div><dt>Sức chứa xe</dt><dd>{kg(vehicle.capacity_kg)}</dd></div>
        <div><dt>Đã phân bổ</dt><dd>{kg(wave.allocated_weight_kg)}</dd></div>
        <div><dt>Tải trọng còn dư</dt><dd>{kg(spare)}</dd></div>
        <div><dt>Hiệu suất tải</dt><dd>{utilization(wave.utilization_pct)}</dd></div>
      </dl>
      <progress className="f3-load-progress" value={Number(wave.allocated_weight_kg)} max={Number(vehicle.capacity_kg)}
        aria-label={`Wave ${wave.wave_no}: ${kg(wave.allocated_weight_kg)} trên ${kg(vehicle.capacity_kg)}`} />
      <h4>Lý do đề xuất</h4>
      <ul className="f3-wave-evidence f3-list">
        <li>Một xe có sức chứa {kg(vehicle.capacity_kg)} chở được {kg(wave.allocated_weight_kg)} trên wave này.</li>
        {smallerCapacity > 0 && <li>Trong các offer đã đối chiếu, một xe {kg(String(smallerCapacity))} thiếu sức chứa cho toàn bộ wave.</li>}
        {compatible && <li>Tương thích tất cả {wave.cargo_compatibility.length} nhóm hàng trên wave.</li>}
        <li>{vehicle.available_vehicle_count} xe khả dụng theo bằng chứng CP7, dùng chung cho các wave cùng offer.</li>
      </ul>
      <details className="dssf-technical">
        <summary>Nhu cầu và luồng hàng</summary>
        <ul className="f3-list">
          {wave.allocations.map(row => <li key={row.demand_id}>
            <strong>{row.demand_code}</strong> · {kg(row.weight_kg)} · {stopName(stops.get(row.from_stop))} → {stopName(stops.get(row.to_stop))}
          </li>)}
        </ul>
        <p className="dssf-help">Luồng hàng từ bản nháp F2. Thứ tự ghé điểm chờ F4.</p>
      </details>
      <details className="dssf-technical">
        <summary>Bằng chứng khả dụng và tương thích</summary>
        <p>{label(vehicle.status)} · {vehicle.available_vehicle_count} trong {vehicle.offer_vehicle_count} xe của offer.</p>
        <ul className="f3-list">
          {vehicle.windows.map(window => <li key={window.id}>
            {deliveryDate(window.service_date)} · {timeWindow(window.start_time, window.end_time)} · {window.count} xe · {label(window.source)} · {label(window.status)}
          </li>)}
          {wave.cargo_compatibility.map(row => <li key={row.cargo_category_id}>
            Nhóm #{row.cargo_category_id} · {row.is_supported ? 'Tương thích' : 'Chưa xác minh'}{row.source && ` · ${row.source}`}
          </li>)}
        </ul>
        {wave.supplier_coverage.length > 0 && <p>Quyền lấy hàng đã xác minh tại {
          wave.supplier_coverage.map(row => `NCC #${row.supplier_id}`).join(', ')
        }.</p>}
      </details>
    </article>
  )
}

export function F3Waves({ result }: { result: ValidF3Evaluation }) {
  const stops = new Map(result.stops.map(stop => [stop.key, stop]))
  if (!result.waves.length) return <div className="dssr-panel">
    <p>Chưa có phân bổ phương tiện cho phương án này.</p>
    <F3Diagnostics rows={result.diagnostics} />
  </div>
  return (
    <section className="dssr-panel f3-work-panel">
      <h2>Phương tiện đề xuất</h2>
      <p className="dssf-help">
        F3 ưu tiên ít xe nhất, sau đó giảm tổng sức chứa cần huy động cho cùng khối lượng và trong phạm vi đã đối chiếu.
        {result.search === 'BOUNDED' && ' Đã đạt giới hạn tìm kiếm. Đề xuất phản ánh các cách phân bổ đã xét.'}
      </p>
      {result.waves.map(wave => <WaveDetail key={wave.wave_no} wave={wave} stops={stops}
        provider={result.provider} offers={result.offers} />)}
    </section>
  )
}

const parameterNotes = {
  TIMEZONE: 'Múi giờ nghiệp vụ và hiển thị khung thời gian CP7.',
  WEIGHT_UNIT: 'Đơn vị bắt buộc cho kiểm tra tải trọng trong contract F3.',
  UTILIZATION_WARNING_PCT: 'Ngưỡng cảnh báo hiệu suất thấp, không chặn phân bổ.',
}

export function F3Evidence({ result, presentation = result.presentation }: {
  result: ValidF3Evaluation; presentation?: F3Presentation
}) {
  const { date, start_time, end_time } = result.availability_envelope
  const rules = presentation?.rule_checks ?? result.hard_constraints.filter(row => row.check.startsWith('RULE-'))
  const otherChecks = result.hard_constraints.filter(row => !row.check.startsWith('RULE-'))
  return (
    <section className="dssr-panel f3-work-panel">
      <h2>Bằng chứng và ràng buộc F3</h2>
      <p>{gateLabels[result.gate_status]} · {deliveryDate(date)} · {timeWindow(start_time, end_time)}</p>
      <F3Diagnostics rows={result.diagnostics} />
      <div className="f3-rule-list">
        {rules.map(row => <details key={row.check} className="dssf-technical">
          <summary><strong>{row.check}</strong> · {label(row.check)} <span className="f3-chip">{label(row.status)}</span></summary>
          {result.waves.length > 0 && <ul className="f3-list">
            {result.waves.map(wave => <li key={wave.wave_no}>
              Wave {wave.wave_no} · {phases[wave.phase]} · {row.check === 'RULE-14'
                ? `${wave.allocations.length} nhu cầu · ${wave.vehicle.vehicle_code} · offer #${wave.vehicle.offer_id}`
                : `${kg(wave.allocated_weight_kg)} / ${kg(wave.vehicle.capacity_kg)}`}
              {row.check === 'RULE-15' && ` · ${utilization(wave.utilization_pct)}`}
            </li>)}
          </ul>}
          {row.check === 'RULE-15' && result.utilization_pct && <p>Hiệu suất tải toàn phương án · {utilization(result.utilization_pct)}</p>}
          <F3Diagnostics check={row.check} rows={result.diagnostics.filter(item =>
            item.values?.includes(row.check) || (row.check !== 'RULE-15' && item.code === 'DEMAND_EXCEEDS_CAPACITY')
            || (row.check === 'RULE-15' && item.code === 'LOW_UTILIZATION'))} />
          {row.status === 'NOT_EVALUATED' && <p>Chưa có phân bổ để đối chiếu quy tắc này.</p>}
        </details>)}
      </div>
      <details className="dssf-technical">
        <summary>Các ràng buộc khác và lịch xe CP7</summary>
        <ul className="f3-list">
          {otherChecks.map(row => <li key={row.check}>{label(row.check)} · {label(row.status)}</li>)}
          {result.offers.map(offer => <li key={offer.offer_id}>
            <strong>{offer.vehicle_code}</strong> · {kg(offer.capacity_kg)} · {offer.available_vehicle_count} xe khả dụng · {label(offer.status)}
            <div>Nhóm hàng · {offer.cargo_compatibility.map(row => `#${row.cargo_category_id} ${row.is_supported === null
              ? 'thiếu dữ liệu' : row.is_supported ? 'tương thích' : 'không tương thích'}`).join(', ')}</div>
            {offer.windows.length > 0 && <ul>{offer.windows.map(window => <li key={window.id}>
              {deliveryDate(window.service_date)} · {timeWindow(window.start_time, window.end_time)} · {window.count} xe · {label(window.source)}
            </li>)}</ul>}
          </li>)}
        </ul>
      </details>
      {result.hub_coverage && <details className="dssf-technical">
        <summary>Tuyến và nguồn xác minh phạm vi Hub</summary>
        <HubCoverage coverage={result.hub_coverage} plan={result.plan} provider={providerName(result.provider)} />
      </details>}
      {!!presentation?.parameters.length && <details className="dssf-technical">
        <summary>Tham số F3 đã đối chiếu</summary>
        <dl className="f3-parameters">
          {presentation.parameters.map(row => <div key={row.key}>
            <dt><code>{row.key}</code>{row.value !== null && ` · ${String(row.value)}`}</dt>
            <dd>{parameterNotes[row.key]} {row.invalid ? 'Giá trị cấu hình không hợp lệ.'
              : row.configured ? 'Có bản ghi cấu hình.' : row.value === null
                ? 'Chưa đặt ngưỡng.' : 'Giá trị do contract hệ thống xác định. Chưa có bản ghi PlanningParameters.'}</dd>
          </div>)}
        </dl>
      </details>}
      <p className="dssf-help"><strong>Chờ F4</strong> · {result.f4_pending.map(label).join(', ')}.</p>
    </section>
  )
}
