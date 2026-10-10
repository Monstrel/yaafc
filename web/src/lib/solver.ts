import { HEAT, itemName, type Stack } from './gameData'
import { checkProcess, wholeMachines } from './logistics'
import { unitScales } from './units'
import { solveLP } from './lp'
import { craftsPerMachine } from './machineRate'
import { paradoxId, runKey, type Process, type ProcessCatalog } from './processes'
import { NO_FLOWS, buildTree, onOverflow, type ByproductRoute, type RowFlows, type TreeNode } from './tree'
import type { Plan } from './types'
import { absorbers, supplyAhead, targetFedBack } from './ledger'
import { consumedBy, isTargetRow, suppliedBy, unfold, type PlanNode, type PlanShape } from './unfold'
import type { Modifiers } from './upgrades'

export interface ProcessRun {
  /** The process on its machine (see `runKey`): one recipe can run on different machines in different branches. */
  key: string
  process: Process
  craftsPerMinute: number
  machines: number
  inputs: Stack[] // per minute
  outputs: Stack[] // per minute
}

export interface ItemBalance {
  item: string
  target: number
  produced: number
  consumed: number
  /** Taken from the bus, less what the plan's own output covers (a fed-back net-surplus target). */
  fromBus: number
  /** What the plan's rows take from the bus, before its own output covers any. */
  drawn: number
  /** Shortfall the chosen producers can't cover (e.g. a loop that doesn't sustain itself). */
  deficit: number
  /** Made but used nowhere: overflow. */
  surplus: number
  /** Sent to Knowledge Altars by the rows making it, as it comes out (not overflow: it's dealt with). */
  altar: number
}

/** A target converted to items per minute. */
export interface ResolvedTarget {
  item: string
  rate: number
  /** Items per minute its row makes: `rate`, plus what the plan takes of a net-surplus target in place of the bus. */
  made: number
  /** Items per minute one of the chosen producer's machines makes, or null if bought/not made by a machine. */
  perMachine: number | null
  machineName: string | null
  /** For an overflow target: the overflow it takes. */
  overflow?: OverflowUse
  /** For a supply target: what it takes of the bus's supply. */
  supply?: SupplyUse
  /** Fed back: items per minute of what it makes that the plan's rows making its item take first. */
  fedIn?: number
}

/** What a supply target takes of the bus's capped supply of an item. */
export interface SupplyUse {
  item: string
  /** The plan caps the bus's supply of it (else there's no amount to size the target by: it makes none). */
  capped: boolean
  /** Its rows take the item from the bus (else it can take none). */
  uses: boolean
  /** Items per minute of the supply it takes. */
  taken: number
  /** Items per minute of the supply nothing takes. */
  unused: number
  /** The supply target above it (index in the plan's targets) that takes it all instead, if any. */
  takenBy: number | null
}

/** What an overflow target takes of the plan's overflow of an item. */
export interface OverflowUse {
  item: string
  /** Its rows use the item (else it can take none). */
  uses: boolean
  /** Items per minute of the overflow it takes. */
  taken: number
  /** Items per minute of the overflow it can't use (taking more would leave something short). */
  unused: number
  /** The overflow target above it (index in the plan's targets) that takes it all instead, if any. */
  takenBy: number | null
  /**
   * It's in a loop of overflow targets that overflows at least as much as it takes: it would need an
   * endless factory, so it takes none.
   */
  runaway: boolean
}

/**
 * Items of overflow targets in a runaway loop. A loop runs through the items overflow targets take:
 * from each to the items the rows of the target taking it make. An item whose overflow its target
 * can't use all of (`unused`) while in such a loop runs away, and so does the rest of its loop.
 */
function runawayItems(
  takerOf: Map<string, number>,
  takers: Map<number, PlanNode[]>,
  inTaker: Set<PlanNode>,
  unused: (item: string) => boolean,
): Set<string> {
  // Per taking target's root row, the items it makes that another overflow target takes.
  const makes = new Map<PlanNode, Set<string>>()
  for (const n of inTaker) {
    if (n.kind !== 'make') continue
    const root = rootOf(n)
    for (const o of n.process!.outputs)
      if (takerOf.has(o.item)) makes.set(root, (makes.get(root) ?? new Set()).add(o.item))
  }
  const roots = new Map<number, PlanNode | undefined>()
  for (const [i, leaves] of takers) roots.set(i, leaves[0] && rootOf(leaves[0]))
  const next = (item: string) => makes.get(roots.get(takerOf.get(item)!)!) ?? new Set<string>()
  const reach = (from: string) => {
    const seen = new Set<string>()
    const todo = [...next(from)]
    while (todo.length) {
      const x = todo.pop()!
      if (seen.has(x)) continue
      seen.add(x)
      todo.push(...next(x))
    }
    return seen
  }
  const found = new Set<string>()
  for (const item of takerOf.keys()) {
    if (found.has(item) || !unused(item)) continue
    const ahead = reach(item)
    if (!ahead.has(item)) continue
    for (const x of ahead) if (reach(x).has(item)) found.add(x)
  }
  return found
}

export interface PlanResult {
  status: 'ok' | 'infeasible' | 'error'
  message?: string
  targets: ResolvedTarget[]
  /** Machines per process (on its machine), summed over the tree's rows. */
  runs: ProcessRun[]
  balances: ItemBalance[]
  tree: TreeNode[]
}

const ZERO = 1e-12
const RELATIVE_NOISE = 1e-7
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
const SHORTFALL_ROW = 'shortfall'
const LEAVING_ROW = 'leaving'
const SPILL_ROW = 'spill'
// What a row takes beyond what it needs, and what a recovery row's other outputs overflow, count
// this many times what other rows spill (see the passes).
const EXCESS_WEIGHT = 1000
// Overflow an overflow target can't use is counted with shortfalls, so it uses all it can, but costs
// less than any shortfall: falling short somewhere never stands in for leaving overflow unused (a
// shortfall in a runaway loop would make it look like it settles).
const UNUSED_OVERFLOW_COST = 1
// A capped supply nothing takes costs more than what using it does (its row's crafts and the bus),
// so a supply target takes all it can. Shortfalls are settled first (see the two passes below), so
// leaving one never stands in for using the supply.
const UNUSED_SUPPLY_COST = 1000

