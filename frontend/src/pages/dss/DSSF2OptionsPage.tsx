import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { planningSearch } from '../../components/dss/planningSearch'
import { deliveryDate, deliveryWarning, masterdataLabel, missing, runTime, skuName, timeWindow, weight as formatWeight } from '../../components/dss/f1Display'
import { dssService } from '../../services/dss/dssService'
import { f2ErrorMessage, f2Service } from '../../services/dss/f2Service'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F1DemandDisplayLabels, F1DemandEvidence } from '../../types/f1'
import type { F2Demand, F2Leg, F2Option, F2Options, F2PlanSummary, F2Stop } from '../../types/f2'
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
const phaseLabels = { DIRECT: 'Trực tiếp', INBOUND: 'Vào Hub (Inbound)', OUTBOUND: 'Ra Hub (Outbound)' }
const completeLabel = 'Đủ dữ liệu xây dựng phương án'
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

function OptionCard({ option, demands, evidence, saved, children }: {
  option: F2Option
  demands: Map<number, F2Demand>
  evidence: SnapshotEvidence
  saved?: boolean
  children?: ReactNode
}) {
  const viaHub = option.template_type === 'HUB_BASED'
  const complete = option.structural_status === 'COMPLETE'
  const suppliers = option.stops.filter((stop) => stop.kind === 'SUPPLIER')
  const outlets = option.stops.filter((stop) => stop.kind === 'OUTLET')
  const stopByKey = new Map(option.stops.map((stop) => [stop.key, stop]))
  const demandCodes = (ids: number[]) => ids.map((id) => demands.get(id)?.code ?? `#${id}`).join(', ')
  const phases: F2Leg['phase'][] = viaHub ? ['INBOUND', 'OUTBOUND'] : ['DIRECT']

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
      <div className="f2-flow" aria-label="Sơ đồ luồng hàng">
        <span><strong>{suppliers.length} điểm lấy</strong><small>Nhà cung cấp</small></span>
        <span aria-hidden="true" className="f2-arrow">→</span>
        {viaHub && <>
          <span className="f2-flow-hub"><strong>{option.hub?.code ?? 'Hub'}</strong><small>{option.hub?.name ?? 'Chưa chọn'}</small></span>
          <span aria-hidden="true" className="f2-arrow">→</span>
        </>}
        <span><strong>{outlets.length} điểm nhận</strong><small>Outlet</small></span>
      </div>
      {option.hub && <p className="dssf-help">{option.hub.address} · {saved ? 'Thông tin Hub tại thời điểm lưu' : 'Nguồn masterdata hiện tại'}</p>}
      {option.diagnostics.length > 0 && <ul className="dssf-notice f2-diagnostics">
        {option.diagnostics.map((issue, index) => <li key={`${issue.code}-${index}`}>
          {issue.demand_id && <strong>{demands.get(issue.demand_id)?.code ?? `#${issue.demand_id}`} · </strong>}
          {diagnosticLabels[issue.code] ?? issue.code}
        </li>)}
      </ul>}

      {complete && phases.map((phase) => {
        const legs = option.legs.filter((leg) => leg.phase === phase)
        const path = phase === 'INBOUND' ? 'Nhà cung cấp → Hub'
          : phase === 'OUTBOUND' ? 'Hub → Outlet' : 'Nhà cung cấp → Outlet'
        return (
          <section className="f2-leg-section" key={phase}>
            <h3>{phaseLabels[phase]} <span>{legs.length} luồng</span></h3>
            <p className="dssf-help">{path}</p>
            <ul className="f2-legs">
              {legs.map((leg) => <li key={`${leg.from_stop}-${leg.to_stop}`}>
                <strong>{stopName(stopByKey.get(leg.from_stop), evidence)} → {stopName(stopByKey.get(leg.to_stop), evidence)}</strong>
                <strong>{weight(leg.load_kg)}</strong>
                <small>{demandCodes(leg.demand_ids)}</small>
              </li>)}
            </ul>
          </section>
        )
      })}

      <details className="dssf-technical">
        <summary>Danh sách điểm lấy và nhận hàng</summary>
        <ul className="f2-stop-list">
          {option.stops.map((stop) => <li key={stop.key}>
            <strong>{stopName(stop, evidence)} · {weight(stop.load_kg)}</strong>
            {stop.address && <span className="dssf-evidence-line">{stop.address}</span>}
            <span className="dssf-evidence-line">{demandCodes(stop.demand_ids)}</span>
          </li>)}
        </ul>
      </details>
      <details className="dssf-technical">
        <summary>Mã phương án và chẩn đoán</summary>
        <p><code>{option.option_key}</code></p>
        <p><code>{option.status} · {option.structural_status}</code></p>
        {option.diagnostics.length > 0 && <p><code>{[...new Set(option.diagnostics.map((item) => item.code))].join(', ')}</code></p>}
      </details>
      {children}
    </article>
  )
}

