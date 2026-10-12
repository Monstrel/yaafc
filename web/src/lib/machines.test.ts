import { describe, expect, it } from 'vitest'
import { altarYield, altarsFor } from './altar'
import { findRecipes } from './cauldron'
import { dispatchTerms } from './dispatch'
import {
  HEAT,
  MONEY,
  NUTRIENTS,
  cauldronIngredients,
  dispatch,
  heightMultiplier,
  itemsByKey,
  upgrades,
} from './gameData'
import {
  buildCatalog,
  defaultProducer,
  defaultCoin,
  paradoxSeconds,
  processTitle,
  type Process,
} from './processes'
import { ledgers } from './ledger'
import { moneyLedger } from './money'
import { checkLogistics, checkProcess } from './logistics'
import { craftsPerMachine } from './machineRate'
import { solvePlan, type PlanResult } from './solver'
import { type TreeNode } from './tree'
import {
  chooseProducer,
  moveTarget,
  pruneChoices,
  keepDefaultInPlan,
  rememberChanges,
  rememberSetup,
  ownPicks,
  setPlanDefault,
  rowsById,
  setMixedFeed,
  setRowHeight,
  setRowStack,
} from './choices'
import { sanitizeMyDefaults, sanitizePlans } from './sanitize'
import { buildingNameFor, itemNameFor, noun } from './plural'
import { legacyProgress, withoutLegacyProgress } from './store'
import type { Plan, SavedRecipe } from './types'
import { PLANNER_UPGRADES, maxLevel, modifiers, upgradeLevel } from './upgrades'
import { round1, plan, expectBalanced } from './engineTestUtils'

describe('purchasing portal prices', () => {
  it('converts stock cost to copper per item (bulk raw materials are priced per bundle)', () => {
    expect(itemsByKey.get('Wood')!.buyPrice).toBe(200) // one log → 200 planks
    expect(itemsByKey.get('IronOre')!.buyPrice).toBe(1200) // one ore → 100 iron ingots
    expect(itemsByKey.get('LavenderSeed')!.buyPrice).toBe(16000) // 16 silver each
    expect(itemsByKey.get('WorldTreeSeed')!.buyPrice).toBe(5_000_000) // 50 gold each
    expect(itemsByKey.get('Catalyst2')!.buyPrice).toBeNull()
  })
})

describe('multi-output machines', () => {
  const mods = modifiers({})
  // Gentian nurseries grow Gentian and Gentian Nectar together.
  const recipe = findRecipes('Vitae', 'normal', cauldronIngredients, 20000).find(
    (r) => r.inputs.includes('Gentian') && r.inputs.includes('GentianNectar'),
  )!
  const saved: SavedRecipe = { id: 'v', mode: 'normal', inputs: recipe.inputs, output: 'Vitae', createdAt: 0 }
  const catalog = buildCatalog({ saved: [saved], machines: {}, mods, fertilizer: 'BasicFertilizer' })
  const targets = [{ item: 'Vitae', rate: 15 }]
  const result = solvePlan(plan({ targets, producers: { Vitae: 'cauldron:v' } }), catalog, mods)
  const [root] = result.tree
  const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]

  it('offers no machine without belts or pipes (the Seed Plot is worked by hand)', () => {
    const all = [...catalog.byId.values()]
    expect(all.some((p) => p.machine?.key === 'SeedPlot' || p.machineOptions.some((m) => m.key === 'SeedPlot'))).toBe(false)
    expect(catalog.byProduct.get('Gentian')!.map((p) => p.id)).toContain('nursery:GentianSeed')
  })

  it('offers the nursery as the producer of its side product', () => {
    expect(catalog.byProduct.get('GentianNectar')!.some((p) => p.id === 'nursery:GentianSeed')).toBe(true)
    expectBalanced(result)
    expect(result.balances.find((b) => b.item === 'GentianNectar')!.fromBus).toBe(0)
  })

  it('shows the side product as covered by the by-product, counting nursery machines once', () => {
    const nectar = all(root).find((n) => n.item === 'GentianNectar')!
    expect(nectar.kind).toBe('byproduct')
    expect(nectar.fromByproduct).toBeCloseTo(nectar.rate)
    const nurseryRun = result.runs.find((r) => r.process.id === 'nursery:GentianSeed')!
    const treeNursery = all(root)
      .filter((n) => n.run?.process.id === 'nursery:GentianSeed')
      .reduce((sum, n) => sum + n.machines, 0)
    expect(treeNursery).toBeCloseTo(nurseryRun.machines)
  })
})

describe('bundle items', () => {
  const catalog = buildCatalog({ saved: [], machines: {}, mods: modifiers({}), fertilizer: null })
  it('counts bundle recipes in whole items (Jupiter = 300 fractions)', () => {
    const jupiter = catalog.byId.get('recipe:Jupiter')!
    expect(jupiter.seconds).toBe(600)
    expect(Object.fromEntries(jupiter.inputs.map((s) => [s.item, s.count]))).toEqual({ WoodBoard: 1200, WoodGear: 1800, WoodPulley: 600 })
    expect(jupiter.outputs).toEqual([{ item: 'Jupiter', count: 1 }])
    const board = catalog.byId.get('recipe:WoodBoard')!
    expect(board.inputs).toEqual([{ item: 'Wood', count: 1 }])
    expect(board.outputs).toEqual([{ item: 'WoodBoard', count: 200 }])
  })
})

describe('conveyor logistics', () => {
  const jupiterCheck = (levels: Record<string, number>) => {
    const m = modifiers(levels)
    const catalog = buildCatalog({ saved: [], machines: {}, mods: m, fertilizer: null })
    const result = solvePlan(plan({ targets: [{ item: 'Jupiter', rate: 1, unit: 'machines' }] }), catalog, m)
    return checkLogistics(result.runs, m).get('recipe:Jupiter')!
  }

  it('Jupiter fills all 6 Shaper inputs at base speed: planks ×2, gears ×3, pulleys ×1', () => {
    const c = jupiterCheck({})
    expect(c.beltIn).toBe(6)
    expect(Object.fromEntries(c.inputs.map((f) => [f.item, f.belts]))).toEqual({ WoodBoard: 2, WoodGear: 3, WoodPulley: 1 })
    expect(c.utilization).toBe(1)
    expect(c.multiBelt).toBe(true)
  })

  it('faster machines outrun the belts and need more machines', () => {
    const c = jupiterCheck({ FactorySpeed: 1 }) // 1.25× → 150/225/75 per min needs 9 belts
    expect(c.inputBeltsNeeded).toBe(9)
    expect(c.utilization).toBeCloseTo(0.8)
    expect(c.machinesNeeded).toBeCloseTo(c.machines / 0.8)
  })

  it('Logistics Efficiency restores full speed', () => {
    const c = jupiterCheck({ FactorySpeed: 1, Conveyer: 1 }) // 75/min belts
    expect(c.beltSpeed).toBe(75)
    expect(c.utilization).toBe(1)
  })
})

