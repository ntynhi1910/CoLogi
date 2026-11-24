import type { F1Diagnostic } from '../../types/f1'
import { f1Label } from './f1Display'

export default function ExclusionReasonList({ diagnostics }: { diagnostics: (F1Diagnostic | string)[] }) {
  if (!diagnostics.length) return null

  const entries = diagnostics.map((item) => typeof item === 'string' ? { code: item } : item)
  return (
    <>
      <ul className="dssr-f1-diagnostics">
        {entries.map((item, index) => (
          <li key={`${item.code}-${index}`}>
            {item.severity && <small>{f1Label(item.severity)} · </small>}
            <span>{f1Label(item.code)}</span>
            {item.demand_ids?.length ? <small> · {item.demand_ids.length} nhu cầu liên quan</small> : null}
          </li>
        ))}
      </ul>
      <details className="dssf-technical">
        <summary>Chi tiết kỹ thuật</summary>
        <ul>
          {entries.map((item, index) => (
            <li key={`${item.code}-${index}`}>
              <code>{[item.stage, item.severity, item.code, item.matching_outcome].filter(Boolean).join(' · ')}</code>
              {item.demand_ids?.length ? <div>ID nhu cầu {item.demand_ids.join(', ')}</div> : null}
              {item.conflict_demand_ids?.length ? <div>ID xung đột {item.conflict_demand_ids.join(', ')}</div> : null}
            </li>
          ))}
        </ul>
      </details>
    </>
  )
}
