import { HEAT } from './gameData'
import { STEAM_HEAT_ID } from './processes'
import type { TreeNode, TreeNodeKind } from './tree'

/** A row's machines on a heat network. */
export interface HeatUse {
  /** The heated row. */
  row: TreeNode
  /** Its Heat row: what it burns is picked there. */
  heatRow: TreeNode
  /** The fuel row under the Heat row. */
  fuelRow: TreeNode
  /** Heat it takes from the network, P/s. */
  heat: number
  /** The rows above it, its target's first (Heat rows left out). */
  trail: TreeNode[]
}

/** Where a network's fuel comes from. */
export type HeatSource =
  | { kind: 'bus' }
  /** Made in the plan: the fuel row itself, or the row gathering it when it's built separately. */
  | { kind: 'row'; row: TreeNode }
  /** Other rows' by-products, a row further up the branch, or the plan's overflow. */
  | { kind: Exclude<TreeNodeKind, 'bus' | 'produce' | 'separate'> }

/**
 * Machines heated by one fuel from one place: everything burning it off the bus, or the uses of one
 * row making it in the plan. Heating pads carry Steam; furnaces burn solid fuel.
 */
export interface HeatNetwork {
  key: string
  fuel: string
  pads: boolean
  source: HeatSource
  /** Biggest first. */
  uses: HeatUse[]
  /** P/s. */
  heat: number
  /** Fuel per minute. */
  rate: number
  /** Fuel per minute nothing supplies (past the bus's cap). */
  shortfall: number
}

/**
 * The plan's heat, by network rather than by product chain: how it gets laid out in the game, where
 * fuel lines run alongside the factory. Biggest network first.
 */
export function heatNetworks(tree: TreeNode[]): HeatNetwork[] {
  const byId = new Map<string, TreeNode>()
  const index = (n: TreeNode) => {
    byId.set(n.id, n)
    n.children.forEach(index)
  }
  tree.forEach(index)

  const found = new Map<string, HeatNetwork>()
  const add = (row: TreeNode, heatRow: TreeNode, trail: TreeNode[]) => {
    const total = heatRow.children.reduce((t, f) => t + f.rate, 0)
    for (const fuelRow of heatRow.children) {
      const group = fuelRow.kind === 'separate' ? byId.get(fuelRow.groupId ?? '') : undefined
      const [key, source]: [string, HeatSource] =
        fuelRow.kind === 'bus'
          ? [`bus:${fuelRow.item}`, { kind: 'bus' }]
          : fuelRow.kind === 'produce'
            ? [`row:${fuelRow.id}`, { kind: 'row', row: fuelRow }]
            : group
              ? [`row:${group.id}`, { kind: 'row', row: group }]
              : [`${fuelRow.kind}:${fuelRow.item}`, { kind: fuelRow.kind as 'byproduct' | 'loop' | 'overflow' }]
      const net = found.get(key) ?? {
        key,
        fuel: fuelRow.item,
        pads: heatRow.producer === STEAM_HEAT_ID,
        source,
        uses: [],
        heat: 0,
        rate: 0,
        shortfall: 0,
      }
      const heat = ((heatRow.rate / 60) * fuelRow.rate) / (total || 1)
      net.uses.push({ row, heatRow, fuelRow, heat, trail })
      net.heat += heat
      net.rate += fuelRow.rate
      net.shortfall += fuelRow.shortfall
      found.set(key, net)
    }
  }
  const visit = (n: TreeNode, trail: TreeNode[]) => {
    const below = n.item === HEAT ? trail : [...trail, n]
    for (const c of n.children) {
      if (c.item === HEAT && c.rate > 0) add(n, c, trail)
      visit(c, below)
    }
  }
  tree.forEach((n) => visit(n, []))

  const nets = [...found.values()]
  for (const net of nets) net.uses.sort((a, b) => b.heat - a.heat)
  return nets.sort((a, b) => b.heat - a.heat)
}
