
import { useCallback, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { planningSearch } from '../../components/dss/planningSearch'
import { missing, runTime } from '../../components/dss/f1Display'
import { gateLabels, kg, planName, providerName, utilization } from '../../components/dss/f3Display'
import {
  F3AllocationDashboard,
  F3Diagnostics,
  F3Evidence,
  F3Waves,
} from '../../components/dss/F3AssessmentDetails'
import { getF3CapacityMetrics } from '../../components/dss/f3Metrics'
import { ApiError } from '../../services/api/client'
import { dssErrorMessage } from '../../services/dss/dssService'
import {
  getF3AcceptancePreview,
  getF3Evaluation,
  getF3History,
  getF3Preview,
  saveF3,
} from '../../services/dss/f3Service'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type {
  F3Evaluation,
  F3GateStatus,
  SavedF3Summary,
} from '../../types/f3'
import './DSSRunDetailPage.css'
import './F1Presentation.css'
import './DSSF3Page.css'



const tabs = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'allocation', label: 'Phân bổ phương tiện' },
  { key: 'history', label: 'Lịch sử đánh giá' },
] as const

type Tab = typeof tabs[number]['key']


const criteria = [
  ['actions', 'Thao tác'],
  ['gate', 'Kết quả F3'],
  ['demand', 'Khối lượng nhu cầu'],
  ['sharedFleet', 'Xe cần / xe khả dụng cùng nguồn'],

['utilization', 'Mức sử dụng công suất wave'],
['backendUtilization', 'Hiệu suất theo thuật toán F3'],

  ['provider', 'Nhà vận chuyển'],
  ['vehicle', 'Loại phương tiện'],
  ['waves', 'Số wave'],
  ['needed', 'Số xe cần'],
  ['fleetCapacity', 'Tổng tải trọng đội xe khả dụng'],
  ['assignedCapacity', 'Tổng tải trọng xe đã phân bổ'],
  ['remainingCapacity', 'Tải trọng còn dư trên xe đã phân bổ'],
  ['saved', 'Trạng thái lưu'],
  ['f4', 'F4'],
  ['f5', 'F5'],
] as const

function allocationError(error: unknown) {
  if (error instanceof ApiError && error.status === 403) return '403 · Bạn chưa được cấp quyền F3 cho phạm vi Outlet này.'
  if (error instanceof ApiError && error.status === 409) return '409 · Bản nháp F2 hoặc bằng chứng phân bổ không hợp lệ. Hãy tải lại trang.'
  if (error instanceof ApiError && error.status === 503) return '503 · Chưa đọc được bản nháp F2 hoặc dữ liệu phương tiện CP7.'
  return dssErrorMessage(error)
}


function Gate({
  status,
}: {
  status: F3GateStatus
  synthetic?: boolean
}) {
  return (
    <span className={`f3-chip f3-chip--${status.toLowerCase()}`}>
      {gateLabels[status]}
    </span>
  )
}


function latestByPlan(rows: SavedF3Summary[]) {
  const latest = new Map<string, SavedF3Summary>()
  for (const row of rows) {
    if (!latest.has(row.plan.plan_code)) latest.set(row.plan.plan_code, row)
  }
  return latest
}

function matchesCurrentEvaluation(result: F3Evaluation, saved: SavedF3Summary) {
  return result.status !== 'INVALID_PLAN' && result.plan.plan_code === saved.plan.plan_code
    && result.plan.revision === saved.plan.revision && result.contract_version === saved.contract_version
    && result.input_fingerprint === saved.input_fingerprint
    && result.configuration_fingerprint === saved.configuration_fingerprint
}

interface EvaluationSaveState {
  result: F3Evaluation
  latest?: SavedF3Summary
  matching?: SavedF3Summary
  needsSave: boolean
}


