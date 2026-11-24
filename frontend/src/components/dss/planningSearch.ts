export function planningSearch(scenario: string | null | undefined, selection: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams()
  if (scenario) params.set('scenario', scenario)
  for (const [key, value] of Object.entries(selection)) {
    if (value) params.set(key, value)
  }
  return params.toString()
}