/** Items per minute of `item` one machine running process `p` makes (output-belt cap included). */
export function outputPerMachine(p: Process, item: string, mods: Modifiers): number | null {
  const out = p.outputs.find((s) => s.item === item)?.count ?? 0
  if (!p.machine || p.seconds <= 0 || out <= 0) return null
  return out * craftsPerMachine(p, mods)
}

/** Converts machine-count targets to items per minute using the producer of each target's row. */
function resolveTargets(plan: Plan, shape: PlanShape, mods: Modifiers): ResolvedTarget[] {
  return plan.targets
    .filter((t) => t.item)
    .map((t, i) => {
      const p = shape.targetRows[i]?.process
      const perMachine = p ? outputPerMachine(p, t.item, mods) : null
      const amount = t.rate || 0
      // An overflow or supply target's rate comes from the solve.
      const rate = t.unit === 'machines' ? amount * (perMachine ?? 0) : consumedBy(t) || suppliedBy(t) ? 0 : amount
      return {
        item: t.item,
        rate,
        made: rate,
        perMachine,
        machineName: perMachine !== null ? (p?.machine?.name ?? null) : null,
      }
    })
}

/**
 * Net-surplus targets the solve sizes, per item: the target that covers what's left of what the
 * plan's rows take of it from the bus, and what the fed-back sources ahead of it supply.
 */
interface Absorbing {
  /** Index among the targets with an item (as `targets` and `shape.targetRows`). */
  target: number
  /** Items per minute the sources ahead of it can supply. */
  ahead: number
}

/** Rounds of solving before the supply ahead of a net-surplus target settles (overflow moves with it). */
const MAX_FEEDBACK_ROUNDS = 8

/** Rounds of solving before rows rounded up to whole machines settle (rounding one can grow another below it). */
const MAX_ROUNDING_ROUNDS = 12

/**
 * Solves the plan. Rows rounded up (`plan.roundUp`) run on the next whole number of the machines
 * built (with input belt limits), the extra output overflowing: each solve gives them a floor on
 * their crafts, and the plan is solved again until no rounded row needs more. Floors only grow.
 * A row built in units (`plan.units`) rounds up in each copy.
 */
export function solvePlan(plan: Plan, catalog: ProcessCatalog, mods: Modifiers): PlanResult {
  const rounded = new Set(plan.roundUp ?? [])
  const floors = new Map<string, number>()
  const utilization = (n: TreeNode) => checkProcess(n.run!.process, mods)?.utilization ?? 1
  let result = solveFed(plan, catalog, mods, floors)
  for (let round = 0; rounded.size && round < MAX_ROUNDING_ROUNDS && result.status === 'ok'; round++) {
    let raised = false
    const { copies } = unitScales(result.tree, plan.units, utilization)
    const visit = (n: TreeNode) => {
      const p = n.run?.process
      // Rows running on overflow can't run faster than it comes: their whole machines run underfed.
      if (rounded.has(n.id) && n.kind === 'produce' && p?.machine && p.seconds > 0 && !onOverflow(n)) {
        const built = wholeMachines(p, n.machines / (copies.get(n.id) ?? 1), mods)
        if (built !== null && built.count > built.exact + 1e-9) {
          floors.set(n.id, (built.count / built.exact) * n.run!.craftsPerMinute)
          raised = true
        }
      }
      n.children.forEach(visit)
    }
    result.tree.forEach(visit)
    if (!raised) break
    result = solveFed(plan, catalog, mods, floors)
  }
  return result
}

/**
 * Solves the plan with rows held to at least `floors` crafts per minute (by row id). A net-surplus
 * target that's fed back makes the plan cover its own use of its item: its row grows to make what
 * the plan's rows would take of it from the bus, less what the sources ahead of it (overflow, then
 * fed-back targets in order) supply, and still delivers its rate. Overflow depends on the solution,
 * so the solve repeats until what those sources supply settles.
 */
function solveFed(plan: Plan, catalog: ProcessCatalog, mods: Modifiers, floors: Map<string, number>): PlanResult {
  const found = absorbers(plan)
  if (!found.size) return solveRound(plan, catalog, mods, new Map(), floors)
  const filtered = plan.targets.map((t, i) => (t.item ? plan.targets.slice(0, i).filter((x) => x.item).length : -1))
  const absorbing = new Map<string, Absorbing>()
  for (const [item, target] of found) absorbing.set(item, { target: filtered[target], ahead: 0 })
  let result = solveRound(plan, catalog, mods, absorbing, floors)
  for (let round = 1; round < MAX_FEEDBACK_ROUNDS && result.status === 'ok'; round++) {
    const ahead = supplyAhead(plan, result)
    let settled = true
    for (const [item, a] of absorbing) {
      const next = ahead.get(item) ?? 0
      if (Math.abs(next - a.ahead) > 1e-9 * Math.max(1, next)) settled = false
      a.ahead = next
    }
    if (settled) break
    result = solveRound(plan, catalog, mods, absorbing, floors)
  }
  return result
}

/** How each row (by id) runs without the plan's overflow and supply targets. */
interface Baseline {
  /** Crafts per minute. */
  crafts: Map<string, number>
  /** Items per minute of its own item it makes that nothing uses. */
  overflow: Map<string, number>
}

/**
 * How each row runs with the plan's overflow and supply targets taking nothing: laid out as they
 * are (so the rows are the same), the rest of the plan is solved as it is without them.
 */
function baselineCrafts(
  plan: Plan,
  catalog: ProcessCatalog,
  mods: Modifiers,
  absorbing: Map<string, Absorbing>,
  floors: Map<string, number>,
): Baseline {
  const crafts = new Map<string, number>()
  const overflow = new Map<string, number>()
  const visit = (n: TreeNode) => {
    if (n.run) crafts.set(n.id, n.run.craftsPerMinute)
    overflow.set(n.id, n.overflow)
    n.children.forEach(visit)
  }
  solveRound(plan, catalog, mods, absorbing, floors, { sizing: false }).tree.forEach(visit)
  return { crafts, overflow }
}

