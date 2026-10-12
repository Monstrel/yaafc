import { describe, expect, it } from 'vitest'
import { HEAT, NUTRIENTS, items } from './gameData'
import { buildCatalog } from './processes'
import { solvePlan } from './solver'
import { modifiers } from './upgrades'
import { plan, expectBalanced } from './engineTestUtils'

describe('solver numerics', () => {
  it.each([
    ['late game', { FactorySpeed: 1, Conveyer: 2, FertilizeEfficiency: 7 }, 'Catalyst2'],
    ['no upgrades', {}, 'BasicFertilizer'],
  ] as const)('never runs machines whose every output is left over — every item, both target units (%s)', (_, levels, fert) => {
    const mods = modifiers(levels)
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: fert })
    const wasted: string[] = []
    for (const unit of ['items', 'machines'] as const)
      for (const target of items.filter((i) => !i.hidden)) {
        const result = solvePlan(
          plan({
            targets: [{ item: target.key, rate: unit === 'items' ? 10 : 1, unit }],
            producers: { [NUTRIENTS]: `fert:${fert}` },
          }),
          catalog,
          mods,
        )
        expect(result.status).toBe('ok')
        const balance = new Map(result.balances.map((b) => [b.item, b]))
        for (const run of result.runs) {
          if (run.craftsPerMinute <= 1e-9) continue
          const allLeftOver = run.outputs.every((s) => {
            const b = balance.get(s.item)
            return !!b && b.surplus > 1e-6 * Math.max(1, b.produced)
          })
          if (allLeftOver) wasted.push(`${target.key} (${unit}): ${run.process.id}`)
        }
      }
    expect(wasted).toEqual([])
  })

  it('never gives up on a producible target because its chain is expensive — Sol with every fuel', () => {
    // Sol's chain burns ~50M P/min: pricing a shortfall below that bill used to report fuel-dependent
    // "can't be met" items (with Wood, Sol itself).
    const mods = modifiers({})
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer' })
    for (const fuel of catalog.byProduct.get(HEAT)!) {
      const result = solvePlan(
        plan({ targets: [{ item: 'Sol', rate: 1, unit: 'machines' }], producers: { [HEAT]: fuel.id } }),
        catalog,
        mods,
      )
      expectBalanced(result)
      expect(result.balances.filter((b) => b.deficit > 0).map((b) => `${fuel.id}: ${b.item}`)).toEqual([])
    }
  })
})
