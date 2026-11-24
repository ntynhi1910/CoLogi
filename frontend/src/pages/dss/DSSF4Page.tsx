import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { planningSearch } from '../../components/dss/planningSearch'
import InternalPlanningNotice from '../../components/dss/InternalPlanningNotice'
import { deliveryDate, runTime, timeWindow } from '../../components/dss/f1Display'
import { kg, phases, planName } from '../../components/dss/f3Display'
import { candidateInfo, duration, elapsedMinutes, firstConflict, kilometres, localTime, noValue, pointNames, roles, statuses, stopLabel } from '../../components/dss/f4Display'
import type { StopNames } from '../../components/dss/f4Display'
import F4GanttChart from '../../components/dss/F4GanttChart'
import { F4AlternateSlots, F4ComparisonTables, F4Diagnostics, F4StatusBadge, F4StopTables } from '../../components/dss/F4ScheduleDetails'
import { ApiError } from '../../services/api/client'
import { dssErrorMessage, dssService } from '../../services/dss/dssService'
import { checkF5Readiness, getCandidateDemandLabels, getF4Evaluation, getF4History, getF4Preview, saveF4 } from '../../services/dss/f4Service'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F4Configuration, F4Evaluation, F4SaveReference, SavedF4Summary } from '../../types/f4'
import './DSSRunDetailPage.css'
import './F1Presentation.css'
import './DSSF4Page.css'

const tabs = [
  ['overview', 'Tổng quan so sánh'],
  ['timeline', 'Lịch trình vận chuyển'],
  ['evidence', 'Xung đột và bằng chứng'],
  ['history', 'Lịch sử đánh giá'],
] as const

type Tab = typeof tabs[number][0]

function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409) return 'Không thể dùng kết quả này. Hãy kiểm tra lại điều kiện F3 hoặc tải lại bản xem trước F4.'
  if (error instanceof ApiError && error.status === 503) return 'Chưa đọc được nguồn bằng chứng F4. Hãy thử lại.'
  return dssErrorMessage(error)
}

interface SaveState {
  preview: F4Evaluation
  reference?: F4SaveReference
  matching?: SavedF4Summary
}

function saveReference(preview: F4Evaluation): F4SaveReference | undefined {
  const { f3_evaluation_code, input_fingerprint, configuration_fingerprint } = preview
  if (!f3_evaluation_code || !input_fingerprint || !configuration_fingerprint) return
  return { f3_evaluation_code, input_fingerprint, configuration_fingerprint }
}

