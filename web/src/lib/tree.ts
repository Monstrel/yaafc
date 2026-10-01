import { HEAT, NUTRIENTS, realItem, type Stack } from './gameData'
import { separationKey } from './separate'
import type { ItemBalance, PlanResult, ProcessRun } from './solver'
import type { Separation } from './types'

export type TreeNodeKind =
  | 'produce' // made by machines running for this item
  | 'byproduct' // covered by side output of machines running for something else
  | 'purchase' // bought at a purchasing portal
  | 'bus' // fuel/fertilizer taken from the factory bus
  | 'loop' // already produced further up this branch (cycle)
  | 'separate' // built separately: its machines are under the row `groupId`

export interface TreeNode {
  /** Stable path id (item keys from the root), used for folding. */
  id: string
  item: string
  kind: TreeNodeKind
  /** Items per minute this branch needs. */
  rate: number
  run?: ProcessRun
  /** Machines working for this branch (fractional). */
  machines: number
  /** Heat this branch's machines use, P/s. */
  heat: number
  /** Nutrients this branch's nurseries use, per second. */
  nutrients: number
  /** Other outputs of this branch's machines, per minute, for this branch's share. */
  byproducts: Stack[]
  /** Part of the rate covered by side outputs of other machines, per minute. */
  fromByproduct: number
  /** Processes whose side output covers `fromByproduct`. */
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

const MAX_DEPTH = 40
const isPseudo = (item: string) => item.startsWith('@')

/** Demand on an item: what the plan consumes plus what it must deliver. */
const demandOf = (b: ItemBalance | undefined) => (b ? b.consumed + b.target : 0)

/**
 * The output that decides how much a process runs: of the outputs it was chosen to make, the one
 * whose demand uses the largest share of what the plan makes of it. Its other outputs are by-products.
 * (An output another process was chosen for would never show this process's machines in the tree.)
 */
function drivingOutput(run: ProcessRun, balances: Map<string, ItemBalance>): string {
  let best = run.process.product
  let bestNeed = -1
  const chosenFor = run.process.outputs.filter((s) => balances.get(s.item)?.producer === run.process.id)
  for (const s of chosenFor.length ? chosenFor : run.process.outputs) {
    if (isPseudo(s.item)) continue
    const b = balances.get(s.item)
    const need = b && b.produced > 0 ? Math.min(1, demandOf(b) / b.produced) : 0
    if (need > bestNeed + 1e-9 || (Math.abs(need - bestNeed) <= 1e-9 && s.item === run.process.product)) {
      best = s.item
      bestNeed = need
    }
  }
  return best
}

/** Separated uses gathered under one row: a root at the top of the plan, or a "with" row. */
interface Group {
  sep: Separation
  rate: number
  /** Reference leaves pointing here (a group of idle uses still gets a row). */
  uses: number
  node?: TreeNode
  /** Got more uses after its row was built. */
  dirty: boolean
  /** What building this group's row gave the frame's other groups, to take back on a rebuild. */
  gave: Map<Group, { rate: number; uses: number }>
}

/** An anchor row being built, with the groups it gathers from below it. */
interface Frame {
  item: string
  id: string
  groups: Map<string, Group>
  /** The group whose row is being built, credited with whatever its subtree adds to the others. */
  building?: Group
}

/**
 * Unfolds the solved plan into a production tree, one root per target.
 * Each item's demand is met, in order, from by-products already being made, then its own
 * producer's machines, then purchases; every branch gets its proportional share of each source.
 * Shared intermediates appear under every branch that uses them, so every row reads as
 * "what this leg of the factory needs" — except items in `separate`. Those get a reference leaf
 * wherever they're used and one row gathering the uses: a root of their own for the whole plan's
 * demand, or a "with" row after the children of their anchor row for the uses below it.
 */
export function buildTree(
  result: PlanResult,
  targets: { item: string; rate: number }[],
  separate: readonly Separation[] = [],
): TreeNode[] {
  const runs = new Map(result.runs.map((r) => [r.process.id, r]))
  const balances = new Map(result.balances.map((b) => [b.item, b]))
  const drivers = new Map(result.runs.map((r) => [r.process.id, drivingOutput(r, balances)]))
  /** Whether machines run for this item (only those are worth building separately). */
  const machineMade = (item: string) => {
    const producer = balances.get(item)?.producer
    return !!producer && drivers.get(producer) === item
  }
  const seps = separate.filter((s) => machineMade(s.item))
  const top = new Map(seps.filter((s) => !s.anchor).map((s) => [s.item, s]))
  // Single-row anchors first, so they win over every-row ones for the same item.
  const anchored = seps.filter((s) => s.anchor && s.anchor !== s.item).sort((a, b) => Number(!a.at) - Number(!b.at))

  // Top-of-plan items needing a root of their own, in the order the tree first uses them.
  const pending: string[] = []
  const topIds = new Map<string, string>()
  targets.forEach((t, i) => {
    if (top.has(t.item) && !topIds.has(t.item)) topIds.set(t.item, `${i}/${t.item}`)
  })
  const frames: Frame[] = []

  /** Sends a separated use to the row that gathers it: returns where that is, or null to build it here. */
  const gather = (item: string, rate: number): { groupId: string; groupAnchor?: string } | null => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i]
      const group = frame.groups.get(item)
      if (!group) continue
      group.rate += rate
      group.uses++
      if (group.node) group.dirty = true
      if (frame.building) {
        const gave = frame.building.gave.get(group) ?? { rate: 0, uses: 0 }
        frame.building.gave.set(group, { rate: gave.rate + rate, uses: gave.uses + 1 })
      }
      return { groupId: `${frame.id}/with:${item}`, groupAnchor: frame.item }
    }
    if (!top.has(item)) return null
    if (!topIds.has(item)) {
      topIds.set(item, `separate/${item}`)
      pending.push(item)
    }
    return { groupId: topIds.get(item)! }
  }

  /** Opens a frame when this row anchors separated items. */
  const openFrame = (item: string, id: string): Frame | null => {
    const groups = new Map<string, Group>()
    for (const s of anchored)
      if (s.anchor === item && (!s.at || s.at === id) && !groups.has(s.item))
        groups.set(s.item, { sep: s, rate: 0, uses: 0, dirty: false, gave: new Map() })
    if (!groups.size) return null
    const frame = { id, item, groups }
    frames.push(frame)
    return frame
  }

  /**
   * Builds the frame's "with" rows. A row's subtree can add uses to groups already built, so those
   * are rebuilt (taking back what their last build gave) until nothing changes.
   */
  const closeFrame = (frame: Frame, path: string[], root: string): TreeNode[] => {
    for (let round = 0; round < 10; round++) {
      const todo = [...frame.groups.values()].filter((g) => g.uses > 0 && (!g.node || g.dirty))
      if (!todo.length) break
      for (const g of todo) {
        for (const [h, given] of g.gave) {
          h.rate -= given.rate
          h.uses -= given.uses
          if (h.node) h.dirty = true
        }
        g.gave.clear()
        g.dirty = false
        frame.building = g
        g.node = node(g.sep.item, g.rate, path, root, g.sep)
        frame.building = undefined
      }
    }
    frames.pop()
    return [...frame.groups.values()].filter((g) => g.uses > 0 && g.node).map((g) => g.node!)
  }

  const node = (item: string, rate: number, path: string[], root: string, group?: Separation): TreeNode => {
    const step = group?.anchor ? `with:${item}` : item
    const id = [root, ...path, step].join('/')
    const base = {
      id,
      item,
      rate,
      machines: 0,
      heat: 0,
      nutrients: 0,
      byproducts: [],
      fromByproduct: 0,
      byproductSources: [],
      purchased: 0,
      shortfall: 0,
      children: [],
    }
    if (realItem(item) !== item) return { ...base, item: realItem(item), kind: 'bus' }

    const balance = balances.get(item)
    const producerRun = balance ? runs.get(balance.producer) : undefined
    const drivenHere = !!producerRun && drivers.get(producerRun.process.id) === item
    const looped = path.includes(item) || path.includes(`with:${item}`)
    if (drivenHere && (looped || path.length >= MAX_DEPTH)) return { ...base, kind: 'loop', run: producerRun }

    // Supplies of this item across the plan.
    let bySupply = 0
    const sources: { id: string; label: string }[] = []
    for (const r of result.runs) {
      const out = r.outputs.find((s) => s.item === item)?.count ?? 0
      if (out <= 0 || (drivenHere && r === producerRun)) continue
      bySupply += out
      sources.push({ id: r.process.id, label: r.process.label })
    }
    const madeHere = drivenHere ? (producerRun.outputs.find((s) => s.item === item)?.count ?? 0) : 0

    // Allocate the plan-wide demand: by-products first, then own machines, then purchases.
    const demand = demandOf(balance)
    const usedBy = Math.min(bySupply, demand)
    const usedMade = Math.min(madeHere, demand - usedBy)
    const usedBought = Math.min(balance?.imported ?? 0, demand - usedBy - usedMade)
    // Ignore floating-point crumbs left by the subtraction.
    const rawShort = demand - usedBy - usedMade - usedBought
    const usedShort = rawShort > 1e-9 * Math.max(1, demand) ? rawShort : 0
    const f = demand > 0 ? Math.min(1, rate / demand) : 0

    const parts = {
      fromByproduct: usedBy * f,
      byproductSources: usedBy > 0 ? sources : [],
      purchased: usedBought * f,
      shortfall: usedShort * f,
    }
    if (!drivenHere)
      return { ...base, ...parts, kind: usedBy > 0 || (bySupply > 0 && demand === 0) ? 'byproduct' : 'purchase' }

    const gathered = !group && path.length > 0 ? gather(item, rate) : null
    if (gathered) return { ...base, ...parts, kind: 'separate', run: producerRun, ...gathered }

    const run = producerRun
    const share = madeHere > 0 ? (usedMade * f) / madeHere : 0
    const pseudo = (key: string) => (run.inputs.find((s) => s.item === key)?.count ?? 0) * share
    const nextPath = [...path, step]
    const frame = openFrame(item, id)
    // Built from the recipe (not the flows) so idle branches still show their structure.
    const children = run.process.inputs
      .filter((s) => s.item !== HEAT && s.item !== NUTRIENTS)
      .map((s) => node(s.item, (run.inputs.find((x) => x.item === s.item)?.count ?? 0) * share, nextPath, root))
    if (frame) children.push(...closeFrame(frame, nextPath, root))
    return {
      ...base,
      ...parts,
      kind: 'produce',
      run,
      machines: run.machines * share,
      heat: pseudo(HEAT) / 60,
      nutrients: pseudo(NUTRIENTS) / 60,
      byproducts: run.outputs
        .filter((s) => s.item !== item && s.count > 0 && !isPseudo(s.item))
        .map((s) => ({ item: s.item, count: s.count * share })),
      children,
      ...(group && { consolidated: true, separation: group }),
    }
  }

  /** One root covering every use of a top-of-plan item (and its target rate, if it's a target). */
  const consolidated = (item: string, root: string): TreeNode =>
    node(item, demandOf(balances.get(item)), [], root, top.get(item))

  const roots: TreeNode[] = []
  targets.forEach((t, i) => {
    if (!t.item) return
    if (!top.has(t.item)) roots.push(node(t.item, t.rate, [], `${i}`))
    else if (topIds.get(t.item) === `${i}/${t.item}`) roots.push(consolidated(t.item, `${i}`))
  })
  // Building a separated root can turn up more separated items; `pending` grows as we go.
  for (let i = 0; i < pending.length; i++) roots.push(consolidated(pending[i], 'separate'))
  return roots
}

/** Choices that gather nothing in this tree (their anchor no longer sits above the item, say). */
export function staleSeparations(roots: TreeNode[], separate: readonly Separation[]): Separation[] {
  const used = new Set<string>()
  const visit = (n: TreeNode) => {
    if (n.separation) used.add(separationKey(n.separation))
    n.children.forEach(visit)
  }
  roots.forEach(visit)
  return separate.filter((s) => !used.has(separationKey(s)))
}

/** Every node id that has children (for "expand/collapse all"). */
export function branchIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children.length ? [n.id, ...branchIds(n.children)] : []))
}