describe('output belts cap machines (observed in game)', () => {
  it('a Redcurrant nursery on Fertile Catalyst outputs exactly one belt', () => {
    for (const [level, belt] of [[1, 75], [2, 90]] as const) {
      const m = modifiers({ FactorySpeed: 1, Conveyer: level, FertilizeEfficiency: 7 })
      const catalog = buildCatalog({ saved: [], machines: {}, mods: m, fertilizer: 'Catalyst2' })
      const result = solvePlan(
        plan({ targets: [{ item: 'Redcurrant', rate: 1, unit: 'machines' }], producers: { [NUTRIENTS]: 'fert:Catalyst2' } }),
        catalog,
        m,
      )
      expect(result.targets[0].rate).toBeCloseTo(belt)
      const run = result.runs.find((r) => r.process.id === 'nursery:RedcurrantSeed')!
      const check = checkLogistics(result.runs, m).get(run.key)!
      expect(check.utilization).toBe(1) // nothing to warn about
      expect(check.outputCappedAt).not.toBeNull()
    }
  })
})

describe('coins on belts', () => {
  it('count 50 coins per belt slot', () => {
    // Copper Ingot (alt) melts Copper Coins in a Kiln with a single input belt.
    const mods = modifiers({})
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
    const p = [...catalog.byId.values()].find((x) => x.kind === 'recipe' && x.inputs.some((s) => s.item === 'CopperCoin'))!
    const c = checkProcess(p, mods, 1)!
    const coins = c.inputs.find((f) => f.item === 'CopperCoin')!
    expect(coins.slots).toBeCloseTo(coins.perMachine / 50)
    expect(coins.belts).toBe(Math.ceil(coins.perMachine / 50 / 60 - 1e-9))
  })

})

describe('Bank Portal (one coin → another)', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const silverToGold = 'bank:SilverCoin:GoldCoin'
  const goldToCopper = 'bank:GoldCoin:CopperCoin'
  const gold = (rate: number) =>
    chooseProducer(plan({ targets: [{ item: 'GoldCoin', rate }] }), catalog, {
      item: 'GoldCoin',
      producer: silverToGold,
      row: '0/GoldCoin',
    })

  it('converts value losslessly, a stack of the output coin per belt entry', () => {
    const p = catalog.byId.get(silverToGold)!
    expect(p.inputs).toEqual([{ item: 'SilverCoin', count: 5000 }])
    expect(p.outputs).toEqual([{ item: 'GoldCoin', count: 50 }])
    expect(p.stack).toBe(50)
    // No craft time, heat or Factory Efficiency: one entry per belt slot.
    expect(craftsPerMachine(p, modifiers({ FactorySpeed: 3 }))).toBeCloseTo(60)
    expect(p.inputs.some((s) => s.item === HEAT)).toBe(false)
    expect(catalog.byId.has('bank:GoldCoin:GoldCoin')).toBe(false)
  })

  it('is offered for coins, but never picked for them', () => {
    expect(catalog.byProduct.get('GoldCoin')?.map((p) => p.id)).toEqual(expect.arrayContaining([silverToGold, 'bank:CopperCoin:GoldCoin']))
    expect(defaultProducer(catalog, 'GoldCoin')).toBe('bus')
    expect(defaultProducer(catalog, 'GoldCoin', true)).not.toMatch(/^bank:/)
  })

  it('takes the coins it converts off the bus, and is held back by its input belt', () => {
    const r = solvePlan(gold(6), catalog, mods)
    expectBalanced(r)
    const [row] = r.tree
    expect(row.run?.process.id).toBe(silverToGold)
    expect(row.children[0]).toMatchObject({ item: 'SilverCoin', rate: 600 })
    // A belt of full silver stacks brings 3,000 silver (30 gold) a minute: 1% of what the output belt carries.
    expect(checkProcess(row.run!.process, mods)!.utilization).toBeCloseTo(0.01, 4)
  })

  it('is held back by its output belt when it breaks coins down', () => {
    const p = catalog.variant(catalog.byId.get(goldToCopper)!, { stack: 10 })
    expect(p.inputs).toEqual([{ item: 'GoldCoin', count: 10 / 100_000 }])
    expect(checkProcess(p, mods)!.utilization).toBe(1)
    expect(craftsPerMachine(p, mods) * p.outputs[0].count).toBeCloseTo(600)
  })

  describe('conversion amount per row', () => {
    const two = chooseProducer(
      plan({ targets: [{ item: 'GoldCoin', rate: 6 }, { item: 'GoldCoin', rate: 6 }] }),
      catalog,
      { item: 'GoldCoin', producer: silverToGold, everywhere: true },
    )

    it('sets each row its own stack', () => {
      const r = solvePlan(setRowStack(two, '1/GoldCoin', 5), catalog, mods)
      expectBalanced(r)
      expect(r.tree.map((n) => n.run?.process.stack)).toEqual([50, 5])
      expect(r.runs.filter((x) => x.process.id === silverToGold)).toHaveLength(2)
      expect(r.tree.map((n) => n.children[0].rate)).toEqual([600, 600])
    })

    it('keeps only stacks that differ from what the row has anyway, within 1–50', () => {
      const set = setRowStack(two, '1/GoldCoin', 5)
      expect(set.rowStacks).toEqual({ '1/GoldCoin': 5 })
      expect(setRowStack(set, '1/GoldCoin', 50).rowStacks).toBeUndefined()
      expect(catalog.variant(catalog.byId.get(silverToGold)!, { stack: 0 }).stack).toBe(1)
      expect(catalog.variant(catalog.byId.get(silverToGold)!, { stack: 99 }).stack).toBe(50)
    })

    it('is dropped when the row no longer converts coins, and moves with its target', () => {
      const set = setRowStack(two, '1/GoldCoin', 5)
      expect(pruneChoices(set, catalog)).toBeNull()
      const minted = chooseProducer(set, catalog, { item: 'GoldCoin', producer: 'import', row: '1/GoldCoin' })
      expect(pruneChoices(minted, catalog)?.rowStacks).toBeUndefined()
      expect(moveTarget(set, 1, 0).rowStacks).toEqual({ '0/GoldCoin': 5 })
    })

    it('feeds the row above in its stacks: smaller ones fill more of its input belts', () => {
      const ingots = chooseProducer(
        chooseProducer(plan({ targets: [{ item: 'CopperIngot', rate: 10 }] }), catalog, {
          item: 'CopperIngot',
          producer: 'recipe:CopperIngot_Alt',
          row: '0/CopperIngot',
        }),
        catalog,
        { item: 'CopperCoin', producer: goldToCopper, row: '0/CopperIngot/CopperCoin' },
      )
      const full = solvePlan(ingots, catalog, mods)
      expect(full.tree[0].run?.process.inputStacks).toBeUndefined()
      const small = solvePlan(setRowStack(ingots, '0/CopperIngot/CopperCoin', 10), catalog, mods)
      expectBalanced(small)
      const p = small.tree[0].run!.process
      expect(p.inputStacks).toEqual({ CopperCoin: 10 })
      const coins = (r: PlanResult) => checkProcess(r.tree[0].run!.process, mods)!.inputs.find((f) => f.item === 'CopperCoin')!
      expect(coins(small)).toMatchObject({ stack: 10 })
      expect(coins(small).slots).toBeCloseTo(coins(full).slots * 5)
      expect(small.tree[0].run!.key).not.toBe(full.tree[0].run!.key)
      // Same ingots, same coins: only the belts change.
      expect(small.tree[0].machines).toBeCloseTo(full.tree[0].machines)
      expect(small.tree[0].children[0].rate).toBeCloseTo(full.tree[0].children[0].rate)
    })

    it('slows a Paradox Crucible it feeds: each entry is worth less', () => {
      const essence = chooseProducer(
        chooseProducer(plan({ targets: [{ item: 'Mors', rate: 1 }] }), catalog, {
          item: 'Mors',
          producer: 'paradox:CopperCoin',
          row: '0/Mors',
        }),
        catalog,
        { item: 'CopperCoin', producer: goldToCopper, row: '0/Mors/CopperCoin' },
      )
      const small = solvePlan(setRowStack(essence, '0/Mors/CopperCoin', 10), catalog, mods)
      expectBalanced(small)
      const p = small.tree[0].run!.process
      expect(p.seconds).toBeCloseTo(paradoxSeconds('CopperCoin', 10))
      expect(p.seconds).toBeCloseTo(paradoxSeconds('CopperCoin') * 5)
      expect(p.inputs.find((s) => s.item === 'CopperCoin')!.count).toBe(10)
      expect(small.tree[0].children[0].rate).toBeCloseTo(10)
    })

    it('is saved with my defaults, and kept by the plan when un-saved', () => {
      const one = setRowStack(gold(6), '0/GoldCoin', 5)
      const before = solvePlan(one, catalog, mods)
      const saved = rememberSetup(one, catalog, before.tree, before.tree[0])
      expect(saved.mine.GoldCoin).toEqual({ producer: silverToGold, stack: 5 })
      expect(saved.plan.rowStacks).toEqual({})

      const withMine = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null, mine: saved.mine })
      const after = solvePlan(saved.plan, withMine, mods)
      expect(after.tree[0]).toMatchObject({ mine: true, defaultStack: 5 })
      expect(after.tree[0].run?.process.stack).toBe(5)

      const kept = keepDefaultInPlan(saved.plan, after.tree, 'GoldCoin', saved.mine.GoldCoin)
      expect(kept.rowStacks).toEqual({ '0/GoldCoin': 5 })
    })
  })
})

