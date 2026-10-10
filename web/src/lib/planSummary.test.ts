import { describe, expect, it } from 'vitest'
import { MAX_TIER } from './gameData'
import { ledgers } from './ledger'
import { buildingCounts, checkLogistics } from './logistics'
import { moneyLedger } from './money'
import { summarizePlan } from './planSummary'
import { buildCatalog } from './processes'
import { solvePlan } from './solver'
import type { Plan } from './types'
import { modifiers } from './upgrades'

const mods = modifiers({})
const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })

function plan(partial: Partial<Plan>): Plan {
  return { id: 't', name: 't', targets: [], producers: {}, machines: {}, ...partial }
}

describe('plan summaries', () => {
  it('sum up what the planner shows as inputs and outputs', () => {
    const p = plan({ targets: [{ item: 'SteelIngot', rate: 10 }] })
    const result = solvePlan(p, catalog, mods)
    const s = summarizePlan(p, result, mods, MAX_TIER)
    const ledger = ledgers(p, result)
    const money = moneyLedger(p, result, ledger)
    expect(s.error).toBeNull()
    expect(s.started).toBe(true)
    expect(s.inputs.map((l) => l.item).sort()).toEqual(ledger.filter((l) => l.bus > 0).map((l) => l.item).sort())
    // Biggest first.
    expect(s.inputs.map((l) => l.perMinute)).toEqual([...s.inputs.map((l) => l.perMinute)].sort((a, b) => b - a))
    expect(s.outputs[0]).toMatchObject({ item: 'SteelIngot', idle: false })
    expect(s.outputs[0].perMinute).toBeCloseTo(10)
    expect(s.cost).toBeCloseTo(money.cost)
    expect(s.value).toBeCloseTo(money.value)
    const machines = buildingCounts(result.tree, checkLogistics(result.runs, mods)).reduce((t, b) => t + b.count, 0)
    expect(s.machines).toBe(machines)
    expect(s.machines).toBeGreaterThan(0)
  })

  it('leave out what the plan feeds back to itself', () => {
    const made = plan({ targets: [{ item: 'SteelIngot', rate: 10 }] })
    const fuel = summarizePlan(made, solvePlan(made, catalog, mods), mods, MAX_TIER).inputs[0]?.item
    expect(fuel).toBeDefined()
    // A net target of the item, fed back: the plan makes what it takes, so it no longer comes in.
    const p = plan({ targets: [...made.targets, { item: fuel!, rate: 0, unit: 'net', feedback: true }] })
    const s = summarizePlan(p, solvePlan(p, catalog, mods), mods, MAX_TIER)
    expect(s.inputs.some((l) => l.item === fuel)).toBe(false)
    expect(s.outputs.some((l) => l.item === fuel)).toBe(false)
  })

  it('tell a plan without targets from one that could not be solved', () => {
    const empty = plan({ targets: [{ item: '', rate: 10 }] })
    expect(summarizePlan(empty, solvePlan(empty, catalog, mods), mods, MAX_TIER)).toMatchObject({ error: null, started: false })
    const failed = summarizePlan(
      plan({ targets: [{ item: 'SteelIngot', rate: 10 }] }),
      { status: 'error', message: 'boom', targets: [], runs: [], balances: [], tree: [] },
      mods,
      MAX_TIER,
    )
    expect(failed).toMatchObject({ error: 'boom', started: true, inputs: [], outputs: [] })
  })
})
