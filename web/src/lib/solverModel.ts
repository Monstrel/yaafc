import { HEAT } from './gameData'
import { LpModel } from './lpModel'
import { craftsPerMachine } from './machineRate'
import { paradoxId, type Process, type ProcessCatalog } from './processes'
import type { Plan } from './types'
import { targetFedBack } from './ledger'
import { consumedBy, isTargetRow, suppliedBy, type PlanNode, type PlanShape } from './unfold'
import type { Modifiers } from './upgrades'
import type { ResolvedTarget } from './solver'

/*
 * The linear program a plan is balanced with (see `buildPlanLp`), and what the solve needs to know
 * to read its solution.
 */

const IMPORT_COST = 1
// Shortfalls are priced by depth (distance from the targets) so they land where a chain actually
// breaks (e.g. an ingredient nothing can make) and everything above it is still sized.
const DEFICIT_COST = 1e6
const DEFICIT_DEPTH_FACTOR = 0.1
const MIN_DEFICIT_COST = 10
const SURPLUS_COST = 1e-4
const CRAFT_COST = 1e-3
// A row running a process for its side product (Gentian Nectar from Gentian nurseries) costs a
// little more, so a sibling row making the main product covers it with its by-product instead.
const SIDE_RUN_FACTOR = 1.001
// By-products go to the nearest rows that use them: priced by the steps between the two rows.
const FLOW_COST = 1e-7
// A crucible row's mixed feed takes the by-products below it after the rows of their own item do.
const MIX_COST = 1e-5
// What a row takes beyond what it needs, and what a recovery row's other outputs overflow, count
// this many times what other rows spill (see the passes).
const EXCESS_WEIGHT = 1000
// Overflow an overflow target can't use is counted with shortfalls, so it uses all it can, but costs
// less than any shortfall: falling short somewhere never stands in for leaving overflow unused (a
// shortfall in a runaway loop would make it look like it settles).
const UNUSED_OVERFLOW_COST = 1
// A capped supply nothing takes costs more than what using it does (its row's crafts and the bus),
// so a supply target takes all it can. Shortfalls are settled first (see the passes), so leaving one
// never stands in for using the supply.
const UNUSED_SUPPLY_COST = 1000

/**
 * The priority passes, in order, each also the row holding it once it's solved (see `solveStaged`).
 * Pass 1 minimizes the depth-weighted shortfall alone, so a shortfall is only ever reported when the
 * chosen producers really can't cover it (in one pass, deficits were just expensive: a big enough
 * plan, like Sol burning millions of P, cost more than giving up on the target). Then each pass
 * settles one rule of where outputs go, held in turn (by cost alone, they lost to whatever was
 * cheaper):
 *   - Locality: a row's outputs go to its own recovery first, and only what that can't take leaves
 *     it (Athanors making Gold Dust refine their failed crafts back up, rather than turning them out
 *     for a cauldron making Resonant Catalyst).
 *   - Then rows using what's left as it is take it, before other rows' recovery does or it
 *     overflows: the pass minimizes what goes those two ways. A row taking more than it needs counts
 *     many times over, so no row runs harder to take more.
 * The last solve holds them all and minimizes the real costs. What's left over costs nothing to take
 * (its source runs no harder for it), so rows take it before they import or make their item.
 */
export const SHORTFALL_PASS = 'shortfall'
export const LEAVING_PASS = 'leaving'
export const SPILL_PASS = 'spill'
export const PASSES = [SHORTFALL_PASS, LEAVING_PASS, SPILL_PASS]

/**
 * The LP's rows and columns, by family. `k` is a row of the tree (by index in `shape.nodes`), `i` a
 * target (by index among the targets with an item).
 */
