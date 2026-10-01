import { HEAT, NUTRIENTS, baseInputKey, realItem, type Stack } from './gameData'
import { solveLP } from './lp'
import { craftsPerMachine } from './machineRate'
import { defaultProducer, type Process, type ProcessCatalog } from './processes'
import { separationsOf } from './separate'
import type { Plan } from './types'
import type { Modifiers } from './upgrades'

export interface ProcessRun {
  process: Process
  craftsPerMinute: number
  machines: number
  inputs: Stack[] // per minute
  outputs: Stack[] // per minute
}

export interface ItemBalance {
  item: string
  producer: string // process id or 'import'
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
  runs: ProcessRun[]
  balances: ItemBalance[]
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

/** Converts machine-count targets to items per minute using each item's chosen producer. */
export function resolveTargets(plan: Plan, catalog: ProcessCatalog, mods: Modifiers): ResolvedTarget[] {
  return plan.targets
    .filter((t) => t.item)
    .map((t) => {
      const p = catalog.byId.get(producerFor(plan, catalog, t.item))
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

export function producerFor(plan: Plan, catalog: ProcessCatalog, item: string): string {
  const choice = plan.producers[item]
  if (choice === 'import') return choice
  const chosen = choice ? catalog.byId.get(choice) : undefined
  if (chosen && (chosen.product === item || chosen.secondary.includes(item))) return choice!
  return defaultProducer(catalog, item)
}

/**
 * Walks from the targets through each item's chosen producer to find the processes involved.
 * Bus items (`@base:X`) have no producer: they're supplied from outside, like purchases.
 */
function walkPlan(plan: Plan, catalog: ProcessCatalog, targets: string[]) {
  const producers = new Map<string, string>()
  const processes = new Map<string, Process>()
  const itemsSeen = new Set<string>()
  const depth = new Map<string, number>()
  const queue = [...targets]
  for (const t of queue) depth.set(t, 0)
  while (queue.length) {
    const item = queue.shift()!
    if (producers.has(item)) continue
    itemsSeen.add(item)
    const producer = realItem(item) !== item ? 'import' : producerFor(plan, catalog, item)
    producers.set(item, producer)
    const found = catalog.byId.get(producer)
    if (!found || processes.has(found.id)) continue
    const p = fromBus(found)
    processes.set(p.id, p)
    for (const s of p.outputs) itemsSeen.add(s.item)
    for (const s of p.inputs) {
      if (!depth.has(s.item)) depth.set(s.item, (depth.get(item) ?? 0) + 1)
      queue.push(s.item)
    }
  }
  return { producers, processes, itemsSeen, depth }
}

/**
 * Drops producer, machine, catalyst and build-separately choices for items and processes no longer in the plan, so
 * an item that's removed and added back starts from its default recipe instead of whatever was
 * last picked for it. Fuel and fertilizer choices are plan-wide settings and always kept.
 * Returns null when there's nothing to drop.
 */
export function pruneChoices(plan: Plan, catalog: ProcessCatalog): Plan | null {
  const { producers, processes } = walkPlan(
    plan,
    catalog,
    plan.targets.filter((t) => t.item).map((t) => t.item),
  )
  const keepItem = (item: string) => item === HEAT || item === NUTRIENTS || producers.has(item)
  const keep = <T>(record: Record<string, T> | undefined, test: (key: string) => boolean) => {
    if (!record) return { record, dropped: false }
    const kept = Object.fromEntries(Object.entries(record).filter(([k]) => test(k)))
    return { record: kept, dropped: Object.keys(kept).length !== Object.keys(record).length }
  }
  const p = keep(plan.producers, keepItem)
  const m = keep(plan.machines, (id) => processes.has(id))
  const c = keep(plan.catalysts, (id) => processes.has(id))
  // "Build separately" only means something for items the plan makes, gathered under items it makes.
  const made = (item: string) => (producers.get(item) ?? 'import') !== 'import'
  const separate = plan.separate && separationsOf(plan.separate).filter((s) => made(s.item) && (!s.anchor || made(s.anchor)))
  const s = separate?.length !== plan.separate?.length
  if (!p.dropped && !m.dropped && !c.dropped && !s) return null
  return { ...plan, producers: p.record!, machines: m.record!, catalysts: c.record, separate }
}

/**
 * Balances the plan as a linear program. Every item gets one constraint:
 *   Σ(outputs − inputs)·crafts + import + deficit − surplus = target
 * Cycles (e.g. a catalyst feeding its own precursors) need no special handling: the LP simply
 * finds crafting rates where each loop item balances, and anything left over shows as surplus.
 */
export function solvePlan(plan: Plan, catalog: ProcessCatalog, mods: Modifiers): PlanResult {
  const resolved = resolveTargets(plan, catalog, mods)
  const targets = new Map<string, number>()
  for (const t of resolved) targets.set(t.item, (targets.get(t.item) ?? 0) + t.rate)

  const { producers, processes, itemsSeen, depth } = walkPlan(plan, catalog, [...targets.keys()])

  const constraints: Record<string, number> = {}
  const variables: Record<string, Record<string, number>> = {}
  for (const item of itemsSeen) {
    constraints[`bal:${item}`] = targets.get(item) ?? 0
    variables[`sur:${item}`] = { [`bal:${item}`]: -1, cost: SURPLUS_COST }
    const producer = producers.get(item)
    if (producer === 'import') variables[`imp:${item}`] = { [`bal:${item}`]: 1, cost: IMPORT_COST }
    else {
      const cost = Math.max(MIN_DEFICIT_COST, DEFICIT_COST * DEFICIT_DEPTH_FACTOR ** (depth.get(item) ?? 0))
      variables[`def:${item}`] = { [`bal:${item}`]: 1, cost }
    }
  }
  for (const p of processes.values()) {
    const coef: Record<string, number> = { cost: CRAFT_COST * Math.max(p.seconds, 1) }
    for (const s of p.outputs) coef[`bal:${s.item}`] = (coef[`bal:${s.item}`] ?? 0) + s.count
    for (const s of p.inputs) coef[`bal:${s.item}`] = (coef[`bal:${s.item}`] ?? 0) - s.count
    variables[`x:${p.id}`] = coef
  }

  // Two passes, so a shortfall is only ever reported when the chosen producers really can't cover
  // it. In one pass, deficits were just expensive: a big enough plan (Sol burns millions of P and
  // tens of thousands of fuel and fertilizer items a minute) cost more than giving up on the target.
  // Pass 1 minimizes the depth-weighted shortfall alone; pass 2 holds it there and minimizes the
  // real costs.
  const phase1 = solveLP({
    equalities: constraints,
    columns: Object.fromEntries(
      Object.entries(variables).map(([name, { cost, ...rows }]) => [name, { ...rows, cost: name.startsWith('def:') ? cost : 0 }]),
    ),
  })
  if (phase1.status !== 'optimal')
    return { status: phase1.status, message: phase1.message, targets: resolved, runs: [], balances: [] }
  let shortfall = 0
  for (const [name, x] of phase1.values) if (name.startsWith('def:')) shortfall += x * variables[name].cost
  // Σ cost·deficit + slack = cap, with a little room for solver tolerance.
  constraints[SHORTFALL_ROW] = shortfall * (1 + 1e-6) + 1e-6
  for (const name of Object.keys(variables))
    if (name.startsWith('def:')) variables[name][SHORTFALL_ROW] = variables[name].cost
  variables[`slack:${SHORTFALL_ROW}`] = { [SHORTFALL_ROW]: 1, cost: 0 }

  const solution = solveLP({ equalities: constraints, columns: variables })
  if (solution.status !== 'optimal')
    return { status: solution.status, message: solution.message, targets: resolved, runs: [], balances: [] }

  const value = solution.values
  const v = (name: string) => {
    const x = value.get(name) ?? 0
    return Math.abs(x) < ZERO ? 0 : x
  }

  const runs: ProcessRun[] = [...processes.values()].map((p) => {
    const crafts = v(`x:${p.id}`)
    return {
      process: p,
      craftsPerMinute: crafts,
      machines: p.seconds > 0 ? crafts / craftsPerMachine(p, mods) : 0,
      inputs: p.inputs.map((s) => ({ item: s.item, count: s.count * crafts })),
      outputs: p.outputs.map((s) => ({ item: s.item, count: s.count * crafts })),
    }
  })

  // Derive import/deficit/surplus from the craft rates so every balance is exact; the solver's
  // own slack values are rounded and would leave visible noise on items with huge counts (heat).
  const balances: ItemBalance[] = [...itemsSeen].map((item) => {
    let produced = 0
    let consumed = 0
    for (const r of runs) {
      for (const s of r.outputs) if (s.item === item) produced += s.count
      for (const s of r.inputs) if (s.item === item) consumed += s.count
    }
    const producer = producers.get(item) ?? 'import'
    const target = targets.get(item) ?? 0
    let missing = target - (produced - consumed)
    if (Math.abs(missing) <= RELATIVE_NOISE * Math.max(1, produced, consumed)) missing = 0
    const shortfall = Math.max(0, missing)
    return {
      item,
      producer,
      target,
      produced,
      consumed,
      imported: producer === 'import' ? shortfall : 0,
      deficit: producer === 'import' ? 0 : shortfall,
      surplus: Math.max(0, -missing),
    }
  })

  return { status: 'ok', targets: resolved, runs, balances }
}
