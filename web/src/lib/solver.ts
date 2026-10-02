import { HEAT, NUTRIENTS, baseInputKey, realItem, type Stack } from './gameData'
import { solveLP } from './lp'
import { craftsPerMachine } from './machineRate'
import { runKey, type Process, type ProcessCatalog } from './processes'
import { NO_FLOWS, buildTree, type ByproductRoute, type RowFlows, type TreeNode } from './tree'
import type { Plan } from './types'
import { planProducer, unfold, type PlanNode, type PlanShape } from './unfold'
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
  imported: number
  /** Shortfall the chosen producers can't cover (e.g. a loop that doesn't sustain itself). */
  deficit: number
  surplus: number
}

/** A target converted to items per minute. */
export interface ResolvedTarget {
  item: string
  rate: number
  /** Items per minute one of the chosen producer's machines makes, or null if bought/not made by a machine. */
  perMachine: number | null
  machineName: string | null
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

/**
 * Fuel and fertilizer come off the factory bus: their processes draw from a separate pool
 * (`@base:X`) so the plan's own output of X never changes how much gets built. Feeding the plan's
 * output back is a reporting step (see baseInputs.ts), not part of the solve.
 */
function fromBus(p: Process): Process {
  if (p.kind !== 'fuel' && p.kind !== 'fertilizer') return p
  return { ...p, inputs: p.inputs.map((s) => ({ ...s, item: baseInputKey(s.item) })) }
}

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
      return {
        item: t.item,
        rate: t.unit === 'machines' ? amount * (perMachine ?? 0) : amount,
        perMachine,
        machineName: perMachine !== null ? (p?.machine?.name ?? null) : null,
      }
    })
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

/** Ingredients a row's process takes from the rows below it, in the order of its children. */
const ingredients = (p: Process) => p.inputs.filter((s) => s.item !== HEAT && s.item !== NUTRIENTS)
const outputOf = (p: Process, item: string) => p.outputs.find((s) => s.item === item)?.count ?? 0

/**
 * Balances the plan as a linear program over the rows of the production tree. Each row's machines
 * feed only the row above them, as built in the factory:
 *   (row's output) + (by-products it takes) + import + deficit − surplus = (what the rows above it use)
 * A loop row adds its use to the row it loops back to, a separate build to the row gathering it.
 * By-products are the one exception: each row's side outputs can feed any row of their item,
 * the nearest first, and what's left over is surplus. Heat and nutrients are plan-wide: fuel and
 * fertilizer come off the bus for every machine.
 */