describe('Advanced Athanor catalysts', () => {
  const mods = modifiers({})
  const coke = (catalysts: string[], machine = 'AdvancedAthanor') =>
    buildCatalog({
      saved: [],
      machines: { 'recipe:Coke': machine },
      mods,
      fertilizer: null,
      catalysts: { 'recipe:Coke': catalysts },
    }).byId.get('recipe:Coke')!
  const out = (p: ReturnType<typeof coke>) => Object.fromEntries(p.outputs.map((s) => [s.item, s.count]))
  const inp = (p: ReturnType<typeof coke>) => Object.fromEntries(p.inputs.map((s) => [s.item, s.count]))

  it('runs Athanor recipes with the standard Athanor heat', () => {
    const athanor = coke([], 'Athanor')
    const advanced = coke([])
    expect(advanced.machine!.key).toBe('AdvancedAthanor')
    expect(inp(advanced)['@heat']).toBeCloseTo(inp(athanor)['@heat'])
    expect(out(advanced)).toEqual(out(athanor)) // no catalyst: same 50/50 outcome
    expect(out(athanor)).toEqual({ Coke: 0.5, Charcoal: 1 })
  })

  it('ignores catalysts on the plain Athanor', () => {
    expect(coke(['Catalyst1'], 'Athanor').catalysts).toEqual([])
  })

  it('applies each catalyst', () => {
    expect(out(coke(['Catalyst1']))).toEqual({ Coke: 0.75, Charcoal: 0.5 }) // unstable [1,0,0,0]
    expect(out(coke(['Catalyst2']))).toEqual({ Coke: 1, Charcoal: 2 }) // fertile doubles
    expect(out(coke(['Catalyst3']))).toEqual({ Coke: 1, Charcoal: 2 }) // resonant: every product
    expect(out(coke(['Catalyst1', 'Catalyst2']))).toEqual({ Coke: 1.5, Charcoal: 1 })
    const eternal = inp(coke(['Catalyst4']))
    expect(eternal.CharcoalPowder).toBeUndefined() // no materials
    expect(eternal.Catalyst4).toBeCloseTo(1 / 99999)
    expect(inp(coke(['Catalyst1'])).Catalyst1).toBeCloseTo(1 / 180) // Coke costs 1 charge per craft
  })

  it('checks catalysts against the three input belts', () => {
    // 120 Charcoal Powder/min already takes 2 of the 3 inputs.
    expect(checkProcess(coke(['Catalyst1']), mods, 1)!.utilization).toBe(1)
    expect(checkProcess(coke(['Catalyst1', 'Catalyst2']), mods, 1)!.utilization).toBeCloseTo(0.5) // powder squeezed to 1 belt
    expect(checkProcess(coke(['Catalyst1', 'Catalyst2', 'Catalyst3']), mods, 1)!.utilization).toBe(0) // 4 ingredients > 3 inputs
  })

  it('decodes multi-fail sequences (Gold Dust 3: 10% / 30% / 60%)', () => {
    const p = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null }).byId.get('recipe:GoldDust3')!
    const o = Object.fromEntries(p.outputs.map((s) => [s.item, s.count]))
    expect(o.GoldDust3).toBeCloseTo(0.1)
    expect(o.GoldDust2).toBeCloseTo(0.3)
    expect(o.GoldDust).toBeCloseTo(0.6)
  })
})

