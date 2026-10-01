import type { Plan, Separation } from './types'

/** The plan's build-separately choices (older plans stored bare item keys: the top of the plan). */
export function separationsOf(separate: Plan['separate']): Separation[] {
  return ((separate ?? []) as (Separation | string)[]).map((s) => (typeof s === 'string' ? { item: s } : s))
}

export const separationKey = (s: Separation) => [s.item, s.anchor ?? '', s.at ?? ''].join('|')

/**
 * Adds a choice, replacing the ones it overrides: the top of the plan and anchors don't mix for
 * one item, and a pick for an anchor replaces earlier picks for that anchor, except single rows
 * of it when this is another single row.
 */
export function withSeparation(list: Separation[], s: Separation): Separation[] {
  const kept = list.filter((o) => {
    if (o.item !== s.item) return true
    if (!o.anchor || !s.anchor) return false
    if (o.anchor !== s.anchor) return true
    return !!s.at && !!o.at && o.at !== s.at
  })
  return [...kept, s]
}

export const withoutSeparation = (list: Separation[], s: Separation) =>
  list.filter((o) => separationKey(o) !== separationKey(s))