/** The root row of a row's tree. */
function rootOf(n: PlanNode): PlanNode {
  let r = n
  while (r.parent) r = r.parent
  return r
}

/** The row that supplies a row: itself, or the row a loop or separate build points to. */
function supplierOf(n: PlanNode): PlanNode {
  let s = n
  while ((s.kind === 'loop' || s.kind === 'separate') && s.ref) s = s.ref
  return s
}

const isSupply = (n: PlanNode) => supplierOf(n) === n

/**
 * What a row whose machines output something is called where that output goes: its recipe, or the
 * item it makes when it runs a recipe for another of its outputs (Athanors making Crude Silver
 * Powder run the Silver Powder recipe: the Silver Powder they leave over isn't "from Silver Powder").
 */
const sourceLabel = (n: PlanNode) => (n.process!.product === n.item ? n.process!.label : itemName(n.item))

/** A solved amount, with solver noise below `tol` dropped. */
const cleaned = (x: number, tol: number) => (x > tol ? x : 0)

/** Steps between two rows of the tree. */
function distance(a: PlanNode, b: PlanNode): number {
  const x = a.id.split('/')
  const y = b.id.split('/')
  let common = 0
  while (common < x.length && common < y.length && x[common] === y[common]) common++
  return x.length + y.length - 2 * common
}