describe('Knowledge Altar', () => {
  const mods = modifiers({})
  const exp = (item: string, m = mods) => altarYield(item, m)

  it('gives 0.0002 × BaseCost EXP per item over 0.1676 × BaseCost^0.518 s (UShrineFacilityComponent)', () => {
    const cost = itemsByKey.get('IronIngot')!.baseCost
    expect(exp('IronIngot')).toEqual({ exp: 0.0002 * cost, seconds: 0.1676 * cost ** 0.518, relic: false })
  })

  it('counts bundles in fractions: a Wood is 200 one-unit cycles', () => {
    const y = exp('Wood')!
    expect(y.exp).toBeCloseTo(200 * 0.0002 * 1)
    expect(y.seconds).toBeCloseTo(200 * 0.1676)
  })

  it('takes relics a fifth of a planet per cycle, at fixed EXP and time', () => {
    expect(exp('Jupiter')).toEqual({ exp: 10, seconds: 60, relic: true }) // 60 of 300 per 12 s cycle, 2 EXP each
    expect(exp('Sol')).toEqual({ exp: 5 * 4887.8, seconds: 600, relic: true })
  })

  it('adds Relic Knowledge to relics only, and Factory Efficiency to every altar', () => {
    const m = modifiers({ AltarEfficiency: 3, FactorySpeed: 4 })
    expect(m.altar).toBeCloseTo(1.3)
    expect(exp('Mars', m)!.exp).toBeCloseTo(5 * 25.2 * 1.3)
    expect(exp('Mars', m)!.seconds).toBeCloseTo(120 / m.factorySpeed)
    expect(exp('IronIngot', m)!.exp).toBe(exp('IronIngot')!.exp)
  })

  it('takes nothing off a pipe, and nothing worthless', () => {
    expect(exp('Brandy')).toBeNull()
    expect(exp('Steam')).toBeNull()
  })

  it('waits on its one belt when it breaks items down faster than a belt brings them', () => {
    const sand = exp('Sand')!
    expect(sand.seconds).toBeLessThan(60 / mods.beltSpeed)
    expect(altarsFor(sand, 120, mods)).toBeCloseTo(120 / mods.beltSpeed)
    expect(altarsFor(exp('Jupiter')!, 3, mods)).toBeCloseTo(3) // a minute per planet
  })
})

describe('Thermal Extractor height', () => {
  const mods = modifiers({})
  const oil = 'recipe:LinseedOil'
  const extract = (machine: string, height?: number) =>
    buildCatalog({
      saved: [],
      machines: { [oil]: machine },
      mods,
      fertilizer: null,
      ...(height !== undefined && { heights: { [oil]: height } }),
    }).byId.get(oil)!
  const made = (p: Process) => p.outputs.find((s) => s.item === 'LinseedOil')!.count

  it('adds height / 128 to the output, up to 3× (GetProductionMultiplier)', () => {
    expect([-4, 0, 32, 64, 128, 200, 256, 999].map(heightMultiplier)).toEqual([1, 1, 1.25, 1.5, 2, 2.5625, 3, 3])
  })

  it('sets the output of Thermal Extractors only', () => {
    const base = made(extract('Extractor'))
    expect(made(extract('ThermalExtractor'))).toBeCloseTo(base)
    expect(made(extract('ThermalExtractor', 64))).toBeCloseTo(base * 1.5)
    expect(made(extract('Extractor', 64))).toBeCloseTo(base)
    expect(extract('Extractor', 64)).toMatchObject({ acceptsHeight: false, height: 0 })
    expect(extract('ThermalExtractor', 64)).toMatchObject({ acceptsHeight: true, height: 64 })
  })

  describe('per row', () => {
    const catalog = buildCatalog({ saved: [], machines: { [oil]: 'ThermalExtractor' }, mods, fertilizer: null })
    const two = plan({
      targets: [{ item: 'LinseedOil', rate: 60 }, { item: 'LinseedOil', rate: 60 }],
      machines: { [oil]: 'ThermalExtractor' },
    })

    it('builds each row at its own height', () => {
      const r = solvePlan(setRowHeight(two, '1/LinseedOil', 128), catalog, mods)
      expectBalanced(r)
      expect(r.tree.map((n) => n.run?.process.height)).toEqual([0, 128])
      expect(r.tree[1].machines).toBeCloseTo(r.tree[0].machines / 2)
      expect(r.runs.filter((x) => x.process.id === oil)).toHaveLength(2)
    })

    it('keeps only heights that differ from what the row has anyway', () => {
      const raised = setRowHeight(two, '1/LinseedOil', 128)
      expect(raised.rowHeights).toEqual({ '1/LinseedOil': 128 })
      expect(setRowHeight(raised, '1/LinseedOil', 0).rowHeights).toBeUndefined()
      expect(setRowHeight(two, '1/LinseedOil', 64, 64).rowHeights).toBeUndefined()
    })

    it('are dropped when the row no longer runs on Thermal Extractors', () => {
      const raised = setRowHeight(two, '1/LinseedOil', 128)
      expect(pruneChoices(raised, catalog)).toBeNull()
      const plain = chooseProducer(raised, catalog, { item: 'LinseedOil', producer: oil, machine: 'Extractor', row: '1/LinseedOil' })
      expect(pruneChoices(plain, catalog)?.rowHeights).toBeUndefined()
    })

    it('move with their target', () => {
      const moved = moveTarget(setRowHeight(two, '1/LinseedOil', 128), 1, 0)
      expect(moved.rowHeights).toEqual({ '0/LinseedOil': 128 })
    })

    it('are saved with my defaults, and kept by the plan when un-saved', () => {
      const raised = setRowHeight(plan({ targets: [{ item: 'LinseedOil', rate: 60 }] }), '0/LinseedOil', 96)
      const picked = chooseProducer(raised, catalog, { item: 'LinseedOil', producer: oil, machine: 'ThermalExtractor', row: '0/LinseedOil' })
      const before = solvePlan(picked, catalog, mods)
      const saved = rememberSetup(picked, catalog, before.tree, before.tree[0])
      expect(saved.mine.LinseedOil).toEqual({ producer: oil, machine: 'ThermalExtractor', height: 96 })
      expect(saved.plan.rowHeights).toEqual({})

      const withMine = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null, mine: saved.mine })
      const after = solvePlan(saved.plan, withMine, mods)
      expect(after.tree[0]).toMatchObject({ mine: true, defaultHeight: 96 })
      expect(after.tree[0].run?.process.height).toBe(96)

      const kept = keepDefaultInPlan(saved.plan, after.tree, 'LinseedOil', saved.mine.LinseedOil)
      expect(kept.rowHeights).toEqual({ '0/LinseedOil': 96 })
      expect(solvePlan(kept, catalog, mods).tree[0].run?.process.height).toBe(96)
    })
  })
})