export const lp = {
  // Per supplying row: what it supplies balances what its uses take (row).
  balance: (k: number) => `b:${k}`,
  // What it supplies that nothing uses (col).
  surplus: (k: number) => `s:${k}`,
  // What it's short (col).
  deficit: (k: number) => `d:${k}`,
  // What it takes from the bus (col).
  import: (k: number) => `i:${k}`,
  // What a recovery row recovers into the row above it (col).
  recovered: (k: number) => `rc:${k}`,
  // Per row making something: its crafts per minute (col), held to a number (row) or to at least one.
  crafts: (k: number) => `x:${k}`,
  hold: (k: number) => `h:${k}`,
  floor: (k: number) => `r:${k}`,
  floorSlack: (k: number) => `rs:${k}`,
  // What a held-back row overflows, capped at what it overflows without the overflow and supply targets.
  surplusCap: (k: number) => `sc:${k}`,
  surplusCapSlack: (k: number) => `scs:${k}`,
  // Per side output of a row making something: its pool (row), what's left of it (col) and where it goes.
  pool: (k: number, item: string) => `p:${k}:${item}`,
  poolSurplus: (k: number, item: string) => `ps:${k}:${item}`,
  flow: (k: number, to: number) => `f:${k}>${to}`,
  // What a row makes beyond what it's used for (col, balanced by its row), and the side output of
  // that, which goes only to rows running the same process (row, and its slack).
  excess: (k: number) => `ex:${k}`,
  excessBalance: (k: number) => `xd:${k}`,
  extra: (k: number, item: string) => `e:${k}:${item}`,
  extraSlack: (k: number, item: string) => `es:${k}:${item}`,
  // A crucible row's mixed feed of a by-product: its crafts (col).
  mix: (k: number, item: string) => `m:${k}:${item}`,
  // Per item an overflow target takes: the overflow (row), what each of its rows takes (col), what
  // sizes the target (col), what it can't use (col), and the cap on what the rest of the plan overflows.
  overflow: (item: string) => `o:${item}`,
  overflowTaken: (k: number) => `od:${k}`,
  overflowTarget: (i: number) => `t:${i}`,
  unusedOverflow: (item: string) => `d:o:${item}`,
  overflowCap: (item: string) => `oc:${item}`,
  overflowCapSlack: (item: string) => `ocs:${item}`,
  // Per item a capped supply target takes: the cap (row), what's left of it (col), what sizes the target (col).
  supplyCap: (item: string) => `bc:${item}`,
  unusedSupply: (item: string) => `bu:${item}`,
  supplyTarget: (i: number) => `ts:${i}`,
  // What a target of a number of machines delivers (col).
  machineTarget: (i: number) => `tm:${i}`,
  // Per item a fed-back net-surplus target covers: the pool (row), what it's short (col), what the
  // sources ahead of it supply (row, and what they supply and don't), and what its row adds (col).
  netPool: (item: string) => `g:${item}`,
  netDeficit: (item: string) => `d:g:${item}`,
  ahead: (item: string) => `ahead:${item}`,
  aheadUsed: (item: string) => `fa:${item}`,
  aheadUnused: (item: string) => `fu:${item}`,
  netMade: (item: string) => `fb:${item}`,
  // Per fed-back target: what it hands on, capped at what it makes (row, and its slack), and what each row takes.
  fedCap: (i: number) => `fbc:${i}`,
  fedCapSlack: (i: number) => `fbs:${i}`,
  fed: (i: number, to: number) => `fbk:${i}>${to}`,
}

/**
 * Net-surplus targets the solve sizes, per item: the target that covers what's left of what the
 * plan's rows take of it from the bus, and what the fed-back sources ahead of it supply.
 */
export interface Absorbing {
  /** Index among the targets with an item (as `targets` and `shape.targetRows`). */
  target: number
  /** Items per minute the sources ahead of it can supply. */
  ahead: number
}

/** How each row (by id) runs without the plan's overflow and supply targets, as the LP solved it. */
export interface Baseline {
  /** Crafts per minute. */
  crafts: Map<string, number>
  /** Per item, items per minute it overflows of it: its own item, and side outputs nothing takes. */
  overflow: Map<string, Map<string, number>>
}

/** The root row of a row's tree. */
export function rootOf(n: PlanNode): PlanNode {
  let r = n
  while (r.parent) r = r.parent
  return r
}

/** The row that supplies a row: itself, or the row a loop or separate build points to. */
export function supplierOf(n: PlanNode): PlanNode {
  let s = n
  while (((s.kind === 'loop' && !s.fedBack) || s.kind === 'separate') && s.ref) s = s.ref
  return s
}

export const isSupply = (n: PlanNode) => supplierOf(n) === n

/** Steps between two rows of the tree. */
function distance(a: PlanNode, b: PlanNode): number {
  const x = a.id.split('/')
  const y = b.id.split('/')
  let common = 0
  while (common < x.length && common < y.length && x[common] === y[common]) common++
  return x.length + y.length - 2 * common
}

/** Ingredients a row's process takes from the rows below it (heat and nutrients too), in the order of its children. */
export const ingredients = (p: Process) => p.inputs
export const outputOf = (p: Process, item: string) => p.outputs.find((s) => s.item === item)?.count ?? 0

/** What the plan's overflow, supply and machine-count targets do, worked out from its rows. */
export interface TargetRoles {
  /** Per target (by index among the targets with an item), its index in the plan's targets. */
  planIndex: number[]
  /** Overflow targets, each with its rows that take its item's overflow. */
  takers: Map<number, PlanNode[]>
  /** Every row under an overflow or supply target. */
  inTaker: Set<PlanNode>
  /** Per item, the overflow target taking its overflow: the first in order that uses it. */
  takerOf: Map<string, number>
  /** Supply targets, each with its rows that take its item from the bus. */
  supplyRows: Map<number, PlanNode[]>
  /** Per capped item, the supply target taking what's left of it: the first in order that uses it. */
  supplyTaker: Map<string, number>
  /** Targets of a number of machines: the crafts per minute their rows run. */
  machineCrafts: Map<number, number>
  /** The rows of targets of a number of machines, with the crafts they run. */
  machineRows: Map<PlanNode, number>
}

