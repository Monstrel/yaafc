import { describe, expect, it } from 'vitest'
import { moveTarget, pruneChoices, removeTarget } from './choices'
import { buildCatalog } from './processes'
import { ROW_FIELDS, ROW_KEYS, rowEntries, type RowKey } from './rowSettings'
import { sanitizePlans } from './sanitize'
import type { Plan } from './types'
import { modifiers } from './upgrades'
import { plan } from './engineTestUtils'

// A value of every row setting: a new one has to be given one here, so it's checked like the rest.
const SAMPLE: {
  [K in RowKey]: NonNullable<Plan[K]> extends unknown[] ? true : NonNullable<Plan[K]> extends Record<string, infer V> ? V : never
} = {
  branches: { producer: 'recipe:X' },
  rowCatalysts: ['Catalyst1'],
  rowHeights: 3,
  rowStacks: 10,
  mixedFeed: true,
  units: { count: 2, of: 4 },
  altarOutputs: ['Y'],
  roundUp: true,
  built: true,
}

/** A plan with every row setting on one row. */
function withEvery(row: string): Plan {
  const p: Plan = plan({ targets: [{ item: 'A', rate: 1 }, { item: 'B', rate: 1 }] })
  for (const key of ROW_KEYS) (p as unknown as Record<string, unknown>)[key] = ROW_FIELDS[key].shape === 'list' ? [row] : { [row]: SAMPLE[key] }
  return p
}
const on = (p: Plan, key: RowKey) => rowEntries(p, key).map(([id]) => id)

describe('row settings', () => {
  it('each move with their row when targets move', () => {
    const moved = moveTarget(withEvery('1/B/X'), 1, 0)
    for (const key of ROW_KEYS) expect(on(moved, key), key).toEqual(['0/B/X'])
  })

  it('each go when their target does', () => {
    const removed = removeTarget(withEvery('1/B/X'), 1)
    for (const key of ROW_KEYS) expect(on(removed, key), key).toEqual([])
  })

  it('each go when their row leaves the plan', () => {
    const mods = modifiers({})
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
    const pruned = pruneChoices(withEvery('0/A/Nowhere'), catalog)!
    for (const key of ROW_KEYS) expect(on(pruned, key), key).toEqual([])
  })

  it('each survive saving and loading', () => {
    const p = withEvery('0/A/X')
    const [loaded] = sanitizePlans([JSON.parse(JSON.stringify(p))], () => 'x')!
    for (const key of ROW_KEYS) expect(loaded[key], key).toEqual(p[key])
  })
})