describe('Purchasing Portal (coins → an item)', () => {
  const mods = modifiers({})
  // Tier VII: silver still buys everything portals sell at full speed, so the plan pays in silver.
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null, tier: 7 })

  it('pays by default with the largest coin prices are written in at the research tier', () => {
    expect([1, 4, 5, 7, 8, 9].map(defaultCoin)).toEqual(['CopperCoin', 'CopperCoin', 'SilverCoin', 'SilverCoin', 'GoldCoin', 'GoldCoin'])
    expect(itemsByKey.get('IronOre')!.buyCoin).toBe('CopperCoin') // 1,200 copper
    expect(itemsByKey.get('WorldTreeSeed')!.buyCoin).toBe('GoldCoin')
    expect(defaultProducer(catalog, MONEY)).toBe('spend:SilverCoin')
    expect(defaultProducer(buildCatalog({ saved: [], machines: {}, mods, fertilizer: null, tier: 8 }), MONEY)).toBe('spend:GoldCoin')
  })
  const ore = catalog.byId.get('buy:IronOre')!
  const paidIn = (coin: string, m = mods) => craftsPerMachine(catalog.variant(ore, { coin }), m)

  it('buys one item per belt slot, unless the coins it is paid in come slower', () => {
    expect(ore).toMatchObject({ kind: 'buy', product: 'IronOre', coin: 'SilverCoin', inputs: [{ item: MONEY, count: 1200 }] })
    expect(paidIn('SilverCoin')).toBeCloseTo(60) // 50 silver pay for 41 ore: the output belt sets the pace
    expect(paidIn('GoldCoin')).toBeCloseTo(60)
    expect(paidIn('CopperCoin')).toBeCloseTo(60 * (50 / 1200)) // 24 entries of 50 copper per ore
  })

  it('runs at belt speed, whatever the Factory Efficiency', () => {
    const fast = modifiers({ FactorySpeed: 4, Conveyer: 2 })
    const c = buildCatalog({ saved: [], machines: {}, mods: fast, fertilizer: null })
    expect(craftsPerMachine(c.byId.get('buy:IronOre')!, fast)).toBeCloseTo(fast.beltSpeed)
  })

  it('pays with the plan\'s coin unless a row picks another, and reads old plans\' "import" as buying', () => {
    const iron = plan({ targets: [{ item: 'IronOre', rate: 10 }], producers: { IronOre: 'import' } })
    const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
    const coins = (p: Plan) =>
      solvePlan(p, catalog, mods)
        .tree.flatMap(all)
        .filter((n) => n.kind === 'bus')
        .map((n) => [n.item, n.fromBus])
    const silver = solvePlan(iron, catalog, mods)
    expect(silver.tree[0]).toMatchObject({ producer: 'buy:IronOre' })
    expect(coins(iron)).toEqual([['SilverCoin', expect.closeTo(12)]]) // 10 × 1,200 copper
    const copper = setPlanDefault(iron, MONEY, 'spend:CopperCoin')
    expect(coins(copper)).toEqual([['CopperCoin', expect.closeTo(12000)]])
    expect(solvePlan(copper, catalog, mods).tree[0].machines).toBeCloseTo(10 / 2.5)
    const picked = chooseProducer(copper, catalog, { item: MONEY, producer: 'spend:GoldCoin', row: `0/IronOre/${MONEY}` })
    expect(coins(picked)).toEqual([['GoldCoin', expect.closeTo(0.12)]])
    expect(ownPicks(picked, catalog, MONEY)).toEqual([`0/IronOre/${MONEY}`])
  })

  it('slows when a Bank Portal below feeds it smaller coin stacks', () => {
    const copper = plan({ targets: [{ item: 'IronOre', rate: 10 }], producers: { [MONEY]: 'spend:CopperCoin' } })
    const coins = `0/IronOre/${MONEY}/CopperCoin`
    const banked = chooseProducer(copper, catalog, { item: 'CopperCoin', producer: 'bank:SilverCoin:CopperCoin', row: coins })
    const full = solvePlan(banked, catalog, mods).tree[0]
    expect(full.machines).toBeCloseTo(10 / 2.5) // full stacks of 50: 2.5 ore a minute each
    const small = solvePlan(setRowStack(banked, coins, 10), catalog, mods).tree[0]
    expect(small.run!.process.inputStacks).toEqual({ CopperCoin: 10 })
    expect(small.machines).toBeCloseTo(10 / 0.5) // stacks of 10: 120 entries an ore
  })

  it('shows what the plan buys once per item, whatever coins pay for it', () => {
    const two = plan({
      targets: [
        { item: 'IronOre', rate: 10 },
        { item: 'IronOre', rate: 5 },
      ],
      branches: { [`1/IronOre/${MONEY}`]: { producer: 'spend:CopperCoin' } },
    })
    const result = solvePlan(two, catalog, mods)
    const money = moneyLedger(two, result, ledgers(two, result))
    expect(money.purchases).toEqual([{ item: 'IronOre', count: expect.closeTo(15), price: 1200 }])
    expect(money.coins.map((l) => l.item).sort()).toEqual(['CopperCoin', 'SilverCoin'])
    expect(money.need).toBeCloseTo(15 * 1200)
  })
})

describe('Dispatch Portal (an item → coins, up to a daily limit)', () => {
  // Items a day per Supplier License count, from the game's limit check (native 0x144A2A2E0): whole
  // contracts until the factory-wide count reaches round(count × DailyLimit × (1 + 0.6 × licenses)).
  const perDay: Record<string, (number | null)[]> = {
    Bandage: [800, 1300, 1800, 2250, 2750, 3200],
    GloomSpores: [null, 2600, 3550, 4500, 5450, 6400],
    PocketWatch: [null, null, 2120, 2700, 3280, 3840],
    Catalyst2: [null, null, null, 3360, 4080, 4800],
    SilverAmulet: [null, null, null, null, 1640, 1920],
    MoonlitSoap: [null, null, null, null, null, 320],
  }

  it('takes whole contracts up to the daily limit, raised by each Supplier License', () => {
    expect(dispatch.contracts.map((c) => c.item).sort()).toEqual(Object.keys(perDay).sort())
    for (const [item, days] of Object.entries(perDay))
      days.forEach((items, licenses) => {
        const terms = dispatchTerms(item, modifiers({ ContractProfit: licenses }))!
        expect(terms.locked).toBe(items === null)
        if (items !== null) expect(terms.itemsPerDay).toBe(items)
      })
    expect(dispatchTerms('WoodBoard', modifiers({}))).toBeNull()
  })

  it('assumes the license a locked contract needs', () => {
    const terms = dispatchTerms('GloomSpores', modifiers({}))!
    expect(terms).toMatchObject({ locked: true, licenses: 1, itemsPerDay: 2600 })
  })

  it('spreads the limit over a day that ends at bedtime, later with each Potion Belt tier', () => {
    expect([0, 1, 2, 3, 4, 9].map((tier) => modifiers({ SleepTime: tier }).dayMinutes)).toEqual([16, 18, 20, 22, 24, 24])
    expect(dispatchTerms('Bandage', modifiers({}))!.rate).toBeCloseTo(50) // 800 over 16 minutes
    expect(dispatchTerms('Bandage', modifiers({ SleepTime: 4 }))!.rate).toBeCloseTo(800 / 24)
  })

  it('pays each coin of the reward rounded down after the license bonus', () => {
    const pay = (licenses: number) => dispatchTerms('Bandage', modifiers({ ContractProfit: licenses }))!.pay
    expect(pay(0)).toEqual([{ coin: 'SilverCoin', count: 12 }])
    expect(pay(1)).toEqual([{ coin: 'SilverCoin', count: 12 }]) // 12.96
    expect(pay(5)).toEqual([{ coin: 'SilverCoin', count: 19 }]) // +60%: 19.2
    expect(dispatchTerms('Bandage', modifiers({}))!.copperPerMinute).toBeCloseTo((16 * 12_000) / 16)
  })

  it('sizes a target to the limit', () => {
    const mods = modifiers({})
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
    const result = solvePlan(plan({ targets: [{ item: 'Bandage', rate: 7, unit: 'dispatch' }] }), catalog, mods)
    expectBalanced(result)
    expect(result.targets[0].rate).toBeCloseTo(50)
    expect(result.balances.find((b) => b.item === 'Bandage')!.produced).toBeCloseTo(50)
  })

  it('reads a dispatch target of an item buyers don’t take as an ordinary one', () => {
    const p = plan({ targets: [{ item: 'Bandage', rate: 7, unit: 'dispatch' }, { item: 'WoodBoard', rate: 7, unit: 'dispatch' }] })
    expect(sanitizePlans([p], () => 't')![0].targets).toEqual([
      { item: 'Bandage', rate: 7, unit: 'dispatch' },
      { item: 'WoodBoard', rate: 7 },
    ])
  })
})