/** Works out the targets' roles; overflow and supply targets take nothing unless `sizing` (see `baselineCrafts`). */
export function targetRoles(plan: Plan, shape: PlanShape, targets: ResolvedTarget[], mods: Modifiers, sizing: boolean): TargetRoles {
  // Overflow targets (by index among the targets with an item), the rows that take their item's
  // overflow under each, and per item the one that takes it.
  const planIndex = plan.targets.flatMap((t, i) => (t.item ? [i] : []))
  const takers = new Map<number, PlanNode[]>()
  const inTaker = new Set<PlanNode>()
  targets.forEach((_, i) => {
    const item = consumedBy(plan.targets[planIndex[i]])
    const row = shape.targetRows[i]
    // A target sharing the row of an item built separately has no rows of its own.
    if (!sizing || !item || !row || !isTargetRow(row.id)) return
    takers.set(i, [])
  })
  for (const n of shape.nodes) {
    const root = rootOf(n)
    const i = shape.targetRows.indexOf(root)
    if (!takers.has(i)) continue
    inTaker.add(n)
    if (n.kind === 'overflow') takers.get(i)!.push(n)
  }
  const takerOf = new Map<string, number>()
  for (const [i, leaves] of takers) {
    const item = consumedBy(plan.targets[planIndex[i]])!
    if (leaves.length && !takerOf.has(item)) takerOf.set(item, i)
  }
  // Supply targets (by index among the targets with an item), their rows of the item they take from
  // the bus, and per capped item the one taking what's left of it: the first in order that uses it.
  const caps = plan.busSupply ?? {}
  const supplyRows = new Map<number, PlanNode[]>()
  targets.forEach((_, i) => {
    const row = shape.targetRows[i]
    if (sizing && suppliedBy(plan.targets[planIndex[i]]) && row && isTargetRow(row.id)) supplyRows.set(i, [])
  })
  for (const n of shape.nodes) {
    const i = shape.targetRows.indexOf(rootOf(n))
    if (!supplyRows.has(i)) continue
    inTaker.add(n)
    if (n.kind === 'bus' && n.item === suppliedBy(plan.targets[planIndex[i]])) supplyRows.get(i)!.push(n)
  }
  const supplyTaker = new Map<string, number>()
  for (const [i, rows] of supplyRows) {
    const item = suppliedBy(plan.targets[planIndex[i]])!
    if (rows.length && Object.hasOwn(caps, item) && !supplyTaker.has(item)) supplyTaker.set(item, i)
  }

  // A target of a number of machines runs them: its row's crafts are fixed, and it delivers what they
  // make and what's recovered into it (sizing it by one machine's own output, recovery shrank them).
  const machineCrafts = new Map<number, number>()
  targets.forEach((_, i) => {
    const row = shape.targetRows[i]
    const t = plan.targets[planIndex[i]]
    if (t.unit === 'machines' && row?.kind === 'make' && isTargetRow(row.id) && row.process!.seconds > 0)
      machineCrafts.set(i, (t.rate || 0) * craftsPerMachine(row.process!, mods))
  })
  const machineRows = new Map([...machineCrafts].map(([i, x]) => [shape.targetRows[i]!, x]))
  return { planIndex, takers, inTaker, takerOf, supplyRows, supplyTaker, machineCrafts, machineRows }
}

/** A side output going from one row to another: a by-product, or a fed-back target's output (`fed`). */
export interface Flow {
  name: string
  from: PlanNode
  to: PlanNode
  fed?: boolean
}

/** A crucible row's mixed feed of one by-product. */
export interface MixPart {
  item: string
  process: Process
  /** Its column of crafts. */
  name: string
  /** The row whose by-product it refines. */
  source: PlanNode
}

/** The plan's LP, with what reading its solution needs. */
export interface PlanLp {
  m: LpModel
  /** Each row's index in `shape.nodes` (its `k` in `lp`). */
  index: Map<PlanNode, number>
  /** The balance row a row's supply goes into (its supplier's). */
  bal: (n: PlanNode) => string
  /** The rows that supply themselves (not loops or separate builds pointing elsewhere). */
  supplies: PlanNode[]
  /** Fed-back net-surplus targets' items the solve pools (see `Absorbing`). */
  pooled: Map<string, Absorbing>
  /** Capped plan inputs a supply target takes what's left of. */
  capped: Map<string, number>
  flows: Flow[]
  /** Per fed-back target, the columns of what each row takes of its output. */
  fedFrom: Map<number, string[]>
  mixes: Map<PlanNode, MixPart[]>
  /** Per column of a row's output it sends to Knowledge Altars, the item. */
  altared: Map<string, string>
}

