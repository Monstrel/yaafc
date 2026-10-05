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

/**
 * The units a row splits into: every count above 1 that splits its whole machines, or those of any
 * row it takes with it, evenly (in each of `above` copies of the line it sits in), up to its own
 * whole machines, fewest first. A split even only below rounds the row up in each copy: a row on 47
 * machines fed by one on 8 splits in 8, 6 machines each, 48 in all.
 */
export function unitChoices(tree: TreeNode[], n: TreeNode, above: number, utilization: Utilization): number[] {
  const whole = wholePerCopy(n, above, utilization)
  if (whole === null || !Number.isFinite(whole)) return []
  const even = new Set<number>()
  const visit = (r: TreeNode) => {
    const w = wholePerCopy(r, above, utilization)
    if (w !== null) for (let d = 2; d <= Math.min(w, whole); d++) if (w % d === 0) even.add(d)
    takenWith(tree, r).forEach(visit)
  }
  visit(n)
  return [...even].sort((a, b) => a - b)
}

/**
 * The rows a row's copies take with them, following the tree as shown: its children, and with a
 * single target, the items built at the top of the plan, which sit under it.
 */
function takenWith(tree: TreeNode[], n: TreeNode): TreeNode[] {
  const targets = tree.filter((t) => !t.id.startsWith('separate/'))
  if (targets.length !== 1 || n !== targets[0]) return n.children
  return [...n.children, ...tree.filter((t) => t.id.startsWith('separate/'))]
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
      if (wholePerCopy(n, above, utilization) === u.of && u.count <= u.of) {
        k *= u.count
        own.set(n.id, u.count)
      } else stale.push(n.id)
    }
    if (k !== 1) copies.set(n.id, k)
    takenWith(tree, n).forEach((c) => visit(c, k))
  }
  const targets = tree.filter((n) => !n.id.startsWith('separate/'))
  for (const n of targets.length === 1 ? targets : tree) visit(n, 1)
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