describe('Paradox Crucible (any item → Oblivion Essence)', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer' })

  it('takes 1500 / CauldronCost seconds per essence, clamped to 0.5–1500 s', () => {
    expect(paradoxSeconds('SageSeed')).toBeCloseTo(1500 / 175) // 8.6 s in game, not BaseCost's 4.2 s
    expect(paradoxSeconds('WoodBoard')).toBe(1500) // value 1
    expect(paradoxSeconds('PhilosopherStone')).toBe(0.5)
  })

  it('speeds up with Factory Efficiency, as in game (Sage Seeds at level 3: 4.9 s, 12.2/min)', () => {
    const p = catalog.byId.get('paradox:SageSeed')!
    const fast = modifiers({ FactorySpeed: 3 })
    expect(p.seconds / fast.factorySpeed).toBeCloseTo(4.9, 1)
    expect(craftsPerMachine(p, fast)).toBeCloseTo(12.25, 1)
  })

  it('refines a whole coin stack at once', () => {
    const copper = itemsByKey.get('CopperCoin')!.cauldronCost
    expect(paradoxSeconds('CopperCoin')).toBeCloseTo(1500 / (50 * copper))
    const p = catalog.byId.get('paradox:CopperCoin')!
    expect(p.inputs.find((s) => s.item === 'CopperCoin')!.count).toBe(50)
    expect(p.outputs).toEqual([{ item: 'Mors', count: 1 }])
  })

  it('burns 1200 P/s for the whole refine', () => {
    const p = catalog.byId.get('paradox:SageSeed')!
    expect(p.machine?.key).toBe('ParadoxCrucible')
    expect(p.inputs.find((s) => s.item === NUTRIENTS)).toBeUndefined()
    expect(p.inputs.find((s) => s.item === '@heat')!.count).toBeCloseTo(1200 * p.seconds)
  })

  it('is the default Oblivion Essence producer, so Vitality Essence no longer dead-ends in a loop', () => {
    expect(defaultProducer(catalog, 'Mors')).toBe('paradox:SageSeed')
    const result = solvePlan(plan({ targets: [{ item: 'Vitae', rate: 6 }] }), catalog, mods)
    expectBalanced(result)
    for (const b of result.balances) expect(b.deficit).toBe(0)
    const refine = result.runs.find((r) => r.process.id === 'paradox:SageSeed')!
    expect(refine.craftsPerMinute).toBeCloseTo(6)
    expect(refine.machines).toBeCloseTo(6 / (60 / (1500 / 175)))
  })

  it('follows the chosen input down the tree', () => {
    const targets = [{ item: 'Mors', rate: 10 }]
    const result = solvePlan(plan({ targets, producers: { Mors: 'paradox:SteelGear' } }), catalog, mods)
    expectBalanced(result)
    const [root] = result.tree
    expect(root.run?.process.id).toBe('paradox:SteelGear')
    const gear = root.children.find((c) => c.item === 'SteelGear')!
    expect(gear.rate).toBeCloseTo(10)
    expect(gear.kind).toBe('produce')
  })
})