export interface PlanLpInput {
  plan: Plan
  catalog: ProcessCatalog
  shape: PlanShape
  targets: ResolvedTarget[]
  roles: TargetRoles
  absorbing: Map<string, Absorbing>
  /** Rows (by id) held to at least these crafts per minute: rounded up. */
  floors: Map<string, number>
  /** How rows run without the overflow and supply targets, when there are any. */
  held: Baseline | null
}

/**
 * Balances the plan as a linear program over the rows of the production tree. Each row's machines
 * feed only the row above them, as built in the factory:
 *   (row's output) + (by-products it takes) + import + deficit − surplus = (what the rows above it use)
 * A loop row adds its use to the row it loops back to, a separate build to the row gathering it.
 * By-products are the one exception: each row's side outputs can feed any row of their item,
 * the nearest first, and what's left over is surplus. They're only what rows make for their own use:
 * no row runs harder to make more of them for a row that can make its item itself. Heat and
 * nutrients are rows like any ingredient, burning or spreading the fuel or fertilizer below them.
 * Rows taking their item from the bus draw on a fed-back net-surplus target of it instead, where
 * there is one (`absorbing`).
 * A row with a floor runs at least that many crafts per minute; what nothing uses overflows.
 * An overflow target takes all of its item's overflow (the first such target in order that uses the
 * item does), its rows of the item drawing from it, and its rate is what that makes. The overflow
 * includes what the overflow target's own rows overflow, so chains and loops of them are solved
 * together. Its rows make only what it needs, so the overflow can't be used up by making extra.
 * Overflow it can't use is priced like a shortfall: a loop that overflows at least as much as it
 * takes would need an endless factory, so it takes none and is flagged as running away.
 */
export function buildPlanLp(input: PlanLpInput): PlanLp {
  return new PlanLpBuilder(input).build()
}

/** Builds the plan's LP family by family (the order of rows and columns is the LP's). */
class PlanLpBuilder {
  private readonly input: PlanLpInput
  private readonly m = new LpModel()
  private readonly index: Map<PlanNode, number>
  private readonly supplies: PlanNode[]
  private readonly pooled = new Map<string, Absorbing>()
  private capped = new Map<string, number>()
  private readonly flows: Flow[] = []
  private readonly fedFrom = new Map<number, string[]>()
  private readonly mixes = new Map<PlanNode, MixPart[]>()
  private readonly altared = new Map<string, string>()
  /** Columns of overflow going to an item's overflow pool, with the row overflowing it (see `overflowCaps`). */
  private readonly overflowing: { column: string; item: string; from: PlanNode }[] = []
  /** Pools of a row's side output its own recovery takes from (see `mixedFeeds`). */
  private readonly leavingPools = new Set<string>()
  /** Per item, the rows taking by-products of it. */
  private readonly consumers = new Map<string, PlanNode[]>()
  /** Fed-back targets and the rows taking their output first (see `fedTargets`). */
  private readonly fedUsers = new Map<number, PlanNode[]>()
  /** Rows whose by-products can go to rows running something else, and the rows they're a chain of uses for. */
  private sharing = new Set<PlanNode>()
  private readonly chain = new Set<PlanNode>()

  constructor(input: PlanLpInput) {
    this.input = input
    this.index = new Map(input.shape.nodes.map((n, k) => [n, k]))
    this.supplies = input.shape.nodes.filter(isSupply)
  }

  build(): PlanLp {
    this.netTargets()
    this.supplyCaps()
    this.rowBalances()
    this.targetDemand()
    this.overflowPools()
    for (const s of this.supplies) if (s.takesLeftovers) this.consumers.set(s.item, [...(this.consumers.get(s.item) ?? []), s])
    this.surplusCaps()
    this.fedTargets()
    this.excess()
    for (const n of this.input.shape.nodes) if (n.kind === 'make') this.craftColumns(n)
    this.fedBack()
    this.mixedFeeds()
    this.overflowCaps()
    const { m, index, supplies, pooled, capped, flows, fedFrom, mixes, altared } = this
    return { m, index, bal: this.bal, supplies, pooled, capped, flows, fedFrom, mixes, altared }
  }

  private readonly bal = (n: PlanNode) => lp.balance(this.index.get(supplierOf(n))!)
  private readonly k = (n: PlanNode) => this.index.get(n)!

  /** A column counted toward a pass, with a weight (see `PASSES`). */
  private leaves(column: string, weight = 1) {
    this.m.weigh(LEAVING_PASS, column, weight)
  }
  private spills(column: string, weight = 1) {
    this.m.weigh(SPILL_PASS, column, weight)
  }
  /** A shortfall column: weighed by its cost in the shortfall pass. */
  private deficit(name: string, coefficients: Record<string, number>, cost: number) {
    this.m.column(name, coefficients, cost)
    this.m.weigh(SHORTFALL_PASS, name, cost)
  }
  private deficitCost = (n: PlanNode) => Math.max(MIN_DEFICIT_COST, DEFICIT_COST * DEFICIT_DEPTH_FACTOR ** n.depth)