function Overview({ options, timezone, names, runId, groupCode, scenario, savingEnabled, historyReady, onSave, onOpen }: {
  options: SaveState[]
  timezone: string
  names: StopNames
  runId: string
  groupCode: string
  scenario?: string | null
  savingEnabled: boolean
  historyReady: boolean
  onSave: (reference: F4SaveReference) => void
  onOpen: (code: string) => void
}) {
  const previews = options.map(option => option.preview)
  const common = previews.find(row => row.f1_common_window)?.f1_common_window
  const rows: { label: string; value: (preview: F4Evaluation) => ReactNode }[] = [
    { label: 'Kết quả F4', value: row => <F4StatusBadge status={row.status} /> },
    { label: 'Kịch bản bằng chứng', value: row => row.scenario_id ?? noValue },
    { label: 'Lượt xe / wave', value: row => row.waves.length ? `${row.waves.length} / ${row.waves.length}` : noValue },
    { label: 'Bắt đầu lấy hàng', value: row => localTime(row.metrics?.first_pickup_at, timezone) },
    { label: 'Hoàn thành giao hàng', value: row => localTime(row.metrics?.completed_at, timezone) },
    { label: 'Tổng thời gian thực hiện', value: row => duration(elapsedMinutes(row.metrics?.first_pickup_at, row.metrics?.completed_at)) },
    { label: 'Tổng thời gian di chuyển', value: row => duration(row.metrics?.travel_minutes) },
    { label: 'Tổng quãng đường giữa các điểm', value: row => kilometres(row.metrics?.distance_km) },
    { label: 'Tổng thời gian chờ', value: row => duration(row.metrics?.wait_minutes) },
    { label: 'Thời gian xử lý tại Hub', value: row => row.plan.hub ? duration(row.metrics?.hub_handling_minutes) : 'Không áp dụng' },
    { label: 'Số điểm giao đúng giờ', value: row => row.metrics ? `${row.metrics.on_time_stops}/${row.metrics.delivery_stop_count}` : noValue },
    { label: 'Số điểm giao xung đột', value: row => row.metrics?.conflict_stops ?? noValue },
    { label: 'Số điểm giao chưa đánh giá', value: row => row.metrics?.not_evaluated_stops ?? noValue },
  ]
  return <section className="dssr-panel f4-card">
    <h2>So sánh khả thi thời gian</h2>
    <div className="f4-option-cards">
      {options.map(({ preview: row, matching }) => {
        const conflict = row.status === 'PASS' ? null : firstConflict(row, timezone, names)
        return <article key={row.plan.plan_code} className={`f4-option-card f4-option-card--${row.status.toLowerCase()}`}>
          <header>
            <h3>{planName(row.plan)}</h3>
            <div className="f4-option-actions">
              <F4StatusBadge status={row.status} />
              {matching?.ready_for_f5 && <F5Preparation key={matching.evaluation_code}
                runId={runId} groupCode={groupCode} code={matching.evaluation_code} scenario={scenario} />}
            </div>
          </header>
          <dl>
            <div><dt>Quãng đường</dt><dd>{kilometres(row.metrics?.distance_km)}</dd></div>
            <div><dt>Thời gian chờ</dt><dd>{duration(row.metrics?.wait_minutes)}</dd></div>
            <div><dt>Điểm giao đúng giờ</dt><dd>{row.metrics ? `${row.metrics.on_time_stops}/${row.metrics.delivery_stop_count}` : noValue}</dd></div>
          </dl>
          {conflict && <p className="f4-stop-reason">{conflict}</p>}
        </article>
      })}
    </div>
    <div className="f4-table-scroll" tabIndex={0} role="region" aria-label="Bảng so sánh F4">
      <table className="f4-table" aria-label="So sánh F4 theo phương án">
        <thead><tr><th scope="col">Tiêu chí</th>{previews.map(row =>
          <th key={row.plan.plan_code} scope="col">
            {planName(row.plan)}{row.evaluation_context === 'UAT' && <small>Dữ liệu mô phỏng UAT</small>}
          </th>
        )}</tr></thead>
        <tbody>{rows.map(({label, value}) => <tr key={label}>
          <th scope="row">{label}</th>
          {previews.map(row => <td key={row.plan.plan_code}>{value(row)}</td>)}
        </tr>)}
          <tr><th scope="row">Trạng thái lưu</th>{options.map(({ preview, reference, matching }) =>
            <td key={preview.plan.plan_code}>
              {reference && <button type="button" className="dssr-secondary-button"
                disabled={!savingEnabled || !!matching} onClick={() => onSave(reference)}>
                {matching ? 'Đã lưu F4' : 'Lưu F4'}
              </button>}
              {matching && <button type="button" className="dssr-secondary-button"
                onClick={() => onOpen(matching.evaluation_code)}>Mở kết quả đã lưu</button>}
              {!reference && noValue}
              {reference && !historyReady && <small>Chưa đối chiếu được lịch sử</small>}
            </td>
          )}</tr>
          <tr><th scope="row">Chuẩn bị F5</th>{options.map(({ preview, matching }) =>
            <td key={preview.plan.plan_code}>
              {matching?.ready_for_f5 ? 'Đủ điều kiện chuẩn bị F5'
                : matching ? 'Chưa đủ điều kiện' : 'Cần kết quả F4 đã lưu'}
            </td>)}</tr>
        </tbody>
      </table>
    </div>
    <p className="dssf-help">Thời gian tính theo {timezone}. Mỗi wave có một lượt xe được phân bổ. Dấu gạch biểu thị thời gian chưa xác định.</p>
    {common && <p className="dssf-help">
      Khung giao chung dùng để xét ghép nhóm F1 · {timeWindow(common.start_time, common.end_time)}.
      F4 kiểm tra giờ xử lý từng Outlet theo khung của Demand và lịch nhận.
    </p>}
  </section>
}