/** Ingredients a row's process takes from the rows below it (heat and nutrients too), in the order of its children. */
const ingredients = (p: Process) => p.inputs
const outputOf = (p: Process, item: string) => p.outputs.find((s) => s.item === item)?.count ?? 0

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
function solveRound(
  plan: Plan,
  catalog: ProcessCatalog,
  mods: Modifiers,
  absorbing: Map<string, Absorbing>,
  floors: Map<string, number>,
  {
    sizing = true,
  }: {
    /** Overflow and supply targets take what they can; else they take nothing (see `baselineCrafts`). */
    sizing?: boolean
  } = {},
): PlanResult {
  const shape = unfold(plan, catalog)
  const targets = resolveTargets(plan, shape, mods)
  const index = new Map(shape.nodes.map((n, k) => [n, k]))
  const bal = (n: PlanNode) => `b:${index.get(supplierOf(n))}`

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
  const caps = new Map(Object.entries(plan.busSupply ?? {}))
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
    if (rows.length && caps.has(item) && !supplyTaker.has(item)) supplyTaker.set(item, i)
  }
  // Overflow and supply targets take what the rest of the plan overflows or leaves as it is without
  // them: its targets' rows run as they would (running one harder could soak up the overflow or
  // supply into a surplus of its own).
  const held =
    takerOf.size || supplyTaker.size
      ? baselineCrafts(plan, catalog, mods, absorbing, floors)
      : null

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

  const equalities: Record<string, number> = {}
  const columns: Record<string, Record<string, number>> = {}
  const add = (col: Record<string, number>, row: string, v: number) => {
    if (v) col[row] = (col[row] ?? 0) + v
  }

  // Per item a fed-back net-surplus target covers: a pool its row and the sources ahead of it supply
  // (up to `ahead`), and the plan's rows taking the item from the bus draw on. What they can't
  // cover is a shortfall: the target's own chain uses more than it gives.
  const pooled = new Map<string, Absorbing>()
  for (const [item, a] of absorbing) {
    const row = shape.targetRows[a.target]
    if (!row) continue
    pooled.set(item, a)
    equalities[`g:${item}`] = 0
    columns[`d:g:${item}`] = { [`g:${item}`]: 1, cost: MIN_DEFICIT_COST }
    equalities[`ahead:${item}`] = a.ahead
    columns[`fa:${item}`] = { [`g:${item}`]: 1, [`ahead:${item}`]: 1, cost: 0 }
    columns[`fu:${item}`] = { [`ahead:${item}`]: 1, cost: 0 }
    columns[`fb:${item}`] = { [bal(row)]: -1, [`g:${item}`]: 1, cost: 0 }
  }

  // Capped plan inputs a supply target takes what's left of (where the plan doesn't make the item in
  // their place): rows taking one share the cap, falling short past it, and the target takes the
  // rest. Elsewhere a cap sizes nothing: rows take what they need (the ledger warns past it).
  const capped = new Map([...caps].filter(([item]) => !pooled.has(item) && supplyTaker.has(item)))
  for (const [item, cap] of capped) {
    equalities[`bc:${item}`] = cap
    columns[`bu:${item}`] = { [`bc:${item}`]: 1, cost: supplyTaker.has(item) ? UNUSED_SUPPLY_COST : 0 }
  }
  for (const [item, i] of supplyTaker) if (capped.has(item)) columns[`ts:${i}`] = { [bal(shape.targetRows[i])]: -1, cost: 0 }
  const deficitCost = (n: PlanNode) => Math.max(MIN_DEFICIT_COST, DEFICIT_COST * DEFICIT_DEPTH_FACTOR ** n.depth)

  const supplies = shape.nodes.filter(isSupply)
  for (const s of supplies) {
    const k = index.get(s)!
    equalities[`b:${k}`] = 0
    // An overflow target's rows of its item get only the overflow taken, and its other rows make no
    // more than it needs. A row of an item an overflow target takes overflows into its pool, whether
    // it makes the item or gets more of other rows' by-products than it needs. A row taking a capped
    // item from the bus takes no more than it needs (the rest is for the others).
    if (s.kind !== 'overflow' && !(s.kind === 'bus' && capped.has(s.item)) && (!inTaker.has(s) || floors.has(s.id)))
      columns[`s:${k}`] = {
        [`b:${k}`]: -1,
        ...(takerOf.has(s.item) && { [`o:${s.item}`]: 1 }),
        cost: SURPLUS_COST,
      }
    // Nothing makes it and the plan doesn't take it in: what other rows leave of it, else a shortfall.
    if (s.unsupplied) columns[`d:${k}`] = { [`b:${k}`]: 1, cost: deficitCost(s) }
    else if (s.kind === 'bus' && pooled.has(s.item)) columns[`i:${k}`] = { [`b:${k}`]: 1, [`g:${s.item}`]: -1, cost: 0 }
    else if (s.kind === 'bus' && capped.has(s.item)) {
      columns[`i:${k}`] = { [`b:${k}`]: 1, [`bc:${s.item}`]: 1, cost: IMPORT_COST }
      columns[`d:${k}`] = { [`b:${k}`]: 1, cost: deficitCost(s) }
    } else if (s.kind === 'bus') columns[`i:${k}`] = { [`b:${k}`]: 1, cost: IMPORT_COST }
    // A row taking what other rows output only has that, and a recovery row only what it recovers:
    // what it makes joins the supply of the row above it.
    else if (s.kind === 'overflow' || s.kind === 'reclaim') continue
    else if (s.recovers) columns[`rc:${k}`] = { [`b:${k}`]: -1, [bal(s.parent!)]: 1, cost: 0 }
    else columns[`d:${k}`] = { [`b:${k}`]: 1, cost: deficitCost(s) }
  }
  targets.forEach((t, i) => {
    const row = shape.targetRows[i]
    if (row && machineCrafts.has(i)) columns[`tm:${i}`] = { [bal(row)]: -1, cost: 0 }
    else if (row) equalities[bal(row)] += t.rate
  })
  // Each item's overflow pools (rows add to it as it overflows them) and goes to the rows of the
  // overflow target taking it, sizing that target; what it can't use is priced as a shortfall.
  for (const [item, i] of takerOf) {
    equalities[`o:${item}`] = 0
    for (const leaf of takers.get(i)!) columns[`od:${index.get(leaf)}`] = { [`o:${item}`]: -1, [`b:${index.get(leaf)}`]: 1, cost: 0 }
    columns[`t:${i}`] = { [bal(shape.targetRows[i])]: -1, cost: 0 }
    columns[`d:o:${item}`] = { [`o:${item}`]: -1, cost: UNUSED_OVERFLOW_COST }
  }

  // By-product pools: what one row makes of each side output, shared out to rows of that item,
  // unless the row sends it to Knowledge Altars as it comes out.
  const consumers = new Map<string, PlanNode[]>()
  for (const s of supplies) if (s.takesLeftovers) consumers.set(s.item, [...(consumers.get(s.item) ?? []), s])
  const toAltar = (n: PlanNode, item: string) => !!plan.altarOutputs?.[n.id]?.includes(item)
  const sharedWith = (n: PlanNode, item: string) => (toAltar(n, item) ? [] : (consumers.get(item) ?? []))
  // `fed`: from a fed-back target's output, not a row's by-products.
  const flows: { name: string; from: PlanNode; to: PlanNode; fed?: boolean }[] = []

  // Rows held to their crafts: rounded up, or as they are without the plan's overflow targets.
  const fixedOf = (n: PlanNode) =>
    (!inTaker.has(n) && isTargetRow(rootOf(n).id) ? held?.crafts.get(n.id) : undefined) ?? machineRows.get(n)
  // Rows built separately serve the overflow and supply targets too, so they can't be held to their
  // crafts; but they overflow no more than they do without them (else running one harder could still
  // soak up the overflow or supply).
  if (held)
    for (const n of supplies) {
      const k = index.get(n)!
      if (n.kind !== 'make' || inTaker.has(n) || fixedOf(n) !== undefined || !columns[`s:${k}`]) continue
      equalities[`sc:${k}`] = held.overflow.get(n.id) ?? 0
      columns[`s:${k}`][`sc:${k}`] = 1
      columns[`scs:${k}`] = { [`sc:${k}`]: 1, cost: 0 }
    }
  const heldToCrafts = (n: PlanNode) => floors.has(n.id) || fixedOf(n) !== undefined
  // Fed-back targets (by index among the targets with an item) and the rows making their item
  // elsewhere in the plan, which take what they make first (see `fedFrom` below). A net-surplus
  // target grows to cover the plan's use instead.
  // Targets after it (in order) of its item feed nothing: it covers all the plan takes.
  const netTargets = new Map([...absorbing].map(([item, a]) => [item, a.target]))
  const fedUsers = new Map<number, PlanNode[]>()
  targets.forEach((t, i) => {
    const row = shape.targetRows[i]
    const net = netTargets.get(t.item)
    if (!row || !isTargetRow(row.id) || (net !== undefined && i >= net) || !targetFedBack(plan, plan.targets[planIndex[i]])) return
    const users = supplies.filter(
      (c) => c.item === t.item && c.kind === 'make' && c.takesLeftovers && !c.recovers && !isTargetRow(c.id) && rootOf(c) !== row,
    )
    if (users.length) fedUsers.set(i, users)
  })
  // Rows held to their crafts that take a fed-back target's output, and the rows below them, run up
  // to those crafts: what the target makes covers the rest.
  const easing = new Set<PlanNode>()
  const ease = (n: PlanNode) => {
    if (easing.has(n)) return
    easing.add(n)
    n.children.forEach(ease)
  }
  for (const users of fedUsers.values()) users.forEach(ease)
  const sameRun = (n: PlanNode, c: PlanNode) => c.kind === 'make' && c.process!.id === n.process!.id
  // Rows whose by-products can go to rows running something else (see `e:` below).
  const sharing = new Set(
    shape.nodes.filter(
      (n) =>
        n.kind === 'make' &&
        !heldToCrafts(n) &&
        n.process!.outputs.some(
          (o) => o.item !== n.item && sharedWith(n, o.item).some((c) => !sameRun(n, c)),
        ),
    ),
  )
  // What each of those rows makes beyond what it's used for (`ex:`): its own overflow, plus what the
  // extra crafts of the rows above it take (else a row above could run harder to soak up its
  // overflow). Loops back up are left out, so it stays a chain down the tree.
  const usesOf = new Map<PlanNode, PlanNode[]>()
  for (const n of shape.nodes)
    if (n.parent && n.kind !== 'loop') usesOf.set(supplierOf(n), [...(usesOf.get(supplierOf(n)) ?? []), n.parent])
  const chain = new Set<PlanNode>()
  const todo = [...sharing]
  while (todo.length) {
    const n = todo.pop()!
    if (chain.has(n) || n.kind !== 'make' || heldToCrafts(n)) continue
    chain.add(n)
    todo.push(...(usesOf.get(n) ?? []))
  }
  for (const n of chain) {
    const k = index.get(n)!
    equalities[`xd:${k}`] = 0
    columns[`ex:${k}`] = { [`xd:${k}`]: 1, cost: 0 }
    if (columns[`s:${k}`]) columns[`s:${k}`][`xd:${k}`] = -1
  }
  for (const n of chain) {
    const ex = columns[`ex:${index.get(n)}`]
    const made = outputOf(n.process!, n.item)
    if (made <= 0) continue
    ingredients(n.process!).forEach((s, j) => {
      const c = n.children[j]
      const below = c && c.kind !== 'loop' ? index.get(supplierOf(c)) : undefined
      if (below !== undefined && columns[`ex:${below}`]) add(ex, `xd:${below}`, -s.count / made)
    })
  }

  // Recovery rows (and the reclaim rows under them) take other rows' outputs to turn them back into
  // an item the plan uses.
  const isRecovery = (c: PlanNode) => c.kind === 'reclaim' || !!c.recovers
  /** The row a recovery row's chain (or a reclaim row's) recovers into. */
  const joins = (c: PlanNode) => {
    let a = c
    while (a.recovers || a.kind === 'reclaim') a = a.parent!
    return supplierOf(a)
  }
  const ownRecovery = (n: PlanNode, c: PlanNode) => isRecovery(c) && joins(c) === n
  // Per column, the items per minute it takes of a row's output away from the row, where its own
  // recovery could take it (see the passes below).
  const leaving = new Map<string, number>()
  // Columns of what recovery rows' other outputs overflow (see the passes below).
  const recoveryOverflow = new Set<string>()
  // Per column of a row's output it sends to Knowledge Altars, the item.
  const altared = new Map<string, string>()

  for (const n of shape.nodes) {
    if (n.kind !== 'make') continue
    const p = n.process!
    const k = index.get(n)!
    const col: Record<string, number> = {
      cost: CRAFT_COST * Math.max(p.seconds, 1) * (p.product === n.item ? 1 : SIDE_RUN_FACTOR),
    }
    columns[`x:${k}`] = col
    const fixed = fixedOf(n)
    if (fixed !== undefined) {
      equalities[`h:${k}`] = fixed
      col[`h:${k}`] = 1
      if (easing.has(n) && !machineRows.has(n)) columns[`hs:${k}`] = { [`h:${k}`]: 1, cost: 0 }
    }
    const floor = floors.get(n.id)
    if (floor) {
      equalities[`r:${k}`] = floor
      col[`r:${k}`] = 1
      columns[`rs:${k}`] = { [`r:${k}`]: -1, cost: 0 }
    }
    add(col, `b:${k}`, outputOf(p, n.item))
    for (const o of p.outputs) {
      if (o.item === n.item || o.item.startsWith('@')) continue
      const pool = `p:${k}:${o.item}`
      equalities[pool] = 0
      add(col, pool, o.count)
      // Sent to Knowledge Altars: all of it goes there, none to an overflow target.
      const altar = toAltar(n, o.item)
      if (altar) altared.set(`ps:${k}:${o.item}`, o.item)
      columns[`ps:${k}:${o.item}`] = { [pool]: -1, ...(!altar && takerOf.has(o.item) && { [`o:${o.item}`]: 1 }), cost: SURPLUS_COST }
      // A recovery row turns leftovers into something the plan uses: what its other outputs overflow
      // counts as much as a row taking more than it needs (see the passes), so it doesn't trade one
      // leftover for another unless nothing else can be done.
      if (n.recovers && !altar) recoveryOverflow.add(`ps:${k}:${o.item}`)
      // By-products are what a row makes running for what it's used for: those of crafts beyond that
      // only go to rows running the same process, which would make them the same way (Gentian Nectar
      // from the Gentian row's nurseries). Rows with a producer of their own make the rest
      // themselves, rather than a row in another branch running harder and overflowing. Rows held
      // to their crafts are exempt: their extra machines are built anyway.
      const extra = `e:${k}:${o.item}`
      const made = outputOf(p, n.item)
      if (sharing.has(n) && made > 0) {
        equalities[extra] = 0
        columns[`ex:${k}`][extra] = o.count / made
        columns[`ps:${k}:${o.item}`][extra] = -1
        columns[`es:${k}:${o.item}`] = { [extra]: 1, cost: 0 }
      }
      const shared = sharedWith(n, o.item)
      const local = shared.some((c) => ownRecovery(n, c))
      if (local) leaving.set(`ps:${k}:${o.item}`, 1)
      for (const c of shared) {
        const name = `f:${k}>${index.get(c)}`
        columns[name] = { [pool]: -1, [`b:${index.get(c)}`]: 1, cost: FLOW_COST * (1 + distance(n, c)) }
        if (local && !ownRecovery(n, c)) leaving.set(name, 1)
        if (extra in equalities && sameRun(n, c)) columns[name][extra] = -1
        flows.push({ name, from: n, to: c })
      }
    }
    ingredients(p).forEach((s, j) => {
      const c = n.children[j]
      if (c) add(col, bal(c), -s.count)
    })
  }

  // A target fed back is one more leftover: rows making its item elsewhere in the plan take what it
  // makes before they run their own recipe (Crude Shard refined from the plan's leftover Sand, the
  // Quartz crushers making the rest). It makes what it's set to; what they don't take goes out. A
  // net-surplus target grows to cover the plan's use instead (`pooled`), and rows taking the item
  // from the bus are covered in the ledger.
  const fedFrom = new Map<number, string[]>()
  for (const [i, users] of fedUsers) {
    const t = targets[i]
    const row = shape.targetRows[i]!
    // What it hands on is no more than it makes: its rate, or what the solve sizes it to.
    const cap = `fbc:${i}`
    const sized = [`tm:${i}`, `t:${i}`, `ts:${i}`].find((name) => name in columns)
    equalities[cap] = sized ? 0 : t.rate
    if (sized) columns[sized][cap] = -1
    columns[`fbs:${i}`] = { [cap]: 1, cost: 0 }
    fedFrom.set(
      i,
      users.map((c) => {
        const name = `fbk:${i}>${index.get(c)}`
        // Targets in order: the first fed back is taken first, as in the ledger.
        columns[name] = { [cap]: 1, [`b:${index.get(c)}`]: 1, cost: FLOW_COST * (1 + distance(row, c) + 1000 * i) }
        flows.push({ name, from: row, to: c, fed: true })
        return name
      }),
    )
  }

  // A crucible row's mixed feed: it also refines the by-products of the row making its input as
  // they come up the belt, a column of crafts (and heat) per item, sharing the row's output, floor
  // and hold. Rows of those items that take by-products get them first; the crucibles take the rest.
  const mixes = new Map<PlanNode, { item: string; process: Process; name: string; source: PlanNode }[]>()
  for (const n of shape.nodes) {
    if (n.kind !== 'make' || !n.mix?.length) continue
    const k = index.get(n)!
    const source = supplierOf(n.children[0])
    const heat = n.children[n.process!.inputs.findIndex((s) => s.item === HEAT)]
    const parts = []
    for (const item of n.mix) {
      const q = catalog.byId.get(paradoxId(item))
      const pool = `p:${index.get(source)}:${item}`
      if (!q || !(pool in equalities) || altared.has(`ps:${index.get(source)}:${item}`)) continue
      const name = `m:${k}:${item}`
      const col: Record<string, number> = { [pool]: -q.inputs[0].count, [`b:${k}`]: 1, cost: CRAFT_COST * Math.max(q.seconds, 1) + MIX_COST }
      if (heat) add(col, bal(heat), -(q.inputs.find((s) => s.item === HEAT)?.count ?? 0))
      for (const row of [`h:${k}`, `r:${k}`]) if (row in equalities) col[row] = 1
      columns[name] = col
      if (leaving.has(`ps:${index.get(source)}:${item}`)) leaving.set(name, q.inputs[0].count)
      parts.push({ item, process: q, name, source })
    }
    if (parts.length) mixes.set(n, parts)
  }

  const fail = (status: 'infeasible' | 'error', message?: string): PlanResult => ({
    status,
    message,
    targets,
    runs: [],
    balances: [],
    tree: buildTree(shape.roots, new Map(), mods),
  })

  // Passes in turn, so a shortfall is only ever reported when the chosen producers really can't cover
  // it. In one pass, deficits were just expensive: a big enough plan (Sol burns millions of P and
  // tens of thousands of fuel and fertilizer items a minute) cost more than giving up on the target.
  // Pass 1 minimizes the depth-weighted shortfall alone; the last pass holds it there and minimizes
  // the real costs. Between them, each pass settles one rule of where outputs go, held in turn (by
  // cost alone, they lost to whatever was cheaper):
  //   - Locality: a row's outputs go to its own recovery first, and only what that can't take
  //     leaves it (Athanors making Gold Dust refine their failed crafts back up, rather than turning
  //     them out for a cauldron making Resonant Catalyst).
  //   - Then rows using what's left as it is take it, before other rows' recovery does or it
  //     overflows: the pass minimizes what goes those two ways. A row taking more than it needs
  //     counts many times over, so no row runs harder to take more.
  // What's left over costs nothing to take (its source runs no harder for it), so the last pass has
  // rows take it before they import or make their item.
  const deficits = new Map(Object.entries(columns).flatMap(([name, { cost }]) => (name.startsWith('d:') ? [[name, cost]] : [])))
  const spill = new Map<string, number>()
  for (const f of flows) if (isRecovery(f.to) && !ownRecovery(f.from, f.to)) spill.set(f.name, 1)
  for (const [name, col] of Object.entries(columns)) {
    const taken = Object.keys(col).some((row) => row.startsWith('o:'))
    if (name.startsWith('ps:') && !taken && !altared.has(name)) spill.set(name, recoveryOverflow.has(name) ? EXCESS_WEIGHT : 1)
    if (name.startsWith('s:') && !taken) spill.set(name, EXCESS_WEIGHT)
  }
  const stages: [string, Map<string, number>][] = [
    [SHORTFALL_ROW, deficits],
    [LEAVING_ROW, leaving],
    [SPILL_ROW, spill],
  ]
  // Items per minute a held pass's room could still move: flows and recovery below it are noise.
  let noise = 0
  for (const [row, weights] of stages) {
    if (!weights.size) continue
    const phase = solveLP({
      equalities,
      columns: Object.fromEntries(Object.entries(columns).map(([name, { cost: _cost, ...rows }]) => [name, { ...rows, cost: weights.get(name) ?? 0 }])),
    })
    if (phase.status !== 'optimal') return fail(phase.status, phase.message)
    let total = 0
    for (const [name, x] of phase.values) total += x * (weights.get(name) ?? 0)
    // Σ weight·x + slack = what the pass reached, with a little room for solver tolerance. What the
    // later passes can still shift within that room is noise (see `noise`).
    const room = total * 1e-6 + 1e-6
    equalities[row] = total + room
    if (row !== SHORTFALL_ROW) noise += room
    for (const [name, w] of weights) if (columns[name]) columns[name][row] = w
    columns[`slack:${row}`] = { [row]: 1, cost: 0 }
  }

  const solution = solveLP({ equalities, columns })
  if (solution.status !== 'optimal') return fail(solution.status, solution.message)
  const v = (name: string) => {
    const x = solution.values.get(name) ?? 0
    return Math.abs(x) < ZERO ? 0 : x
  }

  // What each row uses or delivers itself; a supplying row adds what loops and separate builds take.
  const crafts = (n: PlanNode) => (n.kind === 'make' ? v(`x:${index.get(n)}`) : 0)
  // A net-surplus target's row also makes what the plan takes of it in place of the bus.
  for (const [item, a] of pooled) targets[a.target].made += v(`fb:${item}`)
  // An overflow target makes what the overflow it takes comes to.
  const taken = (i: number) => {
    const x = (takers.get(i) ?? []).reduce((t, leaf) => t + v(`od:${index.get(leaf)}`), 0)
    return cleaned(x, RELATIVE_NOISE * Math.max(1, x))
  }
  const unused = (item: string) => {
    const x = v(`d:o:${item}`)
    return cleaned(x, RELATIVE_NOISE * Math.max(1, x + taken(takerOf.get(item)!)))
  }
  const runaway = runawayItems(takerOf, takers, inTaker, (item) => unused(item) > 0)
  for (const [i, leaves] of takers) {
    const item = consumedBy(plan.targets[planIndex[i]])!
    const by = takerOf.get(item)
    targets[i].rate = targets[i].made = cleaned(v(`t:${i}`), RELATIVE_NOISE * Math.max(1, v(`t:${i}`)))
    targets[i].overflow = {
      item,
      uses: leaves.length > 0,
      taken: by === i ? taken(i) : 0,
      unused: by === i ? unused(item) : 0,
      takenBy: by !== undefined && by !== i && leaves.length > 0 ? planIndex[by] : null,
      runaway: by === i && runaway.has(item),
    }
  }
  // A supply target makes what what's left of the bus's supply comes to.
  for (const [i, rows] of supplyRows) {
    const item = suppliedBy(plan.targets[planIndex[i]])!
    const by = supplyTaker.get(item)
    const taken = rows.reduce((t, n) => t + v(`i:${index.get(n)}`), 0)
    const left = v(`bu:${item}`)
    targets[i].rate = targets[i].made = by === i ? v(`ts:${i}`) : 0
    targets[i].supply = {
      item,
      capped: capped.has(item),
      uses: rows.length > 0,
      taken: by === i ? taken : 0,
      unused: by === i ? cleaned(left, RELATIVE_NOISE * Math.max(1, left + taken)) : 0,
      takenBy: by !== undefined && by !== i && rows.length > 0 ? planIndex[by] : null,
    }
  }
  // What the plan's rows take of each fed-back target's output.
  for (const [i, names] of fedFrom) {
    const x = names.reduce((t, name) => t + v(name), 0)
    targets[i].fedIn = cleaned(x, RELATIVE_NOISE * Math.max(1, x))
  }
  for (const i of machineCrafts.keys()) {
    const x = v(`tm:${i}`)
    targets[i].rate = targets[i].made = cleaned(x, RELATIVE_NOISE * Math.max(1, x))
  }
  const own = new Map<PlanNode, number>()
  targets.forEach((t, i) => {
    const row = shape.targetRows[i]
    if (row) own.set(row, (own.get(row) ?? 0) + t.made)
  })
  for (const n of shape.nodes)
    if (n.kind === 'make')
      ingredients(n.process!).forEach((s, j) => {
        const c = n.children[j]
        if (c) own.set(c, (own.get(c) ?? 0) + s.count * crafts(n))
      })
  // A mixed crucible row's other inputs: their crafts (heated by its heat row) and what they refine.
  const mixed = (n: PlanNode) => (mixes.get(n) ?? []).map((m) => ({ ...m, crafts: v(m.name) }))
  for (const n of mixes.keys()) {
    const heat = n.children[n.process!.inputs.findIndex((s) => s.item === HEAT)]
    for (const m of mixed(n))
      if (heat) own.set(heat, (own.get(heat) ?? 0) + (m.process.inputs.find((s) => s.item === HEAT)?.count ?? 0) * m.crafts)
  }
  // A recovery row supplies what it recovers to the row above it, which needs that much less.
  const recovered = new Map<PlanNode, number>()
  for (const n of shape.nodes)
    if (n.recovers) {
      const x = v(`rc:${index.get(n)}`)
      own.set(n, x)
      const into = supplierOf(n.parent!)
      recovered.set(into, (recovered.get(into) ?? 0) + x)
    }
  const demand = new Map<PlanNode, number>()
  for (const n of shape.nodes) {
    const s = supplierOf(n)
    demand.set(s, (demand.get(s) ?? 0) + (own.get(n) ?? 0))
  }
  const drawn = new Map<PlanNode, { from: PlanNode; amount: number; fed?: boolean }[]>()
  const sent = new Map<PlanNode, { to: PlanNode; item: string; amount: number; direct?: boolean }[]>()
  for (const f of flows) {
    const amount = v(f.name)
    if (amount <= 0) continue
    drawn.set(f.to, [...(drawn.get(f.to) ?? []), { from: f.from, amount, fed: f.fed }])
    sent.set(f.from, [...(sent.get(f.from) ?? []), { to: f.to, item: f.to.item, amount }])
  }
  for (const n of mixes.keys())
    for (const m of mixed(n)) {
      const amount = m.process.inputs[0].count * m.crafts
      if (amount > 0) sent.set(m.source, [...(sent.get(m.source) ?? []), { to: n, item: m.item, amount, direct: true }])
    }
  /** Where each side output of a row goes, and what's left of it. */
  const routes = (n: PlanNode, x: number) => {
    const k = index.get(n)!
    const out: Record<string, ByproductRoute> = {}
    for (const o of n.process!.outputs) {
      if (o.item === n.item || o.item.startsWith('@')) continue
      const tol = Math.max(RELATIVE_NOISE * Math.max(1, o.count * x), noise)
      out[o.item] = {
        to: (sent.get(n) ?? [])
          .filter((s) => s.item === o.item && s.amount > tol)
          .sort((a, b) => b.amount - a.amount)
          .map((s) => ({ id: s.to.id, amount: s.amount, ...(s.direct && { direct: true }) })),
        ...(altared.has(`ps:${k}:${o.item}`)
          ? { overflow: 0, toAltar: true, altar: cleaned(v(`ps:${k}:${o.item}`), tol) }
          : { overflow: cleaned(v(`ps:${k}:${o.item}`), tol), altar: 0 }),
      }
    }
    return out
  }

  const rowFlows = new Map<PlanNode, RowFlows>()
  for (const n of shape.nodes) {
    if (!isSupply(n)) {
      rowFlows.set(n, { ...NO_FLOWS, rate: own.get(n) ?? 0 })
      continue
    }
    const need = demand.get(n) ?? 0
    const x = crafts(n)
    // An overflow target's rows of its item get the overflow it takes.
    const parts = mixed(n)
    const made =
      n.kind === 'make'
        ? outputOf(n.process!, n.item) * x + parts.reduce((t, m) => t + m.crafts, 0)
        : n.kind === 'overflow'
          ? v(`od:${index.get(n)}`)
          : 0
    const tol = RELATIVE_NOISE * Math.max(1, need, made)
    const received = (drawn.get(n) ?? []).filter((d) => d.amount > tol * 1e-2)
    // Shown: draws above what the held passes left room for (noise there isn't a real feed).
    const draws = received.filter((d) => d.amount > noise).sort((a, b) => b.amount - a.amount)
    const fromByproduct = draws.reduce((sum, d) => sum + d.amount, 0)
    const fromRecovery = recovered.get(n) ?? 0
    const missing = need - made - received.reduce((sum, d) => sum + d.amount, 0) - fromRecovery
    const short = missing > tol ? missing : 0
    // Rows taking an item from the bus get what it carries; past a capped supply, they fall short.
    const drew = n.kind !== 'bus' || n.unsupplied ? 0 : capped.has(n.item) ? Math.min(short, cleaned(v(`i:${index.get(n)}`), tol)) : short
    rowFlows.set(n, {
      // A recovery row running only on what the held passes left room for is noise: it isn't shown.
      rate: n.recovers && need <= noise ? 0 : need,
      crafts: x,
      fromByproduct,
      byproductSources: draws.map((d) => ({ id: d.from.id, label: d.fed ? `the ${itemName(d.from.item)} target, fed back` : sourceLabel(d.from) })),
      fromRecovery: cleaned(fromRecovery, Math.max(tol, noise)),
      fromBus: drew,
      shortfall: short - drew > tol ? short - drew : 0,
      overflow: cleaned(v(`s:${index.get(n)}`), Math.max(tol, noise)),
      byproductRoutes: n.kind === 'make' ? routes(n, x) : {},
      ...(parts.length && { mix: [{ process: n.process!, crafts: x }, ...parts.map((m) => ({ process: m.process, crafts: m.crafts }))] }),
    })
  }

  // Machines per process on its machine, summed over the rows.
  const totals = new Map<string, { process: Process; crafts: number }>()
  const count = (p: Process, x: number) => {
    const key = runKey(p)
    const t = totals.get(key) ?? { process: p, crafts: 0 }
    t.crafts += x
    totals.set(key, t)
  }
  // A mixed crucible row counts as a group of crucibles per input.
  for (const n of shape.nodes) if (n.kind === 'make') count(n.process!, crafts(n))
  for (const n of mixes.keys()) for (const m of mixed(n)) count(m.process, m.crafts)
  const runs: ProcessRun[] = [...totals].map(([key, { process: p, crafts: x }]) => ({
    key,
    process: p,
    craftsPerMinute: x,
    machines: p.seconds > 0 ? x / craftsPerMachine(p, mods) : 0,
    inputs: p.inputs.map((s) => ({ item: s.item, count: s.count * x })),
    outputs: p.outputs.map((s) => ({ item: s.item, count: s.count * x })),
  }))

  // Per item: bus draws and shortfalls from the rows, surplus whatever's left, so every
  // balance is exact (the solver's own slack values are rounded and would leave visible noise on
  // items with huge counts). Draws a net-surplus target covers are made in the plan: what the
  // sources ahead of it supply counts as made (the ledger shows which), and what nothing can cover
  // as a shortfall.
  const balance = new Map<string, ItemBalance>()
  const of = (item: string) => {
    let b = balance.get(item)
    if (!b) {
      b = { item, target: 0, produced: 0, consumed: 0, fromBus: 0, drawn: 0, deficit: 0, surplus: 0, altar: 0 }
      balance.set(item, b)
    }
    return b
  }
  // What the plan's rows take of a fed-back target's output stays in the plan.
  for (const t of targets) of(t.item).target += t.rate - (t.fedIn ?? 0)
  for (const item of pooled.keys()) {
    of(item).produced += v(`fa:${item}`)
    of(item).deficit += v(`d:g:${item}`)
  }
  for (const r of runs) {
    for (const s of r.outputs) of(s.item).produced += s.count
    for (const s of r.inputs) of(s.item).consumed += s.count
  }
  for (const n of supplies) {
    const f = rowFlows.get(n)!
    const b = of(n.item)
    b.drawn += f.fromBus
    if (!pooled.has(n.item)) b.fromBus += f.fromBus
    b.deficit += f.shortfall
  }
  for (const [name, item] of altared) of(item).altar += cleaned(v(name), RELATIVE_NOISE * Math.max(1, v(name)))
  for (const b of balance.values()) {
    let net = b.produced - b.consumed + b.fromBus + b.deficit - b.target - b.altar
    if (Math.abs(net) <= RELATIVE_NOISE * Math.max(1, b.produced, b.consumed)) net = 0
    b.surplus = Math.max(0, net)
  }

  return {
    status: 'ok',
    targets,
    runs,
    balances: [...balance.values()],
    tree: buildTree(shape.roots, rowFlows, mods),
  }
}