  /** Rows held to their crafts: as they are without the plan's overflow targets, or a target's machines. */
  private fixedOf(n: PlanNode) {
    const { roles, held } = this.input
    return (!roles.inTaker.has(n) && isTargetRow(rootOf(n).id) ? held?.crafts.get(n.id) : undefined) ?? roles.machineRows.get(n)
  }
  private heldToCrafts = (n: PlanNode) => this.input.floors.has(n.id) || this.fixedOf(n) !== undefined
  /**
   * Once a target feeds back into the plan's rows, none of them are held to how they run without the
   * overflow and supply targets: what it covers changes what they need, and where chains share
   * by-products, rows anywhere in the plan may have to run slower or a little harder for them to
   * rebalance without overflowing. (What the rest of the plan overflows is still capped: `overflowCaps`.)
   */
  private get unheld() {
    return this.fedUsers.size > 0
  }
  private toAltar = (n: PlanNode, item: string) => !!this.input.plan.altarOutputs?.[n.id]?.includes(item)
  /** The rows a row's side output of `item` can go to: none when it goes to Knowledge Altars. */
  private sharedWith = (n: PlanNode, item: string) => (this.toAltar(n, item) ? [] : (this.consumers.get(item) ?? []))
  private sameRun = (n: PlanNode, c: PlanNode) => c.kind === 'make' && c.process!.id === n.process!.id

  /**
   * Per item a fed-back net-surplus target covers: a pool its row and the sources ahead of it supply
   * (up to `ahead`), and the plan's rows taking the item from the bus draw on. What they can't cover
   * is a shortfall: the target's own chain uses more than it gives.
   */
  private netTargets() {
    const { m } = this
    for (const [item, a] of this.input.absorbing) {
      const row = this.input.shape.targetRows[a.target]
      if (!row) continue
      this.pooled.set(item, a)
      m.row(lp.netPool(item))
      this.deficit(lp.netDeficit(item), { [lp.netPool(item)]: 1 }, MIN_DEFICIT_COST)
      m.row(lp.ahead(item), a.ahead)
      m.column(lp.aheadUsed(item), { [lp.netPool(item)]: 1, [lp.ahead(item)]: 1 }, 0)
      m.column(lp.aheadUnused(item), { [lp.ahead(item)]: 1 }, 0)
      m.column(lp.netMade(item), { [this.bal(row)]: -1, [lp.netPool(item)]: 1 }, 0)
    }
  }

  /**
   * Capped plan inputs a supply target takes what's left of (where the plan doesn't make the item in
   * their place): rows taking one share the cap, falling short past it, and the target takes the
   * rest. Elsewhere a cap sizes nothing: rows take what they need (the ledger warns past it).
   */
  private supplyCaps() {
    const { m } = this
    const { plan, shape, roles } = this.input
    this.capped = new Map(Object.entries(plan.busSupply ?? {}).filter(([item]) => !this.pooled.has(item) && roles.supplyTaker.has(item)))
    for (const [item, cap] of this.capped) {
      m.row(lp.supplyCap(item), cap)
      m.column(lp.unusedSupply(item), { [lp.supplyCap(item)]: 1 }, roles.supplyTaker.has(item) ? UNUSED_SUPPLY_COST : 0)
    }
    for (const [item, i] of roles.supplyTaker)
      if (this.capped.has(item)) m.column(lp.supplyTarget(i), { [this.bal(shape.targetRows[i]!)]: -1 }, 0)
  }

  /** Each supplying row's balance, with what it overflows and where it gets what it doesn't make. */
  private rowBalances() {
    const { m, capped, pooled } = this
    const { roles, floors } = this.input
    for (const s of this.supplies) {
      const k = this.k(s)
      const b = lp.balance(k)
      m.row(b)
      // An overflow target's rows of its item get only the overflow taken, and its other rows make no
      // more than it needs. A row of an item an overflow target takes overflows into its pool, whether
      // it makes the item or gets more of other rows' by-products than it needs. A row taking a capped
      // item from the bus takes no more than it needs (the rest is for the others).
      if (s.kind !== 'overflow' && !(s.kind === 'bus' && capped.has(s.item)) && (!roles.inTaker.has(s) || floors.has(s.id))) {
        const taken = roles.takerOf.has(s.item)
        m.column(lp.surplus(k), { [b]: -1, ...(taken && { [lp.overflow(s.item)]: 1 }) }, SURPLUS_COST)
        if (taken) this.overflowing.push({ column: lp.surplus(k), item: s.item, from: s })
        // A row taking more than it needs counts many times over, so no row runs harder to take more.
        // What a row rounded up makes beyond that is what its whole machines make: it overflows by design
        // (counted as spilling, other rows grew to take it, and were rounded up in turn).
        else if (!floors.has(s.id)) this.spills(lp.surplus(k), EXCESS_WEIGHT)
      }
      // Nothing makes it and the plan doesn't take it in: what other rows leave of it, else a shortfall.
      if (s.unsupplied) this.deficit(lp.deficit(k), { [b]: 1 }, this.deficitCost(s))
      else if (s.kind === 'bus' && pooled.has(s.item)) m.column(lp.import(k), { [b]: 1, [lp.netPool(s.item)]: -1 }, 0)
      else if (s.kind === 'bus' && capped.has(s.item)) {
        m.column(lp.import(k), { [b]: 1, [lp.supplyCap(s.item)]: 1 }, IMPORT_COST)
        this.deficit(lp.deficit(k), { [b]: 1 }, this.deficitCost(s))
      } else if (s.kind === 'bus') m.column(lp.import(k), { [b]: 1 }, IMPORT_COST)
      // A row taking what other rows output only has that, and a recovery row only what it recovers:
      // what it makes joins the supply of the row above it.
      else if (s.kind === 'overflow' || s.kind === 'reclaim') continue
      else if (s.recovers) m.column(lp.recovered(k), { [b]: -1, [this.bal(s.parent!)]: 1 }, 0)
      else this.deficit(lp.deficit(k), { [b]: 1 }, this.deficitCost(s))
    }
  }

