import type { Stack } from './gameData'
import { checkProcess, wholeMachines } from './logistics'
import { unitScales } from './units'
import { solveLP } from './lp'
import { craftsPerMachine } from './machineRate'
import { runKey, type Process, type ProcessCatalog } from './processes'
import { NO_FLOWS, buildTree, onOverflow, type ByproductRoute, type RowFlows, type TreeNode } from './tree'
import type { Plan } from './types'
import { absorbers, supplyAhead } from './ledger'
import { consumedBy, isTargetRow, unfold, type PlanNode, type PlanShape } from './unfold'
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
  surplus: number
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
const SHORTFALL_ROW = 'shortfall'
// Overflow an overflow target can't use is counted with shortfalls, so it uses all it can, but costs
// less than any shortfall: falling short somewhere never stands in for leaving overflow unused (a
// shortfall in a runaway loop would make it look like it settles).
const UNUSED_OVERFLOW_COST = 1

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
      // An overflow target's rate comes from the solve.
      const rate = t.unit === 'machines' ? amount * (perMachine ?? 0) : consumedBy(t) ? 0 : amount
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

/**
 * Crafts per minute of each row (by id) with the plan's overflow targets taking nothing: ordinary
 * targets of nothing, so the rest of the plan is laid out and solved as it is without them.
 */
