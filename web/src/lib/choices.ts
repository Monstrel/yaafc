import type { ProcessCatalog } from './processes'
import type { Plan } from './types'
import { resolveChoice, rowItem, unfold } from './unfold'

export interface ProducerPick {
  item: string
  /** Process id, or 'import'. */
  producer: string
  /** Machine to run it on, when it can run on several. */
  machine?: string
  /** Tree row picked on; absent (or `everywhere`) = the plan-wide producer. */
  row?: string
  everywhere?: boolean
}

const without = <T>(rows: Record<string, T> | undefined, drop: (id: string) => boolean) =>
  rows && Object.fromEntries(Object.entries(rows).filter(([id]) => !drop(id)))

/**
 * Applies a producer pick. On a row it covers that row's branch: the row and every row of its
 * item below it, replacing picks made further down. A pick matching what the row would inherit
 * anyway isn't stored. Everywhere, it becomes the plan-wide producer and clears the item's
 * branch picks.
 */
export function chooseProducer(plan: Plan, catalog: ProcessCatalog, pick: ProducerPick): Plan {
  const { item, producer, machine, row } = pick
  if (!row || pick.everywhere)
    return {
      ...plan,
      producers: { ...plan.producers, [item]: producer },
      machines: machine ? { ...plan.machines, [producer]: machine } : plan.machines,
      branches: without(plan.branches, (id) => rowItem(id) === item),
    }
  const next = {
    ...plan,
    branches: without(plan.branches, (id) => (id === row || id.startsWith(`${row}/`)) && rowItem(id) === item),
  }
  const inherited = resolveChoice(next, catalog, item, row)
  const chosen = catalog.byId.get(producer)
  const onMachine = machine && chosen?.machineOptions.some((m) => m.key === machine) ? machine : chosen?.machine?.key
  if (inherited.producer === producer && inherited.process?.machine?.key === onMachine) return next
  return { ...next, branches: { ...next.branches, [row]: { producer, ...(machine && { machine }) } } }
}

/** Loads catalysts into one row's machines (none: the row runs without). */
export function setRowCatalysts(plan: Plan, row: string, catalysts: string[]): Plan {
  const rest = without(plan.rowCatalysts, (id) => id === row) ?? {}
  return { ...plan, rowCatalysts: catalysts.length ? { ...rest, [row]: catalysts } : rest }
}

/**
 * Plans saved before catalysts were per row kept them per recipe: loads them into every row running
 * that recipe where they apply. Returns null when there's nothing to move.
 */
export function migrateCatalysts(plan: Plan, catalog: ProcessCatalog): Plan | null {
  const legacy = plan.catalysts
  if (!legacy) return null
  const { catalysts: _, ...rest } = plan
  const rowCatalysts = { ...plan.rowCatalysts }
  for (const n of unfold(rest, catalog).nodes) {
    const list = n.process?.acceptsCatalysts ? legacy[n.process.id] : undefined
    if (list?.length && !rowCatalysts[n.id]) rowCatalysts[n.id] = list
  }
  return { ...rest, rowCatalysts }
}

/** Drops a row's own pick, so it follows the rows above it (or the plan) again. */
export function clearBranchChoice(plan: Plan, row: string): Plan {
  return { ...plan, branches: without(plan.branches, (id) => id === row) }
}