  /** What each target's row delivers: its rate, or what the machines of a machine-count target make. */
  private targetDemand() {
    const { shape, targets, roles } = this.input
    targets.forEach((t, i) => {
      const row = shape.targetRows[i]
      if (row && roles.machineCrafts.has(i)) this.m.column(lp.machineTarget(i), { [this.bal(row)]: -1 }, 0)
      else if (row) this.m.raise(this.bal(row), t.rate)
    })
  }

  /**
   * Each item's overflow pools (rows add to it as it overflows them) and goes to the rows of the
   * overflow target taking it, sizing that target; what it can't use is priced as a shortfall.
   */
  private overflowPools() {
    const { m } = this
    const { shape, roles } = this.input
    for (const [item, i] of roles.takerOf) {
      m.row(lp.overflow(item))
      for (const leaf of roles.takers.get(i)!)
        m.column(lp.overflowTaken(this.k(leaf)), { [lp.overflow(item)]: -1, [lp.balance(this.k(leaf))]: 1 }, 0)
      m.column(lp.overflowTarget(i), { [this.bal(shape.targetRows[i]!)]: -1 }, 0)
      this.deficit(lp.unusedOverflow(item), { [lp.overflow(item)]: -1 }, UNUSED_OVERFLOW_COST)
    }
  }

  /**
   * Rows built separately serve the overflow and supply targets too, so they can't be held to their
   * crafts; but they overflow no more than they do without them (else running one harder could still
   * soak up the overflow or supply).
   */
  private surplusCaps() {
    const { m } = this
    const { held, roles } = this.input
    if (!held) return
    for (const n of this.supplies) {
      const k = this.k(n)
      if (n.kind !== 'make' || roles.inTaker.has(n) || this.fixedOf(n) !== undefined || !m.hasColumn(lp.surplus(k))) continue
      m.row(lp.surplusCap(k), held.overflow.get(n.id)?.get(n.item) ?? 0)
      m.set(lp.surplus(k), lp.surplusCap(k), 1)
      m.column(lp.surplusCapSlack(k), { [lp.surplusCap(k)]: 1 }, 0)
    }
  }

  /**
   * Fed-back targets (by index among the targets with an item) and the rows making their item
   * elsewhere in the plan, which take what they make first (see `fedBack`). A net-surplus target
   * grows to cover the plan's use instead: targets after it (in order) of its item feed nothing.
   */
  private fedTargets() {
    const { plan, shape, targets, roles, absorbing } = this.input
    const netTargets = new Map([...absorbing].map(([item, a]) => [item, a.target]))
    targets.forEach((t, i) => {
      const row = shape.targetRows[i]
      if (!row || !isTargetRow(row.id)) return
      // Rows of its own chain looping back into it take its output (unfold decides whether they do).
      const loops = this.supplies.filter((c) => c.fedBack && c.ref === row)
      const net = netTargets.get(t.item)
      const fed = (net === undefined || i < net) && targetFedBack(plan, plan.targets[roles.planIndex[i]])
      const users = fed
        ? this.supplies.filter(
            (c) => c.item === t.item && c.kind === 'make' && c.takesLeftovers && !c.recovers && !isTargetRow(c.id) && rootOf(c) !== row,
          )
        : []
      if (users.length || loops.length) this.fedUsers.set(i, [...loops, ...users])
    })
  }

