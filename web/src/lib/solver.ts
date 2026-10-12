import { dispatchTerms } from './dispatch'
import type { Stack } from './gameData'
import { checkProcess, wholeMachines } from './logistics'
import { unitScales } from './units'
import { solveStaged } from './lpModel'
import { craftsPerMachine } from './machineRate'
import type { Process, ProcessCatalog } from './processes'
import { buildTree, onOverflow, type TreeNode } from './tree'
import type { Plan } from './types'
import { absorbers, supplyAhead } from './ledger'
import { consumedBy, suppliedBy, unfold, type PlanShape } from './unfold'
import type { Modifiers } from './upgrades'
import { LEAVING_PASS, PASSES, SHORTFALL_PASS, SPILL_PASS, buildPlanLp, targetRoles, type Absorbing, type Baseline } from './solverModel'
import { Tolerance, readSolution } from './solverResult'

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
  const { takerOf, supplyTaker } = roles
  // Overflow and supply targets take what the rest of the plan overflows or leaves as it is without
  // them: its targets' rows run as they would (running one harder could soak up the overflow or
  // supply into a surplus of its own).
  const held = takerOf.size || supplyTaker.size ? baselineCrafts(plan, catalog, mods, absorbing, floors, room) : null
  const model = buildPlanLp({ plan, catalog, shape, targets, roles, absorbing, floors, held })

  const fail = (status: 'infeasible' | 'error', message?: string): PlanResult => ({
    status,
    message,
    targets,
    runs: [],
    balances: [],
    tree: buildTree(shape.roots, new Map(), mods),
  })

  // Each pass is held with `room`: about 10× the LP's feasibility tolerance (see lp.ts), or later
  // passes can find no solution. What they can still shift within that room is noise.
  const solution = solveStaged(model.m, PASSES, room)
  if (solution.status !== 'optimal') return fail(solution.status, solution.message)
  // Items per minute a held pass's room could still move (flows and recovery below it are noise),
  // and of shortfall the shortfall pass's room could (its weights price them).
  let noise = 0
  for (const pass of [LEAVING_PASS, SPILL_PASS]) noise += solution.held.get(pass)?.room ?? 0
  const shortfall = solution.held.get(SHORTFALL_PASS)
  const tolerance = new Tolerance(noise, shortfall ? shortfall.room / shortfall.minWeight : 0)
  return readSolution({ plan, mods, shape, targets, roles, model, values: solution.values, tolerance })
}