function Evidence({ evaluation, configuration, names }: { evaluation: F4Evaluation; configuration: F4Configuration; names: StopNames }) {
  const conflict = evaluation.status === 'PASS' ? null : firstConflict(evaluation, configuration.timezone, names)
  return <section className="dssr-panel f4-card" aria-label="Chẩn đoán và bằng chứng F4">
    {conflict && <div className="f4-conflict-summary">
      <h2>Xung đột và giới hạn của lịch thử</h2>
      <p>{conflict}</p>
      <p>Kết quả toàn phương án · <F4StatusBadge status={evaluation.status} /></p>
    </div>}
    <h2>Điều kiện và nguồn đã kiểm tra</h2>
    <F4Diagnostics rows={evaluation.diagnostics} />
    {evaluation.evaluation_context === 'UAT'
      ? <p className="dssf-notice">SYNTHETIC/UAT · Bằng chứng mô phỏng phục vụ nghiệm thu.</p>
      : <p>Chế độ nguồn F4 · {evaluation.source_mode ?? noValue}</p>}
    {evaluation.evaluation_context === 'CAPSTONE' && <p className="dssf-notice">SYNTHETIC/CAPSTONE · Dữ liệu trình diễn.</p>}
    {evaluation.f3_uses_synthetic && evaluation.evaluation_context === 'UAT' &&
      <p className="dssf-notice">Kết quả F3 tham chiếu dùng Hub coverage mô phỏng trong UAT.</p>}
    <p className="dssf-help">Thứ tự lấy trước giao sau được xác định theo hạn của điểm và mã định danh. Phạm vi lịch từ điểm xử lý đầu tiên đến điểm xử lý cuối cùng.</p>
    {evaluation.waves.map(wave => <details className="dssf-technical" key={wave.wave_no}>
      <summary>Wave {wave.wave_no} · {phases[wave.phase]} · {statuses[wave.status]} · Bằng chứng CP7 và điểm dừng</summary>
      <p>Giờ hoạt động xe · {timeWindow(wave.operating_hours.start_time, wave.operating_hours.end_time)}</p>
      {wave.vehicle.windows.map(window => <p key={window.id}>
        Lịch xe #{window.id} · {deliveryDate(window.service_date)} · {timeWindow(window.start_time, window.end_time)} · {window.count} xe · {window.source}
      </p>)}
      <details className="dssf-technical">
        <summary>Offer, số xe và bằng chứng khả dụng đã dùng</summary>
        <pre>{JSON.stringify({ offer: wave.vehicle, availability: wave.fleet_evidence }, null, 2)}</pre>
      </details>
      <F4Diagnostics rows={wave.diagnostics} />
      {wave.stops.map(stop => <div className="f4-stop-evidence" key={stop.sequence}>
        <strong>{stopLabel(stop, evaluation, names)} · {roles[stop.role]}</strong>
        <F4Diagnostics rows={stop.diagnostics} />
        <F4AlternateSlots stop={stop} timezone={configuration.timezone} />
        <details className="dssf-technical">
          <summary>Lịch nhận, di chuyển và xử lý tại điểm</summary>
          <pre>{JSON.stringify({ ...stop.evidence, travel_from_previous: stop.travel_from_previous, diagnostics: stop.diagnostics }, null, 2)}</pre>
        </details>
      </div>)}
    </details>)}
    <details className="dssf-technical">
      <summary>RuleSet và tham số đã đối chiếu</summary>
      <pre>{JSON.stringify(configuration, null, 2)}</pre>
    </details>
  </section>
}