  /**
   * Rows whose by-products can go to rows running something else (`sharing`, see `extra` in
   * `craftColumns`), and what each makes beyond what it's used for (`excess`): its own overflow, plus
   * what the extra crafts of the rows above it take (else a row above could run harder to soak up its
   * overflow). Loops back up are left out, so it stays a chain down the tree.
   */
  private excess() {
    const { m } = this
    const { shape } = this.input
    this.sharing = new Set(
      shape.nodes.filter(
        (n) =>
          n.kind === 'make' &&
          !this.heldToCrafts(n) &&
          n.process!.outputs.some((o) => o.item !== n.item && this.sharedWith(n, o.item).some((c) => !this.sameRun(n, c))),
      ),
    )
    const usesOf = new Map<PlanNode, PlanNode[]>()
    for (const n of shape.nodes)
      if (n.parent && n.kind !== 'loop') usesOf.set(supplierOf(n), [...(usesOf.get(supplierOf(n)) ?? []), n.parent])
    const todo = [...this.sharing]
    while (todo.length) {
      const n = todo.pop()!
      if (this.chain.has(n) || n.kind !== 'make' || this.heldToCrafts(n)) continue
      this.chain.add(n)
      todo.push(...(usesOf.get(n) ?? []))
    }
    for (const n of this.chain) {
      const k = this.k(n)
      m.row(lp.excessBalance(k))
      m.column(lp.excess(k), { [lp.excessBalance(k)]: 1 }, 0)
      if (m.hasColumn(lp.surplus(k))) m.set(lp.surplus(k), lp.excessBalance(k), -1)
    }
    for (const n of this.chain) {
      const made = outputOf(n.process!, n.item)
      if (made <= 0) continue
      ingredients(n.process!).forEach((s, j) => {
        const c = n.children[j]
        const below = c && c.kind !== 'loop' ? this.index.get(supplierOf(c)) : undefined
        if (below !== undefined && m.hasColumn(lp.excess(below))) m.add(lp.excess(this.k(n)), lp.excessBalance(below), -s.count / made)
      })
    }
  }

  /** Recovery rows (and the reclaim rows under them) take other rows' outputs to turn them back into an item the plan uses. */
  private isRecovery = (c: PlanNode) => c.kind === 'reclaim' || !!c.recovers
  /** Whether `c` is (in) a recovery chain recovering into row `n`. */
  private ownRecovery = (n: PlanNode, c: PlanNode) => {
    if (!this.isRecovery(c)) return false
    let a = c
    while (a.recovers || a.kind === 'reclaim') a = a.parent!
    return supplierOf(a) === n
  }

  /** A row making something: its crafts, hold and floor, what it makes and takes, and where its side outputs go. */
  private craftColumns(n: PlanNode) {
    const { m } = this
    const { roles, floors } = this.input
    const p = n.process!
    const k = this.k(n)
    const x = lp.crafts(k)
    m.column(x, {}, CRAFT_COST * Math.max(p.seconds, 1) * (p.product === n.item ? 1 : SIDE_RUN_FACTOR))
    const fixed = this.fixedOf(n)
    if (fixed !== undefined && (!this.unheld || roles.machineRows.has(n))) {
      m.row(lp.hold(k), fixed)
      m.set(x, lp.hold(k), 1)
    }
    const floor = floors.get(n.id)
    if (floor) {
      m.row(lp.floor(k), floor)
      m.set(x, lp.floor(k), 1)
      m.column(lp.floorSlack(k), { [lp.floor(k)]: -1 }, 0)
    }
    m.add(x, lp.balance(k), outputOf(p, n.item))
    for (const o of p.outputs) {
      if (o.item === n.item || o.item.startsWith('@')) continue
      const pool = lp.pool(k, o.item)
      const out = lp.poolSurplus(k, o.item)
      m.row(pool)
      m.add(x, pool, o.count)
      // Sent to Knowledge Altars: all of it goes there, none to an overflow target.
      const altar = this.toAltar(n, o.item)
      if (altar) this.altared.set(out, o.item)
      const taken = !altar && roles.takerOf.has(o.item)
      m.column(out, { [pool]: -1, ...(taken && { [lp.overflow(o.item)]: 1 }) }, SURPLUS_COST)
      if (taken) this.overflowing.push({ column: out, item: o.item, from: n })
      // A recovery row turns leftovers into something the plan uses: what its other outputs overflow
      // counts as much as a row taking more than it needs, so it doesn't trade one leftover for
      // another unless nothing else can be done. A row rounded up overflows by design (see `rowBalances`).
      else if (!altar && !floors.has(n.id)) this.spills(out, n.recovers ? EXCESS_WEIGHT : 1)
      // By-products are what a row makes running for what it's used for: those of crafts beyond that
      // only go to rows running the same process, which would make them the same way (Gentian Nectar
      // from the Gentian row's nurseries). Rows with a producer of their own make the rest
      // themselves, rather than a row in another branch running harder and overflowing. Rows held
      // to their crafts are exempt: their extra machines are built anyway.
      const extra = lp.extra(k, o.item)
      const made = outputOf(p, n.item)
      const limited = this.sharing.has(n) && made > 0
      if (limited) {
        m.row(extra)
        m.set(lp.excess(k), extra, o.count / made)
        m.set(out, extra, -1)
        m.column(lp.extraSlack(k, o.item), { [extra]: 1 }, 0)
      }
      const shared = this.sharedWith(n, o.item)
      // Locality: what its own recovery could take leaves it only when that can't.
      const local = shared.some((c) => this.ownRecovery(n, c))
      if (local) {
        this.leaves(out)
        this.leavingPools.add(pool)
      }
      for (const c of shared) {
        const name = lp.flow(k, this.k(c))
        m.column(name, { [pool]: -1, [lp.balance(this.k(c))]: 1 }, FLOW_COST * (1 + distance(n, c)))
        if (local && !this.ownRecovery(n, c)) this.leaves(name)
        if (limited && this.sameRun(n, c)) m.set(name, extra, -1)
        // Then rows using what's left as it is take it, before other rows' recovery does.
        if (this.isRecovery(c) && !this.ownRecovery(n, c)) this.spills(name)
        this.flows.push({ name, from: n, to: c })
      }
    }
    ingredients(p).forEach((s, j) => {
      const c = n.children[j]
      if (c) m.add(x, this.bal(c), -s.count)
    })
  }

