import { useCallback, useEffect, useState } from 'react'

type Query<T> = { data: T; error: null } | { data: null; error: unknown }

export function useDssQuery<T>(load: () => Promise<T>) {
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  const [response, setResponse] = useState<{
    load: typeof load
    revision: number
    result: Query<T>
  }>()

  useEffect(() => {
    let active = true
    load().then(
      (data) => {
        if (active) setResponse({ load, revision, result: { data, error: null } })
      },
      (error: unknown) => {
        if (active) setResponse({ load, revision, result: { data: null, error } })
      },
    )
    return () => { active = false }
  }, [load, revision])

  const result = response?.load === load && response.revision === revision
    ? response.result
    : null

  return {
    data: result?.data ?? null,
    error: result?.error ?? null,
    loading: result === null,
    reload,
  }
}
