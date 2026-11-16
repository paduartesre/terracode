import { useCallback, useEffect, useRef, useState } from 'react'
import { CREDENTIALS_CHANGED_EVENT } from './api'

// Ignore responses from older requests so overlapping refreshes cannot restore
// an obsolete locked, unlocked, or provider-session state.
export function useCredentialStatus<T extends { unlockedUntil?: number }>(load: () => Promise<T>) {
  const [status, setStatus] = useState<T | null>(null)
  const sequence = useRef(0)

  const refresh = useCallback(async (): Promise<T | null> => {
    const current = ++sequence.current
    try {
      const result = await load()
      if (current !== sequence.current) return null
      setStatus(result)
      return result
    } catch {
      if (current === sequence.current) setStatus(null)
      return null
    }
  }, [load])

  useEffect(() => {
    const update = () => { void refresh() }
    update()
    window.addEventListener(CREDENTIALS_CHANGED_EVENT, update)
    window.addEventListener('focus', update)
    return () => {
      sequence.current += 1
      window.removeEventListener(CREDENTIALS_CHANGED_EVENT, update)
      window.removeEventListener('focus', update)
    }
  }, [refresh])

  useEffect(() => {
    if (!status?.unlockedUntil) return
    const expiry = status.unlockedUntil
    let timer: number
    const schedule = () => {
      const remaining = Math.max(1, expiry - Date.now() + 50)
      timer = window.setTimeout(remaining > 2_147_483_647 ? schedule : () => { void refresh() }, Math.min(remaining, 2_147_483_647))
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [refresh, status?.unlockedUntil])

  return { status, refresh }
}
