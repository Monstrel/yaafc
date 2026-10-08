import { HEAT, NUTRIENTS, type Stack } from './gameData'
import { craftsPerMachine } from './machineRate'
import { blendParadox, runKey, type Process } from './processes'
import type { ProcessRun } from './solver'
import type { Separation } from './types'
import { BUS, type PlanNode } from './unfold'
import type { Modifiers } from './upgrades'

export type TreeNodeKind =
  | 'produce' // made by machines running for this item
  | 'byproduct' // covered by side output of machines running for something else
  | 'bus' // taken from the factory bus
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
  /** Process id the row uses, or 'bus', or '' for rows supplied elsewhere (loops, separate builds). */
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
  /** A crucible row refines the by-products below it unless it sets its own. */
  defaultMixed: boolean
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
  /** Part of the rate taken from the bus, per minute. */
  fromBus: number
  /** Part of the rate nothing can supply, per minute. */
  shortfall: number
  /** Part of the rate its recovery rows (children with `recovery`) supply, per minute. */
  fromRecovery: number
  /**
   * The row recovers what other machines output into the supply of the row above it: it joins
   * that row's output rather than feeding its machines.
   */
  recovery?: boolean
  children: TreeNode[]
  /** Gathers the uses of an item built separately (a root, or a "with" row under its anchor). */
  consolidated?: boolean
  /** The choice behind a `consolidated` row. */
  separation?: Separation
  /** For a `separate` leaf: the row that builds it, and the item that row sits under (none at the top). */
  groupId?: string
  groupAnchor?: string
  /** For a Paradox Crucible row: by-products of the row below it that it could also refine. */
  mixable?: string[]
  /** It refines them too (its mixed feed is on). */
  mixed?: boolean
  /** What a mixed crucible row refines of each item, per minute, and the crucibles that takes: its own input first. */
  mixParts?: MixPart[]
  /** Shown only: a line above the row `reusedBy` for the part of it other rows' by-products cover. */
  reusedBy?: string
  /** Shown only: other rows' by-products cover part of the row, on a line of their own above it; `rate` leaves them out. */
  reusedApart?: boolean
  /**
   * Shown only: the Heat, Nutrients and Money rows folded into this one. Their picks (what it burns,
   * spreads or pays with) show on its row, and the fuel, fertilizer or coin rows below them sit
   * below it, except those taken whole off the bus: they stay the folded row's children, shown on
   * the same line as its pick.
   */
  folded?: TreeNode[]
}

/** One input of a mixed crucible row. */
export interface MixPart {
  item: string
  /** Items per minute refined. */
  rate: number
  /** Crucibles' worth of work it takes. */
  machines: number
}

/** Where one by-product of a row goes: rows of its item that take it, and what's left over. */
export interface ByproductRoute {
  /**
   * Rows fed by it, largest share first, per minute: rows of its item, or (`direct`) a crucible row
   * refining it along with its own input.
   */
  to: { id: string; amount: number; direct?: boolean }[]
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
  fromBus: number
  shortfall: number
  /** Part of the row's rate its recovery rows supply. */
  fromRecovery?: number
  /** Part of the row's own item made or brought in that nothing uses. */
  overflow: number
  /** Where each by-product of the row's machines goes, by item. */
  byproductRoutes: Record<string, ByproductRoute>
  /** A crucible row with its mixed feed on: crafts per minute per input's process, its own first. */
  mix?: { process: Process; crafts: number }[]
}

export const NO_FLOWS: RowFlows = {
  rate: 0,
  crafts: 0,
  fromByproduct: 0,
  byproductSources: [],
  fromBus: 0,
  shortfall: 0,
  overflow: 0,
  byproductRoutes: {},
}

const isPseudo = (item: string) => item.startsWith('@')

/** The solved plan rows as the production tree shows them. */
export function buildTree(roots: PlanNode[], flows: Map<PlanNode, RowFlows>, mods: Modifiers): TreeNode[] {
  // Recovery rows the solve doesn't run (recovering costs more than it saves) aren't shown.
  const used = (n: PlanNode) => (flows.get(n)?.rate ?? 0) > 1e-9
  const toNode = (n: PlanNode): TreeNode => {
    const f = flows.get(n) ?? NO_FLOWS
    const base = {
      id: n.id,
      item: n.item,
      rate: f.rate,
      producer: n.kind === 'bus' ? BUS : (n.process?.id ?? ''),
      ownChoice: n.ownChoice,
      mine: n.mine,
      defaultCatalysts: n.defaultCatalysts,
      defaultHeight: n.defaultHeight,
      defaultStack: n.defaultStack,
      defaultMixed: n.defaultMixed,
      reuse: n.reuse,
      reuseChosen: n.reuseChosen,
      ...(n.mixable?.length && { mixable: n.mixable, mixed: !!n.mix }),
      machines: 0,
      heat: 0,
      nutrients: 0,
      overflow: f.overflow,
      byproducts: [],
      fromByproduct: f.fromByproduct,
      byproductSources: f.byproductSources,
      fromBus: f.fromBus,
      shortfall: f.shortfall,
      fromRecovery: f.fromRecovery ?? 0,
      ...(n.recovers && { recovery: true }),
      children: [],
    }
    // Rows recovering other machines' outputs into this one's supply.
    const recoveries = () => n.children.filter((c) => c.recovers && used(c)).map(toNode)
    switch (n.kind) {
      case 'bus':
        return { ...base, kind: f.fromByproduct > 0 && f.fromBus === 0 ? 'byproduct' : 'bus', children: recoveries() }
      // Taken from other machines' outputs, with the rows recovering more of it.
      case 'reclaim':
        return { ...base, kind: 'byproduct', children: recoveries() }
      case 'loop':
        return { ...base, kind: 'loop' }
      case 'overflow':
        return { ...base, kind: 'overflow' }
      case 'separate':
        return { ...base, kind: 'separate', groupId: n.ref!.id, groupAnchor: n.groupAnchor }
    }
    // A crucible row refining several items runs them as one blended process.
    const p = f.mix ? blendParadox(f.mix) : n.process!
    const crafts = f.mix ? f.mix.reduce((t, x) => t + x.crafts, 0) : f.crafts
    const mixParts = f.mix?.map((x) => ({
      item: x.process.inputs[0].item,
      rate: x.process.inputs[0].count * x.crafts,
      machines: x.process.seconds > 0 ? x.crafts / craftsPerMachine(x.process, mods) : 0,
    }))
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
    if (crafts === 0 && f.fromByproduct > 0 && !base.fromRecovery) return { ...base, kind: 'byproduct', run, ...gathered }
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
      children: n.children.filter((c) => !c.recovers || used(c)).map(toNode),
      ...(mixParts && { mixParts }),
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