function Comparison({ options, historyStatus, canSave, onSave, onOpen }: {
  options: EvaluationSaveState[]
  historyStatus: 'loading' | 'available' | 'error'
  canSave: boolean
  onSave: (code: string) => void
  onOpen: (code: string) => void
}) {
  const columns = options.map(({ result, latest, matching, needsSave }) => {
    const view = result.status === 'INVALID_PLAN' ? null : result

const metrics = getF3CapacityMetrics(result)

const capacityUtilization =
  metrics.usedPercent === null
    ? '—'
    : `${metrics.usedPercent}%`

    const fleet = view?.presentation?.fleet
    const target = matching ?? latest

    return {
      planCode: result.plan.plan_code,
      heading: result.plan.hub
        ? result.plan.hub.code
        : 'Direct Consolidated',
      status: result.gate_status,
      synthetic: Boolean(view?.hub_coverage?.uses_synthetic),
      saved: Boolean(matching),
      needsSave,
      readyForF4: Boolean(matching?.ready_for_f4),
      demand: kg(view?.total_required_weight_kg),
      vehicleCount: fleet
        ? `${view?.vehicles_required}/${fleet.available_count}`
        : missing,
      efficiency: capacityUtilization,
      waveCount: view?.waves.length ?? missing,
      rows: {
        actions: (
          <div className="f3-option-actions">
            {target && (
              <button
                type="button"
                className="dssr-secondary-button"
                onClick={() => onOpen(target.evaluation_code)}
              >
                Xem bản đã lưu
              </button>
            )}

            {view && (
              <button
                type="button"
                className="dssr-secondary-button"
                disabled={!canSave || !needsSave}
                onClick={() => onSave(result.plan.plan_code)}
              >
                {matching ? 'Đã lưu F3' : 'Lưu F3'}
              </button>
            )}
          </div>
        ),
        gate: (
          <Gate
            status={result.gate_status}
            synthetic={view?.hub_coverage?.uses_synthetic}
          />
        ),
        demand: kg(view?.total_required_weight_kg),
        sharedFleet: fleet
          ? `${view?.vehicles_required}/${fleet.available_count} xe`
          : missing,

utilization: capacityUtilization,
backendUtilization: utilization(view?.utilization_pct),

        provider: view ? providerName(view.provider) : missing,
        vehicle:
          fleet?.sources
            .map(offer => offer.vehicle_code)
            .join(', ') || missing,
        waves: view?.waves.length ?? missing,
        needed: view?.vehicles_required ?? missing,
        fleetCapacity: kg(fleet?.available_capacity_kg),
        assignedCapacity: kg(fleet?.assigned_capacity_kg),
        remainingCapacity: kg(
          fleet?.remaining_assigned_capacity_kg
        ),
        saved:
          historyStatus === 'loading'
            ? 'Đang đối chiếu'
            : historyStatus === 'error'
              ? 'Chưa tải lịch sử'
              : matching
                ? 'Đã lưu'
                : latest
                  ? 'Có thay đổi chưa lưu'
                  : 'Chưa lưu',
        f4: matching?.ready_for_f4
          ? 'Sẵn sàng F4'
          : 'Chờ lưu F3 hợp lệ',
        f5: 'Chưa đánh giá',
      } satisfies Record<typeof criteria[number][0], ReactNode>,
    }
  })

  return (
    <section
      className="dssr-panel f3-clean-overview"
      aria-labelledby="f3-comparison-title"
    >
      <div className="f3-clean-heading">
        <div>
          <h2 id="f3-comparison-title">So sánh phương án</h2>
          <p>Chọn phương án phù hợp để tiếp tục F4</p>
        </div>

        <span className="f3-clean-count">
          {columns.length} phương án
        </span>
      </div>

      <div className="f3-clean-grid">
        {columns.map((column, index) => (
          <article
            key={column.planCode}
            className="f3-clean-card"
          >
            <div className="f3-clean-card-header">
              <div>
                <span className="f3-clean-index">
                  PHƯƠNG ÁN {String(index + 1).padStart(2, '0')}
                </span>
                <h3>{column.heading}</h3>
              </div>
            </div>

            <div className="f3-clean-gate">
              <Gate
                status={column.status}
                synthetic={column.synthetic}
              />
            </div>

            
<div className="f3-clean-metrics f3-clean-metrics--2col">
  <div className="f3-clean-metric">
    <span>Khối lượng nhu cầu</span>
    <strong>{column.demand}</strong>
  </div>

  <div className="f3-clean-metric">
    <span>Mức sử dụng công suất wave</span>
    <strong>{column.efficiency}</strong>
  </div>
</div>

<div className="f3-clean-card-meta">
  <span>🚚 {column.vehicleCount} xe cần / khả dụng</span>
  <span>·</span>
  <span>🔄 {column.waveCount} wave</span>
</div>


            <div className="f3-clean-status">
              <span
                className={
                  column.saved
                    ? 'f3-clean-saved'
                    : 'f3-clean-unsaved'
                }
              >
                {column.saved ? '✓ Đã lưu' : '● Chưa lưu'}
              </span>

              {column.readyForF4 && (
                <span className="f3-clean-ready">
                  ✓ Sẵn sàng F4
                </span>
              )}
            </div>

            <div className="f3-clean-actions">
              {column.rows.actions}
            </div>
          </article>
        ))}
      </div>

      <details className="f3-clean-expand">
        <summary>
          <span>Xem bảng so sánh đầy đủ</span>
          <span className="f3-clean-expand-hint">
            {criteria.length - 1} thông số
          </span>
        </summary>

        <div className="f3-table-wrap">
          <table className="f3-table">
            <thead>
              <tr>
                <th scope="col">Tiêu chí</th>

                {columns.map(column => (
                  <th key={column.planCode} scope="col">
                    {column.heading}
                  </th>
                ))}
              </tr>
            </thead>




<tbody>
  {criteria
    .filter(([key]) => key !== 'actions')
    .map(([key, label]) => {
      const isNumeric = [
        'demand',
        'sharedFleet',
        'utilization',
        'backendUtilization',
        'waves',
        'needed',
        'fleetCapacity',
        'assignedCapacity',
        'remainingCapacity',
      ].includes(key)

      const values = columns.map(column => column.rows[key])

      const hasDifference =
        isNumeric &&
        new Set(values.map(value => String(value ?? ''))).size > 1

      return (
        <tr
          key={key}
          className={hasDifference ? 'f3-row-different' : ''}
        >
          <th scope="row">{label}</th>

          {columns.map(column => (
            <td key={column.planCode}>
              <span
                className={
                  hasDifference
                    ? 'f3-cell-content f3-cell-content--highlight'
                    : 'f3-cell-content'
                }
              >
                {column.rows[key]}
              </span>
            </td>
          ))}
        </tr>
      )
    })}
</tbody>



          </table>
        </div>
      </details>
    </section>
  )
}

