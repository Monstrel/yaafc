import { HEAT, NUTRIENTS, realItem, type Stack } from './gameData'
import type { ItemBalance, PlanResult, ProcessRun } from './solver'

export type TreeNodeKind =
  | 'produce' // made by machines running for this item
  | 'byproduct' // covered by side output of machines running for something else
  | 'purchase' // bought at a purchasing portal
  | 'bus' // fuel/fertilizer taken from the factory bus
  | 'loop' // already produced further up this branch (cycle)

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

/**
 * Unfolds the solved plan into a production tree, one root per target.
 * Each item's demand is met, in order, from by-products already being made, then its own
 * producer's machines, then purchases; every branch gets its proportional share of each source.
 * Shared intermediates appear under every branch that uses them, so every row reads as
 * "what this leg of the factory needs".
 */
export function buildTree(result: PlanResult, targets: { item: string; rate: number }[]): TreeNode[] {
  const runs = new Map(result.runs.map((r) => [r.process.id, r]))
  const balances = new Map(result.balances.map((b) => [b.item, b]))
  const drivers = new Map(result.runs.map((r) => [r.process.id, drivingOutput(r, balances)]))

  const node = (item: string, rate: number, path: string[], root: number): TreeNode => {
    const id = [root, ...path, item].join('/')
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
    if (drivenHere && (path.includes(item) || path.length >= MAX_DEPTH)) return { ...base, kind: 'loop', run: producerRun }

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

    const run = producerRun
    const share = madeHere > 0 ? (usedMade * f) / madeHere : 0
    const pseudo = (key: string) => (run.inputs.find((s) => s.item === key)?.count ?? 0) * share
    const nextPath = [...path, item]
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
      // Built from the recipe (not the flows) so idle branches still show their structure.
      children: run.process.inputs
        .filter((s) => s.item !== HEAT && s.item !== NUTRIENTS)
        .map((s) => node(s.item, (run.inputs.find((x) => x.item === s.item)?.count ?? 0) * share, nextPath, root)),
    }
  }

  return targets.flatMap((t, i) => (t.item ? [node(t.item, t.rate, [], i)] : []))
}

/** Every node id that has children (for "expand/collapse all"). */
export function branchIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children.length ? [n.id, ...branchIds(n.children)] : []))
}
