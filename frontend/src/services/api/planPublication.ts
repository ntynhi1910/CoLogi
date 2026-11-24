import type { PublicationAudience, PublicationIndex, PublishedPlan } from '../../types/planPublication'
import { apiRequest } from './client'

export function listPublications(audience: PublicationAudience) {
  return apiRequest<PublicationIndex>(`/planning/publication/${audience}/`)
}

export function getPublication(audience: PublicationAudience, code: string) {
  return apiRequest<PublishedPlan>(`/planning/publication/${audience}/${encodeURIComponent(code)}/`)
}