function SavedEvaluation({ runCode, groupCode, code, scenarioSearch }: {
  runCode: string; groupCode: string; code: string; scenarioSearch: string
}) {
  const load = useCallback(() => getF3Evaluation(runCode, groupCode, code), [runCode, groupCode, code])
  const { data, loading, error, reload } = useDssQuery(load)
  if (loading) return <p className="dssr-loading" role="status">Đang tải kết quả đã lưu…</p>
  if (!data || data.evaluation_code !== code) return <div className="dssr-alert" role="alert">
    {data ? 'Mã kết quả phản hồi không khớp với dòng lịch sử đã chọn.' : allocationError(error)}{' '}
    <button type="button" className="dssr-secondary-button" onClick={reload}>Thử lại</button>
  </div>

  const result = data.f3_structure.result

  return (
    <section aria-label="Kết quả F3 đã lưu" className="dssr-panel f3-saved" data-evaluation-code={data.evaluation_code}>

<h2>{planName(data.plan)}</h2>
<Gate
  status={data.gate_status}
  synthetic={result.hub_coverage?.uses_synthetic}
/>

      <p>{runTime(data.evaluated_at)} · F2 phiên bản {data.plan.revision} · Contract F3 v{data.contract_version}</p>
      <p className="dssf-help"><code>{data.evaluation_code}</code></p>
      {data.ready_for_f4 && <Link className="dssr-primary-button f3-all-link"
        to={{ pathname: `/dss/runs/${runCode}/options/${groupCode}/f4/${code}`, search: scenarioSearch }}>
        Kiểm tra thời gian F4
      </Link>}
      {!data.ready_for_f4 && <p className="dssf-help">Kết quả này chưa đủ điều kiện chuẩn bị F4 trong ngữ cảnh hiện tại.</p>}

<div className="f3-saved-diagnostics">
  <div className="f3-saved-section-heading">
    <h3>Ràng buộc và cảnh báo</h3>
    <span>{result.diagnostics.length} kết quả</span>
  </div>

  <F3Diagnostics rows={result.diagnostics} />
</div>

    </section>
  )
}