function baselineCrafts(
  plan: Plan,
  catalog: ProcessCatalog,
  mods: Modifiers,
  absorbing: Map<string, Absorbing>,
  floors: Map<string, number>,
): Map<string, number> {
  const without = {
    ...plan,
    targets: plan.targets.map((t) => (consumedBy(t) ? { item: t.item, rate: 0 } : t)),
  }
  const crafts = new Map<string, number>()
  const visit = (n: TreeNode) => {
    if (n.run) crafts.set(n.id, n.run.craftsPerMinute)
    n.children.forEach(visit)
  }
  solveRound(without, catalog, mods, absorbing, floors).tree.forEach(visit)
  return crafts
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
    if (!item || !row || !isTargetRow(row.id)) return
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
  // Overflow targets take what the rest of the plan overflows as it is without them: its targets'
  // rows run as they would (running one harder could soak up the overflow into a surplus of its own).
  const held = takerOf.size ? baselineCrafts(plan, catalog, mods, absorbing, floors) : null

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

  const supplies = shape.nodes.filter(isSupply)
  for (const s of supplies) {
    const k = index.get(s)!
    equalities[`b:${k}`] = 0
    // An overflow target's rows of its item get only the overflow taken, and its other rows make no
    // more than it needs. A row making an item an overflow target takes overflows into its pool.
    if (s.kind !== 'overflow' && (!inTaker.has(s) || floors.has(s.id)))
      columns[`s:${k}`] = {
        [`b:${k}`]: -1,
        ...(s.kind === 'make' && takerOf.has(s.item) && { [`o:${s.item}`]: 1 }),
        cost: SURPLUS_COST,
      }
    if (s.kind === 'bus' && pooled.has(s.item)) columns[`i:${k}`] = { [`b:${k}`]: 1, [`g:${s.item}`]: -1, cost: 0 }
    else if (s.kind === 'bus') columns[`i:${k}`] = { [`b:${k}`]: 1, cost: IMPORT_COST }
    else if (s.kind === 'overflow') continue
    else {
      const cost = Math.max(MIN_DEFICIT_COST, DEFICIT_COST * DEFICIT_DEPTH_FACTOR ** s.depth)
      columns[`d:${k}`] = { [`b:${k}`]: 1, cost }
    }
  }
  targets.forEach((t, i) => {
    const row = shape.targetRows[i]
    if (row) equalities[bal(row)] += t.rate
  })
  // Each item's overflow pools (rows add to it as it overflows them) and goes to the rows of the
  // overflow target taking it, sizing that target; what it can't use is priced as a shortfall.
  for (const [item, i] of takerOf) {
    equalities[`o:${item}`] = 0
    for (const leaf of takers.get(i)!) columns[`od:${index.get(leaf)}`] = { [`o:${item}`]: -1, [`b:${index.get(leaf)}`]: 1, cost: 0 }
    columns[`t:${i}`] = { [bal(shape.targetRows[i])]: -1, cost: 0 }
    columns[`d:o:${item}`] = { [`o:${item}`]: -1, cost: UNUSED_OVERFLOW_COST }
  }

  // By-product pools: what one row makes of each side output, shared out to rows of that item.
  const consumers = new Map<string, PlanNode[]>()
  for (const s of supplies) if (s.reuse) consumers.set(s.item, [...(consumers.get(s.item) ?? []), s])
  const flows: { name: string; from: PlanNode; to: PlanNode }[] = []

  // Rows held to their crafts: rounded up, or as they are without the plan's overflow targets.
  const fixedOf = (n: PlanNode) => (!inTaker.has(n) && isTargetRow(rootOf(n).id) ? held?.get(n.id) : undefined)
  const heldToCrafts = (n: PlanNode) => floors.has(n.id) || fixedOf(n) !== undefined
  const sameRun = (n: PlanNode, c: PlanNode) => c.kind === 'make' && c.process!.id === n.process!.id
  // Rows whose by-products can go to rows running something else (see `e:` below).
  const sharing = new Set(
    shape.nodes.filter(
      (n) =>
        n.kind === 'make' &&
        !heldToCrafts(n) &&
        n.process!.outputs.some(
          (o) => o.item !== n.item && (consumers.get(o.item) ?? []).some((c) => (n.reuse || c.reuseChosen) && !sameRun(n, c)),
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
      columns[`ps:${k}:${o.item}`] = { [pool]: -1, ...(takerOf.has(o.item) && { [`o:${o.item}`]: 1 }), cost: SURPLUS_COST }
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
      // A row making its own keeps to itself: its by-products only go where reuse was picked.
      for (const c of consumers.get(o.item) ?? []) {
        if (!n.reuse && !c.reuseChosen) continue
        const name = `f:${k}>${index.get(c)}`
        columns[name] = { [pool]: -1, [`b:${index.get(c)}`]: 1, cost: FLOW_COST * (1 + distance(n, c)) }
        if (extra in equalities && sameRun(n, c)) columns[name][extra] = -1
        flows.push({ name, from: n, to: c })
      }
    }
    ingredients(p).forEach((s, j) => {
      const c = n.children[j]
      if (c) add(col, bal(c), -s.count)
    })
  }

  const fail = (status: 'infeasible' | 'error', message?: string): PlanResult => ({
    status,
    message,
    targets,
    runs: [],
    balances: [],
    tree: buildTree(shape.roots, new Map(), mods),
  })

  // Two passes, so a shortfall is only ever reported when the chosen producers really can't cover
  // it. In one pass, deficits were just expensive: a big enough plan (Sol burns millions of P and
  // tens of thousands of fuel and fertilizer items a minute) cost more than giving up on the target.
  // Pass 1 minimizes the depth-weighted shortfall alone; pass 2 holds it there and minimizes the
  // real costs.
  const isDeficit = (name: string) => name.startsWith('d:')
  const phase1 = solveLP({
    equalities,
    columns: Object.fromEntries(
      Object.entries(columns).map(([name, { cost, ...rows }]) => [name, { ...rows, cost: isDeficit(name) ? cost : 0 }]),
    ),
  })
  if (phase1.status !== 'optimal') return fail(phase1.status, phase1.message)
  let shortfall = 0
  for (const [name, x] of phase1.values) if (isDeficit(name)) shortfall += x * columns[name].cost
  // Σ cost·deficit + slack = cap, with a little room for solver tolerance.
  equalities[SHORTFALL_ROW] = shortfall * (1 + 1e-6) + 1e-6
  for (const name of Object.keys(columns)) if (isDeficit(name)) columns[name][SHORTFALL_ROW] = columns[name].cost
  columns[`slack:${SHORTFALL_ROW}`] = { [SHORTFALL_ROW]: 1, cost: 0 }

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
  const taken = (i: number) => (takers.get(i) ?? []).reduce((t, leaf) => t + v(`od:${index.get(leaf)}`), 0)
  const unused = (item: string) => {
    const x = v(`d:o:${item}`)
    return cleaned(x, RELATIVE_NOISE * Math.max(1, x + taken(takerOf.get(item)!)))
  }
  const runaway = runawayItems(takerOf, takers, inTaker, (item) => unused(item) > 0)
  for (const [i, leaves] of takers) {
    const item = consumedBy(plan.targets[planIndex[i]])!
    const by = takerOf.get(item)
    targets[i].rate = targets[i].made = v(`t:${i}`)
    targets[i].overflow = {
      item,
      uses: leaves.length > 0,
      taken: by === i ? taken(i) : 0,
      unused: by === i ? unused(item) : 0,
      takenBy: by !== undefined && by !== i && leaves.length > 0 ? planIndex[by] : null,
      runaway: by === i && runaway.has(item),
    }
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
  const demand = new Map<PlanNode, number>()
  for (const n of shape.nodes) {
    const s = supplierOf(n)
    demand.set(s, (demand.get(s) ?? 0) + (own.get(n) ?? 0))
  }
  const drawn = new Map<PlanNode, { from: PlanNode; amount: number }[]>()
  const sent = new Map<PlanNode, { to: PlanNode; item: string; amount: number }[]>()
  for (const f of flows) {
    const amount = v(f.name)
    if (amount <= 0) continue
    drawn.set(f.to, [...(drawn.get(f.to) ?? []), { from: f.from, amount }])
    sent.set(f.from, [...(sent.get(f.from) ?? []), { to: f.to, item: f.to.item, amount }])
  }
  /** Where each side output of a row goes, and what's left of it. */
  const routes = (n: PlanNode, x: number) => {
    const k = index.get(n)!
    const out: Record<string, ByproductRoute> = {}
    for (const o of n.process!.outputs) {
      if (o.item === n.item || o.item.startsWith('@')) continue
      const tol = RELATIVE_NOISE * Math.max(1, o.count * x)
      out[o.item] = {
        to: (sent.get(n) ?? [])
          .filter((s) => s.item === o.item && s.amount > tol)
          .sort((a, b) => b.amount - a.amount)
          .map((s) => ({ id: s.to.id, amount: s.amount })),
        overflow: cleaned(v(`ps:${k}:${o.item}`), tol),
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
    const made = n.kind === 'make' ? outputOf(n.process!, n.item) * x : n.kind === 'overflow' ? v(`od:${index.get(n)}`) : 0
    const tol = RELATIVE_NOISE * Math.max(1, need, made)
    const draws = (drawn.get(n) ?? []).filter((d) => d.amount > tol * 1e-2).sort((a, b) => b.amount - a.amount)
    const fromByproduct = draws.reduce((sum, d) => sum + d.amount, 0)
    const missing = need - made - fromByproduct
    const short = missing > tol ? missing : 0
    rowFlows.set(n, {
      rate: need,
      crafts: x,
      fromByproduct,
      byproductSources: draws.map((d) => ({ id: d.from.id, label: d.from.process!.label })),
      fromBus: n.kind === 'bus' ? short : 0,
      shortfall: n.kind === 'bus' ? 0 : short,
      overflow: cleaned(v(`s:${index.get(n)}`), tol),
      byproductRoutes: n.kind === 'make' ? routes(n, x) : {},
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
  for (const n of shape.nodes) if (n.kind === 'make') count(n.process!, crafts(n))
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
      b = { item, target: 0, produced: 0, consumed: 0, fromBus: 0, drawn: 0, deficit: 0, surplus: 0 }
      balance.set(item, b)
    }
    return b
  }
  for (const t of targets) of(t.item).target += t.rate
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
  for (const b of balance.values()) {
    let net = b.produced - b.consumed + b.fromBus + b.deficit - b.target
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
