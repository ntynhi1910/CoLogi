import { useCallback, useEffect, useRef, useState } from 'react'
import { getToken } from '../api/client'

type Query<T> = { data: T; error: null } | { data: null; error: unknown }

export function useDssQuery<T>(
  load: () => Promise<T>,
  reuseInFlight = false,
) {
  const pending = useRef<{
    load: () => Promise<T>
    revision: number
    token: string | null
    promise: Promise<T>
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  const [response, setResponse] = useState<{
    load: typeof load
    revision: number
    result: Query<T>
  }>()

  useEffect(() => {
    let active = true

    const token = reuseInFlight ? getToken() : null
    const previous = pending.current

    let request: Promise<T>

    if (
      reuseInFlight &&
      previous &&
      previous.load === load &&
      previous.revision === revision &&
      previous.token === token
    ) {
      request = previous.promise
    } else {
      request = load()

      if (reuseInFlight) {
        const entry = {
          load,
          revision,
          token,
          promise: request,
        }

        pending.current = entry

        const clear = () => {
          if (pending.current === entry) {
            pending.current = null
          }
        }

        request.then(clear, clear)
      }
    }

    request.then(
      (data) => {
        if (active) setResponse({ load, revision, result: { data, error: null } })
      },
      (error: unknown) => {
        if (active) setResponse({ load, revision, result: { data: null, error } })
      },
    )
    return () => { active = false }
  }, [load, revision, reuseInFlight])

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