function History({ rows, selected, onSelect, runCode, groupCode, scenarioSearch, sourceF3, sourceF4 }: {
  rows: SavedF3Summary[]
  selected?: string
  onSelect: (evaluationCode: string) => void
  runCode: string
  groupCode: string
  scenarioSearch: string
  sourceF3: string | null
  sourceF4: string | null
}) {
  const latest = latestByPlan(rows)
  const active = selected ? rows.find(row => row.evaluation_code === selected) : rows[0]
  const linkedSearch = new URLSearchParams(scenarioSearch)
  if (active && active.evaluation_code === sourceF3 && sourceF4) linkedSearch.set('f4', sourceF4)
  return (
    <div className="f3-history-grid">
      <section className="dssr-panel f3-history">
        <h2>Lịch sử đánh giá F3</h2>
        {!rows.length && <p>Chưa có lần đánh giá nào được lưu.</p>}
        {selected && !active && <p role="alert">404 · Không tìm thấy bản đánh giá F3 đã chọn.</p>}
        <ul>
          {rows.map(row => <li key={row.evaluation_code}>
            <button type="button" aria-pressed={active?.evaluation_code === row.evaluation_code}
              data-evaluation-code={row.evaluation_code} onClick={() => onSelect(row.evaluation_code)}>
              <strong>{planName(row.plan)}</strong>
              <span>{latest.get(row.plan.plan_code) === row ? 'Mới nhất' : 'Lịch sử'} · {runTime(row.evaluated_at)}</span>
              <Gate status={row.gate_status} />
            </button>
          </li>)}
        </ul>
      </section>
      {active && <SavedEvaluation key={active.evaluation_code} code={active.evaluation_code}
        runCode={runCode} groupCode={groupCode} scenarioSearch={linkedSearch.toString()} />}
    </div>
  )
}


function F3Acceptance({
  runId,
  optionId,
  planCode,
  onBack,
}: {
  runId: string
  optionId: string
  planCode: string
  onBack: () => void
}) {
  const load = useCallback(
    () => getF3AcceptancePreview(runId, optionId, planCode),
    [runId, optionId, planCode]
  )

  const { data, error, loading, reload } = useDssQuery(load)

  return (
    <main className="dssr-page f3-page">
      <header className="dssr-header f3-header">
        <div>
          <button
            type="button"
            className="dssr-secondary-button"
            onClick={onBack}
          >
            ← Quay về F3
          </button>

          <p className="dssr-eyebrow">
            COLOGI · KIỂM THỬ HỆ THỐNG
          </p>

          <h1>Kiểm thử F3 với nguồn V7</h1>

          <p className="dssr-description">
            Đối chiếu kết quả phân bổ phương tiện với dữ liệu
            V7 trong môi trường nghiệm thu.
          </p>
        </div>
      </header>

      <div className="f3x-acceptance-meta" role="note">
        <span>🔎 Chế độ chỉ đọc</span>
        <span>V7 chưa được TP001 xác minh độc lập</span>
        <span>Không lưu kết quả hoặc chuyển F4/F5</span>
      </div>

      {loading && (
        <p className="dssr-loading" role="status">
          Đang kiểm tra dữ liệu nghiệm thu...
        </p>
      )}

      {error !== null && (
        <div className="dssr-alert" role="alert">
          {allocationError(error)}

          <button
            type="button"
            className="dssr-secondary-button"
            onClick={reload}
          >
            Thử lại
          </button>
        </div>
      )}

      {data && (
        <section className="dssr-panel f3x-acceptance">


<div className="f3x-v7-overview">
  <div className="f3x-v7-heading">
    <div>
      <span className="f3x-v7-eyebrow">KẾT QUẢ KIỂM THỬ</span>
      <h2>{gateLabels[data.evaluation.gate_status]}</h2>
      <p>
        {planName(data.evaluation.plan)}
        {' · '}
        {kg(data.evaluation.total_required_weight_kg)}
        {' · '}
        {data.evaluation.waves.length} wave
      </p>
    </div>

    <span className="f3x-v7-readonly">
      <span aria-hidden="true">●</span> Chỉ đọc
    </span>
  </div>

  <F3AllocationDashboard result={data.evaluation} />
</div>

<div className="f3x-v7-section">
  <div className="f3x-v7-section-head">
    <div>
      <h3>🚚 Phân bổ phương tiện</h3>
      <p>Phương tiện, tải trọng và các luồng hàng đã phân bổ</p>
    </div>
  </div>

  <F3Waves result={data.evaluation} />
</div>

<details className="f3x-v7-accordion">
  <summary>
    <span>🔎 Bằng chứng CP7 và ràng buộc</span>
    <span>Xem chi tiết</span>
  </summary>

  <F3Evidence result={data.evaluation} />
</details>

<details className="f3x-v7-accordion">
  <summary>
    <span>🗂 Nhật ký nguồn V7 và truy vết</span>
    <span>Thông tin kỹ thuật</span>
  </summary>

  <div className="f3x-v7-audit">
    <div>
      <span>Mã quyết định</span>
      <strong>{data.decision_reference}</strong>
    </div>

    <div>
      <span>Lịch V7 được xét</span>
      <strong>
        {data.selected_legacy_ids
          .map(id => `#${id}`)
          .join(', ') || 'Không có'}
      </strong>
    </div>

    <div>
      <span>SHA-256 manifest</span>
      <code>{data.manifest_sha256}</code>
    </div>

    <details className="f3x-v7-source-details">
      <summary>
        Danh sách nguồn kỹ thuật ({data.admitted_sources.length})
      </summary>

      <div className="f3x-v7-source-list">
        {data.admitted_sources.map(source => (
          <div key={source.legacy_id}>
            <strong>
              #{source.legacy_id} · {source.vehicle_type}
            </strong>
            <small>
              {source.sheet}!{source.range}
            </small>
            <small>
              {source.original_provenance} · AuditLog #{source.audit_log_id}
            </small>
          </div>
        ))}
      </div>
    </details>
  </div>
</details>
        </section>
      )}
    </main>
  )
}

