import { dispatchTerms } from './dispatch'
import { HEAT, coinValue, itemName, type Stack } from './gameData'
import { checkProcess, wholeMachines } from './logistics'
import { unitScales } from './units'
import { solveStaged } from './lpModel'
import { craftsPerMachine } from './machineRate'
import { runKey, type Process, type ProcessCatalog } from './processes'
import { NO_FLOWS, buildTree, onOverflow, type ByproductRoute, type RowFlows, type TreeNode } from './tree'
import type { Plan } from './types'
import { absorbers, supplyAhead } from './ledger'
import { consumedBy, suppliedBy, unfold, type PlanNode, type PlanShape } from './unfold'
import type { Modifiers } from './upgrades'
import {
  LEAVING_PASS,
  PASSES,
  SHORTFALL_PASS,
  SPILL_PASS,
  buildPlanLp,
  ingredients,
  isSupply,
  outputOf,
  rootOf,
  supplierOf,
  targetRoles,
  type Absorbing,
  type Baseline,
} from './solverModel'

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
  /** Something the solve couldn't do, though it solved (rounding rows up that wouldn't all round). */
  notice?: string
  targets: ResolvedTarget[]
  /** Machines per process (on its machine), summed over the tree's rows. */
  runs: ProcessRun[]
  balances: ItemBalance[]
  tree: TreeNode[]
  /**
   * Items per minute the held passes left the solver room to shift (see `solveRound`): flows and
   * amounts at or below it are noise, not part of the plan.
   */
  noise?: number
}

const ZERO = 1e-12
const RELATIVE_NOISE = 1e-7
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
      // An overflow or supply target's rate comes from the solve; a dispatch target's from its contract.
      const rate =
        t.unit === 'machines'
          ? amount * (perMachine ?? 0)
          : t.unit === 'dispatch'
            ? (dispatchTerms(t.item, mods)?.rate ?? amount)
            : consumedBy(t) || suppliedBy(t)
              ? 0
              : amount
      return {
        item: t.item,
        rate,
        made: rate,
        perMachine,
        machineName: perMachine !== null ? (p?.machine?.name ?? null) : null,
      }
    })
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
  // A priority pass whose optimum is itself at the solver's noise floor (a millionth of an item,
  // weighed up to 10⁶) can leave the next pass no solution within the usual room: such a plan is
  // solved again holding the passes with 100× more.
  const first = solveRounded(plan, catalog, mods, 1e-8)
  if (first.result.status !== 'infeasible' && !first.failed) return first.result
  const again = solveRounded(plan, catalog, mods, 1e-6)
  return again.result.status === 'ok' && !again.failed ? again.result : first.result.status === 'ok' ? first.result : again.result
}

const UNSETTLED_ROUNDING =
  'Some rows rounded up to whole machines still use part of one: rounding them up kept growing the rows below them.'
const FAILED_ROUNDING =
  "Not every row rounded up to whole machines could be: the plan has no solution with all of them rounded up, so some still use part of one."

/**
 * Solves the plan (see `solvePlan`), holding each priority pass with `room` (see `solveRound`).
 * When rounding can't finish, the last solve that worked comes back with a notice saying so
 * (`failed`: a solve with more rows rounded up had no solution).
 */