function SavedPlanDetail({ runCode, groupCode, planCode, evidence, scenario }: {
  runCode: string; groupCode: string; planCode: string; evidence: SnapshotEvidence; scenario: string | null
}) {
  const load = useCallback(() => f2Service.getPlan(runCode, groupCode, planCode), [runCode, groupCode, planCode])
  const plan = useDssQuery(load)
  if (plan.loading) return <div className="dssr-loading" role="status">Đang tải bản nháp đã lưu…</div>
  if (!plan.data) return <p className="dssr-alert" role="alert">{f2ErrorMessage(plan.error)}</p>
  const { f2_structure: structure, revision, status } = plan.data
  const demandMap = new Map(structure.basis.demands.map((demand) => [demand.id, demand]))
  return (
    <section aria-label="Chi tiết bản nháp đã lưu" className="f2-plan-detail">
      <h2>Bản nháp đã lưu</h2>
      <p><code>{planCode}</code> · Phiên bản {revision} · {status}</p>
      {plan.data.supersedes_plan_code && <p>Thay thế <code>{plan.data.supersedes_plan_code}</code></p>}
      <p>
        <Link to={{ pathname: `/dss/runs/${structure.lineage.run_code}/options/${structure.lineage.group_code}`,
          search: planningSearch(scenario, { plan: planCode }) }}>Nhóm ứng viên F1</Link>
        {' · '}{deliveryDate(structure.basis.requested_date)} · {timeWindow(structure.basis.common_start_time, structure.basis.common_end_time)}
      </p>
      <p>{structure.basis.demand_ids.length} nhu cầu · {weight(structure.basis.total_required_weight_kg)}</p>
      <p><Link className="dssr-secondary-button f2-allocation-link"
        to={{ pathname: `/dss/runs/${runCode}/options/${groupCode}/f3/${encodeURIComponent(planCode)}`,
          search: planningSearch(scenario) }}>
        Phân bổ phương tiện F3
      </Link></p>
      <OptionCard option={structure.option} demands={demandMap} evidence={evidence} saved />
    </section>
  )
}