function F5Preparation({ runId, groupCode, code, scenario }: {
  runId: string; groupCode: string; code: string; scenario?: string | null
}) {
  const navigate = useNavigate()
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string>()

  async function prepare() {
    setChecking(true)
    try {
      const result = await checkF5Readiness(runId, groupCode, code)
      if (result.evaluation_code === code && result.ready_for_f5) {
        void navigate({ pathname: `/dss/runs/${runId}/options/${groupCode}/f5/${code}`,
          search: scenario ? new URLSearchParams({ scenario }).toString() : '' })
      } else {
        setMessage('Kết quả này chưa đủ điều kiện trong ngữ cảnh hiện tại.')
      }
    } catch (readinessError) {
      setMessage(errorMessage(readinessError))
    } finally {
      setChecking(false)
    }
  }

  return <div className="f4-preparation">
    <button type="button" className="dssr-secondary-button" disabled={checking}
      onClick={() => void prepare()}>{checking ? 'Đang kiểm tra…' : 'Chuẩn bị F5'}</button>
    {message && <p role="status">{message}</p>}
  </div>
}

function SavedEvaluation({ runId, groupCode, code, historyLabel, current, names, activeScenario }: {
  runId: string; groupCode: string; code: string; historyLabel: string; current: boolean; names: StopNames
  activeScenario?: string | null
}) {
  const load = useCallback(() => getF4Evaluation(runId, groupCode, code), [runId, groupCode, code])
  const { data, error, loading, reload } = useDssQuery(load)
  if (loading) return <p className="dssr-loading" role="status">Đang đọc kết quả đã lưu…</p>
  if (!data || data.evaluation_code !== code) return <div className="dssr-alert" role="alert">
    {errorMessage(error)}{' '}<button type="button" className="dssr-secondary-button" onClick={reload}>Thử lại</button>
  </div>
  return <section className="dssr-panel f4-card" data-evaluation-code={code}>
    <h2>{planName(data.plan)}</h2>
    <F4StatusBadge status={data.status} />
    <p>{historyLabel}{current && ' · Thuộc kịch bản đang xem'}</p>
    {data.evaluation_context === 'UAT' && <p>Dữ liệu mô phỏng UAT</p>}
    {data.evaluation_context === 'CAPSTONE' && <p>SYNTHETIC/CAPSTONE · Dữ liệu trình diễn</p>}
    <InternalPlanningNotice source={data.internal_planning} />
    <p>Đã lưu {runTime(data.evaluated_at)} · F2 phiên bản {data.plan.revision} · F4 cấu hình {data.configuration_version}</p>
    {data.scenario_id && <p>Kịch bản · {data.scenario_id}</p>}
    <p>F3 tham chiếu · <code>{data.f3_evaluation_code}</code></p>
    {data.ready_for_f5 && <F5Preparation runId={runId} groupCode={groupCode} code={code}
      scenario={current ? activeScenario : data.scenario_id} />}
    <details className="dssf-technical"><summary>Lịch trình đã lưu</summary>
      <F4GanttChart evaluations={[data.result]} visible={[data.result]} timezone={data.configuration.timezone} names={names} />
      <F4StopTables evaluation={data.result} timezone={data.configuration.timezone} names={names} />
    </details>
    <details className="dssf-technical"><summary>Bằng chứng đã lưu</summary>
      <Evidence evaluation={data.result} configuration={data.configuration} names={names} />
    </details>
  </section>
}

