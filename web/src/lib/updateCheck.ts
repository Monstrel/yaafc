import { useEffect, useState } from 'react'

declare const __BUILD_ID__: string
declare const __BUILD_TIME__: string
declare const __BUILD_RUN__: number

const isLocal = __BUILD_ID__.startsWith('local-')

/** The deploy run that built this, counting up with each deploy (0 for a local build). */
export const buildRun = __BUILD_RUN__

/** This build as the footer shows it: a deployed build names its commit, a local one just says so. */
export const buildInfo = {
  label: isLocal ? 'local' : __BUILD_ID__.slice(0, 7),
  commitUrl: isLocal ? null : `https://github.com/Monstrel/yaafc/commit/${__BUILD_ID__}`,
  time: __BUILD_TIME__,
}

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