describe('Paradox Crucible mixed feed (refining the by-products below it too)', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer' })
  // 180 Oblivion Essence from Gentian, and 18 Gentian Nectar used elsewhere in the plan.
  const gentian = plan({
    targets: [{ item: 'Mors', rate: 180 }, { item: 'GentianNectar', rate: 18 }],
    producers: { Mors: 'paradox:Gentian', Gentian: 'nursery:GentianSeed', GentianNectar: 'nursery:GentianSeed' },
  })
  const nurseries = (r: PlanResult) => r.runs.filter((x) => x.process.id === 'nursery:GentianSeed').reduce((t, x) => t + x.craftsPerMinute, 0)
  const crafts = (r: PlanResult, id: string) => r.runs.find((x) => x.process.id === id)?.craftsPerMinute ?? 0
  const surplus = (r: PlanResult, item: string) => r.balances.find((b) => b.item === item)?.surplus ?? 0

  it('refines only its input when off, overflowing the Nectar', () => {
    const result = solvePlan(gentian, catalog, mods)
    expectBalanced(result)
    expect(nurseries(result)).toBeCloseTo(180)
    expect(surplus(result, 'GentianNectar')).toBeCloseTo(162)
    expect(result.tree[0].mixable).toEqual(['GentianNectar'])
    expect(result.tree[0].mixed).toBe(false)
  })

  it('takes the Nectar up the same belt when on: the nurseries make only what that leaves', () => {
    const result = solvePlan(setMixedFeed(gentian, '0/Mors', true), catalog, mods)
    expectBalanced(result)
    // Gentian + (Gentian − 18) Nectar = 180.
    expect(nurseries(result)).toBeCloseTo(99)
    expect(surplus(result, 'GentianNectar')).toBeCloseTo(0)
    expect(surplus(result, 'Gentian')).toBeCloseTo(0)
    expect(crafts(result, 'paradox:Gentian')).toBeCloseTo(99)
    expect(crafts(result, 'paradox:GentianNectar')).toBeCloseTo(81)
    for (const b of result.balances) expect(b.deficit).toBe(0)

    const [root] = result.tree
    expect(root.rate).toBeCloseTo(180)
    expect(root.shortfall).toBe(0)
    expect(root.run!.process.mixed).toBe(true)
    expect(root.mixParts!.map((m) => [m.item, round1(m.rate)])).toEqual([
      ['Gentian', 99],
      ['GentianNectar', 81],
    ])
    // One group of crucibles per input, adding up to the row.
    const groups = root.mixParts!.reduce((t, m) => t + m.machines, 0)
    expect(root.machines).toBeCloseTo(groups)
    expect(groups).toBeCloseTo((99 * paradoxSeconds('Gentian') + 81 * paradoxSeconds('GentianNectar')) / 60)
    // Heat for every essence, whichever item it came from.
    expect(root.heat).toBeCloseTo((1200 * (99 * paradoxSeconds('Gentian') + 81 * paradoxSeconds('GentianNectar'))) / 60)
    // Both items come up the crucible's one input belt.
    expect(checkProcess(root.run!.process, mods)!.utilization).toBe(1)
    // The nursery row shows its Nectar going into the crucibles.
    const grown = root.children.find((c) => c.item === 'Gentian')!
    const nectar = grown.byproducts.find((b) => b.item === 'GentianNectar')!
    expect(nectar.to.find((t) => t.direct)?.id).toBe('0/Mors')
    expect(nectar.overflow).toBeCloseTo(0)
  })

  it('is forgotten once the crucible refines something with no by-products below it', () => {
    const mixed = setMixedFeed(gentian, '0/Mors', true)
    expect(pruneChoices(mixed, catalog)).toBeNull()
    const sage = { ...mixed, producers: { ...mixed.producers, Mors: 'paradox:SageSeed' } }
    expect(pruneChoices(sage, catalog)!.mixedFeed).toBeUndefined()
    expect(sanitizePlans([mixed], () => 'n')![0].mixedFeed).toEqual({ '0/Mors': true })
  })

  it('is saved with my defaults, followed by other plans, and kept by the plan when un-saved', () => {
    const mixed = setMixedFeed(gentian, '0/Mors', true)
    const before = solvePlan(mixed, catalog, mods)
    expect(rememberChanges(catalog, rowsById(before.tree), before.tree[0])).toBe(true)
    const saved = rememberSetup(mixed, catalog, before.tree, before.tree[0])
    expect(saved.mine.Mors).toEqual({ producer: 'paradox:Gentian', mixed: true })
    expect(saved.plan.mixedFeed).toEqual({})

    // A new plan making Oblivion Essence follows the default, crucibles mixing their feed.
    const withMine = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer', mine: saved.mine })
    const fresh = plan({ targets: [{ item: 'Mors', rate: 180 }] })
    const after = solvePlan(fresh, withMine, mods)
    expect(after.tree[0]).toMatchObject({ mine: true, defaultMixed: true, mixed: true })
    expect(nurseries(after)).toBeCloseTo(90)
    expect(rememberChanges(withMine, rowsById(after.tree), after.tree[0])).toBe(false)
    expect(sanitizeMyDefaults(saved.mine)!.Mors).toEqual({ producer: 'paradox:Gentian', mixed: true })

    // One row can still turn it off, and back on to follow the default again.
    const off = setMixedFeed(fresh, '0/Mors', false, true)
    expect(off.mixedFeed).toEqual({ '0/Mors': false })
    expect(nurseries(solvePlan(off, withMine, mods))).toBeCloseTo(180)
    expect(setMixedFeed(off, '0/Mors', true, true).mixedFeed).toBeUndefined()

    const kept = keepDefaultInPlan(fresh, after.tree, 'Mors', saved.mine.Mors)
    expect(kept.mixedFeed).toEqual({ '0/Mors': true })
  })
})

describe('upgrade levels (DT_Improvements)', () => {
  const at = (key: string, level: number) => modifiers({ [key]: level })

  it('level 13 is a smaller final step for Factory and Logistics Efficiency', () => {
    expect(at('FactorySpeed', 12).factorySpeed).toBeCloseTo(4) // 12 × 25%
    expect(at('FactorySpeed', 13).factorySpeed).toBeCloseTo(4.05) // + 5%
    expect(at('Conveyer', 12).beltSpeed).toBe(240) // 60 + 12 × 15
    expect(at('Conveyer', 13).beltSpeed).toBe(243) // + 3
  })

  it('Fuel, Fertilizer and Alchemy Skill follow their tables to 13', () => {
    expect(at('FuelEfficiency', 13).fuel).toBeCloseTo(2.3) // 13 × 10%
    expect(at('FertilizeEfficiency', 13).fertilizer).toBeCloseTo(2.3)
    expect(at('AlchemySkill', 13).extractor).toBeCloseTo(2.1) // 2×6 + 6×8 + 5×10 = 110%
    expect(at('AlchemySkill', 13).alembic).toBeCloseTo(2.1)
  })

  it('buys level 13 up to 80 times in all for Factory and Logistics Efficiency', () => {
    expect(at('FactorySpeed', 14).factorySpeed).toBeCloseTo(4.1)
    expect(at('FactorySpeed', 92).factorySpeed).toBeCloseTo(8) // 4 + 80 × 5%
    expect(at('Conveyer', 92).beltSpeed).toBe(480) // 240 + 80 × 3
    expect(at('FactorySpeed', 200).factorySpeed).toBeCloseTo(8) // capped
  })

  it('repeats level 13 without limit for Fuel, Fertilizer and Alchemy Skill (MaxUnlimitedLevel 0)', () => {
    expect(at('FuelEfficiency', 20).fuel).toBeCloseTo(3) // 2.3 + 7 × 10%
    expect(at('FertilizeEfficiency', 20).fertilizer).toBeCloseTo(3)
    expect(at('AlchemySkill', 20).extractor).toBeCloseTo(2.8) // 2.1 + 7 × 10%
    expect(at('FuelEfficiency', 1e9).fuel).toBeCloseTo(1 + (130 + (1e9 - 13) * 10) / 100) // no per-level loop
  })

  it('lists planner upgrades in the in-game skill-tree order', () => {
    expect(PLANNER_UPGRADES.map((u) => u.key)).toEqual([
      'Conveyer',
      'FactorySpeed',
      'AlchemySkill',
      'FuelEfficiency',
      'FertilizeEfficiency',
      'AltarEfficiency',
    ])
  })

  it('caps levels per series', () => {
    const caps = Object.fromEntries(PLANNER_UPGRADES.map((u) => [u.key, maxLevel(u)]))
    expect(caps).toEqual({
      FactorySpeed: 92, Conveyer: 92, FuelEfficiency: Infinity, FertilizeEfficiency: Infinity, AlchemySkill: Infinity,
      AltarEfficiency: Infinity,
    })
    expect(maxLevel(upgrades.find((u) => u.key === 'Bag')!)).toBe(6) // not repeatable
    for (const u of PLANNER_UPGRADES) {
      expect(upgradeLevel({ [u.key]: 1000 }, u)).toBe(Math.min(1000, maxLevel(u)))
      expect(upgradeLevel({ [u.key]: -2 }, u)).toBe(0)
      expect(upgradeLevel({ [u.key]: 2.7 }, u)).toBe(2)
    }
  })

  it('moves per-plan upgrades from older saves to one shared set, preferring the open plan', () => {
    const a = plan({ id: 'a', upgrades: { FactorySpeed: 3 }, tier: 4 })
    const b = plan({ id: 'b', upgrades: { FactorySpeed: 9 } })
    const fresh = plan({ id: 'c', upgrades: undefined })
    expect(legacyProgress([a, b], 'b')).toEqual({ upgrades: { FactorySpeed: 9 }, tier: undefined })
    expect(legacyProgress([fresh, a, b], 'c')).toEqual({ upgrades: { FactorySpeed: 3 }, tier: 4 })
    expect(legacyProgress([fresh])).toBeUndefined()
    expect(withoutLegacyProgress(a)).toEqual({ id: 'a', name: 't', targets: [], producers: {}, machines: {} })
    expect(withoutLegacyProgress(fresh)).toBe(fresh)
  })
})

