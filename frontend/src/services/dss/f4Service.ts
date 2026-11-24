import { apiRequest } from '../api/client'
import { getDemand } from '../api/demands'
import type { F4Preview, F4SaveReference, SavedF4Detail, SavedF4Summary } from '../../types/f4'

const groupPath = (runCode: string, groupCode: string) =>
  `/planning/f4/runs/${encodeURIComponent(runCode)}/groups/${encodeURIComponent(groupCode)}`

export function getF4Preview(runCode: string, groupCode: string, evaluationCode?: string, scenario?: string) {
  const group = groupPath(runCode, groupCode)
  const path = evaluationCode
    ? `${group}/evaluations/${encodeURIComponent(evaluationCode)}/preview/`
    : `${group}/preview/`
  return apiRequest<F4Preview>(scenario ? `${path}?scenario=${encodeURIComponent(scenario)}` : path)
}

export function getF4History(runCode: string, groupCode: string) {
  return apiRequest<{ evaluations: SavedF4Summary[] }>(`${groupPath(runCode, groupCode)}/evaluations/`)
}

export function getF4Evaluation(runCode: string, groupCode: string, evaluationCode: string) {
  return apiRequest<SavedF4Detail>(
    `${groupPath(runCode, groupCode)}/evaluations/${encodeURIComponent(evaluationCode)}/`,
  )
}

export function saveF4(runCode: string, groupCode: string, evaluations: F4SaveReference[], scenario?: string) {
  return apiRequest<{ evaluations: SavedF4Summary[]; created_count: number }>(
    `${groupPath(runCode, groupCode)}/evaluations/`,
    { method: 'POST', body: JSON.stringify({ evaluations, scenario }) },
  )
}

export function checkF5Readiness(runCode: string, groupCode: string, evaluationCode: string) {
  return apiRequest<{ evaluation_code: string; ready_for_f5: boolean }>(
    `${groupPath(runCode, groupCode)}/evaluations/${encodeURIComponent(evaluationCode)}/f5-readiness/`,
  )
}

export async function getCandidateDemandLabels(demandIds: number[]) {
  const results = await Promise.allSettled(demandIds.map(getDemand))
  return results.flatMap(row => row.status === 'fulfilled' ? [row.value] : [])
}
