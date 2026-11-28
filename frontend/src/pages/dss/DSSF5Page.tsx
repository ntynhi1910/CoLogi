import { useCallback, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { deliveryDate, runTime } from '../../components/dss/f1Display'
import { kg, planName } from '../../components/dss/f3Display'
import { planningSearch } from '../../components/dss/planningSearch'
import { diagnostic, money, number, percent, syntheticNotice } from '../../components/dss/f5Display'
import { Allocations, CostBreakdown, Overview, Rank, Sources } from '../../components/dss/F5DecisionPanels'
import { ApiError } from '../../services/api/client'
import { dssErrorMessage } from '../../services/dss/dssService'
import { getF5Evaluation, getF5History, getF5Preview, saveF5 } from '../../services/dss/f5Service'
import { useDssQuery } from '../../services/dss/useDssQuery'
import type { F5Option, F5Saved, F5SaveReference, F5SaveResult } from '../../types/f5'
import './DSSRunDetailPage.css'
import './F1Presentation.css'
import './DSSF5Page.css'

const tabs = ['Tổng quan so sánh', 'Cấu phần chi phí', 'Phân bổ theo Outlet', 'Nguồn dữ liệu và giải thích', 'Lịch sử đánh giá F5']

function reference(option: F5Option, config: string | null): F5SaveReference | null {
  if (option.status !== 'EVALUATED' || number(option.collaborative_cost) === null ||
      !option.lineage || !option.input_fingerprint || !config) return null
  return { f4_evaluation_code: option.lineage.f4_evaluation_code, input_fingerprint: option.input_fingerprint,
    configuration_fingerprint: config }
}

function sameResult(row: F5Saved, ref: F5SaveReference, version: number) {
  return row.contract_version === version && row.f4_evaluation_code === ref.f4_evaluation_code
    && row.input_fingerprint === ref.input_fingerprint && row.configuration_fingerprint === ref.configuration_fingerprint
}


function HistoryDetail({
  runId,
  groupCode,
  code,
  isCurrent,
}: {
  runId: string
  groupCode: string
  code: string
  isCurrent: boolean
}) {
  const load = useCallback(
    () => getF5Evaluation(runId, groupCode, code),
    [runId, groupCode, code]
  )

  const { data, loading, error, reload } = useDssQuery(load)

  if (loading) {
    return <p role="status">Đang tải kết quả đã lưu…</p>
  }

  if (!data || data.evaluation_code !== code) {
    return (
      <div className="dssr-alert" role="alert">
        {dssErrorMessage(error)}{' '}
        <button
          type="button"
          className="dssr-secondary-button"
          onClick={reload}
        >
          Thử lại
        </button>
      </div>
    )
  }

  return (
    <article
      className="dssr-panel f5-panel f5-history-summary"
      data-evaluation-code={code}
    >
      <div className="f5-panel-heading">
        <div>
          <h2>{planName(data.plan)}</h2>
          <p>{runTime(data.calculated_at)}</p>
        </div>

        <span
          className={
            'f5-badge ' +
            (isCurrent ? 'f5-rank--first' : 'f5-neutral')
          }
        >
          {isCurrent ? 'Kết quả hiện tại' : 'Kết quả lịch sử'}
        </span>
      </div>

      {data.evaluation_context === 'UAT' && (
        <p className="f5-notice">{syntheticNotice}</p>
      )}

      {data.evaluation_context === 'CAPSTONE' && (
        <p className="f5-notice">
          SYNTHETIC/CAPSTONE · Chi phí mô phỏng.
        </p>
      )}


{(() => {
  const saving = number(data.cost_saving)
  const rate = number(data.saving_rate_pct)

  const negative = saving !== null && saving < 0
  const positive = saving !== null && saving > 0

  const amount = saving === null
    ? '—'
    : money(String(Math.abs(saving)))

  const rateText = rate === null
    ? null
    : percent(String(Math.abs(rate)))

  return (
    <div className="f5-history-cost-summary">
      <div className="f5-history-metrics">
        <div>
          <span>Giao độc lập</span>
          <strong>{money(data.baseline_cost)}</strong>
        </div>

        <div>
          <span>Chi phí phối hợp</span>
          <strong>{money(data.collaborative_cost)}</strong>
        </div>

        <div>
          <span>Tiết kiệm</span>
          <strong
            className={
              negative
                ? 'f5-history-saving-negative'
                : positive
                  ? 'f5-history-saving-positive'
                  : ''
            }
          >
            {saving === null
              ? '—'
              : `${negative ? '−' : positive ? '+' : ''}${amount}`}
          </strong>
        </div>
      </div>

      {saving !== null && saving !== 0 && (
        <p className={
          'f5-history-saving-note ' +
          (negative
            ? 'f5-history-saving-note--negative'
            : 'f5-history-saving-note--positive')
        }>
          <span aria-hidden="true">
            {negative ? '!' : '✓'}
          </span>

          {negative
            ? `Phương án này tốn thêm ${amount}${rateText ? ` (${rateText})` : ''} so với giao độc lập.`
            : `Phương án này tiết kiệm ${amount}${rateText ? ` (${rateText})` : ''} so với giao độc lập.`}
        </p>
      )}
    </div>
  )
})()}


      <div className="f5-history-meta">
        <span>Thứ hạng tại thời điểm lưu</span>
        <Rank rank={data.snapshot.result.option.rank} />
      </div>

      


<section
  className="f5-history-info-section"
  aria-label="Thông tin bản đánh giá"
>
  <h3>Thông tin bản đánh giá</h3>

  <div className="f5-history-info">
    <div className="f5-history-info-row">
      <span>Trạng thái kết quả</span>
      <strong>
        {isCurrent
          ? 'Thuộc kết quả hiện tại'
          : 'Kết quả lịch sử'}
      </strong>
    </div>
  </div>
</section>


    </article>
  )
}


function History({ runId, groupCode, rows, current, active, onOpen }: {
  runId: string; groupCode: string; rows: F5Saved[]; current: Set<string>; active?: string; onOpen: (code: string) => void
}) {
  const groups = new Map<string, F5Saved[]>()
  for (const row of rows) {
    const key = `${row.plan.template_type}/${row.plan.hub_id ?? ''}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return <div className="f5-history">
    <section className="dssr-panel f5-panel f5-history-list"><h2>Lịch sử đánh giá F5</h2>
      {rows.length === 0 && <p>Chưa có kết quả đã lưu.</p>}
      {Array.from(groups, ([key, group]) => <section key={key}>
        <h3>{planName(group[0].plan)}</h3>
        {group.map(row => <button type="button" className="f5-history-entry" key={row.evaluation_code}
          aria-pressed={row.evaluation_code === active} onClick={() => onOpen(row.evaluation_code)}>
          <strong>{money(row.collaborative_cost)}</strong>
          <span className={'f5-badge ' + (current.has(row.evaluation_code) ? 'f5-rank--first' : 'f5-neutral')}>
            {current.has(row.evaluation_code) ? 'Kết quả hiện tại' : 'Kết quả lịch sử'}
          </span>
          <small>{runTime(row.calculated_at)}</small>
        </button>)}
      </section>)}
    </section>
    {active && <HistoryDetail key={active} runId={runId} groupCode={groupCode} code={active} isCurrent={current.has(active)} />}
  </div>
}

export default function DSSF5Page() {
  const { runId = '', optionId = '', evaluationCode = '' } = useParams()
  const [query] = useSearchParams()
  const scenario = query.get('scenario')
  const load = useCallback(() => getF5Preview(runId, optionId, evaluationCode, scenario), [runId, optionId, evaluationCode, scenario])
  const { data, loading, error, reload } = useDssQuery(load)
  const loadHistory = useCallback(() => getF5History(runId, optionId), [runId, optionId])
  const history = useDssQuery(loadHistory)
  const [selected, setSelected] = useState(0)
  const [active, setActive] = useState<string>()
  const [results, setResults] = useState<F5SaveResult[]>([])
  const [saveError, setSaveError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const id = useId()
  const source = data?.options.find(option => option.lineage?.f4_evaluation_code === evaluationCode)?.lineage
  const f4Path = `/dss/runs/${runId}/options/${optionId}/f4`
  const back = {
    pathname: source ? `${f4Path}/${encodeURIComponent(source.f3_evaluation_code)}` : f4Path,
    search: planningSearch(data?.scenario ?? scenario, { f4: source ? evaluationCode : undefined }),
  }
  const rows = history.data?.evaluations ?? []
  const current = new Set<string>()
  const pending: F5SaveReference[] = []
  let eligible = 0
  if (data) {
    for (const option of data.options) {
      const ref = reference(option, data.configuration_fingerprint)
      if (!ref) continue
      eligible += 1
      const saved = rows.find(row => sameResult(row, ref, data.contract_version))
      if (saved) current.add(saved.evaluation_code)
      else pending.push(ref)
    }
  }
  const canSave = Boolean(data?.persistence_available && history.data?.available && !history.loading && !saving)

  const allSaved = eligible > 0 && current.size === eligible

  async function publish(items: F5SaveReference[]) {
    if (!data || !canSave || inFlight.current || items.length === 0) return
    inFlight.current = true
    setSaving(true)
    setSaveError(undefined)
    setResults([])
    try {
      const response = await saveF5(runId, optionId, items, data.scenario)
      setResults(response.results)
    } catch (err) {
      const body = err instanceof ApiError ? err.data as { results?: F5SaveResult[] } | null : null
      if (Array.isArray(body?.results)) setResults(body.results)
      else setSaveError(dssErrorMessage(err))
    } finally {
      history.reload()
      inFlight.current = false
      setSaving(false)
    }
  }
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const targets: Record<string, number> = { ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }
    const next = targets[event.key]
    if (next === undefined) return
    event.preventDefault()
    setSelected(next)
    document.getElementById(`${id}-${next}`)?.focus()
  }
  return <main className="dssr-page f5-page">
    <header className="dssr-header"><div><Link className="dssr-back-link" to={back}>← Kiểm tra thời gian F4</Link>
      <p className="dssr-eyebrow">COLOGI · DSS F5</p>
<div className="f5-heading-row">
  <h1>Đánh giá kinh tế F5</h1>

  {rows.length > 0 && (
    <Link
      className="f5-decision-button"
      to={`/dss/decisions/${runId}/${optionId}`}
    >
      <span>Xem phương án để quyết định</span>
      <span aria-hidden="true">→</span>
    </Link>
  )}
</div>

      {data && <p className="dssr-description">{data.demands.length} nhu cầu · {kg(data.total_weight_kg)}
        {' · '}{deliveryDate(data.service_date)}{data.scenario && ` · ${data.scenario}`}</p>}</div></header>
    {loading && <p className="dssr-loading" role="status">Đang đối chiếu chi phí và kết quả đã lưu…</p>}
    {error != null && <div className="dssr-alert" role="alert">
      {error instanceof ApiError && error.status === 409 ? 'Kết quả F4 đã chọn không đủ điều kiện trong kịch bản này.' : dssErrorMessage(error)}
      {' '}<button type="button" className="dssr-secondary-button" onClick={reload}>Thử lại</button>
    </div>}
    {data && <>
      <div className="f5-context-bar">
        {data.evaluation_context === 'UAT' && <p className="f5-notice">{syntheticNotice}</p>}
        {data.evaluation_context === 'CAPSTONE' && <p className="f5-notice">SYNTHETIC/CAPSTONE · Chi phí mô phỏng.</p>}
        {data.persistence_available && <div className="f5-save-bar">
          <button type="button" className="dssr-primary-button" disabled={!canSave || !pending.length}
            onClick={() => void publish(pending)}>
            {allSaved ? 'Đã lưu (' + current.size + '/' + eligible + ')' : saving ? 'Đang lưu…'
              : eligible ? 'Lưu tất cả phương án đủ điều kiện' : 'Chưa có phương án đủ điều kiện lưu'}
          </button>
        </div>}
      </div>
      {saveError && <p className="dssr-alert" role="alert">{saveError}</p>}
      {results.length > 0 && <ul className="f5-save-results" role="status">
        {results.map(result => {
          const plan = data.options.find(option => option.lineage?.f4_evaluation_code === result.f4_evaluation_code)?.plan
          const message = result.outcome === 'REJECTED' ? diagnostic[result.code] ?? result.code
            : result.outcome === 'EXISTS' ? 'Đã có bản lưu đúng fingerprint.' : 'Đã lưu.'
          return <li key={result.f4_evaluation_code}><strong>{plan ? planName(plan) : result.f4_evaluation_code}</strong> · {message}</li>
        })}
      </ul>}
      {data.persistence_available && history.error != null && <p className="dssr-alert" role="alert">
        Chưa xác nhận được trạng thái đã lưu. <button type="button" className="dssr-secondary-button" onClick={history.reload}>Tải lại lịch sử</button>
      </p>}
      <div className="f5-tabs" role="tablist" aria-label="Nội dung đánh giá kinh tế">
        {tabs.map((tab, i) => <button type="button" key={tab} role="tab" id={`${id}-${i}`}
          aria-selected={selected === i} aria-controls={`${id}-panel`} tabIndex={selected === i ? 0 : -1}
          onClick={() => setSelected(i)} onKeyDown={event => onKey(event, i)}>{tab}</button>)}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${selected}`} tabIndex={0} className="f5-content">
        {selected === 0 && <Overview data={data} saved={current.size} eligible={eligible} actions={option => {
          if (!data.persistence_available) return null
          const ref = reference(option, data.configuration_fingerprint)
          if (!ref) return null
          const saved = rows.find(row => sameResult(row, ref, data.contract_version))
          return <div className="f5-row-actions">
            <button type="button" className="dssr-secondary-button" disabled={!canSave || !!saved}
              onClick={() => void publish([ref])}>{saved ? 'Đã lưu' : 'Lưu phương án'}</button>
            {saved && <button type="button" className="dssr-secondary-button"
              onClick={() => { setActive(saved.evaluation_code); setSelected(4) }}>Mở bản đã lưu</button>}
          </div>
        }} />}
        {selected === 1 && <CostBreakdown data={data} />}
        {selected === 2 && <Allocations data={data} />}
        {selected === 3 && <Sources data={data} />}
        {selected === 4 && (data.persistence_available
          ? history.loading ? <p role="status">Đang đọc lịch sử F5…</p>
            : <History runId={runId} groupCode={optionId} rows={rows} current={current}
              active={active ?? rows[0]?.evaluation_code} onOpen={setActive} />
          : <p className="f5-notice">Môi trường này đang hỗ trợ F5 Preview. Lịch sử lưu chưa khả dụng.</p>)}
      </div>
    </>}
  </main>
}