function solveRounded(plan: Plan, catalog: ProcessCatalog, mods: Modifiers, room: number): { result: PlanResult; failed?: boolean } {
  const rounded = new Set(plan.roundUp ?? [])
  // A target of a number of machines runs just those: its row isn't rounded (see `machineCrafts`).
  plan.targets.filter((t) => t.item).forEach((t, i) => t.unit === 'machines' && rounded.delete(`${i}/${t.item}`))
  const floors = new Map<string, number>()
  const utilization = (n: TreeNode) => checkProcess(n.run!.process, mods)?.utilization ?? 1
  /** Higher floors for rounded rows still using part of a machine (none once all run whole ones). */
  const raises = (result: PlanResult) => {
    const out = new Map<string, number>()
    const { copies } = unitScales(result.tree, plan.units, utilization)
    const visit = (n: TreeNode) => {
      const p = n.run?.process
      // Rows running on overflow can't run faster than it comes: their whole machines run underfed.
      if (rounded.has(n.id) && n.kind === 'produce' && p?.machine && p.seconds > 0 && !onOverflow(n)) {
        const built = wholeMachines(p, n.machines / (copies.get(n.id) ?? 1), mods)
        if (built !== null && built.count > built.exact + 1e-9) out.set(n.id, (built.count / built.exact) * n.run!.craftsPerMinute)
      }
      n.children.forEach(visit)
    }
    result.tree.forEach(visit)
    return out
  }
  let result = solveFed(plan, catalog, mods, floors, room)
  for (let round = 0; rounded.size && result.status === 'ok'; round++) {
    const raised = raises(result)
    if (!raised.size) break
    if (round === MAX_ROUNDING_ROUNDS) return { result: { ...result, notice: UNSETTLED_ROUNDING } }
    for (const [id, floor] of raised) floors.set(id, floor)
    const next = solveFed(plan, catalog, mods, floors, room)
    if (next.status !== 'ok') return { result: { ...result, notice: FAILED_ROUNDING }, failed: true }
    result = next
  }
  return { result }
}

/**
 * Solves the plan with rows held to at least `floors` crafts per minute (by row id). A net-surplus
 * target that's fed back makes the plan cover its own use of its item: its row grows to make what
 * the plan's rows would take of it from the bus, less what the sources ahead of it (overflow, then
 * fed-back targets in order) supply, and still delivers its rate. Overflow depends on the solution,
 * so the solve repeats until what those sources supply settles.
 */
function solveFed(plan: Plan, catalog: ProcessCatalog, mods: Modifiers, floors: Map<string, number>, room: number): PlanResult {
  const found = absorbers(plan)
  if (!found.size) return solveRound(plan, catalog, mods, new Map(), floors, { room })
  const filtered = plan.targets.map((t, i) => (t.item ? plan.targets.slice(0, i).filter((x) => x.item).length : -1))
  const absorbing = new Map<string, Absorbing>()
  for (const [item, target] of found) absorbing.set(item, { target: filtered[target], ahead: 0 })
  let result = solveRound(plan, catalog, mods, absorbing, floors, { room })
  for (let round = 1; round < MAX_FEEDBACK_ROUNDS && result.status === 'ok'; round++) {
    const ahead = supplyAhead(plan, result)
    let settled = true
    for (const [item, a] of absorbing) {
      const next = ahead.get(item) ?? 0
      if (Math.abs(next - a.ahead) > 1e-9 * Math.max(1, next)) settled = false
      a.ahead = next
    }
    if (settled) break
    result = solveRound(plan, catalog, mods, absorbing, floors, { room })
  }
  return result
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
  room: number,
): Baseline {
  const crafts = new Map<string, number>()
  const overflow = new Map<string, number>()
  const visit = (n: TreeNode) => {
    if (n.run) crafts.set(n.id, n.run.craftsPerMinute)
    overflow.set(n.id, n.overflow)
    n.children.forEach(visit)
  }
  const result = solveRound(plan, catalog, mods, absorbing, floors, { sizing: false, room })
  result.tree.forEach(visit)
  return { crafts, overflow, surplus: new Map(result.balances.map((b) => [b.item, b.surplus])) }
}

/**
 * What a row whose machines output something is called where that output goes: its recipe, or the
 * item it makes when it runs a recipe for another of its outputs (Athanors making Crude Silver
 * Powder run the Silver Powder recipe: the Silver Powder they leave over isn't "from Silver Powder").
 */
const sourceLabel = (n: PlanNode) => (n.process!.product === n.item ? n.process!.label : itemName(n.item))

/** A solved amount, with solver noise below `tol` dropped. */
const cleaned = (x: number, tol: number) => (x > tol ? x : 0)

