// Test setup: every plan a test solves must set its row settings on rows the plan has. A setting
// on a row id that's gone (a recipe path that changed with the game data, say) is ignored by the
// solve, so a test of it would pass without testing anything.
import { vi } from 'vitest'
import type { ProcessCatalog } from '../lib/processes'
import { ROW_KEYS, rowEntries } from '../lib/rowSettings'
import { separationsOf } from '../lib/separate'
import type { Plan } from '../lib/types'
import { unfold } from '../lib/unfold'

/** The row settings (and build-separately rows) a plan sets on rows it doesn't have. */
export function danglingRows(plan: Plan, catalog: ProcessCatalog): string[] {
  const rows = new Set(unfold(plan, catalog).nodes.map((n) => n.id))
  return [
    ...ROW_KEYS.flatMap((key) => rowEntries(plan, key).flatMap(([id]) => (rows.has(id) ? [] : [`${key} on ${id}`]))),
    ...separationsOf(plan.separate).flatMap((s) => (s.at && !rows.has(s.at) ? [`separate ${s.item} at ${s.at}`] : [])),
  ]
}

vi.mock('../lib/solver', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/solver')>()
  return {
    ...real,
    solvePlan: (...args: Parameters<typeof real.solvePlan>) => {
      const [plan, catalog] = args
      const dangling = danglingRows(plan, catalog)
      if (dangling.length) throw new Error(`The plan sets these on rows it doesn't have: ${dangling.join('; ')}`)
      return real.solvePlan(...args)
    },
  }
})