function InputEvidence({ options, evidence }: { options: F2Options; evidence: SnapshotEvidence }) {
  const { basis, lineage } = options
  return (
    <>
      <details className="dssr-panel dssf-technical">
        <summary>Dữ liệu nhu cầu và xác nhận cung ứng đã lưu</summary>
        <div className="dssf-results-list f2-evidence">
          {basis.demands.map((demand) => {
            const row = evidence.get(demand.id)
            const snapshot = row?.snapshot
            const supplier = masterdataLabel(snapshot?.supplier_code, snapshot?.supplier_name, row?.labels?.supplier, `Nhà cung cấp #${demand.supplier_id}`)
            const outlet = masterdataLabel(snapshot?.outlet_code || demand.outlet_code, snapshot?.outlet_name, row?.labels?.outlet, `Outlet #${demand.outlet_id}`)
            return (
              <article className="dssf-result-row" key={demand.id}>
                <strong>{demand.code} · {weight(demand.required_weight_kg)}</strong>
                <dl className="dssf-facts">
                  <div><dt>Lấy hàng</dt><dd>{supplier} · {demand.pickup_address ?? missing}</dd></div>
                  <div><dt>Sẵn sàng lấy</dt><dd>{deliveryDate(demand.pickup_ready_date)} · {timeWindow(demand.pickup_ready_start_time, demand.pickup_ready_end_time)}</dd></div>
                  <div><dt>Điểm và giờ nhận yêu cầu</dt><dd>{outlet} · {timeWindow(demand.requested_start_time, demand.requested_end_time)}</dd></div>
                  <div><dt>Nhóm hàng</dt><dd>{demand.cargo_category_code || missing}</dd></div>
                </dl>
                <ul className="dssf-lines">
                  {demand.items.map((item) => <li key={item.item_id}>{skuName(item.item_id, snapshot, row?.labels)} · Yêu cầu {weight(item.required_weight_kg)} · Xác nhận đủ điều kiện {weight(item.confirmed_weight_kg)}</li>)}
                </ul>
                <small>Snapshot v{demand.snapshot_version} · {runTime(demand.snapshot_captured_at)}</small>
              </article>
            )
          })}
        </div>
      </details>
      <details className="dssr-panel dssf-technical">
        <summary>Nguồn dữ liệu và liên kết lần chạy F1</summary>
        <dl className="dssf-facts">
          <div><dt>PlanningRun</dt><dd><Link to={`/dss/runs/${lineage.run_code}?tab=groups`}>{lineage.run_code}</Link></dd></div>
          <div><dt>Candidate Group</dt><dd><code>{lineage.group_code}</code></dd></div>
          <div><dt>RuleSet đã chốt</dt><dd>{lineage.rule_set_code ?? missing}{lineage.rule_set_version && ` · v${lineage.rule_set_version}`}</dd></div>
          <div><dt>Thời điểm chốt cấu hình</dt><dd>{runTime(lineage.configuration_captured_at)}</dd></div>
          <div><dt>Rule F1 đã chốt</dt><dd>{lineage.f1_rule_codes.join(', ') || missing}</dd></div>
          <div><dt>Phiên bản hợp đồng F2</dt><dd>{options.contract_version}</dd></div>
          <div><dt>Mã kiểm tra cấu hình</dt><dd><code>{lineage.configuration_fingerprint ?? missing}</code></dd></div>
        </dl>
      </details>
    </>
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
      <p className="f2-comparison-note">Luồng hàng mô tả phần nhu cầu đi giữa hai điểm. Số chuyến xe được xác định ở F3.</p>
      <p className="f2-comparison-note">
        Chưa thể kết luận phương án nào tốt hơn khi F3–F5 chưa có kết quả phân bổ phương tiện, kiểm tra lịch lấy/giao và đánh giá chi phí.
        Manager quyết định sau khi xem kết quả F1–F5 và thông qua CP09.
      </p>
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

function SavedOptions({ plans, selectedPlan, onSelect, allocationPath, scenario }: {
  plans: F2PlanSummary[][]; selectedPlan?: string; onSelect: (code: string) => void; allocationPath: string; scenario: string | null
}) {
  if (plans.length === 0) return null
  return (
    <section className="dssr-panel f2-saved-options" aria-labelledby="f2-saved-title">
      <div className="f2-overview-heading">
        <h2 id="f2-saved-title">Phương án đã lưu</h2>
        <Link className="dssr-primary-button f2-allocation-link" to={{ pathname: allocationPath, search: planningSearch(scenario) }}>
          Đánh giá F3 tất cả phương án
        </Link>
      </div>
      <ul className="f2-saved-list">
        {plans.map((history) => {
          const latest = history.at(-1)!
          const identity = optionIdentity(latest.template_type, latest.hub_id)
          const title = latest.template_type === 'DIRECT_CONSOLIDATED' ? optionLabels.DIRECT_CONSOLIDATED
            : partyName(latest.hub?.code, latest.hub?.name, `Hub #${latest.hub_id}`)
          return (
            <li key={identity} className="f2-saved-option">
              <h3>{title}</h3>
              <p>Phiên bản {latest.revision} · {latest.status}</p>
              <code>{latest.plan_code}</code>
              <button type="button" className="dssr-secondary-button"
                aria-label={`Xem bản đã lưu: ${title}`}
                aria-pressed={selectedPlan === latest.plan_code} onClick={() => onSelect(latest.plan_code)}>
                Xem bản đã lưu
              </button>
              <Link className="dssr-secondary-button f2-allocation-link"
                to={{ pathname: `${allocationPath}/${encodeURIComponent(latest.plan_code)}`, search: planningSearch(scenario) }}>
                Phân bổ phương tiện F3
              </Link>
              {history.length > 1 && <details className="dssf-technical">
                <summary>Các phiên bản trước ({history.length - 1})</summary>
                <ul className="f2-plan-list">
                  {history.slice(0, -1).toReversed().map((plan) => <li key={plan.plan_code}>
                    <button type="button" className="dssr-secondary-button"
                      aria-pressed={selectedPlan === plan.plan_code} onClick={() => onSelect(plan.plan_code)}>
                      Phiên bản {plan.revision} · {plan.status}
                    </button>
                    <code>{plan.plan_code}</code>
                  </li>)}
                </ul>
              </details>}
            </li>
          )
        })}
      </ul>
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
          <div><dt>Ngày và khung giờ giao chung</dt><dd>{deliveryDate(basis.requested_date)} · {timeWindow(basis.common_start_time, basis.common_end_time)}</dd></div>
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
          {!!hubs.data?.length && <p className="dssf-help">Hub do Manager chọn từ danh sách đang hoạt động.</p>}
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
        <ComparisonOverview targets={targets} allowSave={allowSave} saving={saving} onSave={() => void savePlans(targets)} />
        <div className="f2-comparison">
          {targets.map((target) => {
            const { option, latest, isSaved } = target
            return (
              <OptionCard key={option.template_type} option={option} demands={demands} evidence={evidence} saved={isSaved}>
                <footer className="f2-plan-actions">
                  {latest && <p>Đã lưu <code>{latest.plan_code}</code> · Phiên bản {latest.revision} · {latest.status}</p>}
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
        <SavedOptions plans={savedOptions.map(([, plans]) => plans)} selectedPlan={selectedPlan}
          onSelect={setSelectedPlan} allocationPath={`${candidatePath}/f3`} scenario={scenario} />
        {selectedPlan && <SavedPlanDetail runCode={runId} groupCode={optionId} planCode={selectedPlan} evidence={evidence} scenario={scenario} />}
        <InputEvidence options={options} evidence={evidence} />
      </>}
    </main>
  )
}