function F3Page({ runId, optionId, planCode }: { runId: string; optionId: string; planCode?: string }) {
  const base = `/dss/runs/${runId}/options/${optionId}`
  const [query] = useSearchParams()
  const scenario = query.get('scenario')
  const sourceF3 = query.get('f3')
  const sourceF4 = query.get('f4')
  const scenarioSearch = planningSearch(scenario)
  const tabId = useId()
  const [tab, setTab] = useState<Tab>(sourceF3 ? 'history' : 'overview')
  const [planFocus, setPlanFocus] = useState<string>()
  const [selected, setSelected] = useState<string | undefined>(sourceF3 ?? undefined)
  const [saving, setSaving] = useState(false)
  const [showAcceptance, setShowAcceptance] = useState(false)
  const saveInFlight = useRef(false)
  const [message, setMessage] = useState<{ text: string; failed: boolean }>()
  const load = useCallback(() => getF3Preview(runId, optionId, planCode), [runId, optionId, planCode])
  const { data, error, loading, reload } = useDssQuery(load)
  const storage = data?.persistence_available === true
  const loadHistory = useCallback(() => storage ? getF3History(runId, optionId, planCode)
    : Promise.resolve({ evaluations: [] as SavedF3Summary[] }), [runId, optionId, planCode, storage])
  const history = useDssQuery(loadHistory)
  const evaluations = data?.evaluations ?? []

  const focused = evaluations.find(row => row.plan.plan_code === planFocus) ?? evaluations[0]

if (focused && focused.status !== 'INVALID_PLAN') {
  console.table({
    planCode: focused.plan.plan_code,
    hub: focused.plan.hub?.code ?? 'DIRECT',
    totalRequiredKg: focused.total_required_weight_kg,
    waveCount: focused.waves.length,
    vehiclesRequired: focused.vehicles_required,
    backendUtilization: focused.utilization_pct,
  })

  console.table(
    focused.waves.map((wave, index) => ({
      wave: index + 1,
      phase: wave.phase,
      vehicle: wave.vehicle.vehicle_code,
      allocatedKg: wave.allocated_weight_kg,
      capacityKg: wave.vehicle.capacity_kg,
      percent:
        Number(wave.vehicle.capacity_kg) > 0
          ? Math.round(
              Number(wave.allocated_weight_kg) /
              Number(wave.vehicle.capacity_kg) * 100
            )
          : 0,
    }))
  )
}

  const historyRows = history.data?.evaluations ?? []
  const latest = latestByPlan(historyRows)
  const options: EvaluationSaveState[] = evaluations.map(result => {
    const matching = historyRows.find(row => matchesCurrentEvaluation(result, row))
    return {
      result,
      latest: latest.get(result.plan.plan_code),
      matching,
      needsSave: !matching && result.status !== 'INVALID_PLAN' && result.contract_version !== undefined
        && Boolean(result.input_fingerprint && result.configuration_fingerprint),
    }
  })
  const pendingCodes = options.filter(option => option.needsSave).map(option => option.result.plan.plan_code)
  const savedCount = options.filter(option => option.matching).length
  const canSave = storage && !saving && history.data !== null
  const bulkLabel = savedCount === evaluations.length
    ? `Đã lưu tất cả phương án (${savedCount}/${evaluations.length})`
    : pendingCodes.length > 0 && pendingCodes.length < evaluations.length
      ? `Lưu ${pendingCodes.length} phương án còn lại`
      : 'Lưu kết quả tất cả phương án'

  function openSaved(code: string) {
    setSelected(code)
    setTab('history')
    document.getElementById(`${tabId}-history`)?.focus()
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break
      case 'ArrowRight': next = (index + 1) % tabs.length; break
      case 'Home': next = 0; break
      case 'End': next = tabs.length - 1; break
      default: return
    }
    event.preventDefault()
    setTab(tabs[next].key)
    document.getElementById(`${tabId}-${tabs[next].key}`)?.focus()
  }

  async function save(planCodes: string[], openAfterSave = false) {
    if (!canSave || saveInFlight.current) return
    const requested = pendingCodes.filter(code => planCodes.includes(code))
    if (!requested.length) return
    saveInFlight.current = true
    setSaving(true)
    setMessage(undefined)
    try {
      const saved = await saveF3(runId, optionId, requested)
      const confirmed = saved.evaluations.filter(row => requested.includes(row.plan.plan_code))
      if (new Set(confirmed.map(row => row.plan.plan_code)).size < requested.length) {
        setMessage({
          text: 'Máy chủ mới xác nhận một phần yêu cầu. Bạn có thể lưu lại các phương án còn thiếu sau khi đối chiếu lịch sử.',
          failed: true,
        })
      } else {
        setMessage({ text: saved.created_count
          ? `Đã lưu ${saved.created_count} kết quả mới. ${confirmed.length - saved.created_count} kết quả được dùng lại.`
          : 'Đã dùng lại kết quả có cùng đầu vào và cấu hình.', failed: false })
      }
      if (confirmed.some(row => !evaluations.some(result => matchesCurrentEvaluation(result, row)))) reload()
      if (openAfterSave && confirmed.length === 1) openSaved(confirmed[0].evaluation_code)
    } catch (saveError) {
      setMessage({ text: allocationError(saveError), failed: true })
      reload()
    } finally {
      history.reload()
      saveInFlight.current = false
      setSaving(false)
    }
  }

  const acceptancePlan = data?.acceptance_preview_plan_code
  if (showAcceptance && acceptancePlan) {
    return <F3Acceptance runId={runId} optionId={optionId} planCode={acceptancePlan}
      onBack={() => setShowAcceptance(false)} />
  }

  return (
    <main className="dssr-page f3-page">
      <header className="dssr-header f3-header">
        <div>
          <Link className="dssr-back-link" to={{ pathname: `${base}/f2`,
            search: planningSearch(scenario, { plan: planCode ?? planFocus }) }}>← Phương án F2</Link>
          <p className="dssr-eyebrow">COLOGI · DSS F3</p>
          <h1>Phân bổ phương tiện</h1>
          <p className="dssr-description">So sánh tải trọng, đội xe và bằng chứng CP7 cho từng phương án F2.</p>
        </div>
        <div className="f3-header-actions">
          {acceptancePlan && <button type="button" className="dssr-secondary-button"
            disabled={saving} onClick={() => setShowAcceptance(true)}>
            Xem trước nghiệm thu (V7)
          </button>}
          {planCode && <Link className="dssr-secondary-button f3-all-link" to={{ pathname: `${base}/f3`, search: scenarioSearch }}>
            Đánh giá tất cả phương án
          </Link>}
          {!planCode && evaluations.length > 0 && <button type="button" className="dssr-primary-button"
            disabled={!canSave || !pendingCodes.length} onClick={() => void save(pendingCodes)}>
            {bulkLabel}
          </button>}
        </div>
      </header>

      {loading && <p role="status" className="dssr-loading">Đang đối chiếu phương tiện…</p>}
      {error !== null && <div className="dssr-alert" role="alert">{allocationError(error)}{' '}
        <button type="button" className="dssr-secondary-button" onClick={reload}>Thử lại</button></div>}
      {data?.evaluations.length === 0 && <p className="dssf-notice">Hãy lưu bản nháp F2 để đánh giá phương tiện.</p>}
      {message && <p className={message.failed ? 'dssr-alert' : 'dssf-notice'}
        role={message.failed ? 'alert' : 'status'}>{message.text}</p>}
      {saving && <p className="dssr-loading" role="status">Đang lưu kết quả F3…</p>}
      {evaluations.length > 0 && <>
        {!storage && <p className="dssf-notice">Môi trường này hỗ trợ xem trước. Lưu và lịch sử F3 cần migration 0006.</p>}

<div
  className="f3-tabs"
  role="tablist"
  aria-label="Nội dung phân bổ phương tiện"
>
  {tabs.map(({ key, label }, index) => (
    <button
      key={key}
      type="button"
      role="tab"
      id={`${tabId}-${key}`}
      aria-selected={key === tab}
      aria-controls={`${tabId}-panel`}
      tabIndex={key === tab ? 0 : -1}
      onClick={() => setTab(key)}
      onKeyDown={event => onTabKey(event, index)}
    >
      {label}
    </button>
  ))}
</div>

        <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
          {(tab === 'overview' || tab === 'history') && storage && history.error !== null && <div className="dssr-alert" role="alert">
            {allocationError(history.error)} <button type="button" className="dssr-secondary-button" onClick={history.reload}>Tải lại lịch sử</button>
          </div>}
          {tab === 'overview' && <Comparison options={options}
            historyStatus={history.loading ? 'loading' : history.error !== null ? 'error' : 'available'}
            canSave={canSave} onSave={code => void save([code], true)} onOpen={openSaved} />}

{tab === 'allocation' && focused && (
  <>
    <div className="f3-plan-picker">
      <label htmlFor={`${tabId}-plan`}>Phương án</label>

      <select
        id={`${tabId}-plan`}
        value={focused.plan.plan_code}
        onChange={event => setPlanFocus(event.target.value)}
      >
        {evaluations.map(row => (
          <option
            key={row.plan.plan_code}
            value={row.plan.plan_code}
          >
            {planName(row.plan)}
          </option>
        ))}
      </select>

      <Gate
        status={focused.gate_status}
        synthetic={
          focused.status !== 'INVALID_PLAN' &&
          focused.hub_coverage?.uses_synthetic
        }
      />
    </div>

    {focused.status === 'INVALID_PLAN' ? (
      <F3Diagnostics rows={focused.diagnostics} />
    ) : (
      <>
        <F3AllocationDashboard result={focused} />
        <F3Waves result={focused} />
      </>
    )}
  </>
)}

          {tab === 'history' && (history.loading ? <p role="status" className="dssr-loading">Đang tải lịch sử F3…</p>
            : history.data && <History rows={history.data.evaluations} selected={selected} onSelect={setSelected}
              runCode={runId} groupCode={optionId} scenarioSearch={scenarioSearch} sourceF3={sourceF3} sourceF4={sourceF4} />)}
        </div>
      </>}
    </main>
  )
}

export default function DSSF3Page() {
  const { runId = '', optionId = '', planCode } = useParams()
  return <F3Page key={`${runId}/${optionId}/${planCode ?? ''}`} runId={runId} optionId={optionId} planCode={planCode} />
}
