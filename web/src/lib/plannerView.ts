import { itemName } from './gameData'
import { type OutputSource } from './money'
import { machineNameFor } from './plural'
import type { TreeNode } from './tree'

/** What a target's item can feed back into: what the plan takes of it from the bus, or (coins) its money. */
export type Feeds = 'bus' | 'money' | null

/** Whether the plan feeds this source back into its own use or its money (so it's in a banner, not out). */
export const isFed = (s: OutputSource) => s.fedBack && s.feeds.length > 0

/** What the plan feeds back of a source, and what's left of it after that, its own overflow targets and Knowledge Altars, per minute. */
export function sourceUse(s: OutputSource) {
  const fed = Object.values(s.used).reduce((t, n) => t + (n ?? 0), 0)
  const taken = s.taken.reduce((t, x) => t + x.amount, 0)
  return { fed, left: s.amount - fed - taken - s.altar }
}

/** Where an item overflows from: the rows of one kind of machine (by name). */
export interface OverflowSource {
  /** The machines, as "Athanors" (or the item made, for rows not made by a machine). */
  label: string
  /** What the rows make, as "Athanors making Copper Powder, Steel Ingot". */
  title: string
  /** The tree rows it overflows from, biggest first. */
  ids: string[]
}

/**
 * Per overflowing item, the rows it overflows from, by machine: the overflow may be their main
 * product or a side one.
 */
export function overflowRows(tree: TreeNode[]): Map<string, OverflowSource[]> {
  const found = new Map<string, Map<string, { machines: number; making: Set<string>; rows: TreeNode[] }>>()
  const note = (item: string, n: TreeNode) => {
    const machine = n.run?.process.machine?.name ?? ''
    const byMachine = found.get(item) ?? new Map()
    found.set(item, byMachine)
    const g = byMachine.get(machine) ?? { machines: 0, making: new Set(), rows: [] }
    byMachine.set(machine, g)
    g.machines += n.machines
    g.making.add(itemName(n.item))
    g.rows.push(n)
  }
  const visit = (n: TreeNode) => {
    if (n.overflow > 0) note(n.item, n)
    for (const b of n.byproducts) if (b.overflow > 0) note(b.item, n)
    n.children.forEach(visit)
  }
  tree.forEach(visit)
  return new Map(
    [...found].map(([item, byMachine]) => [
      item,
      [...byMachine].map(([machine, g]) => {
        const making = [...g.making].join(', ')
        const label = machine ? machineNameFor(machine, g.machines) : making
        return {
          label,
          title: machine ? `${label} making ${making}` : making,
          ids: g.rows.sort((a, b) => b.machines - a.machines).map((n) => n.id),
        }
      }),
    ]),
  )
}

/** Steps of the plan whose own recipe, machine or purchase needs research beyond `tier`. */
export function beyondTier(tree: TreeNode[], tier: number): { item: string; tier: number; what: string }[] {
  const found = new Map<string, { item: string; tier: number; what: string }>()
  const visit = (n: TreeNode) => {
    const p = n.run?.process
    const made = !!p && (n.kind === 'produce' || n.kind === 'byproduct')
    const needs = made ? p.tier : 0
    const seen = found.get(n.item)
    if (made && needs > tier && (!seen || needs < seen.tier))
      found.set(n.item, { item: n.item, tier: needs, what: p.kind === 'buy' ? 'bought at a Purchasing Portal' : (p.machine?.name ?? p.label) })
    n.children.forEach(visit)
  }
  tree.forEach(visit)
  return [...found.values()].sort((a, b) => a.tier - b.tier)
}
