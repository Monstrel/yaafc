import { craftsPerMachine, itemsPerSlot, onBelt, outputCap } from './machineRate'
import { runKey, type Process } from './processes'
import type { ProcessRun } from './solver'
import type { TreeNode } from './tree'
import type { Modifiers } from './upgrades'

/** One ingredient on a machine's input belts. */
export interface BeltFlow {
  item: string
  /** Items per minute one machine consumes. */
  perMachine: number
  /** Belt slots per minute that takes (coins travel 50 to a slot). */
  slots: number
  /** Belts (input ports) needed for that rate. */
  belts: number
}

export interface LogisticsCheck {
  /** The process on its machine (`runKey`). */
  key: string
  machineName: string
  beltSpeed: number
  beltIn: number
  /** Ingredients at the machine's actual rate (output-belt cap already applied). */
  inputs: BeltFlow[]
  /** Input belts needed (each ingredient on its own belts). */
  inputBeltsNeeded: number
  /** Fraction of that rate the input belts can feed (1 = fine, 0 = can't be fed at all). */
  utilization: number
  /** Machines the plan needs when fully fed. */
  machines: number
  /** Machines needed once input starvation is accounted for. */
  machinesNeeded: number
  /** Some ingredient needs more than one input belt (worth knowing when building). */
  multiBelt: boolean
  /** Items/min the output belts cap this machine at, when that's below its upgraded speed. */
  outputCappedAt: number | null
}

const EPS = 1e-9
const beltsFor = (rate: number, speed: number) => (rate > EPS ? Math.ceil(rate / speed - EPS) : 0)

/**
 * Highest fraction u of the rate where every ingredient gets enough input belts:
 * Σ ceil(u · rate_j / beltSpeed) ≤ input ports. The left side only grows with u, so bisect.
 */
function inputUtilization(rates: number[], ports: number, speed: number): number {
  const fits = (u: number) => rates.reduce((n, r) => n + beltsFor(u * r, speed), 0) <= ports
  if (rates.length > ports) return 0
  if (fits(1)) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/** Belt check for one machine type running a process, independent of how many are built. */
export function checkProcess(p: Process, mods: Modifiers, machines = 0): LogisticsCheck | null {
  const machine = p.machine
  if (!machine || p.seconds <= 0) return null
  const speed = mods.beltSpeed
  const crafts = craftsPerMachine(p, mods)
  const beltIn = machine.ports.beltIn
  const inputs =
    beltIn > 0
      ? p.inputs
          .filter((s) => onBelt(s.item) && s.count > 0)
          .map((s) => {
            const perMachine = s.count * crafts
            const slots = perMachine / itemsPerSlot(s.item, mods)
            return { item: s.item, perMachine, slots, belts: beltsFor(slots, speed) }
          })
      : []
  const utilization = inputs.length ? inputUtilization(inputs.map((f) => f.slots), beltIn, speed) : 1
  const cap = outputCap(p, mods)
  // Output items per minute at the capped rate (for the "capped at" note).
  const solidOut = p.outputs.filter((s) => onBelt(s.item)).reduce((sum, s) => sum + s.count * crafts, 0)
  return {
    key: runKey(p),
    machineName: machine.name,
    beltSpeed: speed,
    beltIn,
    inputs,
    inputBeltsNeeded: inputs.reduce((n, f) => n + f.belts, 0),
    utilization,
    machines,
    machinesNeeded: utilization > 0 ? machines / utilization : Infinity,
    multiBelt: inputs.some((f) => f.belts > 1),
    outputCappedAt: cap < 1 - EPS ? solidOut : null,
  }
}

/**
 * Checks every machine in the plan against conveyor capacity. Output belts never need a warning:
 * machines throttle to what they can emit, which is already in their machine counts. Inputs can
 * starve a machine, though, when its ingredients need more belts than it has input ports.
 */
export function checkLogistics(runs: ProcessRun[], mods: Modifiers): Map<string, LogisticsCheck> {
  const checks = new Map<string, LogisticsCheck>()
  for (const run of runs) {
    const check = checkProcess(run.process, mods, run.machines)
    if (check) checks.set(run.key, check)
  }
  return checks
}

/**
 * Machines a row builds (input belt limits included, as the player builds them) and that rounded
 * up to a whole number; null when its belts can't feed it at all.
 */
export function wholeMachines(p: Process, machines: number, mods: Modifiers): { exact: number; count: number } | null {
  const utilization = checkProcess(p, mods)?.utilization ?? 1
  if (utilization <= 0) return null
  const exact = machines / utilization
  return { exact, count: Math.ceil(exact - 1e-9) }
}

/** Whole machines of one building type a plan builds. */
export interface BuildingCount {
  name: string
  /** Whole machines, input belt limits included. */
  count: number
  /** Whole machines if every one ran at full speed (fewer when belts hold some back). */
  atFullSpeed: number
}

/**
 * Whole machines per building type. Every row of the production tree is its own group of machines
 * in the factory, so each rounds up on its own (as built, input belt limits included) before they're
 * added up: two rows of 0.5 Grinders are two Grinders, not one.
 */
export function buildingCounts(tree: TreeNode[], logistics: Map<string, LogisticsCheck>): BuildingCount[] {
  const counts = new Map<string, BuildingCount>()
  const whole = (x: number) => Math.ceil(x - 1e-9)
  const visit = (n: TreeNode) => {
    const machine = n.run?.process.machine
    if (n.kind === 'produce' && machine && n.machines > 0) {
      const utilization = logistics.get(n.run!.key)?.utilization ?? 1
      const c = counts.get(machine.name) ?? { name: machine.name, count: 0, atFullSpeed: 0 }
      c.count += utilization > 0 ? whole(n.machines / utilization) : Infinity
      c.atFullSpeed += whole(n.machines)
      counts.set(machine.name, c)
    }
    n.children.forEach(visit)
  }
  tree.forEach(visit)
  return [...counts.values()]
}
