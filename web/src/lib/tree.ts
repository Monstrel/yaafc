import { HEAT, NUTRIENTS, type Stack } from './gameData'
import { craftsPerMachine } from './machineRate'
import { runKey } from './processes'
import type { ProcessRun } from './solver'
import type { Separation } from './types'
import { IMPORT, type PlanNode } from './unfold'
import type { Modifiers } from './upgrades'

export type TreeNodeKind =
  | 'produce' // made by machines running for this item
  | 'byproduct' // covered by side output of machines running for something else
  | 'purchase' // bought at a purchasing portal
  | 'bus' // fuel/fertilizer taken from the factory bus
  | 'loop' // already produced further up this branch (cycle)
  | 'separate' // built separately: its machines are under the row `groupId`
  | 'overflow' // the plan's overflow of the item, taken by an overflow target

export interface TreeNode {
  /** Stable path id (item keys from the root), used for folding and per-branch choices. */
  id: string
  item: string
  kind: TreeNodeKind
  /** Items per minute this row supplies: what the row above uses, plus anything gathered or looped back to it. */
  rate: number
  run?: ProcessRun
  /** Process id the row uses, 'import', or '' for rows supplied elsewhere (loops, separate builds, the bus). */
  producer: string
  /** The producer was picked for this row's branch, not inherited from above or the plan. */
  ownChoice: boolean
  /** The row follows one of the player's saved defaults. */
  mine: boolean
  /** Catalysts the row loads unless it sets its own. */
  defaultCatalysts: string[]
  /** Height the row's machines are built at unless it sets its own. */
  defaultHeight: number
  /** Coins its Bank Portals output per entry unless it sets its own. */
  defaultStack: number
  /** The row takes other rows' by-products of its item first (else it makes all of it). */
  reuse: boolean
  /** Reuse was picked: the row also takes by-products from rows that make their own. */
  reuseChosen: boolean
  /** Machines working for this row (fractional). */
  machines: number
  /** Heat this row's machines use, P/s. */
  heat: number
  /** Nutrients this row's nurseries use, per second. */
  nutrients: number
  /** Part of what this row's machines make of its item that nothing uses, per minute. */
  overflow: number
  /** Other outputs of this row's machines, per minute, and where they go. */
  byproducts: ByproductOutput[]
  /** Part of the rate covered by side outputs of other rows' machines, per minute. */
  fromByproduct: number
  /** Rows whose side output covers `fromByproduct`, largest share first. */
  byproductSources: { id: string; label: string }[]
  /** Part of the rate bought, per minute. */
  purchased: number
  /** Part of the rate nothing can supply, per minute. */
  shortfall: number
  children: TreeNode[]
  /** Gathers the uses of an item built separately (a root, or a "with" row under its anchor). */
  consolidated?: boolean
  /** The choice behind a `consolidated` row. */
  separation?: Separation
  /** For a `separate` leaf: the row that builds it, and the item that row sits under (none at the top). */
  groupId?: string
  groupAnchor?: string
}

/** Where one by-product of a row goes: rows of its item that take it, and what's left over. */
export interface ByproductRoute {
  /** Rows of the by-product's item fed by it, largest share first, per minute. */
  to: { id: string; amount: number }[]
  /** Part nothing uses, per minute. */
  overflow: number
}

/** A by-product of a row's machines, per minute, and where it goes. */
export interface ByproductOutput extends Stack, ByproductRoute {}

/** Solved flows of one plan row. */
export interface RowFlows {
  rate: number
  crafts: number
  fromByproduct: number
  byproductSources: { id: string; label: string }[]
  purchased: number
  shortfall: number
  /** Part of the row's own item made or brought in that nothing uses. */
  overflow: number
  /** Where each by-product of the row's machines goes, by item. */
  byproductRoutes: Record<string, ByproductRoute>
}

export const NO_FLOWS: RowFlows = {
  rate: 0,
  crafts: 0,
  fromByproduct: 0,
  byproductSources: [],
  purchased: 0,
  shortfall: 0,
  overflow: 0,
  byproductRoutes: {},
}

const isPseudo = (item: string) => item.startsWith('@')

/** The solved plan rows as the production tree shows them. */
export function buildTree(roots: PlanNode[], flows: Map<PlanNode, RowFlows>, mods: Modifiers): TreeNode[] {
  const toNode = (n: PlanNode): TreeNode => {
    const f = flows.get(n) ?? NO_FLOWS
    const base = {
      id: n.id,
      item: n.item,
      rate: f.rate,
      producer: n.kind === 'import' ? IMPORT : (n.process?.id ?? ''),
      ownChoice: n.ownChoice,
      mine: n.mine,
      defaultCatalysts: n.defaultCatalysts,
      defaultHeight: n.defaultHeight,
      defaultStack: n.defaultStack,
      reuse: n.reuse,
      reuseChosen: n.reuseChosen,
      machines: 0,
      heat: 0,
      nutrients: 0,
      overflow: f.overflow,
      byproducts: [],
      fromByproduct: f.fromByproduct,
      byproductSources: f.byproductSources,
      purchased: f.purchased,
      shortfall: f.shortfall,
      children: [],
    }
    switch (n.kind) {
      case 'bus':
        return { ...base, kind: 'bus' }
      case 'loop':
        return { ...base, kind: 'loop' }
      case 'overflow':
        return { ...base, kind: 'overflow' }
      case 'separate':
        return { ...base, kind: 'separate', groupId: n.ref!.id, groupAnchor: n.groupAnchor }
      case 'import':
        return { ...base, kind: f.fromByproduct > 0 && f.purchased === 0 ? 'byproduct' : 'purchase' }
    }
    const p = n.process!
    const crafts = f.crafts
    const run: ProcessRun = {
      key: runKey(p),
      process: p,
      craftsPerMinute: crafts,
      machines: p.seconds > 0 ? crafts / craftsPerMachine(p, mods) : 0,
      inputs: p.inputs.map((s) => ({ item: s.item, count: s.count * crafts })),
      outputs: p.outputs.map((s) => ({ item: s.item, count: s.count * crafts })),
    }
    // A gathered row stays one, even when by-products cover it, so it can still be undone.
    const gathered = n.separation && { consolidated: true, separation: n.separation }
    // Wholly covered by other rows' by-products: its own machines and ingredients stand idle.
    if (crafts === 0 && f.fromByproduct > 0) return { ...base, kind: 'byproduct', run, ...gathered }
    const perSecond = (key: string) => (run.inputs.find((s) => s.item === key)?.count ?? 0) / 60
    return {
      ...base,
      kind: 'produce',
      run,
      machines: run.machines,
      heat: perSecond(HEAT),
      nutrients: perSecond(NUTRIENTS),
      byproducts: run.outputs
        .filter((s) => s.item !== n.item && s.count > 0 && !isPseudo(s.item))
        .map((s) => ({ ...s, ...(f.byproductRoutes[s.item] ?? { to: [], overflow: s.count }) })),
      children: n.children.map(toNode),
      ...gathered,
    }
  }
  return roots.map(toNode)
}

/** Whether a row runs on the plan's overflow: a row below it takes an overflow target's overflow. */
export const onOverflow = (n: TreeNode): boolean => n.children.some((c) => c.kind === 'overflow' || onOverflow(c))

/** Every node id that has children (for "expand/collapse all"). */
export function branchIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children.length ? [n.id, ...branchIds(n.children)] : []))
}
