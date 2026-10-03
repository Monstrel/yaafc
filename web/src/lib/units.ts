import type { TreeNode } from './tree'
import type { Plan, Unitizing } from './types'

/**
 * Building a row in units: the row and everything below it, built as several identical copies of
 * a smaller line (to blueprint and paste in the game). Rates don't change: each copy makes its share,
 * and its rows run on their share of the machines, rounded up to whole ones per copy, so a unitized
 * line can take more buildings, each running slower.
 */

/** How far belt limits slow a row's machines (1 = full speed). */
export type Utilization = (n: TreeNode) => number

/**
 * Whole machines a row is built on in each of `copies` copies of the line it sits in (input belt
 * limits included), or null for rows that don't run machines.
 */
export function wholePerCopy(n: TreeNode, copies: number, utilization: Utilization): number | null {
  const p = n.run?.process
  if (n.kind !== 'produce' || !p?.machine || p.seconds <= 0 || n.machines <= 0) return null
  const u = utilization(n)
  if (u <= 0) return null
  return Math.ceil(n.machines / copies / u - 1e-9)
}

/** The units a row on `whole` machines splits into evenly: every divisor above 1, fewest first. */
export function unitChoices(whole: number | null): number[] {
  const out: number[] = []
  if (whole === null || !Number.isFinite(whole)) return out
  for (let d = 2; d <= whole; d++) if (whole % d === 0) out.push(d)
  return out
}

export interface UnitScales {
  /** Per row id: copies of it built (its own units times those of the rows above it). Absent = 1. */
  copies: Map<string, number>
  /** Per row id: the units it's built in, for rows that are (still) unitized. */
  own: Map<string, number>
  /** Unitized rows whose machine count changed since: they're a different line now. */
  stale: string[]
}

/**
 * Copies of every row, following the tree as shown: with a single target, the items built at the
 * top of the plan sit under it, so they're split with it too.
 */
export function unitScales(tree: TreeNode[], units: Plan['units'], utilization: Utilization): UnitScales {
  const copies = new Map<string, number>()
  const own = new Map<string, number>()
  const stale: string[] = []
  if (!units || !Object.keys(units).length) return { copies, own, stale }
  const visit = (n: TreeNode, above: number) => {
    let k = above
    const u = units[n.id]
    if (u) {
      if (wholePerCopy(n, above, utilization) === u.of && u.of % u.count === 0) {
        k *= u.count
        own.set(n.id, u.count)
      } else stale.push(n.id)
    }
    if (k !== 1) copies.set(n.id, k)
    n.children.forEach((c) => visit(c, k))
    if (groups && n === targets[0]) groups.forEach((g) => visit(g, k))
  }
  const targets = tree.filter((n) => !n.id.startsWith('separate/'))
  const groups = targets.length === 1 ? tree.filter((n) => n.id.startsWith('separate/')) : null
  for (const n of groups ? targets : tree) visit(n, 1)
  return { copies, own, stale }
}

/** Builds a row in `count` units of its `of` whole machines, or as one line (null). */
export function setUnits(plan: Plan, row: string, unit: Unitizing | null): Plan {
  const { [row]: _, ...rest } = plan.units ?? {}
  const units = unit ? { ...rest, [row]: unit } : rest
  return { ...plan, units: Object.keys(units).length ? units : undefined }
}

/** Drops unitizing gone stale (only as it was found, in case it has been picked again since). */
export function dropUnits(plan: Plan, rows: string[], was: Plan['units']): Plan {
  let next = plan
  for (const id of rows) {
    const u = plan.units?.[id]
    if (u && u.count === was?.[id]?.count && u.of === was[id].of) next = setUnits(next, id, null)
  }
  return next
}
