import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A function that keeps its identity across renders and calls the latest `fn`: for handlers passed
 * to memoized children, so those whose own props didn't change aren't drawn again. Call it from
 * events, not while rendering.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  return useCallback((...args: A) => latest.current(...args), [])
}