export function solvePlan(plan: Plan, catalog: ProcessCatalog, mods: Modifiers): PlanResult {
  const shape = unfold(plan, catalog)
  const targets = resolveTargets(plan, shape, mods)
  const index = new Map(shape.nodes.map((n, k) => [n, k]))
  const bal = (n: PlanNode) => `b:${index.get(supplierOf(n))}`

  const equalities: Record<string, number> = {}
  const columns: Record<string, Record<string, number>> = {}
  const add = (col: Record<string, number>, row: string, v: number) => {
    if (v) col[row] = (col[row] ?? 0) + v
  }

  const supplies = shape.nodes.filter(isSupply)
  for (const s of supplies) {
    const k = index.get(s)!
    equalities[`b:${k}`] = 0
    columns[`s:${k}`] = { [`b:${k}`]: -1, cost: SURPLUS_COST }
    if (s.kind === 'import' || s.kind === 'bus') columns[`i:${k}`] = { [`b:${k}`]: 1, cost: IMPORT_COST }
    else {
      const cost = Math.max(MIN_DEFICIT_COST, DEFICIT_COST * DEFICIT_DEPTH_FACTOR ** s.depth)
      columns[`d:${k}`] = { [`b:${k}`]: 1, cost }
    }
  }
  targets.forEach((t, i) => {
    const row = shape.targetRows[i]
    if (row) equalities[bal(row)] += t.rate
  })

  // Plan-wide heat and nutrients, supplied by the preferred fuel and fertilizer from the bus.
  const globals = new Map<string, Process | null>()
  const global = (item: string) => {
    if (globals.has(item)) return
    const p = realItem(item) !== item ? undefined : catalog.byId.get(planProducer(plan, catalog, item))
    const process = p ? fromBus(p) : null
    globals.set(item, process)
    equalities[`g:${item}`] = 0
    columns[`gs:${item}`] = { [`g:${item}`]: -1, cost: SURPLUS_COST }
    if (process) columns[`d:g:${item}`] = { [`g:${item}`]: 1, cost: MIN_DEFICIT_COST }
    else columns[`gi:${item}`] = { [`g:${item}`]: 1, cost: IMPORT_COST }
    if (!process) return
    const col: Record<string, number> = { cost: CRAFT_COST * Math.max(process.seconds, 1) }
    columns[`gx:${item}`] = col
    for (const s of process.outputs) add(col, `g:${s.item}`, s.count)
    for (const s of process.inputs) {
      global(s.item)
      add(col, `g:${s.item}`, -s.count)
    }
  }

  // By-product pools: what one row makes of each side output, shared out to rows of that item.
  const consumers = new Map<string, PlanNode[]>()
  for (const s of supplies)
    if (s.kind !== 'bus') consumers.set(s.item, [...(consumers.get(s.item) ?? []), s])
  const flows: { name: string; from: PlanNode; to: PlanNode }[] = []

  for (const n of shape.nodes) {
    if (n.kind !== 'make') continue
    const p = n.process!
    const k = index.get(n)!
    const col: Record<string, number> = {
      cost: CRAFT_COST * Math.max(p.seconds, 1) * (p.product === n.item ? 1 : SIDE_RUN_FACTOR),
    }
    columns[`x:${k}`] = col
    add(col, `b:${k}`, outputOf(p, n.item))
    for (const o of p.outputs) {
      if (o.item === n.item) continue
      if (o.item.startsWith('@')) {
        global(o.item)
        add(col, `g:${o.item}`, o.count)
        continue
      }
      const pool = `p:${k}:${o.item}`
      equalities[pool] = 0
      add(col, pool, o.count)
      columns[`ps:${k}:${o.item}`] = { [pool]: -1, cost: SURPLUS_COST }
      for (const c of consumers.get(o.item) ?? []) {
        const name = `f:${k}>${index.get(c)}`
        columns[name] = { [pool]: -1, [`b:${index.get(c)}`]: 1, cost: FLOW_COST * (1 + distance(n, c)) }
        flows.push({ name, from: n, to: c })
      }
    }
    for (const s of p.inputs)
      if (s.item === HEAT || s.item === NUTRIENTS) {
        global(s.item)
        add(col, `g:${s.item}`, -s.count)
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
  const own = new Map<PlanNode, number>()
  targets.forEach((t, i) => {
    const row = shape.targetRows[i]
    if (row) own.set(row, (own.get(row) ?? 0) + t.rate)
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
    const made = n.kind === 'make' ? outputOf(n.process!, n.item) * x : 0
    const tol = RELATIVE_NOISE * Math.max(1, need, made)
    const draws = (drawn.get(n) ?? []).filter((d) => d.amount > tol * 1e-2).sort((a, b) => b.amount - a.amount)
    const fromByproduct = draws.reduce((sum, d) => sum + d.amount, 0)
    const missing = need - made - fromByproduct
    const short = missing > tol ? missing : 0
    const bought = n.kind === 'import' || n.kind === 'bus'
    rowFlows.set(n, {
      rate: need,
      crafts: x,
      fromByproduct,
      byproductSources: draws.map((d) => ({ id: d.from.id, label: d.from.process!.label })),
      purchased: bought ? short : 0,
      shortfall: bought ? 0 : short,
      overflow: cleaned(v(`s:${index.get(n)}`), tol),
      byproductRoutes: n.kind === 'make' ? routes(n, x) : {},
    })
  }

  // Machines per process on its machine, summed over the rows, plus the plan-wide fuel and fertilizer.
  const totals = new Map<string, { process: Process; crafts: number }>()
  const count = (p: Process, x: number) => {
    const key = runKey(p)
    const t = totals.get(key) ?? { process: p, crafts: 0 }
    t.crafts += x
    totals.set(key, t)
  }
  for (const n of shape.nodes) if (n.kind === 'make') count(n.process!, crafts(n))
  for (const [item, p] of globals) if (p) count(p, v(`gx:${item}`))
  const runs: ProcessRun[] = [...totals].map(([key, { process: p, crafts: x }]) => ({
    key,
    process: p,
    craftsPerMinute: x,
    machines: p.seconds > 0 ? x / craftsPerMachine(p, mods) : 0,
    inputs: p.inputs.map((s) => ({ item: s.item, count: s.count * x })),
    outputs: p.outputs.map((s) => ({ item: s.item, count: s.count * x })),
  }))

  // Per item: imports and shortfalls from the rows, surplus whatever's left, so every balance is
  // exact. Plan-wide items (heat, nutrients, the bus) balance from the craft rates alone; the
  // solver's own slack values are rounded and would leave visible noise on items with huge counts.
  const balance = new Map<string, ItemBalance>()
  const of = (item: string) => {
    let b = balance.get(item)
    if (!b) {
      b = { item, target: 0, produced: 0, consumed: 0, imported: 0, deficit: 0, surplus: 0 }
      balance.set(item, b)
    }
    return b
  }
  for (const t of targets) of(t.item).target += t.rate
  for (const r of runs) {
    for (const s of r.outputs) of(s.item).produced += s.count
    for (const s of r.inputs) of(s.item).consumed += s.count
  }
  for (const n of supplies) {
    const f = rowFlows.get(n)!
    const b = of(n.item)
    b.imported += f.purchased
    b.deficit += f.shortfall
  }
  for (const b of balance.values()) {
    let net = b.produced - b.consumed + b.imported + b.deficit - b.target
    if (Math.abs(net) <= RELATIVE_NOISE * Math.max(1, b.produced, b.consumed)) net = 0
    if (globals.has(b.item)) {
      const missing = Math.max(0, -net)
      if (globals.get(b.item)) b.deficit += missing
      else b.imported += missing
    }
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