  /**
   * A target fed back is one more leftover: rows making its item elsewhere in the plan take what it
   * makes before they run their own recipe (Crude Shard refined from the plan's leftover Sand, the
   * Quartz crushers making the rest). It makes what it's set to; what they don't take goes out. A
   * net-surplus target grows to cover the plan's use instead (`pooled`), and rows taking the item
   * from the bus are covered in the ledger.
   */
  private fedBack() {
    const { m } = this
    const { shape, targets } = this.input
    for (const [i, users] of this.fedUsers) {
      const row = shape.targetRows[i]!
      // What it hands on is no more than it makes: its rate, or what the solve sizes it to.
      const cap = lp.fedCap(i)
      const sized = [lp.machineTarget(i), lp.overflowTarget(i), lp.supplyTarget(i)].find((name) => m.hasColumn(name))
      m.row(cap, sized ? 0 : targets[i].rate)
      if (sized) m.set(sized, cap, -1)
      m.column(lp.fedCapSlack(i), { [cap]: 1 }, 0)
      this.fedFrom.set(
        i,
        users.map((c) => {
          const name = lp.fed(i, this.k(c))
          // Targets in order: the first fed back is taken first, as in the ledger.
          m.column(name, { [cap]: 1, [lp.balance(this.k(c))]: 1 }, FLOW_COST * (1 + distance(row, c) + 1000 * i))
          this.flows.push({ name, from: row, to: c, fed: true })
          return name
        }),
      )
    }
  }

  /**
   * A crucible row's mixed feed: it also refines the by-products of the row making its input as they
   * come up the belt, a column of crafts (and heat) per item, sharing the row's output, floor and
   * hold. Rows of those items that take by-products get them first; the crucibles take the rest.
   */
  private mixedFeeds() {
    const { m } = this
    const { shape, catalog } = this.input
    for (const n of shape.nodes) {
      if (n.kind !== 'make' || !n.mix?.length) continue
      const k = this.k(n)
      const source = supplierOf(n.children[0])
      const heat = n.children[n.process!.inputs.findIndex((s) => s.item === HEAT)]
      const parts: MixPart[] = []
      for (const item of n.mix) {
        const q = catalog.byId.get(paradoxId(item))
        const pool = lp.pool(this.k(source), item)
        if (!q || !m.hasRow(pool) || this.altared.has(lp.poolSurplus(this.k(source), item))) continue
        const name = lp.mix(k, item)
        m.column(name, { [pool]: -q.inputs[0].count, [lp.balance(k)]: 1 }, CRAFT_COST * Math.max(q.seconds, 1) + MIX_COST)
        if (heat) m.add(name, this.bal(heat), -(q.inputs.find((s) => s.item === HEAT)?.count ?? 0))
        for (const row of [lp.hold(k), lp.floor(k)]) if (m.hasRow(row)) m.set(name, row, 1)
        if (this.leavingPools.has(pool)) this.leaves(name, q.inputs[0].count)
        parts.push({ item, process: q, name, source })
      }
      if (parts.length) this.mixes.set(n, parts)
    }
  }

  /**
   * Rows no longer held could otherwise run harder to make more of what an overflow target takes:
   * the rest of the plan's rows overflow no more of it than they do without the plan's overflow targets.
   */
  private overflowCaps() {
    const { m } = this
    const { held, roles } = this.input
    if (!held || !this.unheld) return
    for (const item of roles.takerOf.keys()) {
      const cap = lp.overflowCap(item)
      let surplus = 0
      for (const o of this.overflowing)
        if (o.item === item && !roles.inTaker.has(o.from)) {
          m.set(o.column, cap, 1)
          surplus += held.overflow.get(o.from.id)?.get(item) ?? 0
        }
      m.row(cap, surplus * (1 + 1e-6) + 1e-6)
      m.column(lp.overflowCapSlack(item), { [cap]: 1 }, 0)
    }
  }
}