/** Solves the plan once as it's laid out (see `buildPlanLp` for the model, `PASSES` for how). */
function solveRound(
  plan: Plan,
  catalog: ProcessCatalog,
  mods: Modifiers,
  absorbing: Map<string, Absorbing>,
  floors: Map<string, number>,
  {
    sizing = true,
    room,
  }: {
    /** Overflow and supply targets take what they can; else they take nothing (see `baselineCrafts`). */
    sizing?: boolean
    /** Room each priority pass is held with, relative to what it reached and absolute. */
    room: number
  },
): PlanResult {
  const shape = unfold(plan, catalog)
  const targets = resolveTargets(plan, shape, mods)
  const roles = targetRoles(plan, shape, targets, mods, sizing)
  const { planIndex, takers, inTaker, takerOf, supplyRows, supplyTaker, machineCrafts } = roles
  // Overflow and supply targets take what the rest of the plan overflows or leaves as it is without
  // them: its targets' rows run as they would (running one harder could soak up the overflow or
  // supply into a surplus of its own).
  const held = takerOf.size || supplyTaker.size ? baselineCrafts(plan, catalog, mods, absorbing, floors, room) : null
  const { m, index, supplies, pooled, capped, flows, fedFrom, mixes, altared } = buildPlanLp({
    plan,
    catalog,
    shape,
    targets,
    roles,
    absorbing,
    floors,
    held,
  })

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
  // Each pass is held with `room`: about 10× the LP's feasibility tolerance (see lp.ts), or later
  // passes can find no solution. What they can still shift within that room is noise.
  const solution = solveStaged(m, PASSES, room)
  if (solution.status !== 'optimal') return fail(solution.status, solution.message)
  // Items per minute a held pass's room could still move: flows and recovery below it are noise.
  let noise = 0
  for (const pass of [LEAVING_PASS, SPILL_PASS]) noise += solution.held.get(pass)?.room ?? 0
  // Items per minute of shortfall the shortfall pass's room could still move (its weights price them).
  const shortfall = solution.held.get(SHORTFALL_PASS)
  const shortNoise = shortfall ? shortfall.room / shortfall.minWeight : 0
  const v = (name: string) => {
    const x = solution.values.get(name) ?? 0
    // Every column is at least 0: below that is the solver's tolerance.
    return x < ZERO ? 0 : x
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
  // What the plan's rows take of each fed-back target's output: no more than the held passes left
  // room for is noise, as on the rows taking it.
  for (const [i, names] of fedFrom) {
    const x = names.reduce((t, name) => t + v(name), 0)
    targets[i].fedIn = cleaned(x, Math.max(RELATIVE_NOISE * Math.max(1, x), noise))
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
    // A row other rows' leftovers cover (as they come or recovered), making only what the held passes
    // left room for, stands idle.
    const idle = !parts.length && (fromByproduct > 0 || fromRecovery > noise) && made <= noise
    rowFlows.set(n, {
      // A recovery row running only on what the held passes left room for is noise: it isn't shown.
      rate: n.recovers && need <= noise ? 0 : need,
      crafts: idle ? 0 : x,
      fromByproduct,
      byproductSources: draws.map((d) => ({ id: d.from.id, label: d.fed ? `the ${itemName(d.from.item)} target, fed back` : sourceLabel(d.from) })),
      fromRecovery: cleaned(fromRecovery, Math.max(tol, noise)),
      fromBus: drew,
      // A shortfall no more than the shortfall pass's room could move is noise.
      shortfall: short - drew > tol + shortNoise ? short - drew : 0,
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
  // Machines run only for the rows the tree shows, as it shows them: rows it leaves out (recovering
  // only what the held passes left room for, or under a row other rows' leftovers cover) run none.
  const tree = buildTree(shape.roots, rowFlows, mods)
  const shown = new Set<string>()
  const mark = (t: TreeNode) => {
    shown.add(t.id)
    t.children.forEach(mark)
  }
  tree.forEach(mark)
  // A mixed crucible row counts as a group of crucibles per input.
  for (const n of shape.nodes) if (n.kind === 'make' && shown.has(n.id)) count(n.process!, rowFlows.get(n)?.crafts ?? crafts(n))
  for (const n of mixes.keys()) if (shown.has(n.id)) for (const m of mixed(n)) count(m.process, m.crafts)
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
    // What the held passes left room for is noise too, as on the rows (coins aside: real amounts of
    // them can be that small).
    const room = coinValue(b.item) === null ? noise + shortNoise : 0
    if (Math.abs(net) <= Math.max(RELATIVE_NOISE * Math.max(1, b.produced, b.consumed), room)) net = 0
    b.surplus = Math.max(0, net)
  }

  return {
    status: 'ok',
    targets,
    runs,
    balances: [...balance.values()],
    tree,
    noise,
  }
}
