import { apiRequest } from '../api/client'
import type { F5Preview, F5Saved, F5SavedDetail, F5SaveReference, F5SaveResponse } from '../../types/f5'

const evaluationsPath = (runCode: string, groupCode: string) =>
  `/planning/f5/runs/${encodeURIComponent(runCode)}/groups/${encodeURIComponent(groupCode)}/evaluations/`

export function getF5Preview(runCode: string, groupCode: string, evaluationCode: string, scenario?: string | null) {
  const path = `${evaluationsPath(runCode, groupCode)}${encodeURIComponent(evaluationCode)}/preview/`
  return apiRequest<F5Preview>(scenario ? `${path}?scenario=${encodeURIComponent(scenario)}` : path)
}

export function getF5History(runCode: string, groupCode: string) {
  return apiRequest<{ available: boolean; evaluations: F5Saved[] }>(evaluationsPath(runCode, groupCode))
}

export function getF5Evaluation(runCode: string, groupCode: string, evaluationCode: string) {
  return apiRequest<F5SavedDetail>(`${evaluationsPath(runCode, groupCode)}${encodeURIComponent(evaluationCode)}/`)
}

export function saveF5(runCode: string, groupCode: string, items: F5SaveReference[], scenario: string | null) {
  return apiRequest<F5SaveResponse>(evaluationsPath(runCode, groupCode), {
    method: 'POST',
    body: JSON.stringify({ items, scenario: scenario ?? undefined }),
  })
}
