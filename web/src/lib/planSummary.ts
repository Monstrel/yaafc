import { KNOWLEDGE_ALTAR, altarYield, altarsBuilt } from './altar'
import { machineTier, machinesByKey } from './gameData'
import { ledgers } from './ledger'
import { buildingCounts, checkLogistics, type BuildingCount, type LogisticsCheck } from './logistics'
import { moneyLedger, type MoneyLedger } from './money'
import type { PlanResult } from './solver'
import type { TreeNode } from './tree'
import type { Plan } from './types'
import { unitScales } from './units'
import type { Modifiers } from './upgrades'

/**
 * Whole machines per building type, as built: each tree row rounds up on its own, and so do the
 * Knowledge Altars breaking down each item's overflow (`altar`: the upgrades, when the plan's
 * research tier has them; else null).
 */
export function planBuildings(
  tree: TreeNode[],
  logistics: Map<string, LogisticsCheck>,
  copies: Map<string, number>,
  money: MoneyLedger,
  altar: Modifiers | null,
): BuildingCount[] {
  const counts = buildingCounts(tree, logistics, copies)
  const altars = altar ? money.outputs.reduce((t, o) => t + altarsBuilt(o.item, o.altar, altar), 0) : 0
  if (altars > 0) counts.push({ name: machinesByKey.get(KNOWLEDGE_ALTAR)?.name ?? 'Knowledge Altar', count: altars, atFullSpeed: altars })
  return counts
}

/** The upgrades, when the research tier has the Knowledge Altar; else null. */
export const altarMods = (mods: Modifiers, tier: number): Modifiers | null => (machineTier(KNOWLEDGE_ALTAR) <= tier ? mods : null)

/** An item coming in or going out, per minute. */
export interface SummaryLine {
  item: string
  perMinute: number
}

/** A plan at a glance: what comes in, what goes out, and how big it is, as its Inputs and Outputs show them. */
export interface PlanSummary {
  /** Why the plan couldn't be solved; null when it was. */
  error: string | null
  /** Whether it has a target with an item picked: without one it makes nothing yet. */
  started: boolean
  /** Items taken in, biggest first (coins aside: they're `cost`). */
  inputs: SummaryLine[]
  /** Copper per minute of coins taken in, after what the plan's own coins cover. */
  cost: number
  /** Items going out, targets first, then overflow. */
  outputs: (SummaryLine & { idle: boolean })[]
  /** What the outputs are worth at base shop prices, copper per minute. */
  value: number
  /** EXP per minute from overflow broken down at Knowledge Altars. */
  exp: number
  /** Whole machines built. */
  machines: number
  /** Items the plan can't supply (a loop that uses more than it makes, or a capped input). */
  short: string[]
  /** Overflow targets whose loop runs away. */
  runaway: number
}

/** What a plan takes in and puts out, from its solve. */
export function summarizePlan(plan: Plan, result: PlanResult, mods: Modifiers, tier: number): PlanSummary {
  const started = plan.targets.some((t) => t.item)
  if (result.status !== 'ok')
    return { error: result.message ?? 'Could not solve', started, inputs: [], cost: 0, outputs: [], value: 0, exp: 0, machines: 0, short: [], runaway: 0 }
  const ledger = ledgers(plan, result)
  const money = moneyLedger(plan, result, ledger)
  const logistics = checkLogistics(result.runs, mods)
  const units = unitScales(result.tree, plan.units, (n) => logistics.get(n.run!.key)?.utilization ?? 1)
  const altar = altarMods(mods, tier)
  const machines = planBuildings(result.tree, logistics, units.copies, money, altar).reduce((t, b) => t + b.count, 0)
  return {
    error: null,
    started,
    inputs: ledger
      .filter((l) => l.bus > 0)
      .map((l) => ({ item: l.item, perMinute: l.bus }))
      .sort((a, b) => b.perMinute - a.perMinute),
    cost: money.cost,
    outputs: money.outputs
      .filter((o) => o.toBus > 0)
      .map((o) => ({
        item: o.item,
        perMinute: o.toBus,
        // Overflow nothing uses backs up the machines making it (the planner flags it the same way).
        idle: o.sources.some((s) => s.target === null && !(s.fedBack && o.feeds.length > 0) && sourceLeft(s) > 1e-9 * s.amount),
      })),
    value: money.value,
    exp: altar ? money.outputs.reduce((t, o) => t + o.altar * (altarYield(o.item, altar)?.exp ?? 0), 0) : 0,
    machines,
    short: [
      ...new Set([...result.balances.filter((b) => b.deficit > 0).map((b) => b.item), ...ledger.filter((l) => l.short > 0).map((l) => l.item)]),
    ],
    runaway: result.targets.filter((t) => t.overflow?.runaway).length,
  }
}

/** What's left of an output source after what the plan feeds back, overflow targets and Knowledge Altars take. */
function sourceLeft(s: MoneyLedger['outputs'][number]['sources'][number]): number {
  const fed = Object.values(s.used).reduce((t, n) => t + (n ?? 0), 0)
  return s.amount - fed - s.taken.reduce((t, x) => t + x.amount, 0) - s.altar
}
