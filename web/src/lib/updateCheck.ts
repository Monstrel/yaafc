import { useEffect, useState } from 'react'

declare const __BUILD_ID__: string

const POLL_MS = 15 * 60 * 1000

/** True once the deployed version.json names a different build than the one running in this tab. */
export function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    if (!import.meta.env.PROD || available) return
    const check = async () => {
      try {
        const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) return
        const { build } = (await res.json()) as { build?: string }
        if (build && build !== __BUILD_ID__) setAvailable(true)
      } catch {
        // Offline or mid-deploy; try again next time.
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(check, POLL_MS)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [available])

  return available
}
