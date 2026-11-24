import { apiRequest } from '../api/client'
import type { F3ManagerAcceptancePreview, F3Preview, SavedF3Detail, SavedF3Summary } from '../../types/f3'

const groupPath = (runCode: string, groupCode: string) =>
  `/planning/f3/runs/${encodeURIComponent(runCode)}/groups/${encodeURIComponent(groupCode)}`

export function getF3Preview(runCode: string, groupCode: string, planCode?: string) {
  const group = groupPath(runCode, groupCode)
  return apiRequest<F3Preview>(planCode
    ? `${group}/plans/${encodeURIComponent(planCode)}/allocation/`
    : `${group}/allocations/`)
}

export function getF3AcceptancePreview(runCode: string, groupCode: string, planCode: string) {
  const path = `${groupPath(runCode, groupCode)}/plans/${encodeURIComponent(planCode)}/acceptance-preview/`
  return apiRequest<F3ManagerAcceptancePreview>(path)
}

export function saveF3(runCode: string, groupCode: string, planCodes: string[]) {
  return apiRequest<{ evaluations: SavedF3Summary[]; created_count: number }>(`${groupPath(runCode, groupCode)}/evaluations/`, {
    method: 'POST',
    body: JSON.stringify({ plan_codes: planCodes }),
  })
}

export function getF3History(runCode: string, groupCode: string, planCode?: string) {
  const group = groupPath(runCode, groupCode)
  return apiRequest<{ evaluations: SavedF3Summary[] }>(planCode
    ? `${group}/plans/${encodeURIComponent(planCode)}/evaluations/`
    : `${group}/evaluations/`)
}

export function getF3Evaluation(runCode: string, groupCode: string, evaluationCode: string) {
  return apiRequest<SavedF3Detail>(`${groupPath(runCode, groupCode)}/evaluations/${encodeURIComponent(evaluationCode)}/`)
}

export function checkF4Readiness(runCode: string, groupCode: string, evaluationCode: string) {
  const path = `${groupPath(runCode, groupCode)}/evaluations/${encodeURIComponent(evaluationCode)}/f4-readiness/`
  return apiRequest<{ evaluation_code: string; ready_for_f4: boolean }>(path)
}