function F4Page({ runId, groupCode, evaluationCode }: { runId: string; groupCode: string; evaluationCode?: string }) {
  const tabId = useId()
  const [query, setQuery] = useSearchParams()
  const [tab, setTab] = useState<Tab>(query.get('f4') ? 'history' : 'overview')
  const [planCode, setPlanCode] = useState<string>()
  const [compare, setCompare] = useState(false)
  const [savedCode, setSavedCode] = useState<string | undefined>(query.get('f4') ?? undefined)
  const [saving, setSaving] = useState(false)
  const saveInFlight = useRef(false)
  const [message, setMessage] = useState<{text: string; failed: boolean}>()
  const scenario = query.get('scenario') || undefined
  const load = useCallback(() => getF4Preview(runId, groupCode, evaluationCode, scenario), [runId, groupCode, evaluationCode, scenario])
  const { data, error, loading, reload } = useDssQuery(load)
  const activeScenario = data?.active_scenario
  useEffect(() => {
    if (scenario || !activeScenario) return
    setQuery(current => {
      const next = new URLSearchParams(current)
      next.set('scenario', activeScenario)
      return next
    }, { replace: true })
  }, [activeScenario, scenario, setQuery])
  const loadRun = useCallback(async () => {
    const run = await dssService.getRun(runId)
    const group = run.candidate_groups.find(row => row.group_code === groupCode)
    // Old snapshots may omit display names. Read only this candidate's Demand labels.
    const labels = group ? await getCandidateDemandLabels(group.memberships.map(row => row.demand_id)) : []
    return { run, labels }
  }, [runId, groupCode])
  const run = useDssQuery(loadRun)
  const storage = data?.history_available === true
  const loadHistory = useCallback(() => storage ? getF4History(runId, groupCode)
    : Promise.resolve({ evaluations: [] as SavedF4Summary[] }), [runId, groupCode, storage])
  const history = useDssQuery(loadHistory)
  const previews = data?.evaluations ?? []
  const candidate = candidateInfo(run.data?.run ?? null, groupCode, previews)
  const names = { ...pointNames(run.data?.labels ?? []), ...candidate.names }
  const inScope = previews.filter(row => !row.diagnostics.some(item => item.code === 'F4_OPTION_OUTSIDE_SCENARIO'))
  const focused = previews.find(row => row.plan.plan_code === planCode)
    ?? previews.find(row => row.f3_evaluation_code === data?.selected_evaluation_code) ?? previews[0]
  const timelineContext = [data?.active_scenario, ...previews.map(row =>
    `${row.plan.plan_code}/${row.input_fingerprint ?? ''}/${row.configuration_fingerprint ?? ''}`,
  )].join('|')
  const saved = history.data?.evaluations ?? []
  const lockedSource = savedCode === query.get('f4') ? evaluationCode : undefined
  const selectedSaved = savedCode ? saved.find(row => row.evaluation_code === savedCode &&
    (!lockedSource || row.f3_evaluation_code === lockedSource)) : saved[0]
  const sourceF3 = tab === 'history' ? selectedSaved : focused
  const f3Path = `/dss/runs/${runId}/options/${groupCode}/f3`
  const back = {
    pathname: sourceF3 ? `${f3Path}/${encodeURIComponent(sourceF3.plan.plan_code)}` : f3Path,
    search: planningSearch(activeScenario ?? scenario, {
      f3: sourceF3?.f3_evaluation_code ?? undefined,
      f4: tab === 'history' ? selectedSaved?.evaluation_code : undefined,
    }),
  }
  const options = previews.map(preview => {
    const reference = saveReference(preview)
    const matching = reference && saved.find(row => row.f3_evaluation_code === reference.f3_evaluation_code
      && row.plan.plan_code === preview.plan.plan_code && row.plan.revision === preview.plan.revision
      && row.contract_version === preview.contract_version && row.input_fingerprint === reference.input_fingerprint
      && row.configuration_fingerprint === reference.configuration_fingerprint)
    return { preview, reference, matching }
  })
  const pending = options.flatMap(({ reference, matching }) => reference && !matching ? [reference] : [])
  const savedCount = options.filter(({ matching }) => matching).length
  const availableCount = options.filter(({ reference }) => reference).length
  const canSave = storage && history.data !== null && !saving
  const currentCodes = new Set(options.flatMap(({ matching }) => matching ? [matching.evaluation_code] : []))
  const historyGroups = new Map<string, SavedF4Summary[]>()
  for (const row of saved) {
    const key = `${row.plan.template_type}/${row.plan.hub_id ?? ''}`
    const entries = historyGroups.get(key)
    if (entries) entries.push(row)
    else historyGroups.set(key, [row])
  }
  const latestCodes = new Set(Array.from(historyGroups.values(), rows => rows[0].evaluation_code))
  const historyLabel = (code: string) => latestCodes.has(code) ? 'Mới nhất của phương án' : 'Kết quả lịch sử'

  function openHistory(code: string) {
    setSavedCode(code)
    setTab('history')
  }

  async function save(references: F4SaveReference[], openAfterSave = false) {
    if (!canSave || saveInFlight.current) return
    const requested = pending.filter(ref => references.some(row => row.f3_evaluation_code === ref.f3_evaluation_code))
    if (!requested.length) return
    saveInFlight.current = true
    setSaving(true)
    setMessage(undefined)
    try {
      const result = await saveF4(runId, groupCode, requested, data?.active_scenario ?? undefined)
      const confirmed = result.evaluations.filter(row => requested.some(ref =>
        row.f3_evaluation_code === ref.f3_evaluation_code && row.input_fingerprint === ref.input_fingerprint
        && row.configuration_fingerprint === ref.configuration_fingerprint,
      ))
      const savedAll = new Set(confirmed.map(row => row.f3_evaluation_code)).size === requested.length
      setMessage({
        text: savedAll ? `Đã xác nhận lưu ${confirmed.length} kết quả F4.` : 'Máy chủ mới xác nhận một phần kết quả.',
        failed: !savedAll,
      })
      if (openAfterSave && confirmed.length === 1) openHistory(confirmed[0].evaluation_code)
    } catch (saveError) {
      setMessage({text: errorMessage(saveError), failed: true})
      reload()
    } finally {
      history.reload()
      saveInFlight.current = false
      setSaving(false)
    }
  }

  function onTabKey(event: KeyboardEvent, index: number) {
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break
      case 'ArrowRight': next = (index + 1) % tabs.length; break
      case 'Home': next = 0; break
      case 'End': next = tabs.length - 1; break
      default: return
    }
    event.preventDefault()
    setTab(tabs[next][0])
    document.getElementById(`${tabId}-${tabs[next][0]}`)?.focus()
  }

  return <main className="dssr-page f4-page">
    <header className="dssr-header">
      <div>
        <Link className="dssr-back-link" to={back}>← Phân bổ phương tiện F3</Link>
        <p className="dssr-eyebrow">COLOGI · DSS F4</p>
        <h1>Kiểm tra khả thi thời gian F4</h1>
        {previews.length > 0 && <p className="dssr-description">
          {candidate.demandIds.length || noValue} nhu cầu · {candidate.outletCount ?? noValue} Outlet · {candidate.weight ? kg(candidate.weight) : noValue}
          {' · '}{candidate.date ? deliveryDate(candidate.date) : noValue}
          {data?.active_scenario && ' · Kịch bản UAT'}
        </p>}
      </div>
      {availableCount > 0 && <button type="button" className="dssr-primary-button" disabled={!canSave || !pending.length}
        onClick={() => void save(pending)}>
        {savedCount === availableCount ? `Đã lưu (${savedCount}/${availableCount})`
          : savedCount > 0 ? `Lưu ${pending.length} phương án còn lại` : 'Lưu tất cả kết quả F4'}
      </button>}
    </header>
    <InternalPlanningNotice source={previews.find(row => row.internal_planning)?.internal_planning} />
    {loading && <p role="status" className="dssr-loading">Đang đối chiếu lịch trình…</p>}
    {error !== null && <div className="dssr-alert" role="alert">{errorMessage(error)}{' '}
      <button type="button" className="dssr-secondary-button" onClick={reload}>Thử lại</button>
    </div>}
    {data && !previews.length && <p className="dssf-notice">Chưa có kết quả F3 đã lưu để kiểm tra thời gian.</p>}
    {data && !storage && <p className="dssf-notice">Môi trường đang hỗ trợ F4 Preview. Lưu kết quả cần migration planning/0007.</p>}
    {!!data?.scenarios?.length && <div className="f4-picker">
      <label htmlFor={`${tabId}-scenario`}>Kịch bản UAT</label>
      <select id={`${tabId}-scenario`} value={data.active_scenario ?? ''} disabled={saving} onChange={event => {
        setQuery({ scenario: event.target.value })
        setSavedCode(undefined)
        setTab('overview')
        setPlanCode(undefined)
        setCompare(false)
        setMessage(undefined)
      }}>
        {data.scenarios.map(row => <option value={row.code} key={row.code}>{row.label}</option>)}
      </select>
    </div>}
    {message && <p className={message.failed ? 'dssr-alert' : 'dssf-notice'} role={message.failed ? 'alert' : 'status'}>{message.text}</p>}
    {saving && <p className="dssr-loading" role="status">Đang lưu F4…</p>}
    {storage && history.error !== null && <div className="dssr-alert" role="alert">
      {errorMessage(history.error)}{' '}<button type="button" className="dssr-secondary-button" onClick={history.reload}>Tải lại lịch sử</button>
    </div>}
    {data && previews.length > 0 && <>
      <dl className="f4-kpis" aria-label="Chỉ số F4">
        <div><dt>Phương án đánh giá</dt><dd>{inScope.length}</dd></div>
        <div className="f4-kpi-pass"><dt>Đạt kiểm tra F4</dt><dd>{inScope.filter(row => row.status === 'PASS').length}/{inScope.length}</dd></div>
        <div><dt>Xung đột hoặc thiếu bằng chứng</dt><dd>{inScope.filter(row => row.status !== 'PASS').length}</dd></div>
        <div><dt>Đủ điều kiện chuẩn bị F5</dt><dd>{history.loading ? noValue : options.filter(row => row.matching?.ready_for_f5).length}</dd></div>
      </dl>
      <div className="f4-tabs" role="tablist" aria-label="Nội dung kiểm tra thời gian">
        {tabs.map(([key,label], index) => <button type="button" role="tab" id={`${tabId}-${key}`}
          key={key} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} aria-controls={`${tabId}-panel`}
          onClick={() => setTab(key)} onKeyDown={event => onTabKey(event, index)}>{label}</button>)}
      </div>
      <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
        {tab === 'overview' && <Overview options={options} timezone={data.configuration.timezone}
          names={names} runId={runId} groupCode={groupCode} scenario={activeScenario}
          savingEnabled={canSave} historyReady={storage && history.data !== null}
          onSave={reference => void save([reference], true)} onOpen={openHistory} />}
        {focused && <div hidden={tab !== 'timeline'} key={timelineContext}>
          <div className="f4-picker">
            {previews.length > 1 && <div className="f4-view-toggle" role="group" aria-label="Chế độ lịch trình">
              <button type="button" aria-pressed={!compare} onClick={() => setCompare(false)}>Từng phương án</button>
              <button type="button" aria-pressed={compare} onClick={() => setCompare(true)}>So sánh các phương án</button>
            </div>}
            {!compare && <>
              <label htmlFor={`${tabId}-plan`}>Phương án</label>
              <select id={`${tabId}-plan`} value={focused.plan.plan_code} onChange={e => setPlanCode(e.target.value)}>
                {previews.map(row => <option key={row.plan.plan_code} value={row.plan.plan_code}>{planName(row.plan)}</option>)}
              </select>
              <F4StatusBadge status={focused.status} />
            </>}
          </div>
          <div className="f4-stack">
            <F4GanttChart key={compare ? 'compare' : focused.plan.plan_code}
              evaluations={previews} visible={compare ? previews : [focused]} timezone={data.configuration.timezone} names={names} />
            <div hidden={compare} className="f4-schedule-detail">
              <F4StopTables key={focused.plan.plan_code} evaluation={focused}
                timezone={focused.configuration?.timezone ?? data.configuration.timezone} names={names} />
            </div>
            <div hidden={!compare} className="f4-schedule-detail">
              <F4ComparisonTables evaluations={previews} timezone={data.configuration.timezone} names={names} />
            </div>
          </div>
        </div>}
        {tab === 'evidence' && focused && <>
          <div className="f4-picker">
            <label htmlFor={`${tabId}-evidence-plan`}>Phương án</label>
            <select id={`${tabId}-evidence-plan`} value={focused.plan.plan_code} onChange={e => setPlanCode(e.target.value)}>
              {previews.map(row => <option key={row.plan.plan_code} value={row.plan.plan_code}>{planName(row.plan)}</option>)}
            </select>
            <F4StatusBadge status={focused.status} />
          </div>
          <Evidence evaluation={focused} configuration={focused.configuration ?? data.configuration} names={names} />
        </>}
        {tab === 'history' && !storage && <section className="dssr-panel f4-card">
          <h2>Lịch sử đánh giá F4</h2>
          <p className="dssf-help">Lịch sử F4 sẽ khả dụng sau migration planning/0007.</p>
          <h3>Kết quả F3 được tham chiếu</h3>
          <ul>{previews.map(row => <li key={row.plan.plan_code}>
            {planName(row.plan)} · Phiên bản F2 {row.plan.revision} · <code>{row.f3_evaluation_code ?? noValue}</code>
          </li>)}</ul>
          <details className="dssf-technical"><summary>Fingerprint của lần xem trước</summary>
            <p>Cấu hình · <code>{data.configuration_fingerprint}</code></p>
            {previews.filter(row => row.input_fingerprint).map(row =>
              <p key={row.plan.plan_code}>{planName(row.plan)} · <code>{row.input_fingerprint}</code>
                {' · '}<code>{row.configuration_fingerprint}</code></p>)}
          </details>
        </section>}
        {tab === 'history' && storage && <div className="f4-history">
          <section className="dssr-panel f4-card">
            <h2>Lịch sử đánh giá F4</h2>
            {history.loading && <p role="status">Đang đọc lịch sử F4…</p>}
            {history.data && !saved.length && <p>Chưa có kết quả F4 đã lưu.</p>}
            {history.data && savedCode && !selectedSaved && <p role="alert">404 · Không tìm thấy bản đánh giá F4 đã chọn.</p>}
            {Array.from(historyGroups).sort(([left], [right]) => left.localeCompare(right, 'vi', { numeric: true })).map(([key, rows]) =>
              <div className="f4-history-group" key={key}>
                <h3>{planName(rows[0].plan)}</h3>
                <ul>{rows.map(row => <li key={row.evaluation_code} data-case={row.scenario_id ?? undefined}>
              <button type="button" className="dssr-secondary-button"
                aria-pressed={selectedSaved?.evaluation_code === row.evaluation_code}
                onClick={() => setSavedCode(row.evaluation_code)}>
                {runTime(row.evaluated_at)} · F2 phiên bản {row.plan.revision}
              </button>
              <F4StatusBadge status={row.status} />
              <small>{historyLabel(row.evaluation_code)}{currentCodes.has(row.evaluation_code) && ' · Thuộc kịch bản đang xem'}</small>
              {row.ready_for_f5 && <small className="f4-history-ready">Đủ điều kiện chuẩn bị F5</small>}
              {row.scenario_id && <small>{row.scenario_id}</small>}
                </li>)}</ul>
              </div>)}
          </section>
          {selectedSaved && <SavedEvaluation key={selectedSaved.evaluation_code} runId={runId}
            groupCode={groupCode} code={selectedSaved.evaluation_code} historyLabel={historyLabel(selectedSaved.evaluation_code)}
            current={currentCodes.has(selectedSaved.evaluation_code)} names={names} activeScenario={activeScenario} />}
        </div>}
      </div>
    </>}
  </main>
}

export default function DSSF4Page() {
  const { runId = '', optionId = '', evaluationCode } = useParams()
  return <F4Page key={`${runId}/${optionId}/${evaluationCode ?? ''}`}
    runId={runId} groupCode={optionId} evaluationCode={evaluationCode} />
}