describe('World Tree nursery', () => {
  // Basic Fertilizer is slow (12 nutrients/s): the tree's speed must not depend on it.
  const catalog = buildCatalog({ saved: [], machines: {}, mods: modifiers({}), fertilizer: 'BasicFertilizer' })
  const tree = catalog.byId.get('nursery:TreeStage3')!
  const out = Object.fromEntries(tree.outputs.map((s) => [s.item, s.count]))
  const perMinute = (p: typeof tree, item: string, stacks: typeof tree.outputs) =>
    ((stacks.find((s) => s.item === item)?.count ?? 0) * 60) / p.seconds

  it('grows 100 leaves per core, each item costing the full nutrient value', () => {
    expect(out.WorldTreeLeaf / out.WorldTreeCore).toBeCloseTo(100)
    const nutrients = tree.inputs.find((s) => s.item === NUTRIENTS)!.count
    expect(nutrients).toBeCloseTo(60000 * (out.WorldTreeLeaf + out.WorldTreeCore))
  })

  it('runs at a fixed 3 s per item, whatever the fertilizer', () => {
    for (const stage of ['TreeStage2', 'TreeStage3']) {
      const p = catalog.byId.get(`nursery:${stage}`)!
      const items = p.outputs.reduce((sum, s) => sum + s.count, 0)
      expect(p.seconds / items).toBeCloseTo(3)
    }
  })

  // The stage isn't a choice: the nursery matures to stage 3; only the miniature stays at stage 2.
  it('grows stage 3 in the World Tree Nursery and stage 2 in the Miniature World Tree', () => {
    expect(tree.machine?.key).toBe('WorldTreeNursery')
    const mini = catalog.byId.get('nursery:TreeStage2')!
    expect(mini.machine?.key).toBe('MiniWorldTree')
    expect(mini.outputs.map((s) => s.item)).toEqual(['WorldTreeLeaf'])
    expect(mini.inputs.find((s) => s.item === NUTRIENTS)!.count).toBeCloseTo(30000)
    expect(processTitle(mini)).toBe('Miniature World Tree')
  })

  it('defaults leaves to the World Tree Nursery, even once the miniature is unlocked', () => {
    expect(defaultProducer(catalog, 'WorldTreeLeaf')).toBe('nursery:TreeStage3')
  })

  it('speeds up with Factory Efficiency', () => {
    const mods = modifiers({ FactorySpeed: 2 })
    expect(mods.factorySpeed).toBeGreaterThan(1)
    expect(craftsPerMachine(tree, mods) / craftsPerMachine(tree, modifiers({}))).toBeCloseTo(mods.factorySpeed)
  })

  it('lists the stage 3 trees grown for cores, though leaves come from miniature trees', () => {
    const mods = modifiers({})
    const targets = [{ item: 'Sol', rate: 0.25 }]

    const result = solvePlan(plan({ targets, producers: { WorldTreeLeaf: 'nursery:TreeStage2' } }), catalog, mods)
    const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
    const nodes = result.tree.flatMap(all)
    for (const run of result.runs.filter((r) => r.machines > 0 && r.process.machine)) {
      const shown = nodes.filter((n) => n.run?.process.id === run.process.id).reduce((sum, n) => sum + n.machines, 0)
      expect(shown, run.process.label).toBeCloseTo(run.machines)
    }
  })

  it('five trees fall just short of one Sol shaper (tester report)', () => {
    const sol = catalog.byId.get('recipe:Sol')!
    const coresNeeded = perMinute(sol, 'WorldTreeCore', sol.inputs)
    const coresGrown = 5 * perMinute(tree, 'WorldTreeCore', tree.outputs)
    expect(coresNeeded).toBeCloseTo(1)
    expect(coresGrown).toBeCloseTo(100 / 101)
  })
})

describe('plural names', () => {
  it('pluralizes machines whenever the count shown is not 1', () => {
    expect(buildingNameFor('Grinder', 1)).toBe('Grinder')
    expect(buildingNameFor('Grinder', 1.0004)).toBe('Grinder') // shown as "1"
    expect(buildingNameFor('Grinder', 2.5)).toBe('Grinders')
    expect(buildingNameFor('Grinder', 0.5)).toBe('Grinders')
    expect(buildingNameFor('AutoNursery', 3)).toBe('Nurseries')
    expect(buildingNameFor('Portal_Output', 2)).toBe('Portals (Output)')
    expect(buildingNameFor('SteamHeater', 2)).toBe('Steam Heating Pads')
  })

  it('pluralizes counted items and keeps measured or already-plural ones', () => {
    expect(itemNameFor('IronIngot', 12)).toBe('Iron Ingots')
    expect(itemNameFor('Ruby', 2)).toBe('Rubies')
    expect(itemNameFor('Topaz', 2)).toBe('Topazes')
    expect(itemNameFor('WorldTreeLeaf', 100)).toBe('World Tree Leaves')
    expect(itemNameFor('WoodPulley', 2)).toBe('Wooden Pulleys')
    expect(itemNameFor('PocketWatch', 2)).toBe('Pocket Watches')
    expect(itemNameFor('PhilosopherStone', 2)).toBe("Philosopher's Stones")
    expect(itemNameFor('Coal', 120)).toBe('Coal')
    expect(itemNameFor('Wood', 3)).toBe('Logs')
    expect(itemNameFor('Wood', 1)).toBe('Log')
    expect(itemNameFor('Nails', 1)).toBe('Iron Nail')
    expect(itemNameFor('FlaxSeed', 1)).toBe('Flax Seed')
    expect(itemNameFor('WhisperingFields', 1)).toBe('Whispering Fields')
    expect(itemNameFor('WhisperingFields', 2)).toBe('Whispering Fields')
    expect(itemNameFor('CharcoalPowder', 3)).toBe('Charcoal Powder')
    expect(itemNameFor(HEAT, 3)).toBe('Heat (P)')
  })

  it('pluralizes plain nouns', () => {
    expect(noun(1, 'recipe')).toBe('recipe')
    expect(noun(0, 'recipe')).toBe('recipes')
    expect(noun(2, 'belt')).toBe('belts')
  })
})
