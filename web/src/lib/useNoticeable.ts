import { useEffect, useState } from 'react'

/** How long work runs before it's worth showing: quicker solves come and go without a flash. */
const NOTICEABLE_MS = 300

/** Whether `on` has held for a noticeable while; false again as soon as it's off. */
export function useNoticeable(on: boolean, ms = NOTICEABLE_MS): boolean {
  const [shown, setShown] = useState(false)
  if (!on && shown) setShown(false)
  useEffect(() => {
    if (!on) return
    const timer = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(timer)
  }, [on, ms])
  return on && shown
}
