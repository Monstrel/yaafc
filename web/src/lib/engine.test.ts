import { describe, expect, it } from 'vitest'
import { altarYield, altarsFor } from './altar'
import { cauldronStats, evaluateAdvanced, evaluateNormal, findRecipes } from './cauldron'
import {
  HEAT,
  MAX_TIER,
  MONEY,
  NUTRIENTS,
  buyTier,
  cauldronIngredients,
  gameRecipes,
  heightMultiplier,
  items,
  itemsByKey,
  licenseFor,
  machineTier,
  research,
  targetItems,
  upgrades,
} from './gameData'
import {
  buildCatalog,
  defaultProducer,
  STEAM_HEAT_ID,
  defaultCoin,
  paradoxSeconds,
  processTitle,
  savedRecipeProcess,
  type Process,
  type ProcessCatalog,
} from './processes'
import { ledgers } from './ledger'
import { fedOverflow, moneyLedger, type MoneyLedger } from './money'
import { allowedIngredients, builtinGroups, emptyPrefs, onlyGroup, preferredCount, setPrefs } from './itemGroups'
import { countRecipes, diagnoseNoResults, type FinderQuery } from './diagnose'
import { buildingCounts, checkLogistics, checkProcess, resourceUsers } from './logistics'
import { craftsPerMachine } from './machineRate'
import { solvePlan, type PlanResult } from './solver'
import { onOverflow, type TreeNode } from './tree'
import { heatNetworks } from './heatNetworks'
import { setNetworkFuel, setNetworkSource } from './heatChoices'
import {
  chooseProducer,
  chooseReuse,
  clearBranchChoice,
  addProvider,
  addOverflowTarget,
  addSupplyTarget,
  setBusSupply,
  convertOverflowTarget,
  linkToOverflow,
  linkToSupply,
  migrateCatalysts,
  migrateFeedback,
  moveTarget,
  removeTarget,
  setItemFeedback,
  setTargetFeedback,
  pruneChoices,
  keepDefaultInPlan,
  rememberChanges,
  rememberSetup,
  ownPicks,
  followDefault,
  setPlanDefault,
  rowsById,
  setBuilt,
  setRoundUp,
  setMixedFeed,
  setRowCatalysts,
  setRowHeight,
  setRowStack,
} from './choices'
import { sanitizeMyDefaults, sanitizePlans } from './sanitize'
import { dropUnits, setUnits, unitChoices, unitScales, wholePerCopy } from './units'
import { BOILER_HEAT, BUS, resolveChoice } from './unfold'
import { separationsOf, withSeparation } from './separate'
import { canSeparateShared, mergeSingleUses, separateShared, setSeparation } from './separateAll'
import { buildingNameFor, itemNameFor, noun } from './plural'
import { BOILER_SETTINGS, STEAM_HEAT } from './steamBoiler'
import { legacyProgress, withoutLegacyProgress } from './store'
import type { MyDefaults, Plan, SavedRecipe, Separation } from './types'
import { PLANNER_UPGRADES, maxLevel, modifiers, upgradeLevel } from './upgrades'

const round1 = (x: number) => Math.round(x * 10) / 10

function plan(partial: Partial<Plan>): Plan {
  return { id: 't', name: 't', targets: [], producers: {}, machines: {}, ...partial }
}

function expectBalanced(result: PlanResult) {
  expect(result.status).toBe('ok')
  for (const b of result.balances) {
    const net = b.produced - b.consumed + b.fromBus + b.deficit - b.surplus
    const scale = Math.max(1, b.produced, b.consumed)
    expect(Math.abs(net - b.target) / scale).toBeLessThan(1e-6)
  }
}

describe('cauldron craft time/heat curve', () => {
  it('reproduces every fixed cauldron recipe time from the game data', () => {
    const fixed = gameRecipes.filter((r) => r.craftType === 'Cauldron')
    expect(fixed.length).toBeGreaterThan(0)
    for (const r of fixed) {
      const target = itemsByKey.get(r.output.item)!.cauldronTarget
      expect(round1(cauldronStats(target).seconds)).toBe(r.time)
    }
  })

  it('matches known values for Clay and Ruby', () => {
    expect(round1(cauldronStats(20).seconds)).toBe(3.6)
    expect(round1(cauldronStats(20).heatPerSecond)).toBe(4.6)
    expect(round1(cauldronStats(200000).heatPerSecond)).toBe(3131.3)
  })
})

describe('cauldron evaluation', () => {
  it('applies duplicate penalties', () => {
    const a = cauldronIngredients[10].key
    const b = cauldronIngredients[20].key
    const c = cauldronIngredients[30].key
    expect(evaluateNormal([a, b, c])!.ratio).toBe(1)
    expect(evaluateNormal([a, a, c])!.ratio).toBe(0.65)
    expect(evaluateNormal([a, a, a])!.ratio).toBe(0.5)
  })

  it('advanced cauldron never returns a target at or above the higher ingredient', () => {
    for (let i = 0; i < 40; i++) {
      const a = cauldronIngredients[(i * 7) % cauldronIngredients.length]
      const b = cauldronIngredients[(i * 13 + 5) % cauldronIngredients.length]
      if (a.key === b.key) continue
      const r = evaluateAdvanced([a.key, b.key])
      if (r) expect(r.output.cauldronTarget).toBeLessThan(Math.max(a.cauldronCost, b.cauldronCost))
    }
  })

  it('offers no liquids as cauldron ingredients', () => {
    expect(cauldronIngredients.length).toBeGreaterThan(0)
    expect(cauldronIngredients.some((i) => i.liquid)).toBe(false)
    expect(cauldronIngredients.some((i) => i.key === 'Brandy')).toBe(false)
    expect(cauldronIngredients.some((i) => i.key === 'WhisperingFields' || i.key === 'StrangeTide')).toBe(false)
  })

  it('reverse search never uses the target as its own ingredient', () => {
    for (const mode of ['normal', 'advanced'] as const)
      for (const target of ['GloomSpores', 'Catalyst2']) {
        const found = findRecipes(target, mode, cauldronIngredients, 20000)
        expect(found.some((f) => f.inputs.includes(target))).toBe(false)
      }
  })

  it('reverse search only returns combinations that really make the target', () => {
    const found = findRecipes('Clay', 'normal', cauldronIngredients, 200)
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(evaluateNormal(f.inputs as [string, string, string])!.output.key).toBe('Clay')
  })
})

describe('purchasing portal prices', () => {
  it('converts stock cost to copper per item (bulk raw materials are priced per bundle)', () => {
    expect(itemsByKey.get('Wood')!.buyPrice).toBe(200) // one log → 200 planks
    expect(itemsByKey.get('IronOre')!.buyPrice).toBe(1200) // one ore → 100 iron ingots
    expect(itemsByKey.get('LavenderSeed')!.buyPrice).toBe(16000) // 16 silver each
    expect(itemsByKey.get('WorldTreeSeed')!.buyPrice).toBe(5_000_000) // 50 gold each
    expect(itemsByKey.get('Catalyst2')!.buyPrice).toBeNull()
  })
})

describe('planner solver', () => {
  const mods = modifiers({})

  it('solves a plain chain with imports for raw materials', () => {
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
    const result = solvePlan(plan({ targets: [{ item: 'WoodBoard', rate: 60 }] }), catalog, mods)
    expectBalanced(result)
    const board = result.balances.find((b) => b.item === 'WoodBoard')!
    expect(board.produced).toBeCloseTo(60)
    expect(result.balances.every((b) => b.deficit === 0)).toBe(true)
    expect(result.runs.find((r) => r.process.id === 'buy:Wood')!.craftsPerMinute).toBeGreaterThan(0) // Logs, at a Purchasing Portal
  })

  it('works back from the target to fractional machine counts, scaled by Factory Efficiency', () => {
    // Table saw: 200 boards per 400 s → 30/min per machine at level 0; level 4 = +100%.
    for (const [level, machines] of [[0, 2], [4, 1]] as const) {
      const m = modifiers({ FactorySpeed: level })
      const catalog = buildCatalog({ saved: [], machines: {}, mods: m, fertilizer: null })
      const result = solvePlan(plan({ targets: [{ item: 'WoodBoard', rate: 60 }] }), catalog, m)
      expect(result.runs.find((r) => r.process.id === 'recipe:WoodBoard')!.machines).toBeCloseTo(machines)
    }
  })

  it('converts machine-count targets using the chosen producer and upgrades', () => {
    for (const [level, perSaw] of [[0, 30], [4, 60]] as const) {
      const m = modifiers({ FactorySpeed: level })
      const catalog = buildCatalog({ saved: [], machines: {}, mods: m, fertilizer: null })
      const result = solvePlan(plan({ targets: [{ item: 'WoodBoard', rate: 2, unit: 'machines' }] }), catalog, m)
      expect(result.targets[0].perMachine).toBeCloseTo(perSaw)
      expect(result.balances.find((b) => b.item === 'WoodBoard')!.produced).toBeCloseTo(2 * perSaw)
      expect(result.runs.find((r) => r.process.id === 'recipe:WoodBoard')!.machines).toBeCloseTo(2)
    }
  })

  it('1 Advanced Blender of Fertile Catalyst = its craft rate', () => {
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
    const result = solvePlan(plan({ targets: [{ item: 'Catalyst2', rate: 1, unit: 'machines' }] }), catalog, mods)
    const recipe = gameRecipes.find((r) => r.key === 'Catalyst2')!
    expect(result.targets[0].machineName).toBe('Advanced Blender')
    expect(result.targets[0].rate).toBeCloseTo(60 / (recipe.time * recipe.batch))
  })

  it('spreads fertilizer from the bus without expanding its production chain', () => {
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'AdvancedFertilizer' })
    const result = solvePlan(
      plan({ targets: [{ item: 'Flax', rate: 60 }], producers: { [NUTRIENTS]: 'fert:AdvancedFertilizer' } }),
      catalog,
      mods,
    )
    expectBalanced(result)
    expect(result.runs.some((r) => r.process.id === 'recipe:AdvancedFertilizer')).toBe(false)
    const fert = result.balances.find((b) => b.item === 'AdvancedFertilizer')!
    expect(fert.fromBus).toBeGreaterThan(0)
    expect(result.runs.some((r) => r.process.kind === 'buy' && r.process.product === 'AdvancedFertilizer')).toBe(false) // the bus isn't bought: it costs nothing here
  })

  describe('a loop where a saved cauldron recipe makes its own fertilizer', () => {
    // Needs a plant ingredient so the loop's nurseries consume the catalyst as fertilizer.
    const recipe = findRecipes('Catalyst2', 'normal', cauldronIngredients, 5000).find((r) => r.inputs.includes('Flax'))!
    const saved: SavedRecipe = { id: 'fc', mode: 'normal', inputs: recipe.inputs, output: 'Catalyst2', createdAt: 0 }
    const catalog = buildCatalog({ saved: [saved], machines: {}, mods, fertilizer: 'Catalyst2' })
    const loopPlan = (fertilizerFeedback: boolean) =>
      plan({
        targets: [{ item: 'Catalyst2', rate: 10 }],
        producers: { Catalyst2: 'cauldron:fc', [NUTRIENTS]: 'fert:Catalyst2' },
        ...(fertilizerFeedback && { feedbackItems: ['Catalyst2'] }),
      })
    const fertilizer = (p: Plan, result: PlanResult) => ledgers(p, result).find((l) => l.item === 'Catalyst2')!

    it('sizes the factory from the target and draws fertilizer from the bus', () => {
      const result = solvePlan(loopPlan(false), catalog, mods)
      expectBalanced(result)
      const fc = result.balances.find((b) => b.item === 'Catalyst2')!
      expect(fc.produced).toBeCloseTo(10)
      expect(fc.deficit).toBe(0) // any shortfall is reported deeper, where the chain breaks
      expect(fc.consumed).toBeCloseTo(fc.fromBus) // the nurseries spread only what the bus brings
      const ledger = fertilizer(loopPlan(false), result)
      expect(ledger.need).toBeGreaterThan(0)
      expect(ledger.uses).toEqual({ spread: ledger.need })
      expect(ledger.covered).toBe(0)
      expect(ledger.bus).toBeCloseTo(ledger.need)
      expect(ledger.sources).toMatchObject([{ item: 'Catalyst2', target: 0, amount: 10, fedBack: false, used: 0 }])
    })

    it('feedback covers the need from the target without changing the factory', () => {
      const off = solvePlan(loopPlan(false), catalog, mods)
      const on = solvePlan(loopPlan(true), catalog, mods)
      expect(on.runs.map((r) => r.machines)).toEqual(off.runs.map((r) => r.machines))
      const ledger = fertilizer(loopPlan(true), on)
      const [source] = ledger.sources
      expect(source.fedBack).toBe(true)
      expect(source.used).toBeCloseTo(Math.min(10, ledger.need))
      expect(source.used + ledger.bus).toBeCloseTo(ledger.need)
    })
  })
})

describe('production tree', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
  /** Every machine in the plan shows up in exactly one row. */
  const expectMachinesOnce = (r: PlanResult) => {
    const nodes = r.tree.flatMap(all)
    for (const run of r.runs.filter((x) => x.machines > 0 && x.process.machine)) {
      const shown = nodes.filter((n) => n.run?.key === run.key).reduce((sum, n) => sum + n.machines, 0)
      expect(shown, run.process.label).toBeCloseTo(run.machines)
    }
  }

  it('splits machines by branch and ends in purchases, paid with coins off the bus', () => {
    const targets = [{ item: 'WoodBoard', rate: 60 }]
    const [root] = solvePlan(plan({ targets }), catalog, mods).tree
    expect(root.kind).toBe('produce')
    expect(root.machines).toBeCloseTo(2)
    const wood = root.children.find((c) => c.item === 'Wood')!
    expect(wood).toMatchObject({ kind: 'produce', producer: 'buy:Wood' })
    expect(wood.rate).toBeCloseTo(0.3)
    expect(wood.machines).toBeCloseTo(0.3 / 60) // a Log per belt slot
    const [money] = wood.children
    expect(money).toMatchObject({ item: MONEY, producer: 'spend:GoldCoin' }) // every tier: gold buys it all at full speed
    expect(money.children[0]).toMatchObject({ item: 'GoldCoin', kind: 'bus' })
    expect(money.children[0].fromBus).toBeCloseTo((0.3 * 200) / 100_000) // 200 copper a Log
  })

  it('stops at cycles instead of recursing forever', () => {
    // Vitality Essence ← Oblivion Essence ← Vitality Essence (both Paradox Crucible recipes).
    const targets = [{ item: 'Vitae', rate: 10 }]
    const result = solvePlan(plan({ targets, producers: { Mors: 'recipe:Mors_Alt' } }), catalog, mods)
    const find = (nodes: TreeNode[]): TreeNode | undefined =>
      nodes.map((n) => (n.kind === 'loop' ? n : find(n.children))).find(Boolean)
    expect(find(result.tree)?.item).toBe('Vitae')
  })

  it('says at the source where by-products go and what overflows', () => {
    // Nectar only comes with Gentian: the Gentian row runs for the Nectar, so its own Gentian overflows.
    const [gentian, nectar] = solvePlan(
      plan({ targets: [{ item: 'Gentian', rate: 1 }, { item: 'GentianNectar', rate: 100 }] }),
      catalog,
      mods,
    ).tree
    const side = gentian.byproducts.find((b) => b.item === 'GentianNectar')!
    expect(side.to).toEqual([{ id: nectar.id, amount: expect.closeTo(100) }])
    expect(side.overflow).toBe(0)
    expect(gentian.rate).toBeCloseTo(1)
    expect(gentian.overflow).toBeCloseTo(side.count - 1)

    // Steel's failed Iron Ingots all go back into its own Iron Ingot supply: nothing overflows.
    const [steel] = solvePlan(plan({ targets: [{ item: 'SteelIngot', rate: 10 }] }), catalog, mods).tree
    const failed = steel.byproducts.find((b) => b.item === 'IronIngot')!
    expect(failed.to.map((t) => t.id)).toEqual([steel.children.find((c) => c.item === 'IronIngot')!.id])
    expect(failed.overflow).toBe(0)
    expect(steel.overflow).toBe(0)
  })

  it('lets a row make its own instead of reusing a by-product, and go back', () => {
    const base = plan({ targets: [{ item: 'CopperIngot', rate: 37.5 }, { item: 'BronzeIngot', rate: 50 }] })
    const impureRow = (p: Plan) => solvePlan(p, catalog, mods).tree[1].children.find((c) => c.item === 'CopperPowder')!
    // By default the Bronze's Impure Copper Powder comes from the Copper Ingot chain's Athanors.
    const reused = impureRow(base)
    expect(reused.reuse).toBe(true)
    expect(reused.fromByproduct).toBeGreaterThan(0)
    expect(defaultProducer(catalog, 'CopperPowder')).toBe('bus') // never run just for a failed craft

    // Made separately: its own Athanors run Copper Powder for their failed crafts, nothing reused.
    const own = chooseProducer(chooseReuse(base, 'CopperPowder', false, reused.id), catalog, {
      item: 'CopperPowder',
      producer: 'recipe:CopperPowder2',
      row: reused.id,
    })
    const made = impureRow(own)
    expect(made.reuse).toBe(false)
    expect(made.fromByproduct).toBe(0)
    expect(made.kind).toBe('produce')
    expect(made.producer).toBe('recipe:CopperPowder2')
    expect(made.rate).toBeCloseTo(50)
    // It keeps to itself: its Athanors' Copper Powder isn't taken by the Copper Ingot chain, which
    // runs its own Athanors (now overflowing their Impure Copper Powder) unless reuse is picked there.
    const copperRow = (p: Plan) => solvePlan(p, catalog, mods).tree[0].children.find((c) => c.item === 'CopperPowder2')!
    const pure = made.byproducts.find((b) => b.item === 'CopperPowder2')!
    expect(pure.to).toEqual([])
    expect(pure.overflow).toBeCloseTo(50)
    const copper = copperRow(own)
    expect(copper.kind).toBe('produce')
    expect(copper.fromByproduct).toBe(0)
    // Their Impure Copper Powder has no row of its own to go to now: it's recovered into Copper Powder.
    const impure = copper.byproducts.find((b) => b.item === 'CopperPowder')!
    expect(impure.overflow).toBe(0)
    expect(impure.to.length).toBeGreaterThan(0)

    // Picking reuse on the Copper Ingot side takes them after all.
    const linked = chooseReuse(own, 'CopperPowder2', true, copper.id)
    expect(copperRow(linked).reuseChosen).toBe(true)
    expect(copperRow(linked).fromByproduct).toBeCloseTo(37.5)

    // Reuse again on the Bronze side: the by-products are taken again, its Athanors making the rest.
    const back = chooseReuse(own, 'CopperPowder', true, reused.id)
    expect(back.branches).toEqual({ [reused.id]: { producer: 'recipe:CopperPowder2', reuse: true } })
    // Its rest would run the same Athanors the Copper Ingot chain does: those make all of it.
    expect(impureRow(back).kind).toBe('byproduct')
    expect(impureRow(back).fromByproduct).toBeCloseTo(50)
    // Everywhere: every row of the item makes its own, and back.
    const all = chooseReuse(base, 'CopperPowder', false)
    expect(all.noReuse).toEqual(['CopperPowder'])
    expect(impureRow(all).reuse).toBe(false)
    expect(chooseReuse(all, 'CopperPowder', true).noReuse).toBeUndefined()
  })

  it('picks what makes the rest apart from taking by-products first', () => {
    // Growth Potion (from Reddit): crushing Rock Salt for the Salt makes Sand on the side, which goes
    // into the Clay; Stone ground on Enhanced Grinders makes the rest.
    const base = plan({ targets: [{ item: 'GrowthPotion', rate: 2 }], producers: { Salt: 'recipe:Salt_Alt' } })
    const row = '0/GrowthPotion/ClayPowder/Clay/Sand'
    const sand = (p: Plan) => {
      const r = solvePlan(p, catalog, mods)
      expectBalanced(r)
      return rowsById(r.tree).get(row)!
    }
    const reused = sand(base).fromByproduct
    expect(reused).toBeGreaterThan(0)

    const enhanced = chooseProducer(base, catalog, { item: 'Sand', producer: 'recipe:Sand', machine: 'EnhancedGrinder', row })
    const rest = sand(enhanced)
    expect(rest.reuse).toBe(true)
    expect(rest.fromByproduct).toBeCloseTo(reused)
    expect(rest.run!.process.machine!.key).toBe('EnhancedGrinder')
    expect(rest.run!.outputs[0].count).toBeCloseTo(rest.rate - reused)

    // Off and on again: all of it on Enhanced Grinders, then back to the rest.
    const off = chooseReuse(enhanced, 'Sand', false, row)
    expect(sand(off).fromByproduct).toBe(0)
    expect(sand(off).run!.process.machine!.key).toBe('EnhancedGrinder')
    expect(sand(off).run!.outputs[0].count).toBeCloseTo(rest.rate)
    const on = chooseReuse(off, 'Sand', true, row)
    expect(sand(on).fromByproduct).toBeCloseTo(reused)
    expect(sand(on).run!.process.machine!.key).toBe('EnhancedGrinder')

    // Clearing the producer pick, or picking one for every row, leaves taking by-products as set.
    expect(clearBranchChoice(off, row).branches).toEqual({ [row]: { producer: '', reuse: false } })
    const everywhere = chooseProducer(off, catalog, { item: 'Sand', producer: 'recipe:Sand', machine: 'Grinder', everywhere: true })
    expect(sand(everywhere).reuse).toBe(false)
    expect(sand(everywhere).run!.process.machine!.key).toBe('Grinder')
    // Off where it's off anyway stores nothing.
    expect(chooseReuse(chooseReuse(base, 'Sand', false), 'Sand', false, row).branches ?? {}).toEqual({})
  })

  it('reuses only the by-products there are, never running their source harder for more', () => {
    // Mars: the Copper Bearings' Athanors fail into less Impure Copper Powder than the Bronze Rivets
    // need. A costly cauldron recipe makes the rest; growing the Athanors would be cheaper, but would
    // overflow Copper Powder.
    const saved: SavedRecipe = { id: 'imp', mode: 'normal', inputs: ['Charcoal', 'Jupiter', 'VitalityPotion'], output: 'CopperPowder', createdAt: 0 }
    const c = buildCatalog({ saved: [saved], machines: {}, mods, fertilizer: null })
    const r = solvePlan(plan({ targets: [{ item: 'Mars', rate: 1 }], producers: { CopperPowder: 'cauldron:imp' } }), c, mods)
    expectBalanced(r)
    const rows = rowsById(r.tree)
    const powder = rows.get('0/Mars/CopperBearing/CopperIngot/CopperPowder2')!
    const failed = powder.byproducts.find((b) => b.item === 'CopperPowder')!
    expect(powder.overflow).toBe(0)
    expect(failed.overflow).toBe(0)
    const impure = rows.get('0/Mars/BronzeRivet/BronzeIngot/CopperPowder')!
    expect(impure.kind).toBe('produce')
    expect(impure.fromByproduct).toBeCloseTo(failed.count)
    expect(impure.run!.outputs[0].count).toBeCloseTo(impure.rate - failed.count)
  })

  it('feeds a by-product to the row that uses it nearest its source', () => {
    // Steel fails into Iron Ingots, which go straight back into the Steel's own Iron Ingot supply.
    const [steel] = solvePlan(plan({ targets: [{ item: 'SteelIngot', rate: 10 }] }), catalog, mods).tree
    const iron = steel.children.find((c) => c.item === 'IronIngot')!
    const failed = steel.byproducts.find((b) => b.item === 'IronIngot')!.count
    expect(failed).toBeGreaterThan(0)
    expect(iron.byproductSources.map((s) => s.id)).toEqual([steel.id])
    expect(iron.fromByproduct).toBeCloseTo(failed)
  })

  it('shows every machine in exactly one row', () => {
    expectMachinesOnce(solvePlan(plan({ targets: [{ item: 'Sol', rate: 0.25 }] }), catalog, mods))
  })

  describe('building an item separately', () => {
    const targets = [{ item: 'Sol', rate: 0.25 }]
    const solve = (separate: Separation[] = []) => solvePlan(plan({ targets, separate }), catalog, mods)
    const keptSeparations = (separate: Separation[]) =>
      pruneChoices(plan({ targets, separate }), catalog)?.separate ?? separate
    const result = solve()

    it('gathers every use under one root, keeping each machine counted once', () => {
      const r = solve([{ item: 'WorldTreeLeaf' }])
      const nodes = r.tree.flatMap(all)
      const leafRoots = r.tree.filter((n) => n.item === 'WorldTreeLeaf')
      expect(leafRoots).toHaveLength(1)
      expect(leafRoots[0].consolidated).toBe(true)
      const balance = r.balances.find((b) => b.item === 'WorldTreeLeaf')!
      expect(leafRoots[0].rate).toBeCloseTo(balance.consumed + balance.target)

      const uses = nodes.filter((n) => n.item === 'WorldTreeLeaf' && !n.consolidated)
      expect(uses.length).toBeGreaterThan(1)
      expect(uses.every((n) => n.kind === 'separate' && n.children.length === 0 && n.machines === 0)).toBe(true)
      expectMachinesOnce(r)
    })

    it('ignores items no machine makes for the plan', () => {
      const bought = result.tree.flatMap(all).find((n) => n.kind === 'bus')!
      const nodes = solve([{ item: bought.item }]).tree.flatMap(all)
      expect(nodes.some((n) => n.consolidated)).toBe(false)
      expect(nodes.some((n) => n.item === bought.item && n.kind === 'bus')).toBe(true)
      expect(keptSeparations([{ item: bought.item }])).toEqual([])
    })

    it('uses the target row itself as the root when the target is separated', () => {
      const roots = solve([{ item: 'Sol' }]).tree
      expect(roots).toHaveLength(1)
      expect(roots[0].consolidated).toBe(true)
    })

    it('is forgotten once the item leaves the plan', () => {
      const p = plan({
        targets: [{ item: 'WoodBoard', rate: 1 }],
        separate: [{ item: 'WoodBoard' }, { item: 'WorldTreeLeaf' }, { item: 'WoodBoard', anchor: 'Sol' }],
      })
      expect(pruneChoices(p, catalog)?.separate).toEqual([{ item: 'WoodBoard' }])
    })

    it('reads plans saved before anchors as the top of the plan', () => {
      expect(separationsOf(['Plank'] as never)).toEqual([{ item: 'Plank' }])
    })

    describe('with an item above it', () => {
      // Fairy Dust is made in two branches of Sol, each grinding its own Chamomile.
      const dusts = result.tree.flatMap(all).filter((n) => n.item === 'FairyDust' && n.kind === 'produce')
      const chamomileUnder = (n: TreeNode) => all(n).filter((c) => c.item === 'Chamomile' && c !== n)

      it('finds the example it needs', () => {
        expect(dusts.length).toBeGreaterThan(1)
        expect(dusts.every((d) => chamomileUnder(d).length > 0)).toBe(true)
      })

      it('gathers the uses below every anchor row into a "with" row after its children', () => {
        const sep = { item: 'Chamomile', anchor: 'FairyDust' }
        const r = solve([sep])
        const nodes = r.tree.flatMap(all)
        const anchors = nodes.filter((n) => n.item === 'FairyDust' && n.kind === 'produce')
        for (const dust of anchors) {
          const group = dust.children.at(-1)!
          expect(group.item).toBe('Chamomile')
          expect(group.separation).toEqual(sep)
          const uses = chamomileUnder(dust).filter((n) => n.kind === 'separate')
          expect(uses.length).toBeGreaterThan(0)
          expect(uses.every((n) => n.groupId === group.id && n.groupAnchor === 'FairyDust')).toBe(true)
          expect(group.rate).toBeCloseTo(uses.reduce((sum, n) => sum + n.rate, 0))
        }
        expect(keptSeparations([sep])).toEqual([sep])
        expectMachinesOnce(r)
      })

      it('can gather under just one anchor row', () => {
        const sep = { item: 'Chamomile', anchor: 'FairyDust', at: dusts[0].id }
        const r = solve([sep])
        const nodes = r.tree.flatMap(all)
        const groups = nodes.filter((n) => n.separation)
        expect(groups).toHaveLength(1)
        expect(groups[0].id).toBe(`${dusts[0].id}/with:Chamomile`)
        const other = nodes.find((n) => n.id === dusts[1].id)!
        expect(chamomileUnder(other).some((n) => n.kind === 'produce')).toBe(true)
        expectMachinesOnce(r)
      })

      it('counts machines once when one gathered row feeds another, in either order', () => {
        const powder = { item: 'ChamomilePowder', anchor: 'FairyDust' }
        const herb = { item: 'Chamomile', anchor: 'FairyDust' }
        // Jupiter uses Planks directly and through its Pulleys.
        const plank = { item: 'WoodBoard', anchor: 'Jupiter' }
        const pulley = { item: 'WoodPulley', anchor: 'Jupiter' }
        for (const seps of [
          [powder, herb],
          [herb, powder],
          [plank, pulley],
          [pulley, plank],
        ]) {
          expect(keptSeparations(seps)).toEqual(seps)
          expectMachinesOnce(solve(seps))
        }
        const jupiter = solve([plank, pulley])
          .tree.flatMap(all)
          .find((n) => n.item === 'Jupiter')!
        const planks = jupiter.children.find((c) => c.item === 'WoodBoard' && c.consolidated)!
        const uses = all(jupiter).filter((n) => n.item === 'WoodBoard' && n.kind === 'separate')
        expect(uses.length).toBeGreaterThan(1)
        expect(planks.rate).toBeCloseTo(uses.reduce((sum, n) => sum + n.rate, 0))
      })

      it('forgets a choice whose anchor sits above none of its uses', () => {
        expect(keptSeparations([{ item: 'Chamomile', anchor: 'WorldTreeLeaf' }])).toEqual([])
      })
    })
  })

  describe('building every shared item separately', () => {
    const sol = plan({ targets: [{ item: 'Sol', rate: 0.25 }] })
    // Rows recovering outputs, and the rows supplying them, are never gathered.
    const outsideRecovery = (n: TreeNode): TreeNode[] => (n.recovery ? [] : [n, ...n.children.flatMap(outsideRecovery)])
    const madeIn = (p: Plan) => {
      const counts = new Map<string, number>()
      for (const n of solvePlan(p, catalog, mods).tree.flatMap(outsideRecovery))
        if (n.run && !n.consolidated && !n.item.startsWith('@')) counts.set(n.item, (counts.get(n.item) ?? 0) + 1)
      return counts
    }

    it('gathers each item made in several rows into one, under the nearest row above them all', () => {
      expect([...madeIn(sol).values()].some((c) => c > 1)).toBe(true)
      const p = separateShared(sol, catalog)
      const seps = separationsOf(p.separate)
      expect(seps.length).toBeGreaterThan(0)
      // Every row of Sol sits under its one target, so nothing goes to the top of the plan.
      expect(seps.every((s) => s.anchor)).toBe(true)
      expect([...madeIn(p).values()].every((c) => c <= 1)).toBe(true)
      expect(pruneChoices(p, catalog)).toBeNull()
      const r = solvePlan(p, catalog, mods)
      expectBalanced(r)
      expectMachinesOnce(r)
      expect(canSeparateShared(sol, catalog)).toBe(true)
      expect(canSeparateShared(p, catalog)).toBe(false)
      expect(separateShared(p, catalog)).toBe(p)
    })

    it('gathers rows under different targets at the top of the plan', () => {
      const p = plan({ targets: [{ item: 'WorldTreeLeaf', rate: 1 }, { item: 'Sol', rate: 0.25 }] })
      expect(separationsOf(separateShared(p, catalog).separate)).toContainEqual({ item: 'WorldTreeLeaf' })
    })

    it("keeps the plan's own choices", () => {
      const p = plan({ targets: sol.targets, separate: [{ item: 'FairyDust' }] })
      expect(separationsOf(separateShared(p, catalog).separate)).toContainEqual({ item: 'FairyDust' })
    })

    it('merges back items built separately for a single use, and only those', () => {
      const shared = separateShared(sol, catalog)
      expect(mergeSingleUses(shared, catalog)).toBe(shared)
      const single = { item: 'Sol' }
      const p = { ...shared, separate: [...separationsOf(shared.separate), single] }
      expect(mergeSingleUses(p, catalog).separate).toEqual(shared.separate)
    })

    it('keeps the settings of rows it merges back, even inside other rows it merges', () => {
      const athanor = buildCatalog({ saved: [], machines: { 'recipe:Coke': 'AdvancedAthanor' }, mods, fertilizer: null })
      const p = plan({
        targets: [{ item: 'Brandy', rate: 10 }],
        machines: { 'recipe:Coke': 'AdvancedAthanor' },
        separate: [{ item: 'CokePowder' }, { item: 'Coke' }],
        rowCatalysts: { 'separate/Coke': ['Catalyst2'] },
      })
      const merged = mergeSingleUses(p, athanor)
      expect(merged.separate).toEqual([])
      expect(merged.rowCatalysts).toEqual({ '0/Brandy/CokePowder/Coke': ['Catalyst2'] })
      const machines = (x: Plan) => solvePlan(x, athanor, mods).runs.reduce((sum, r) => sum + r.machines, 0)
      expect(machines(merged)).toBeCloseTo(machines(p))
      // Gathering leaves copies set up differently apart, and carries the settings of alike ones.
      const twice = plan({ ...merged, targets: [...merged.targets, { item: 'CokePowder', rate: 5 }] })
      expect(separationsOf(separateShared(twice, athanor).separate)).not.toContainEqual({ item: 'CokePowder' })
      const alike = { ...twice, rowCatalysts: { ...twice.rowCatalysts, '1/CokePowder/Coke': ['Catalyst2'] } }
      const shared = separateShared(alike, athanor)
      expect(separationsOf(shared.separate)).toContainEqual({ item: 'CokePowder' })
      expect(shared.rowCatalysts).toEqual({ '1/CokePowder/Coke': ['Catalyst2'] })
    })
  })

  describe('keeping row settings when building separately or merging back', () => {
    const athanor = buildCatalog({ saved: [], machines: { 'recipe:Coke': 'AdvancedAthanor' }, mods, fertilizer: null })
    const coke = (targets: Plan['targets'], rowCatalysts: Plan['rowCatalysts']) =>
      plan({ targets, machines: { 'recipe:Coke': 'AdvancedAthanor' }, rowCatalysts })
    const brandy = { item: 'Brandy', rate: 10 }

    it('round-trips', () => {
      const p = coke([brandy], { '0/Brandy/CokePowder/Coke': ['Catalyst2'] })
      const apart = setSeparation(p, athanor, { item: 'CokePowder' }, true, '0/Brandy/CokePowder')
      expect(apart.rowCatalysts).toEqual({ 'separate/CokePowder/Coke': ['Catalyst2'] })
      const back = setSeparation(apart, athanor, { item: 'CokePowder' }, false)
      expect(back.separate).toEqual([])
      expect(back.rowCatalysts).toEqual(p.rowCatalysts)
    })

    it('gives a merged row’s settings to every use', () => {
      const p = setSeparation(coke([brandy, { item: 'CokePowder', rate: 5 }], { '1/CokePowder/Coke': ['Catalyst2'] }), athanor, { item: 'CokePowder' }, true)
      expect(p.rowCatalysts).toEqual({ '1/CokePowder/Coke': ['Catalyst2'] })
      expect(setSeparation(p, athanor, { item: 'CokePowder' }, false).rowCatalysts).toEqual({
        '1/CokePowder/Coke': ['Catalyst2'],
        '0/Brandy/CokePowder/Coke': ['Catalyst2'],
      })
    })

    it('moves an item built separately to another place, with its settings', () => {
      const top = { item: 'CokePowder' }
      const p = setSeparation(coke([brandy], { '0/Brandy/CokePowder/Coke': ['Catalyst2'] }), athanor, top, true)
      const withBrandy = { item: 'CokePowder', anchor: 'Brandy' }
      const moved = setSeparation(p, athanor, withBrandy, true, 'separate/CokePowder', top)
      expect(moved.separate).toEqual([withBrandy])
      expect(moved.rowCatalysts).toEqual({ '0/Brandy/with:CokePowder/Coke': ['Catalyst2'] })
      // And back to the top.
      const back = setSeparation(moved, athanor, top, true, '0/Brandy/with:CokePowder', withBrandy)
      expect(back.separate).toEqual([top])
      expect(back.rowCatalysts).toEqual(p.rowCatalysts)
    })

    it('replaces the anchor it moves from, even one on another item', () => {
      const sol = plan({ targets: [{ item: 'Sol', rate: 0.25 }], separate: [{ item: 'Chamomile', anchor: 'Sol' }] })
      const every = { item: 'Chamomile', anchor: 'FairyDust' }
      expect(setSeparation(sol, catalog, every, true).separate).toHaveLength(2)
      const moved = setSeparation(sol, catalog, every, true, undefined, { item: 'Chamomile', anchor: 'Sol' })
      expect(moved.separate).toEqual([every])
      expectBalanced(solvePlan(moved, catalog, mods))
    })

    it('gathers the settings of the row it was chosen on first', () => {
      const p = coke([brandy, brandy], { '0/Brandy/CokePowder/Coke': ['Catalyst2'], '1/Brandy/CokePowder/Coke': ['Catalyst3'] })
      for (const at of ['0', '1'])
        expect(setSeparation(p, athanor, { item: 'CokePowder' }, true, `${at}/Brandy/CokePowder`).rowCatalysts).toEqual({
          'separate/CokePowder/Coke': p.rowCatalysts![`${at}/Brandy/CokePowder/Coke`],
        })
    })
  })

  describe('choosing where to build separately', () => {
    const top = { item: 'Plank' }
    const every = { item: 'Plank', anchor: 'Jupiter' }
    const one = { item: 'Plank', anchor: 'Jupiter', at: 'a' }
    const other = { item: 'Plank', anchor: 'Jupiter', at: 'b' }

    it('keeps the top of the plan and anchors apart for an item', () => {
      expect(withSeparation([every, { item: 'Logs' }], top)).toEqual([{ item: 'Logs' }, top])
      expect(withSeparation([top], every)).toEqual([every])
    })

    it('lets single anchor rows add up, and "every" replace them', () => {
      expect(withSeparation([one], other)).toEqual([one, other])
      expect(withSeparation([one, other], every)).toEqual([every])
      expect(withSeparation([every], one)).toEqual([one])
    })

    it('keeps anchors on different items', () => {
      const saturn = { item: 'Plank', anchor: 'Saturn' }
      expect(withSeparation([saturn], every)).toEqual([saturn, every])
    })
  })
})

describe('producers per branch', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
  const solved = (p: Plan) => solvePlan(p, catalog, mods)
  const rows = (r: PlanResult, item: string) => r.tree.flatMap(all).filter((n) => n.item === item)
  // Sol makes Fairy Dust in two branches.
  const sol = plan({ targets: [{ item: 'Sol', rate: 0.25 }] })
  const [first, second] = rows(solved(sol), 'FairyDust')

  it('applies a pick to its own branch only', () => {
    const p = chooseProducer(sol, catalog, { item: 'FairyDust', producer: 'bus', row: first.id })
    expect(p.branches).toEqual({ [first.id]: { producer: 'bus' } })
    const r = solved(p)
    expectBalanced(r)
    const [a, b] = rows(r, 'FairyDust')
    expect(a.kind).toBe('bus')
    expect(a.ownChoice).toBe(true)
    expect(b.kind).toBe('produce')
    expect(b.ownChoice).toBe(false)
    const dust = r.balances.find((x) => x.item === 'FairyDust')!
    expect(dust.fromBus).toBeCloseTo(a.rate)
    expect(dust.produced).toBeCloseTo(b.rate)
  })

  it('applies a pick everywhere on request, clearing branch picks', () => {
    const branch = chooseProducer(sol, catalog, { item: 'FairyDust', producer: 'bus', row: first.id })
    const p = chooseProducer(branch, catalog, { item: 'FairyDust', producer: 'bus', row: second.id, everywhere: true })
    expect(p.producers.FairyDust).toBe('bus')
    expect(p.branches).toEqual({})
    expect(rows(solved(p), 'FairyDust').every((n) => n.kind === 'bus')).toBe(true)
  })

  it("doesn't store a pick the row inherits anyway, and can clear one", () => {
    const same = chooseProducer(sol, catalog, { item: 'FairyDust', producer: first.producer, row: first.id })
    expect(same.branches ?? {}).toEqual({})
    const picked = chooseProducer(sol, catalog, { item: 'FairyDust', producer: 'bus', row: first.id })
    expect(clearBranchChoice(picked, first.id).branches).toEqual({})
  })

  it('covers rows of the same item further down the branch, the deepest pick winning', () => {
    const p = plan({ branches: { '0/WoodBoard': { producer: 'bus' }, '0/WoodBoard/X/WoodBoard/Y/WoodBoard': { producer: 'recipe:WoodBoard' } } })
    expect(resolveChoice(p, catalog, 'WoodBoard', '0/WoodBoard/X/WoodBoard').producer).toBe('bus')
    expect(resolveChoice(p, catalog, 'WoodBoard', '0/WoodBoard/X/WoodBoard').own).toBe(false)
    expect(resolveChoice(p, catalog, 'Wood', '0/WoodBoard/Wood').producer).not.toBe('recipe:WoodBoard')
    expect(resolveChoice(p, catalog, 'WoodBoard', '0/WoodBoard/X/WoodBoard/Y/WoodBoard/Z/WoodBoard').producer).toBe(
      'recipe:WoodBoard',
    )
    expect(resolveChoice(p, catalog, 'WoodBoard', '1/WoodBoard').producer).toBe('recipe:WoodBoard')
  })

  it('a pick on a row replaces picks below it for the same item', () => {
    const p = plan({ branches: { '0/A/WoodBoard': { producer: 'import' }, '0/A/Other': { producer: 'import' } } })
    const next = chooseProducer(p, catalog, { item: 'WoodBoard', producer: 'import', row: '0/A' })
    expect(next.branches).toEqual({ '0/A/Other': { producer: 'import' }, '0/A': { producer: 'import' } })
  })

  it('runs one recipe on different machines in different branches', () => {
    const coke = plan({ targets: [{ item: 'Coke', rate: 10 }, { item: 'Coke', rate: 10 }] })
    const p = chooseProducer(coke, catalog, { item: 'Coke', producer: 'recipe:Coke', machine: 'AdvancedAthanor', row: '1/Coke' })
    const r = solved(p)
    expectBalanced(r)
    const runs = r.runs.filter((x) => x.process.id === 'recipe:Coke')
    expect(runs.map((x) => x.process.machine?.key).sort()).toEqual(['AdvancedAthanor', 'Athanor'])
    expect(r.tree.map((n) => n.run?.process.machine?.key)).toEqual(['Athanor', 'AdvancedAthanor'])
  })

  describe('catalysts', () => {
    const coke = chooseProducer(
      plan({ targets: [{ item: 'Coke', rate: 10 }, { item: 'Coke', rate: 10 }] }),
      catalog,
      { item: 'Coke', producer: 'recipe:Coke', machine: 'AdvancedAthanor', everywhere: true },
    )
    const athanor = buildCatalog({ saved: [], machines: coke.machines, mods, fertilizer: null })

    it('loads into one row at a time', () => {
      const r = solvePlan(setRowCatalysts(coke, '1/Coke', ['Catalyst2']), athanor, mods)
      expectBalanced(r)
      expect(r.tree.map((n) => n.run?.process.catalysts)).toEqual([[], ['Catalyst2']])
      // Fertile doubles the output, so the second row needs half the machines.
      expect(r.tree[1].machines).toBeCloseTo(r.tree[0].machines / 2)
      expect(r.runs.filter((x) => x.process.id === 'recipe:Coke')).toHaveLength(2)
    })

    it('are dropped when the row no longer takes them', () => {
      const loaded = setRowCatalysts(coke, '1/Coke', ['Catalyst2'])
      expect(pruneChoices(loaded, athanor)).toBeNull()
      const plain = chooseProducer(loaded, athanor, { item: 'Coke', producer: 'recipe:Coke', machine: 'Athanor', row: '1/Coke' })
      expect(pruneChoices(plain, athanor)?.rowCatalysts).toEqual({})
      expect(setRowCatalysts(loaded, '1/Coke', []).rowCatalysts).toEqual({})
    })

    it('saved per recipe by older plans move onto every row running it', () => {
      const old = { ...coke, catalysts: { 'recipe:Coke': ['Catalyst1'] } }
      const moved = migrateCatalysts(old, athanor)!
      expect(moved.catalysts).toBeUndefined()
      expect(moved.rowCatalysts).toEqual({ '0/Coke': ['Catalyst1'], '1/Coke': ['Catalyst1'] })
      expect(migrateCatalysts(moved, athanor)).toBeNull()
    })
  })

  it('forgets picks for rows that left the plan', () => {
    const p = chooseProducer(sol, catalog, { item: 'FairyDust', producer: 'import', row: first.id })
    expect(pruneChoices(p, catalog)).toBeNull()
    expect(pruneChoices({ ...p, targets: [{ item: 'WoodBoard', rate: 1 }] }, catalog)?.branches).toEqual({})
  })
})

describe('forgetting choices', () => {
  const mods = modifiers({})
  const choices = {
    producers: { Coke: 'recipe:Coke', [HEAT]: 'fuel:Coal', [NUTRIENTS]: 'fert:BasicFertilizer' },
    machines: { 'recipe:Coke': 'AdvancedAthanor' },
    rowCatalysts: { '0/Coke': ['Catalyst1'] },
  }
  const catalog = buildCatalog({ saved: [], machines: choices.machines, mods, fertilizer: null })

  it("drops picks for items and processes that left the plan, keeping fuel and fertilizer", () => {
    const pruned = pruneChoices(plan({ targets: [{ item: 'WoodBoard', rate: 1 }], ...choices }), catalog)!
    expect(pruned.producers).toEqual({ [HEAT]: 'fuel:Coal', [NUTRIENTS]: 'fert:BasicFertilizer' })
    expect(pruned.machines).toEqual({})
    expect(pruned.rowCatalysts).toEqual({})
  })

  it('runs Steam Boilers on the game’s Low/Medium/High settings, scaled by Factory Efficiency', () => {
    const boilers = BOILER_SETTINGS.map((s) => catalog.byId.get(`boiler:${s.name}`)!)
    const heatPerSecond = (p: Process, m: ReturnType<typeof modifiers>) =>
      (p.inputs.find((s) => s.item === HEAT)!.count * craftsPerMachine(p, m)) / 60
    expect(boilers.map((b) => heatPerSecond(b, mods))).toEqual([100, 500, 3000])
    expect(heatPerSecond(boilers[2], modifiers({ FactorySpeed: 4 }))).toBeCloseTo(6000)
    expect(boilers.map((b) => b.outputs[0].count * STEAM_HEAT)).toEqual(boilers.map((b) => b.inputs[0].count)) // lossless
  })

  it('keeps a heat pick of Steam: heating pads are a heat source', () => {
    const steam = plan({ targets: [{ item: 'WoodBoard', rate: 1 }], producers: { [HEAT]: 'fuel:Steam' } })
    expect(catalog.byProduct.get(HEAT)!.map((p) => p.id)).toContain('fuel:Steam')
    expect(pruneChoices(steam, catalog)).toBeNull()
  })

  it('keeps picks still in use', () => {
    expect(pruneChoices(plan({ targets: [{ item: 'Coke', rate: 1 }], ...choices }), catalog)).toBeNull()
  })

  it('drops built marks on rows that left the plan or run no machines', () => {
    const p = plan({ targets: [{ item: 'Coke', rate: 1 }], ...choices, built: ['0/Coke', '0/Gone'] })
    expect(pruneChoices(p, catalog)!.built).toEqual(['0/Coke'])
    const bought = plan({ targets: [{ item: 'Coke', rate: 1 }], ...choices, producers: { Coke: 'import' }, built: ['0/Coke'] })
    expect(pruneChoices(bought, catalog)!.built).toBeUndefined()
  })
})

describe('build checklist', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })

  it('marks and unmarks rows, round-tripping to no marks', () => {
    const p = plan({ targets: [{ item: 'WoodBoard', rate: 1 }] })
    const marked = setBuilt(p, ['0/WoodBoard', '0/WoodBoard/Log'], true)
    expect(marked.built).toEqual(['0/WoodBoard', '0/WoodBoard/Log'])
    expect(setBuilt(marked, ['0/WoodBoard'], false).built).toEqual(['0/WoodBoard/Log'])
    expect(setBuilt(marked, ['0/WoodBoard', '0/WoodBoard/Log'], false).built).toBeUndefined()
  })

  it('changes nothing the plan makes', () => {
    const p = plan({ targets: [{ item: 'WoodBoard', rate: 10 }] })
    const marked = setBuilt(p, ['0/WoodBoard'], true)
    expect(solvePlan(marked, catalog, mods).tree).toEqual(solvePlan(p, catalog, mods).tree)
  })

  it('moves marks with their target', () => {
    const p = setBuilt(plan({ targets: [{ item: 'WoodBoard', rate: 1 }, { item: 'Coke', rate: 1 }] }), ['1/Coke'], true)
    expect(moveTarget(p, 1, 0).built).toEqual(['0/Coke'])
    expect(removeTarget(p, 1).built).toBeUndefined()
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

describe('ingredient groups and preferences', () => {
  const group = (id: string) => builtinGroups.find((g) => g.id === id)!

  it('derives nursery and portal presets from the game data', () => {
    for (const k of ['Flax', 'Gentian', 'GentianNectar', 'Redcurrant']) expect(group('grown').items.has(k)).toBe(true)
    expect(group('grown').items.has('FlaxFiber')).toBe(false)
    expect(group('grown+1').items.has('FlaxFiber')).toBe(true) // Flax → Flax Fiber
    expect(group('bought').items.has('IronOre')).toBe(true)
    expect(group('bought+1').items.has('IronIngot')).toBe(true) // Iron Ore → Iron Ingot
    expect(group('bought+1').items.has('SteelIngot')).toBe(false) // needs more than portal goods
    // No liquids: they can't go in a cauldron.
    for (const g of builtinGroups) for (const k of g.items) expect(itemsByKey.get(k)!.liquid).toBe(false)
  })

  it('never searches avoided ingredients and can restrict to preferred ones', () => {
    let prefs = setPrefs(emptyPrefs, group('tag:Component').items, 'avoid')
    const allowed = new Set(allowedIngredients(prefs).map((i) => i.key))
    for (const k of group('tag:Component').items) expect(allowed.has(k)).toBe(false)
    for (const r of findRecipes('Catalyst2', 'normal', allowedIngredients(prefs), 5000))
      for (const k of r.inputs) expect(group('tag:Component').items.has(k)).toBe(false)

    prefs = { ...onlyGroup(emptyPrefs, group('grown+1')), onlyPreferred: true }
    for (const i of allowedIngredients(prefs)) expect(group('grown+1').items.has(i.key)).toBe(true)
    expect(preferredCount(prefs, ['Flax', 'Flax', 'IronOre'])).toBe(2)
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

describe('heat and nutrients as rows', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
  const rows = (r: PlanResult) => r.tree.flatMap(all)
  // Steel Ingots take Coke Powder as an ingredient, and the plan burns it too.
  const steel = plan({ targets: [{ item: 'SteelIngot', rate: 10 }], producers: { [HEAT]: 'fuel:CokePowder' } })

  it("gives each heated row a Heat row burning the plan's fuel, taken from the bus", () => {
    const result = solvePlan(steel, catalog, mods)
    expectBalanced(result)
    const heat = rows(result).filter((n) => n.item === HEAT)
    expect(heat.length).toBeGreaterThan(1)
    for (const h of heat) {
      expect(h.producer).toBe('fuel:CokePowder')
      expect(h.machines).toBe(0) // furnaces pass the heat on without loss: not counted
      expect(h.children).toHaveLength(1)
      expect(h.children[0]).toMatchObject({ item: 'CokePowder', kind: 'bus', producer: 'bus' })
      expect(h.children[0].fromBus * 660).toBeCloseTo(h.rate)
    }
    // The ingredient is made; the fuel comes off the bus.
    const powder = result.balances.find((b) => b.item === 'CokePowder')!
    expect(powder.fromBus).toBeCloseTo(heat.reduce((t, h) => t + h.children[0].fromBus, 0))
    expect(powder.produced).toBeCloseTo(powder.consumed - powder.fromBus)
  })

  it('burns another fuel in one branch when picked there', () => {
    const first = solvePlan(steel, catalog, mods).tree[0].children.find((c) => c.item === HEAT)!
    const p = chooseProducer(steel, catalog, { item: HEAT, producer: 'fuel:WoodBoard', row: first.id })
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    const heat = rows(result).filter((n) => n.item === HEAT)
    expect(heat.find((h) => h.id === first.id)).toMatchObject({ producer: 'fuel:WoodBoard', children: [{ item: 'WoodBoard', kind: 'bus' }] })
    const others = heat.filter((h) => h.id !== first.id)
    expect(others.length).toBeGreaterThan(0)
    expect(others.every((h) => h.producer === 'fuel:CokePowder')).toBe(true)
  })

  it('makes the fuel in the plan where its branch picks how, whatever the plan-wide pick', () => {
    const id = `0/SteelIngot/${HEAT}/CokePowder`
    const made = chooseProducer(steel, catalog, { item: 'CokePowder', producer: 'recipe:CokePowder', row: id })
    expect(made.branches).toEqual({ [id]: { producer: 'recipe:CokePowder' } })
    const result = solvePlan(made, catalog, mods)
    expectBalanced(result)
    const fuel = rows(result).find((n) => n.id === id)!
    expect(fuel).toMatchObject({ kind: 'produce', producer: 'recipe:CokePowder', fromBus: 0 })
    // Plan-wide picks are for the item as an ingredient: older plans have many.
    const everywhere = { ...steel, producers: { ...steel.producers, CokePowder: 'recipe:CokePowder' } }
    expect(rows(solvePlan(everywhere, catalog, mods)).find((n) => n.id === id)!.kind).toBe('bus')
  })

  it('heats with Steam from the bus, on heating pads', () => {
    const p = plan({ targets: [{ item: 'SteelIngot', rate: 10 }], producers: { [HEAT]: STEAM_HEAT_ID } })
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    const pads = rows(result).filter((n) => n.item === HEAT && n.producer === STEAM_HEAT_ID)
    expect(pads.length).toBeGreaterThan(1)
    for (const pad of pads) {
      expect(pad.children[0]).toMatchObject({ item: 'Steam', kind: 'bus' })
      expect(pad.children[0].rate * 20).toBeCloseTo(pad.rate) // 20 P per Steam
    }
    expect(rows(result).some((n) => n.item === 'Steam' && n.kind === 'produce')).toBe(false)
    const [steam] = ledgers(p, result)
    expect(steam).toMatchObject({ item: 'Steam', uses: { burn: steam.need } })
  })

  it('makes the Steam in the plan when asked, its boilers burning a solid fuel', () => {
    const p = addProvider(plan({ targets: [{ item: 'SteelIngot', rate: 10 }], producers: { [HEAT]: STEAM_HEAT_ID } }), 'Steam')
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    const boilers = result.tree[1]
    expect(targetItems.some((i) => i.key === 'Steam')).toBe(true) // its target row can show it
    expect(boilers).toMatchObject({ item: 'Steam', kind: 'produce', producer: 'boiler:High' })
    expect(boilers.machines).toBeCloseTo(boilers.rate / 9000) // High: 300 Steam every 2 s
    const heat = boilers.children.find((c) => c.item === HEAT)!
    expect(heat.producer).toBe(defaultProducer(catalog, HEAT))
    expect(heat.rate).toBeCloseTo(boilers.rate * 20)
    const [steam, fuel] = [...ledgers(p, result)].sort((a) => (a.item === 'Steam' ? -1 : 1))
    expect(steam).toMatchObject({ item: 'Steam', absorbedBy: 1, bus: 0 })
    expect(boilers.rate).toBeCloseTo(steam.need)
    // What the boilers burn comes off the bus instead.
    expect(fuel.item).toBe(catalog.byId.get(defaultProducer(catalog, HEAT))!.inputs[0].item)
    expect(fuel.need * catalog.byId.get(defaultProducer(catalog, HEAT))!.outputs[0].count).toBeCloseTo(heat.rate)
  })

  it("burns the plan's pick for boilers when it heats with Steam, else the best solid fuel", () => {
    const steam = addProvider(plan({ targets: [{ item: 'SteelIngot', rate: 10 }], producers: { [HEAT]: STEAM_HEAT_ID } }), 'Steam')
    const boilerHeat = (p: Plan) => solvePlan(p, catalog, mods).tree[1].children.find((c) => c.item === HEAT)!.producer
    expect(boilerHeat(steam)).toBe(defaultProducer(catalog, HEAT))
    const coal = setPlanDefault(steam, BOILER_HEAT, 'fuel:Coal')
    expect(boilerHeat(coal)).toBe('fuel:Coal')
    // Kept with the plan's other defaults, even before anything needs them.
    const empty = { ...coal, targets: [], producers: { ...coal.producers, [MONEY]: 'spend:CopperCoin' } }
    expect(pruneChoices(empty, catalog)).toBeNull()
  })

  it('changes the default fuel without losing the rows that pick their own, which can follow it after', () => {
    const first = solvePlan(steel, catalog, mods).tree[0].children.find((c) => c.item === HEAT)!
    const picked = chooseProducer(steel, catalog, { item: HEAT, producer: 'fuel:WoodBoard', row: first.id })
    const changed = setPlanDefault(picked, HEAT, 'fuel:Charcoal')
    expect(changed.branches).toEqual(picked.branches)
    expect(ownPicks(changed, catalog, HEAT)).toEqual([first.id])
    const heat = rows(solvePlan(changed, catalog, mods)).filter((n) => n.item === HEAT)
    expect(heat.find((h) => h.id === first.id)!.producer).toBe('fuel:WoodBoard')
    expect(heat.filter((h) => h.id !== first.id).every((h) => h.producer === 'fuel:Charcoal')).toBe(true)
    const all = followDefault(changed, HEAT)
    expect(ownPicks(all, catalog, HEAT)).toEqual([])
    expect(rows(solvePlan(all, catalog, mods)).filter((n) => n.item === HEAT).every((h) => h.producer === 'fuel:Charcoal')).toBe(true)
  })

  it('never heats a boiler with Steam, even when picked there', () => {
    const p = plan({ targets: [{ item: 'Steam', rate: 9000 }], branches: { [`0/Steam/${HEAT}`]: { producer: STEAM_HEAT_ID } } })
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    expect(result.tree[0].machines).toBeCloseTo(1)
    expect(result.tree[0].children[0]).toMatchObject({ item: HEAT, producer: defaultProducer(catalog, HEAT) })
  })

  it('grows nurseries at the speed of the fertilizer their own row spreads', () => {
    const flax = plan({ targets: [{ item: 'Flax', rate: 60 }], producers: { [NUTRIENTS]: 'fert:BasicFertilizer' } })
    const basic = solvePlan(flax, catalog, mods)
    const picked = chooseProducer(flax, catalog, { item: NUTRIENTS, producer: 'fert:AdvancedFertilizer', row: `0/Flax/${NUTRIENTS}` })
    const advanced = solvePlan(picked, catalog, mods)
    expectBalanced(advanced)
    expect(basic.tree[0].run!.process.fertilizer).toBe('BasicFertilizer')
    expect(advanced.tree[0].run!.process.fertilizer).toBe('AdvancedFertilizer')
    // 144 nutrients/s instead of 12: one machine fills its output belt.
    expect(advanced.tree[0].machines).toBeCloseTo(1)
    expect(basic.tree[0].machines).toBeCloseTo(2)
    expect(advanced.tree[0].children[0].children[0]).toMatchObject({ item: 'AdvancedFertilizer', kind: 'bus' })
  })

  it('groups heated rows into networks: one per fuel off the bus, one per row making it', () => {
    const steel = plan({ targets: [{ item: 'SteelIngot', rate: 10 }], producers: { [HEAT]: STEAM_HEAT_ID } })
    const before = solvePlan(steel, catalog, mods)
    const pads = rows(before).filter((n) => n.item === HEAT)
    const [bus] = heatNetworks(before.tree)
    expect(heatNetworks(before.tree)).toHaveLength(1)
    expect(bus).toMatchObject({ key: 'bus:Steam', fuel: 'Steam', pads: true, source: { kind: 'bus' } })
    expect(bus.uses).toHaveLength(pads.length)
    expect(bus.heat).toBeCloseTo(rows(before).reduce((t, n) => t + n.heat, 0))
    expect(bus.rate * 20).toBeCloseTo(bus.heat * 60) // 20 P per Steam
    expect(bus.uses[0].trail[0]).toBe(before.tree[0]) // from its target down

    // One row's Steam made in the plan: its own network, whose boilers sit on the boiler fuel's.
    const steamRow = bus.uses[0].fuelRow.id
    const result = solvePlan(chooseProducer(steel, catalog, { item: 'Steam', producer: 'boiler:High', row: steamRow }), catalog, mods)
    const nets = heatNetworks(result.tree)
    const made = nets.find((n) => n.key === `row:${steamRow}`)!
    expect(made).toMatchObject({ fuel: 'Steam', pads: true, source: { kind: 'row', row: { id: steamRow, kind: 'produce' } } })
    expect(made.uses).toHaveLength(1)
    const boilerFuel = nets.find((n) => n.uses.some((u) => u.row.id === steamRow))!
    expect(boilerFuel).toMatchObject({ pads: false, source: { kind: 'bus' } })
    expect(nets.find((n) => n.key === 'bus:Steam')!.uses).toHaveLength(pads.length - 1)
  })

  it('switches a whole network to one shared boiler bank and back to the bus', () => {
    const steel = plan({ targets: [{ item: 'SteelIngot', rate: 10 }], producers: { [HEAT]: STEAM_HEAT_ID } })
    const [bus] = heatNetworks(solvePlan(steel, catalog, mods).tree)
    const banked = setNetworkSource(steel, catalog, bus, 'boiler:Low')
    const result = solvePlan(banked, catalog, mods)
    expectBalanced(result)
    const nets = heatNetworks(result.tree)
    const steam = nets.filter((n) => n.fuel === 'Steam')
    expect(steam).toHaveLength(1)
    expect(steam[0].uses).toHaveLength(bus.uses.length)
    expect(steam[0].source).toMatchObject({ kind: 'row', row: { producer: 'boiler:Low', consolidated: true } })
    expect(steam[0].rate).toBeCloseTo(bus.rate)
    // Another setting for the bank, then back to the bus: as it was.
    expect(heatNetworks(solvePlan(setNetworkSource(banked, catalog, steam[0], 'boiler:High'), catalog, mods).tree).find((n) => n.fuel === 'Steam')!.source)
      .toMatchObject({ kind: 'row', row: { producer: 'boiler:High' } })
    const back = setNetworkSource(banked, catalog, steam[0], BUS)
    const again = heatNetworks(solvePlan(back, catalog, mods).tree)
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ key: 'bus:Steam', uses: { length: bus.uses.length } })
    expect(pruneChoices(back, catalog)?.separate ?? back.separate ?? []).toEqual([])
  })

  it('switches what a whole network burns', () => {
    const steel = plan({ targets: [{ item: 'SteelIngot', rate: 10 }], producers: { [HEAT]: STEAM_HEAT_ID } })
    const [bus] = heatNetworks(solvePlan(steel, catalog, mods).tree)
    const coal = heatNetworks(solvePlan(setNetworkFuel(steel, catalog, bus, 'fuel:Coal'), catalog, mods).tree)
    expect(coal).toHaveLength(1)
    expect(coal[0]).toMatchObject({ key: 'bus:Coal', pads: false, uses: { length: bus.uses.length } })
  })
})

describe('taking items from the bus', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })

  it('takes any row from the bus instead of making it, at no money cost', () => {
    const made = plan({ targets: [{ item: 'SteelIngot', rate: 10 }] })
    const p = chooseProducer(made, catalog, { item: 'CokePowder', producer: 'bus', row: '0/SteelIngot/CokePowder' })
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    const powder = result.tree[0].children.find((c) => c.item === 'CokePowder')!
    expect(powder).toMatchObject({ kind: 'bus', producer: 'bus', children: [] })
    expect(powder.fromBus).toBeCloseTo(powder.rate)
    expect(result.runs.some((r) => r.process.id === 'recipe:CokePowder')).toBe(false)
    const money = moneyLedger(p, result, ledgers(p, result))
    expect(money.purchases.some((l) => l.item === 'CokePowder')).toBe(false)
  })

  it('reads plans that bought what portals never sold as taking it from the bus', () => {
    const p = plan({ targets: [{ item: 'FairyDust', rate: 5 }], producers: { FairyDust: 'import' } })
    expect(resolveChoice(p, catalog, 'FairyDust', '0/FairyDust').producer).toBe('bus')
    expect(solvePlan(p, catalog, mods).balances.find((b) => b.item === 'FairyDust')).toMatchObject({ fromBus: 5 })
  })

  describe('Fertile Catalyst both loaded into Advanced Athanors and spread on nurseries', () => {
    const athanors = buildCatalog({ saved: [], machines: { 'recipe:Coke': 'AdvancedAthanor' }, mods, fertilizer: 'Catalyst2' })
    const both = plan({
      targets: [
        { item: 'Coke', rate: 60 },
        { item: 'Flax', rate: 600 },
      ],
      producers: { [NUTRIENTS]: 'fert:Catalyst2' },
      rowCatalysts: { '0/Coke': ['Catalyst2'] },
      branches: { '0/Coke/Catalyst2': { producer: 'bus' } },
    })

    it('takes both from the bus as one item', () => {
      const result = solvePlan(both, athanors, mods)
      expectBalanced(result)
      const [fc] = ledgers(both, result).filter((l) => l.item === 'Catalyst2')
      expect(fc.uses.use).toBeGreaterThan(0)
      expect(fc.uses.spread).toBeGreaterThan(0)
      expect(fc.need).toBeCloseTo(fc.uses.use! + fc.uses.spread!)
      expect(fc.bus).toBeCloseTo(fc.need)
      expect(result.runs.some((r) => r.process.id === 'recipe:Catalyst2')).toBe(false)
    })

    it('covers both from a fed-back net-surplus target', () => {
      const provided = addProvider(both, 'Catalyst2')
      const result = solvePlan(provided, athanors, mods)
      expectBalanced(result)
      const [fc] = ledgers(provided, result).filter((l) => l.item === 'Catalyst2')
      expect(fc.absorbedBy).toBe(2)
      expect(fc.bus).toBe(0)
      expect(fc.short).toBe(0)
      expect(fc.covered).toBeCloseTo(fc.need)
      expect(result.targets[2].made).toBeCloseTo(fc.need)
      expect(result.balances.find((b) => b.item === 'Catalyst2')!.fromBus).toBe(0)
    })
  })
})

describe('feeding output back in place of the bus', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  // Planks (WoodBoard) are a fuel; Steel Ingots need heat; the plan burns planks.
  const base = plan({
    targets: [
      { item: 'WoodBoard', rate: 1 },
      { item: 'WoodBoard', rate: 1e5 },
      { item: 'SteelIngot', rate: 10 },
    ],
    producers: { [HEAT]: 'fuel:WoodBoard' },
  })
  const planks = (p: Plan) => ledgers(p, solvePlan(p, catalog, mods)).find((l) => l.item === 'WoodBoard')!

  it('takes everything from the bus unless the plan feeds back', () => {
    const l = planks(base)
    expect(l.need).toBeGreaterThan(1)
    expect(l.uses).toEqual({ burn: l.need })
    expect(l.covered).toBe(0)
    expect(l.bus).toBeCloseTo(l.need)
    expect(l.sources.map((s) => [s.target, s.fedBack])).toEqual([
      [0, false],
      [1, false],
    ])
  })

  it('takes fed-back targets in target order, then the bus', () => {
    const l = planks({ ...base, feedbackItems: ['WoodBoard'] })
    const [first, second] = l.sources
    expect(first.used).toBeCloseTo(1) // all of it, before the second target
    expect(second.used).toBeCloseTo(l.need - 1)
    expect(l.covered).toBeCloseTo(l.need)
    expect(l.bus).toBe(0)

    const moved = planks(moveTarget({ ...base, feedbackItems: ['WoodBoard'] }, 1, 0))
    expect(moved.sources[0]).toMatchObject({ target: 0, amount: 1e5 })
    expect(moved.sources[1].used).toBe(0) // the big target covers it all now
  })

  it('lets a target set its own feedback, and dropping it again restores the plan', () => {
    const fed = { ...base, feedbackItems: ['WoodBoard'] }
    const optedOut = setTargetFeedback(fed, 1, false)
    expect(optedOut.targets[1].feedback).toBe(false)
    const l = planks(optedOut)
    expect(l.sources[1]).toMatchObject({ fedBack: false, used: 0 })
    expect(l.bus).toBeGreaterThan(0)
    expect(setTargetFeedback(optedOut, 1, true)).toEqual(fed)
    // Turning the item off keeps the target's own setting.
    expect(setItemFeedback(setTargetFeedback(base, 0, true), 'WoodBoard', true).targets[0].feedback).toBe(true)
    expect(setItemFeedback(setItemFeedback(base, 'WoodBoard', true), 'WoodBoard', false)).toEqual({ ...base, feedbackItems: undefined })
  })

  it('never changes the factory', () => {
    const off = solvePlan(base, catalog, mods)
    const on = solvePlan({ ...base, feedbackItems: ['WoodBoard'] }, catalog, mods)
    expect(on.runs.map((r) => r.machines)).toEqual(off.runs.map((r) => r.machines))
  })

  it('moves feedback from plans saved per use to the items they fed back', () => {
    const legacy = plan({ ...base, feedback: { fuel: true, fertilizer: false } })
    const migrated = migrateFeedback(legacy, catalog)!
    expect(migrated.feedbackItems).toEqual(['WoodBoard'])
    expect(migrated).not.toHaveProperty('feedback')
    expect(migrateFeedback(migrated, catalog)).toBeNull()
  })

  it('forgets fed-back items the plan no longer makes', () => {
    const pruned = pruneChoices({ ...base, feedbackItems: ['WoodBoard', 'PanaceaElixir'] }, catalog)!
    expect(pruned.feedbackItems).toEqual(['WoodBoard'])
  })

  it('nets an item that is both burned and spread once', () => {
    // Panacea Potion (internally PanaceaElixir) is the one item that's both fuel and fertilizer.
    const both = plan({
      targets: [
        { item: 'PanaceaElixir', rate: 12.5 },
        { item: 'SteelIngot', rate: 10 },
        { item: 'Flax', rate: 60 },
      ],
      producers: { [NUTRIENTS]: 'fert:PanaceaElixir', [HEAT]: 'fuel:PanaceaElixir' },
      feedbackItems: ['PanaceaElixir'],
    })
    const panacea = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'PanaceaElixir' })
    const result = solvePlan(both, panacea, mods)
    const [l] = ledgers(both, result)
    expect(l.item).toBe('PanaceaElixir')
    expect(l.uses.burn).toBeGreaterThan(0)
    expect(l.uses.spread).toBeGreaterThan(0)
    expect(l.sources[0].used).toBeCloseTo(Math.min(12.5, l.need))
    expect(l.sources[0].used + l.bus).toBeCloseTo(l.need)
    const money = moneyLedger(both, result, [l])
    const out = money.outputs.find((o) => o.item === 'PanaceaElixir')!
    expect(out.feeds).toEqual(['plan'])
    expect(out.toBus).toBeCloseTo(12.5 - out.used.plan!)
  })
})

describe('net-surplus targets', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const solved = (p: Plan, item = 'WoodBoard') => {
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    return { result, fuel: ledgers(p, result).find((l) => l.item === item)! }
  }
  const steel = { item: 'SteelIngot', rate: 10 }
  const fed = (targets: Plan['targets'], fuel = 'WoodBoard') =>
    plan({ targets, producers: { [HEAT]: `fuel:${fuel}` }, feedbackItems: ['WoodBoard', 'CokePowder'] })

  it('builds enough to cover what the plan burns and still deliver the rate', () => {
    const { result, fuel } = solved(fed([{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel]))
    const [source] = fuel.sources
    expect(fuel.absorbedBy).toBe(0)
    expect(fuel.bus).toBe(0)
    expect(fuel.short).toBe(0)
    expect(source.used).toBeCloseTo(fuel.need)
    expect(source.amount - source.used).toBeCloseTo(50)
    expect(result.targets[0]).toMatchObject({ rate: 50 })
    expect(result.targets[0].made).toBeCloseTo(source.amount)
    expect(result.balances.find((b) => b.item === 'WoodBoard')!.deficit).toBe(0)
    expect(result.tree[0].rate).toBeCloseTo(source.amount) // the row is built for all of it
  })

  it('covers only what the fed-back targets ahead of it leave', () => {
    const alone = solved(fed([{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel]))
    const { fuel } = solved(fed([{ item: 'WoodBoard', rate: 100 }, steel, { item: 'WoodBoard', rate: 50, unit: 'net' }]))
    const [ahead, net] = fuel.sources
    expect(ahead.used).toBeCloseTo(100)
    expect(net.target).toBe(2)
    expect(net.used).toBeCloseTo(fuel.need - 100)
    expect(net.amount - net.used).toBeCloseTo(50)
    expect(net.amount).toBeCloseTo(alone.fuel.sources[0].amount - 100)
  })

  it('leaves the targets after it unburned', () => {
    const { fuel } = solved(fed([{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel, { item: 'WoodBoard', rate: 100 }]))
    expect(fuel.sources.map((s) => s.target)).toEqual([0, 2])
    expect(fuel.sources[1].used).toBe(0)
    expect(fuel.sources[0].used).toBeCloseTo(fuel.need)
  })

  it('counts what its own chain burns', () => {
    // Coke Powder comes from Coke, which Athanors make with heat.
    const { result, fuel } = solved(fed([{ item: 'CokePowder', rate: 10, unit: 'net' }], 'CokePowder'), 'CokePowder')
    expect(fuel.need).toBeGreaterThan(0)
    expect(fuel.covered).toBeCloseTo(fuel.need)
    expect(fuel.sources[0].amount - fuel.sources[0].used).toBeCloseTo(10)
    expect(result.targets[0].made).toBeCloseTo(10 + fuel.need)
  })

  it('takes fed-back overflow first, though it grows with the target', () => {
    // Without reuse, the Charcoal the Coke Athanors make on the side overflows: more Charcoal net,
    // more of it. The solve settles on a build where the overflow and the target cover the burning.
    const p = plan({
      targets: [{ item: 'Charcoal', rate: 10, unit: 'net' }, steel],
      producers: { [HEAT]: 'fuel:Charcoal' },
      noReuse: ['Charcoal'],
    })
    const { fuel } = solved({ ...p, feedbackItems: ['Charcoal'] }, 'Charcoal')
    const [overflow, net] = fuel.sources
    expect(overflow).toMatchObject({ item: 'Charcoal', target: null })
    expect(overflow.used).toBeCloseTo(overflow.amount)
    expect(overflow.used + net.used).toBeCloseTo(fuel.need)
    expect(net.amount - net.used).toBeCloseTo(10)
  })

  it("doesn't count fed-back overflow as overflow", () => {
    const p = plan({ targets: [steel], producers: { [HEAT]: 'fuel:Charcoal' }, noReuse: ['Charcoal'], feedbackItems: ['Charcoal'] })
    const { fuel } = solved(p, 'Charcoal')
    const [overflow] = fuel.sources
    expect(overflow.item).toBe('Charcoal')
    // Steel's Coke Athanors make Charcoal on the side; the share burned stops being overflow.
    const moneyOf = (q: Plan) => {
      const r = solvePlan(q, catalog, mods)
      return moneyLedger(q, r, ledgers(q, r))
    }
    expect(fedOverflow(moneyOf(p)).get('Charcoal')).toEqual({ share: expect.closeTo(overflow.used / overflow.amount), into: ['plan'] })
    expect(fuel.made).toBeCloseTo(overflow.amount)
    expect(fuel.covered).toBeCloseTo(Math.min(fuel.need, fuel.made))
    expect(fedOverflow(moneyOf({ ...p, feedbackItems: [] })).size).toBe(0)
  })

  it('burns a by-product before taking the fuel from the bus', () => {
    const p = plan({ targets: [steel], producers: { [HEAT]: 'fuel:Charcoal' } })
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
    const burned = result.tree.flatMap(all).filter((n) => n.item === 'Charcoal' && n.id.includes(`/${HEAT}/`))
    expect(burned.some((n) => n.fromByproduct > 0)).toBe(true)
  })

  it('sets up a provider as an ordinary target that removing undoes', () => {
    const bus = plan({ targets: [steel], producers: { [HEAT]: 'fuel:CokePowder' } })
    const provided = addProvider(bus, 'CokePowder')
    expect(provided.targets[1]).toEqual({ item: 'CokePowder', rate: 0, unit: 'net', feedback: true })
    const { fuel } = solved(provided, 'CokePowder')
    expect(fuel.absorbedBy).toBe(1)
    expect(fuel.covered).toBeCloseTo(fuel.need)
    expect(fuel.sources[0].amount - fuel.sources[0].used).toBeCloseTo(0)
    expect(removeTarget(provided, 1)).toEqual(bus)
    // Already fed back for the whole plan: the target just follows that.
    expect(addProvider({ ...bus, feedbackItems: ['CokePowder'] }, 'CokePowder').targets[1]).not.toHaveProperty('feedback')
  })

  it('is a plain items target unless it is fed back', () => {
    const net = plan({ targets: [{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel], producers: { [HEAT]: 'fuel:WoodBoard' } })
    const { result, fuel } = solved(net)
    expect(fuel.absorbedBy).toBeNull()
    expect(fuel.bus).toBeCloseTo(fuel.need)
    expect(result.targets[0].made).toBe(50)
    expect(result.tree[0].rate).toBeCloseTo(50)
  })
})

describe('the bus: money in, items out', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const bus = (p: Plan, c: ProcessCatalog = catalog) => {
    const result = solvePlan(p, c, mods)
    const l = ledgers(p, result)
    return { result, ledgers: l, money: moneyLedger(p, result, l) }
  }
  const out = (m: MoneyLedger, item: string) => m.outputs.find((o) => o.item === item)!

  it("values what goes out at the shop's base price, and costs portal purchases", () => {
    const { result, money } = bus(plan({ targets: [{ item: 'Bandage', rate: 10 }, { item: 'WoodBoard', rate: 60 }] }))
    expect(out(money, 'Bandage')).toMatchObject({ toBus: 10, price: 350, feeds: [] })
    expect(out(money, 'WoodBoard')).toMatchObject({ toBus: 60, price: null, feeds: [] }) // the shop won't buy it; the plan doesn't burn it
    expect(money.value).toBeCloseTo(3500)
    // The portals are paid in coins off the bus: the money in is what the plan buys.
    expect(money.purchases.length).toBeGreaterThan(0)
    expect(money.purchases.every((l) => l.price === itemsByKey.get(l.item)!.buyPrice)).toBe(true)
    expect(money.need).toBeCloseTo(money.purchases.reduce((t, l) => t + l.count * l.price!, 0))
    expect(money.coins.map((l) => l.item)).toEqual(['GoldCoin'])
    expect(result.runs.some((r) => r.process.kind === 'buy')).toBe(true)
    expect(money.cost).toBe(money.need)
  })

  it('lists targets first, in order, then overflow, flagging overflow nothing uses', () => {
    const { money } = bus(plan({ targets: [{ item: 'BlastPotion', rate: 21 }], producers: { Mors: 'paradox:BlackPowder' } }))
    expect(money.outputs[0].item).toBe('BlastPotion')
    const iron = out(money, 'IronIngot')
    expect(iron.sources).toEqual([expect.objectContaining({ target: null, fedBack: false })])
    expect(iron.toBus).toBeCloseTo(iron.sources[0].amount)
  })

  it('takes coin ingredients off the bus at face value', () => {
    const p = plan({ targets: [{ item: 'CopperIngot', rate: 10 }], producers: { CopperIngot: 'recipe:CopperIngot_Alt' } })
    const { result, money } = bus(p)
    expect(result.runs.some((r) => r.process.id === 'recipe:CopperCoin')).toBe(false) // not minted
    const coins = result.balances.find((b) => b.item === 'CopperCoin')!
    expect(coins.fromBus).toBeGreaterThan(0)
    expect(money.coins).toEqual([{ item: 'CopperCoin', count: coins.fromBus, price: 1 }])
    expect(defaultProducer(catalog, 'GoldCoin')).toBe('bus')
  })

  it('mints coins for a coin target, worth their face value out, or covering the money in when fed back', () => {
    const minted = plan({ targets: [{ item: 'SilverCoin', rate: 5 }, { item: 'Bandage', rate: 10 }] })
    const { result, money } = bus(minted)
    expect(result.runs.some((r) => r.process.id === 'recipe:SilverCoin')).toBe(true)
    expect(out(money, 'SilverCoin')).toMatchObject({ toBus: 5, price: 1000, feeds: ['money'] })
    const fed = bus(setTargetFeedback(minted, 0, true)).money
    expect(fed.covered).toBeCloseTo(Math.min(fed.need, 5000))
    expect(fed.cost).toBeCloseTo(fed.need - fed.covered)
    expect(out(fed, 'SilverCoin').used.money).toBeCloseTo(fed.covered / 1000)
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

describe("the bus's capped supply", () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: { 'recipe:Coke': 'AdvancedAthanor' }, mods, fertilizer: 'Catalyst2' })
  // Coke on Advanced Athanors with Fertile Catalyst from the bus: 0.25/min of it.
  const coke = plan({
    targets: [{ item: 'Coke', rate: 60 }],
    producers: { [NUTRIENTS]: 'fert:Catalyst2' },
    rowCatalysts: { '0/Coke': ['Catalyst2'] },
    branches: { '0/Coke/Catalyst2': { producer: 'bus' } },
  })
  const fc = (p: Plan) => {
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    return { result, line: ledgers(p, result).find((l) => l.item === 'Catalyst2')!, balance: result.balances.find((b) => b.item === 'Catalyst2')! }
  }

  it('lets rows take up to what the bus carries, and falls short past it', () => {
    const open = fc(coke)
    expect(open.line).toMatchObject({ bus: expect.closeTo(0.25), cap: null })
    const { result, line, balance } = fc(setBusSupply(coke, 'Catalyst2', 0.1))
    expect(line).toMatchObject({ bus: expect.closeTo(0.1), cap: 0.1 })
    expect(balance.deficit).toBeCloseTo(0.15)
    expect(result.tree[0].children.find((c) => c.item === 'Catalyst2')).toMatchObject({ fromBus: expect.closeTo(0.1), shortfall: expect.closeTo(0.15) })
    // Plenty on the bus: as if uncapped.
    expect(fc(setBusSupply(coke, 'Catalyst2', 5)).balance.deficit).toBe(0)
    expect(setBusSupply(setBusSupply(coke, 'Catalyst2', 5), 'Catalyst2', undefined)).toEqual(coke)
  })

  it('sizes a supply target to what the other rows leave, without changing them', () => {
    // Flax nurseries spread Fertile Catalyst: 24 nutrients a plant, 24,000 a catalyst.
    const capped = addSupplyTarget(setBusSupply(coke, 'Catalyst2', 1), 'Flax', 'Catalyst2')
    expect(capped.targets[1]).toEqual({ item: 'Flax', rate: 0, unit: 'supply', consumes: 'Catalyst2' })
    const { result, line, balance } = fc(capped)
    expect(balance.deficit).toBe(0)
    expect(line.bus).toBeCloseTo(1)
    expect(result.targets[1].made).toBeCloseTo((1 - 0.25) / 0.001)
    expect(result.targets[1].supply).toMatchObject({ item: 'Catalyst2', capped: true, uses: true, taken: expect.closeTo(0.75), unused: 0, takenBy: null })
    const alone = solvePlan(coke, catalog, mods)
    expect(result.tree[0].machines).toBeCloseTo(alone.tree[0].machines)
    // A second one takes none: the first takes all that's left.
    const second = fc(addSupplyTarget(capped, 'Flax', 'Catalyst2')).result.targets[2]
    expect(second).toMatchObject({ made: 0, supply: { takenBy: 1 } })
    // Made a standard target, it keeps what it makes.
    expect(convertOverflowTarget(capped, 1, 750).targets[1]).toEqual({ item: 'Flax', rate: 750 })
  })

  it('switches a standard target to using the rest of the supply, and back', () => {
    const standard = { ...setBusSupply(coke, 'Catalyst2', 1), targets: [...coke.targets, { item: 'Flax', rate: 10 }] }
    const linked = linkToSupply(standard, 1, 'Catalyst2')
    expect(linked.targets[1]).toEqual({ item: 'Flax', rate: 10, unit: 'supply', consumes: 'Catalyst2' })
    expect(fc(linked).result.targets[1].made).toBeCloseTo(750)
    expect(convertOverflowTarget(linked, 1, 750).targets[1]).toEqual({ item: 'Flax', rate: 750 })
  })

  it('leaves rows built separately as they are without the target, though they can serve it', () => {
    // Coke built once for two Steel targets, its Advanced Athanors loading Fertile Catalyst from the bus.
    const steel = plan({
      targets: [
        { item: 'SteelIngot', rate: 10 },
        { item: 'SteelIngot', rate: 10 },
      ],
      producers: { [NUTRIENTS]: 'fert:Catalyst2' },
      separate: [{ item: 'Coke' }],
      rowCatalysts: { 'separate/Coke': ['Catalyst2'] },
      branches: { 'separate/Coke/Catalyst2': { producer: 'bus' } },
      busSupply: { Catalyst2: 5 },
    })
    const coke = (p: Plan) => fc(p).result.tree.find((n) => n.id === 'separate/Coke')!
    const flax = addSupplyTarget(steel, 'Flax', 'Catalyst2')
    expect(coke(flax)).toMatchObject({ rate: coke(steel).rate, overflow: coke(steel).overflow, machines: coke(steel).machines })
    expect(fc(flax).result.targets[2].made).toBeGreaterThan(0)
  })

  it('makes none from a supply the plan leaves uncapped', () => {
    const open = addSupplyTarget(coke, 'Flax', 'Catalyst2')
    const { result } = fc(open)
    expect(result.targets[1]).toMatchObject({ made: 0, supply: { capped: false, uses: true } })
  })

  it('reads and forgets caps like the plan\'s other settings', () => {
    const capped = addSupplyTarget(setBusSupply(coke, 'Catalyst2', 1), 'Flax', 'Catalyst2')
    expect(sanitizePlans([capped], () => 'x')![0]).toEqual(capped)
    expect(sanitizePlans([{ ...capped, busSupply: { Catalyst2: -1 } }], () => 'x')![0].busSupply).toBeUndefined()
    expect(pruneChoices(capped, catalog)).toBeNull()
    expect(pruneChoices({ ...capped, targets: [] }, catalog)!.busSupply).toBeUndefined()
  })
})

describe('overflow targets', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  // Blast Potions this way overflow Iron Ingots nothing in the plan uses.
  const blast = plan({ targets: [{ item: 'BlastPotion', rate: 21 }], producers: { Mors: 'paradox:BlackPowder' } })
  const using = (p: Plan, item: string, consumes = 'IronIngot') => addOverflowTarget(p, item, consumes)
  const surplus = (r: PlanResult, item: string) => r.balances.find((b) => b.item === item)?.surplus ?? 0
  const alone = solvePlan(blast, catalog, mods)
  const iron = surplus(alone, 'IronIngot')
  const rows = (r: PlanResult) => [...rowsById(r.tree).values()]

  it('makes as much as the overflow it takes comes to, leaving none of it', () => {
    expect(iron).toBeGreaterThan(0)
    const p = using(blast, 'Nails')
    const r = solvePlan(p, catalog, mods)
    expectBalanced(r)
    const nails = r.targets[1]
    expect(nails.overflow).toEqual({ item: 'IronIngot', uses: true, taken: expect.closeTo(iron), unused: 0, takenBy: null, runaway: false })
    const leaf = rows(r).find((n) => n.id === '1/Nails/IronIngot')!
    expect(leaf.kind).toBe('overflow')
    expect(leaf.rate).toBeCloseTo(iron)
    expect(leaf.shortfall).toBe(0)
    const perIron = catalog.byId.get(rows(r).find((n) => n.id === '1/Nails')!.producer)!.outputs[0].count
    expect(nails.rate).toBeCloseTo(iron * perIron)
    expect(surplus(r, 'IronIngot')).toBeCloseTo(0)
    expect(r.targets[0].rate).toBe(21) // the rest of the plan is as it was
  })

  it('shows the overflow it takes on the bus, none of it going out', () => {
    const p = using(blast, 'Nails')
    const r = solvePlan(p, catalog, mods)
    const l = ledgers(p, r)
    const money = moneyLedger(p, r, l)
    const out = money.outputs.find((o) => o.item === 'IronIngot')!
    expect(out.sources).toEqual([expect.objectContaining({ target: null, amount: expect.closeTo(iron), taken: [{ target: 1, amount: expect.closeTo(iron) }] })])
    expect(out.toBus).toBe(0)
    expect(fedOverflow(money).get('IronIngot')).toEqual({ share: expect.closeTo(1), into: [], taken: [1] })
  })

  it('leaves the rest of the plan as it was, taking what it overflows', () => {
    // Mars with its Copper Powder row rounded up overflows Copper Powder. Running the Copper Ingot
    // row above it harder would soak that up into a Copper Ingot surplus; the plan stays put instead.
    const mars = setRoundUp(plan({ targets: [{ item: 'Mars', rate: 0.13 }] }), '0/Mars/CopperBearing/CopperIngot/CopperPowder2', true)
    const before = solvePlan(mars, catalog, mods)
    const powder = surplus(before, 'CopperPowder2')
    expect(powder).toBeGreaterThan(0)
    const r = solvePlan(using(mars, 'CopperBearing', 'CopperPowder2'), catalog, mods)
    expectBalanced(r)
    expect(r.targets[1].overflow).toMatchObject({ taken: expect.closeTo(powder), unused: 0 })
    expect(r.targets[1].rate).toBeGreaterThan(0)
    expect(surplus(r, 'CopperIngot')).toBe(0)
    const machines = (x: PlanResult) => rows(x).filter((n) => n.id.startsWith('0/')).map((n) => [n.id, round1(n.machines)])
    expect(machines(r)).toEqual(machines(before))
  })

  it("doesn't gather other uses of its item when that's built separately", () => {
    // Mars's Bronze Rivets built separately: they gather in a row of their own, which reuses the
    // Copper Bearings' failed crafts and buys the rest, rather than in the overflow target's row
    // (which only takes overflow, so it would fall short).
    const mars = plan({ targets: [{ item: 'Mars', rate: 1 }], separate: [{ item: 'BronzeRivet' }] })
    const r = solvePlan(addOverflowTarget(mars, 'BronzeRivet', 'CopperPowder'), catalog, mods)
    expectBalanced(r)
    const byId = rowsById(r.tree)
    expect(byId.get('0/Mars/BronzeRivet')!.kind).toBe('separate')
    const gathered = byId.get('separate/BronzeRivet')!
    expect(gathered.consolidated).toBe(true)
    expect(byId.get('1/BronzeRivet')!.consolidated).toBeFalsy()
    expect(rows(r).every((n) => n.shortfall === 0)).toBe(true)
    // The rivets' Impure Copper Powder takes every failed craft, so none overflows for the target.
    expect(gathered.children[0].children[0].fromByproduct).toBeGreaterThan(0)
    expect(r.targets[1]).toMatchObject({ rate: 0, overflow: { uses: true, taken: 0 } })
  })

  it("makes none, saying why, when its recipes don't use the item", () => {
    const r = solvePlan(using(blast, 'Bandage'), catalog, mods)
    expectBalanced(r)
    expect(r.targets[1]).toMatchObject({ rate: 0, overflow: { uses: false, taken: 0, takenBy: null } })
    expect(surplus(r, 'IronIngot')).toBeCloseTo(iron)
  })

  it('makes none when nothing overflows', () => {
    const r = solvePlan(using(plan({ targets: [{ item: 'WoodBoard', rate: 10 }] }), 'Nails'), catalog, mods)
    expectBalanced(r)
    expect(r.targets[1]).toMatchObject({ rate: 0, overflow: { uses: true, taken: 0 } })
  })

  it('gives the overflow to the first target in order that uses it', () => {
    const p = using(using(using(blast, 'Bandage'), 'Cart'), 'Nails')
    const r = solvePlan(p, catalog, mods)
    expectBalanced(r)
    expect(r.targets[1].overflow).toMatchObject({ uses: false })
    expect(r.targets[2].overflow).toMatchObject({ uses: true, taken: expect.closeTo(iron), unused: 0, takenBy: null, runaway: false })
    expect(r.targets[3]).toMatchObject({ rate: 0, overflow: { uses: true, taken: 0, takenBy: 2 } })
    const swapped = solvePlan(moveTarget(p, 3, 2), catalog, mods)
    expect(swapped.targets[2].overflow).toMatchObject({ item: 'IronIngot', taken: expect.closeTo(iron) })
    expect(swapped.targets[3].overflow).toMatchObject({ takenBy: 2 })
  })

  it("solves a chain together: one overflow target's overflow sizes the next", () => {
    // Nails rounded up to whole machines overflow; Mars takes them, and its Steel Gear row rounded
    // up overflows gears for a second Mars.
    const nailsFirst = setRoundUp(plan({ targets: [{ item: 'Nails', rate: 10 }] }), '0/Nails', true)
    const p = using(setRoundUp(using(nailsFirst, 'Mars', 'Nails'), '1/Mars/SteelGear', true), 'Mars', 'SteelGear')
    const r = solvePlan(p, catalog, mods)
    expectBalanced(r)
    const nails = rows(r).find((n) => n.id === '0/Nails')!
    const gears = rows(r).find((n) => n.id === '1/Mars/SteelGear')!
    expect(nails.overflow).toBeGreaterThan(0)
    expect(gears.overflow).toBeGreaterThan(0)
    expect(r.targets[1].overflow).toMatchObject({ item: 'Nails', uses: true, taken: expect.closeTo(nails.overflow) })
    const mars = catalog.byId.get(rows(r).find((n) => n.id === '1/Mars')!.producer)!
    const per = (item: string) => mars.outputs[0].count / mars.inputs.find((s) => s.item === item)!.count
    expect(r.targets[1].rate).toBeCloseTo(nails.overflow * per('Nails'))
    expect(r.targets[2].overflow).toMatchObject({ item: 'SteelGear', uses: true, taken: expect.closeTo(gears.overflow) })
    expect(r.targets[2].rate).toBeCloseTo(gears.overflow * per('SteelGear'))
    expect(surplus(r, 'Nails')).toBeCloseTo(0)
    expect(surplus(r, 'SteelGear')).toBeCloseTo(0)
  })

  it("doesn't round up rows running on overflow: they can't run faster than it comes", () => {
    const exact = solvePlan(using(blast, 'Nails'), catalog, mods)
    const r = solvePlan(setRoundUp(using(blast, 'Nails'), '1/Nails', true), catalog, mods)
    expectBalanced(r)
    const nails = rows(r).find((n) => n.id === '1/Nails')!
    expect(nails.machines).toBeCloseTo(rows(exact).find((n) => n.id === '1/Nails')!.machines)
    expect(onOverflow(nails)).toBe(true)
    const leaf = rows(r).find((n) => n.id === '1/Nails/IronIngot')!
    expect(leaf.rate).toBeCloseTo(iron)
    expect(leaf.shortfall).toBe(0)
  })

  it('solves loops through its own overflow exactly', () => {
    // Steel's failed crafts give back 3 iron for every 4 it takes: 4× the overflow in all.
    const r = solvePlan(using(blast, 'SteelIngot'), catalog, mods)
    expectBalanced(r)
    expect(r.targets[1].overflow).toMatchObject({ taken: expect.closeTo(4 * iron), unused: 0, runaway: false })
    expect(surplus(r, 'IronIngot')).toBeCloseTo(0)
  })

  describe('a loop that overflows at least as much as it takes', () => {
    // Every Gentian nursery craft also makes Gentian Nectar, as much as Gentian.
    const vitae = (inputs: [string, string, string]) => {
      const saved: SavedRecipe = { id: 'v', mode: 'normal', inputs, output: evaluateNormal(inputs)!.output.key, createdAt: 0 }
      const c = buildCatalog({ saved: [saved], machines: {}, mods, fertilizer: null })
      const p = plan({ targets: [{ item: 'Gentian', rate: 80 }], producers: { [saved.output]: savedRecipeProcess(saved)!.id } })
      return { result: solvePlan(addOverflowTarget(p, saved.output, 'GentianNectar'), c, mods), item: saved.output }
    }

    it('settles when it gives back less than it takes', () => {
      // 2 Nectar and 1 Gentian Powder: half the Nectar comes back, so it takes twice the overflow.
      const { result } = vitae(['GentianNectar', 'GentianNectar', 'GentianPowder'])
      expectBalanced(result)
      expect(result.targets[1].overflow).toMatchObject({ taken: expect.closeTo(160), unused: 0, runaway: false })
    })

    it('runs away, making none, when it gives back as much or more, without falling short anywhere', () => {
      // 1 Nectar and 2 Gentian Powder: twice the Nectar comes back.
      const { result } = vitae(['GentianNectar', 'GentianPowder', 'GentianPowder'])
      expectBalanced(result)
      expect(result.targets[1]).toMatchObject({ rate: 0, overflow: { taken: 0, unused: expect.closeTo(80), runaway: true } })
      expect(result.balances.every((b) => b.deficit === 0)).toBe(true)
      expect(surplus(result, 'GentianNectar')).toBeCloseTo(80) // back out to the bus
    })
  })

  it('turns a standard target into one using the overflow, and back', () => {
    const standard = plan({ ...blast, targets: [...blast.targets, { item: 'Nails', rate: 5, unit: 'machines' }] })
    const linked = linkToOverflow(standard, 1, 'IronIngot')
    expect(linked.targets[1]).toEqual({ item: 'Nails', rate: 5, unit: 'overflow', consumes: 'IronIngot' })
    const r = solvePlan(linked, catalog, mods)
    expect(r.targets[1].overflow!.taken).toBeCloseTo(iron)
    expect(linked.targets[0]).toBe(standard.targets[0])
    expect(convertOverflowTarget(linked, 1, r.targets[1].rate).targets[1]).toEqual({
      item: 'Nails',
      rate: Math.round(r.targets[1].rate * 1000) / 1000,
    })
  })

  it('becomes a standard target making what it makes now, and round-trips through saving', () => {
    const p = using(blast, 'Nails')
    const rate = solvePlan(p, catalog, mods).targets[1].rate
    const converted = convertOverflowTarget(p, 1, rate)
    expect(converted.targets[1]).toEqual({ item: 'Nails', rate: Math.round(rate * 1000) / 1000 })
    expect(convertOverflowTarget(using(blast, 'Bandage'), 1, 0).targets[1]).toEqual({ item: 'Bandage', rate: 10 })
    expect(removeTarget(p, 1)).toEqual(blast)
    expect(sanitizePlans([p], () => 'n')![0].targets[1]).toEqual({ item: 'Nails', rate: 0, unit: 'overflow', consumes: 'IronIngot' })
    expect(sanitizePlans([{ ...blast, targets: [{ item: 'Nails', rate: 3, unit: 'overflow' }] }], () => 'n')![0].targets[0]).toEqual({
      item: 'Nails',
      rate: 3,
    })
  })
})

describe('rounding rows up to whole machines', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const rowOf = (r: PlanResult, id: string) => [...rowsById(r.tree).values()].find((n) => n.id === id)!
  const bandages = plan({ targets: [{ item: 'Bandage', rate: 10 }] })

  it('runs a rounded row on the next whole machine, overflowing the extra and feeding it from below', () => {
    const exact = solvePlan(bandages, catalog, mods)
    expect(rowOf(exact, '0/Bandage').machines).toBeCloseTo(5 / 3)
    const rounded = solvePlan(setRoundUp(bandages, '0/Bandage', true), catalog, mods)
    expectBalanced(rounded)
    const row = rowOf(rounded, '0/Bandage')
    expect(row.machines).toBeCloseTo(2)
    expect(row.overflow).toBeCloseTo(2) // 12/min made, 10 wanted
    expect(rowOf(rounded, '0/Bandage/Linen').rate).toBeCloseTo(rowOf(exact, '0/Bandage/Linen').rate * 1.2)
  })

  it('rounds rows below a rounded row after it grows', () => {
    const both = setRoundUp(setRoundUp(bandages, '0/Bandage', true), '0/Bandage/Linen', true)
    const r = solvePlan(both, catalog, mods)
    expectBalanced(r)
    expect(rowOf(r, '0/Bandage').machines).toBeCloseTo(2)
    const linen = rowOf(r, '0/Bandage/Linen').machines
    expect(linen).toBeCloseTo(Math.round(linen))
    expect(linen).toBeGreaterThanOrEqual(rowOf(solvePlan(bandages, catalog, mods), '0/Bandage/Linen').machines)
  })

  it('leaves whole numbers alone and undoes cleanly', () => {
    const whole = plan({ targets: [{ item: 'Bandage', rate: 12 }] })
    expect(rowOf(solvePlan(setRoundUp(whole, '0/Bandage', true), catalog, mods), '0/Bandage').machines).toBeCloseTo(2)
    expect(setRoundUp(setRoundUp(bandages, '0/Bandage', true), '0/Bandage', false)).toEqual(bandages)
  })

  it('counts whole buildings, each row rounding up on its own', () => {
    const r = solvePlan(bandages, catalog, mods)
    const rows = [...rowsById(r.tree).values()].filter((n) => n.kind === 'produce' && n.run?.process.machine?.name === 'Assembler')
    const fractional = rows.reduce((t, n) => t + n.machines, 0)
    const assemblers = buildingCounts(r.tree, checkLogistics(r.runs, mods)).find((b) => b.name === 'Assembler')!
    expect(assemblers.count).toBe(rows.reduce((t, n) => t + Math.ceil(n.machines - 1e-9), 0))
    expect(fractional).toBeCloseTo(4.5) // 1.67 + 0.83 + 2 in use, built as 2 + 1 + 2
    expect(assemblers.count).toBe(5)
  })

  it('lists what draws heat by building, adding up to the need', () => {
    const p = plan({ targets: [{ item: 'SteelIngot', rate: 10 }, { item: 'Bandage', rate: 10 }] })
    const r = solvePlan(p, catalog, mods)
    const logistics = checkLogistics(r.runs, mods)
    const heat = resourceUsers(r.tree, logistics, 'heat')
    expect(heat.map((u) => u.machine)).toContain('Athanor')
    expect(heat.reduce((t, u) => t + u.perSecond, 0)).toBeCloseTo(r.balances.find((b) => b.item === HEAT)!.consumed / 60)
    expect(heat.every((u, i) => i === 0 || heat[i - 1].perSecond >= u.perSecond)).toBe(true)
    const nutrients = resourceUsers(r.tree, logistics, 'nutrients')
    expect(nutrients.every((u) => u.item)).toBe(true) // nurseries per plant
    expect(nutrients.reduce((t, u) => t + u.perSecond, 0)).toBeCloseTo(r.balances.find((b) => b.item === NUTRIENTS)!.consumed / 60)
  })

  it('keeps rounding with its row when targets move, and forgets rows that left the plan', () => {
    const two = setRoundUp(plan({ targets: [{ item: 'WoodBoard', rate: 10 }, { item: 'Bandage', rate: 10 }] }), '1/Bandage', true)
    expect(moveTarget(two, 1, 0).roundUp).toEqual(['0/Bandage'])
    expect(pruneChoices({ ...bandages, roundUp: ['0/Bandage', '0/Gone'] }, catalog)!.roundUp).toEqual(['0/Bandage'])
  })
})

describe('reordering targets', () => {
  it("clears the only target instead of removing it, its rows' settings going with it", () => {
    const one = plan({ targets: [{ item: 'Salt', rate: 5 }], branches: { '0/Salt': { producer: 'recipe:Salt_Alt' } }, roundUp: ['0/Salt'] })
    const cleared = removeTarget(one, 0)
    expect(cleared.targets).toEqual([{ item: '', rate: 10 }])
    expect(cleared.branches ?? {}).toEqual({})
    expect(cleared.roundUp).toBeUndefined()
  })

  const base = plan({
    targets: [
      { item: 'A', rate: 1 },
      { item: '', rate: 1 }, // no item yet: has no rows
      { item: 'B', rate: 1 },
    ],
    branches: { '0/A/X': { producer: 'p:a' }, '1/B/X': { producer: 'p:b' } },
    rowCatalysts: { '1/B': ['Catalyst1'] },
    separate: [{ item: 'X', anchor: 'B', at: '1/B' }, { item: 'Y' }],
  })

  it('moves per-row picks with their target', () => {
    const moved = moveTarget(base, 2, 0)
    expect(moved.targets.map((t) => t.item)).toEqual(['B', 'A', ''])
    expect(moved.branches).toEqual({ '1/A/X': { producer: 'p:a' }, '0/B/X': { producer: 'p:b' } })
    expect(moved.rowCatalysts).toEqual({ '0/B': ['Catalyst1'] })
    expect(moved.separate).toEqual([{ item: 'X', anchor: 'B', at: '0/B' }, { item: 'Y' }])
    expect(moveTarget(moved, 0, 2)).toEqual(base)
  })

  it("drops a removed target's picks and keeps the others with theirs", () => {
    const removed = removeTarget(base, 0)
    expect(removed.targets.map((t) => t.item)).toEqual(['', 'B'])
    expect(removed.branches).toEqual({ '0/B/X': { producer: 'p:b' } })
    expect(removed.rowCatalysts).toEqual({ '0/B': ['Catalyst1'] })
    expect(removed.separate).toEqual([{ item: 'X', anchor: 'B', at: '0/B' }, { item: 'Y' }])
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

describe('empty recipe search diagnosis', () => {
  const base: FinderQuery = { target: 'Diamond1', mode: 'normal', prefs: emptyPrefs, mustInclude: null }

  it('flags a must-include ingredient that is avoided, and un-avoiding it finds recipes', () => {
    const q = { ...base, prefs: setPrefs(emptyPrefs, ['Chamomile'], 'avoid'), mustInclude: 'Chamomile' }
    expect(countRecipes(q)).toBe(0)
    const d = diagnoseNoResults(q)
    expect(d.reason).toMatch(/avoided/)
    expect(d.fixes[0].label).toBe('Make Chamomile neutral')
    expect(d.fixes[0].count).toBe(countRecipes(d.fixes[0].query))
    expect(d.fixes[0].count).toBeGreaterThan(0)
  })

  it('flags "only preferred" with nothing preferred', () => {
    const q = { ...base, prefs: { ...emptyPrefs, onlyPreferred: true } }
    expect(countRecipes(q)).toBe(0)
    const d = diagnoseNoResults(q)
    expect(d.reason).toMatch(/no ingredients are preferred/)
    expect(d.fixes.map((f) => f.label)).toEqual(['Turn off "Only use preferred"'])
  })

  it('flags the target as its own must-include ingredient', () => {
    const d = diagnoseNoResults({ ...base, mustInclude: 'Diamond1' })
    expect(d.reason).toMatch(/own product/)
    expect(d.fixes[0].query.mustInclude).toBeNull()
  })

  it('offers only fixes that find something', () => {
    const q = { ...base, prefs: { ...setPrefs(emptyPrefs, ['Chamomile'], 'prefer'), onlyPreferred: true } }
    expect(countRecipes(q)).toBe(0)
    const d = diagnoseNoResults(q)
    expect(d.reason).toMatch(/none of them fit/)
    expect(d.fixes.length).toBeGreaterThan(0)
    for (const f of d.fixes) expect(f.count).toBeGreaterThan(0)
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

describe('research tiers', () => {
  const mods = modifiers({})
  const at = (tier: number) => buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer', tier })

  it('reads what each tier unlocks from the research tree and workbench', () => {
    expect(machineTier('Athanor')).toBe(5)
    expect(machineTier('AdvancedAthanor')).toBe(8)
    expect(machineTier('EnhancedGrinder')).toBe(5) // workbench building, unlocked with the Steel Gear research
    expect(buyTier('IronOre')).toBe(3)
    expect(licenseFor('CopperIngot_Alt')).toMatch(/License/)
    expect(research.tiers.map((t) => t.tier)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('works out when each item can first be had, ingredients included', () => {
    const catalog = at(MAX_TIER)
    expect(catalog.itemReach('WoodBoard')).toBe(1)
    expect(catalog.itemReach('SteelIngot')).toBe(5)
    expect(catalog.itemReach('Sol')).toBe(9)
    expect(catalog.itemReach('Steam')).toBe(machineTier('SteamBoiler'))
  })

  it('defaults to what the tier unlocks', () => {
    // Never the hand-worked seed plot: the nursery, flagged until it's unlocked.
    expect(defaultProducer(at(3), 'Flax')).toBe('nursery:FlaxSeed')
    expect(defaultProducer(at(4), 'Flax')).toBe('nursery:FlaxSeed')
    expect(defaultProducer(at(1), HEAT)).toBe('fuel:WoodBoard')
    expect(defaultProducer(at(5), HEAT)).toBe('fuel:CokePowder') // Steam isn't a fuel, even with boilers
    // Nothing unlocked yet: still the usual recipe, flagged where it's used.
    expect(defaultProducer(at(2), 'SteelIngot')).toBe('recipe:SteelIngot')
  })

  it('runs recipes on an unlocked machine when there is one', () => {
    for (const tier of [4, 6, 8]) {
      const catalog = at(tier)
      for (const p of catalog.byId.values()) {
        if (!p.machine || !p.machineOptions.some((m) => machineTier(m.key) <= tier)) continue
        expect(machineTier(p.machine.key), `${p.id} at tier ${tier}`).toBeLessThanOrEqual(tier)
      }
    }
  })

  it('leaves plans without a tier unchanged', () => {
    const targets = [{ item: 'Sol', rate: 0.25 }]
    const open = solvePlan(plan({ targets }), at(MAX_TIER), mods)
    const all = solvePlan(plan({ targets }), buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer' }), mods)
    expect(open.runs.map((r) => r.key)).toEqual(all.runs.map((r) => r.key))
  })
})

describe('my defaults', () => {
  const mods = modifiers({})
  const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
  const catalogWith = (mine: MyDefaults = {}, tier?: number) =>
    buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer', mine, tier })
  const salt = plan({ targets: [{ item: 'Salt', rate: 10 }] })

  it('remembers how a row and everything below it is made, for every plan', () => {
    const catalog = catalogWith()
    const picked = chooseProducer(salt, catalog, { item: 'Salt', producer: 'recipe:Salt_Alt', row: '0/Salt' })
    const [root] = solvePlan(picked, catalog, mods).tree
    const { mine, plan: cleaned } = rememberSetup(picked, catalog, [root], root)
    expect(mine.Salt).toEqual({ producer: 'recipe:Salt_Alt' })
    // Rows made the built-in way aren't saved.
    expect(Object.keys(mine)).toEqual(['Salt'])
    // The plan's matching pick goes: the row now follows the saved default.
    expect(cleaned.branches).toEqual({})

    const other = plan({ targets: [{ item: 'Salt', rate: 5 }] })
    const [row] = solvePlan(other, catalogWith(mine), mods).tree
    expect(row.producer).toBe('recipe:Salt_Alt')
    expect(row.mine).toBe(true)
  })

  it('is only offered where saving would change something', () => {
    const savable = (p: Plan, catalog: ProcessCatalog) => {
      const tree = solvePlan(p, catalog, mods).tree
      return rememberChanges(catalog, rowsById(tree), tree[0])
    }
    // Built-in all the way down: nothing to save.
    expect(savable(salt, catalogWith())).toBe(false)
    // A pick of its own: saving would remember it.
    const catalog = catalogWith()
    const picked = chooseProducer(salt, catalog, { item: 'Salt', producer: 'recipe:Salt_Alt', row: '0/Salt' })
    expect(savable(picked, catalog)).toBe(true)
    // Following the saved default: nothing new (the row shows it's saved instead).
    const saved = catalogWith({ Salt: { producer: 'recipe:Salt_Alt' } })
    expect(savable(salt, saved)).toBe(false)
    expect(solvePlan(salt, saved, mods).tree[0].mine).toBe(true)
    // A plan pick overriding the saved default, back to the built-in way: saving would forget it.
    expect(savable({ ...salt, producers: { Salt: 'recipe:Salt' } }, saved)).toBe(true)
  })

  it('un-saving from a row keeps this plan as it was, ready to save again', () => {
    // Brine made the built-in way, from Salt made by its alternate recipe.
    const brine = plan({ targets: [{ item: 'SaltWater', rate: 10 }] })
    const catalog = catalogWith()
    const picked = chooseProducer(brine, catalog, { item: 'Salt', producer: 'recipe:Salt_Alt', row: '0/SaltWater/Salt' })
    const state = (p: Plan, c: ProcessCatalog) => {
      const tree = solvePlan(p, c, mods).tree
      const rows = rowsById(tree)
      const salt = tree[0].children[0]
      return { tree, salt, brineSavable: rememberChanges(c, rows, tree[0]), saltSavable: rememberChanges(c, rows, salt) }
    }
    const before = state(picked, catalog)
    expect(before.brineSavable).toBe(true)
    expect(before.saltSavable).toBe(true)

    // Saved from the Brine row: the Salt row follows the default (filled), nothing left to save.
    const saved = rememberSetup(picked, catalog, before.tree, before.tree[0])
    const savedCatalog = catalogWith(saved.mine)
    const after = state(saved.plan, savedCatalog)
    expect(after.salt.mine).toBe(true)
    expect(after.saltSavable).toBe(false)
    expect(after.brineSavable).toBe(false)

    // Un-saved from the Salt row: Salt is still made the alternate way here, both rows offer saving again.
    const kept = keepDefaultInPlan(saved.plan, after.tree, 'Salt', saved.mine.Salt)
    const back = state(kept, catalogWith())
    expect(back.salt.producer).toBe('recipe:Salt_Alt')
    expect(back.saltSavable).toBe(true)
    expect(back.brineSavable).toBe(true)
  })

  it("loses to the plan's own picks", () => {
    const catalog = catalogWith({ Salt: { producer: 'recipe:Salt_Alt' } })
    const [row] = solvePlan({ ...salt, producers: { Salt: 'recipe:Salt' } }, catalog, mods).tree
    expect(row.producer).toBe('recipe:Salt')
    expect(row.mine).toBe(false)
  })

  it('forgets an item once it is remembered the built-in way', () => {
    const catalog = catalogWith({ Salt: { producer: 'recipe:Salt_Alt' } })
    const picked = chooseProducer(salt, catalog, { item: 'Salt', producer: 'recipe:Salt', row: '0/Salt' })
    const [root] = solvePlan(picked, catalog, mods).tree
    expect(rememberSetup(picked, catalog, [root], root).mine).toEqual({})
  })

  it('brings its machine and catalysts, which a row can still turn off', () => {
    const mine = { Coke: { producer: 'recipe:Coke', machine: 'AdvancedAthanor', catalysts: ['Catalyst2'] } }
    const coke = plan({ targets: [{ item: 'Coke', rate: 10 }] })
    const [row] = solvePlan(coke, catalogWith(mine), mods).tree
    expect(row.run?.process.machine?.key).toBe('AdvancedAthanor')
    expect(row.run?.process.catalysts).toEqual(['Catalyst2'])
    const off = setRowCatalysts(coke, row.id, [], row.defaultCatalysts)
    expect(off.rowCatalysts).toEqual({ [row.id]: [] })
    expect(solvePlan(off, catalogWith(mine), mods).tree[0].run?.process.catalysts).toEqual([])
    expect(setRowCatalysts(off, row.id, ['Catalyst2'], row.defaultCatalysts).rowCatalysts).toEqual({})
  })

  it("is skipped below the research tier it needs", () => {
    const mine = { Coke: { producer: 'recipe:Coke', machine: 'AdvancedAthanor' } }
    const coke = plan({ targets: [{ item: 'Coke', rate: 10 }] })
    const [row] = solvePlan(coke, catalogWith(mine, machineTier('AdvancedAthanor') - 1), mods).tree
    expect(row.mine).toBe(false)
    expect(row.run?.process.machine?.key).toBe('Athanor')
  })

  it('follows separate builds into the rows that make them', () => {
    const catalog = catalogWith()
    const sol = plan({ targets: [{ item: 'Sol', rate: 0.25 }], separate: [{ item: 'WorldTreeLeaf' }] })
    const leaf = solvePlan(sol, catalog, mods).tree.find((n) => n.item === 'WorldTreeLeaf')!
    const picked = chooseProducer(sol, catalog, { item: 'WorldTreeLeaf', producer: 'nursery:TreeStage2', row: leaf.id })
    const tree = solvePlan(picked, catalog, mods).tree
    const root = tree[0]
    expect(all(root).some((n) => n.kind === 'separate' && n.item === 'WorldTreeLeaf')).toBe(true)
    expect(rememberSetup(picked, catalog, tree, root).mine.WorldTreeLeaf).toEqual({ producer: 'nursery:TreeStage2' })
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

describe('building rows in units', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const rowOf = (r: PlanResult, id: string) => [...rowsById(r.tree).values()].find((n) => n.id === id)!
  const full = (n: TreeNode) => checkProcess(n.run!.process, mods)?.utilization ?? 1
  // 24 Bandages a minute: 4 Assemblers, fed by rows below on fractional machines.
  const bandages = plan({ targets: [{ item: 'Bandage', rate: 24 }] })
  const solved = solvePlan(bandages, catalog, mods)
  const top = rowOf(solved, '0/Bandage')
  const below = top.children.find((c) => c.kind === 'produce' && c.machines > 0)!

  it("offers the even splits of a row's whole machines, or a row's below it", () => {
    const row = (id: string, machines: number, children: TreeNode[] = []) =>
      ({ ...top, id, machines, children, run: { ...top.run!, key: id } }) as TreeNode
    const solo = (n: TreeNode) => unitChoices([n], n, 1, () => 1)
    expect(solo(row('0/A', 8))).toEqual([2, 4, 8])
    expect(solo(row('0/A', 9))).toEqual([3, 9])
    expect(solo(row('0/A', 7))).toEqual([7])
    expect(solo(row('0/A', 1))).toEqual([])
    // 47 Extractors fed by 8 Nurseries: eight copies of 6 Extractors (48 in all) and a Nursery.
    const wine = row('0/A', 46.9, [row('0/A/B', 7.82)])
    expect(solo(wine)).toEqual([2, 4, 8, 47])
    expect(wholePerCopy(wine, 8, () => 1)).toBe(6)
    // Never more copies than the row's own machines.
    expect(solo(row('0/A', 3, [row('0/A/B', 12)]))).toEqual([2, 3])
    // Within each copy of the line above.
    expect(unitChoices([wine], wine.children[0], 2, () => 1)).toEqual([2, 4])
    expect(wholePerCopy(top, 1, full)).toBe(4)
  })

  it('splits a row and everything below it into copies, nesting', () => {
    const two = setUnits(bandages, '0/Bandage', { count: 2, of: 4 })
    const s = unitScales(solved.tree, two.units, full)
    expect(s.own.get('0/Bandage')).toBe(2)
    expect(s.copies.get('0/Bandage')).toBe(2)
    expect(s.copies.get(below.id)).toBe(2)
    expect(s.stale).toEqual([])
    // A row below splits again within each copy, offered splits of its share.
    const of = wholePerCopy(below, 2, full)!
    const choice = unitChoices(solved.tree, below, 2, full)[0]
    if (choice) {
      const nested = setUnits(two, below.id, { count: choice, of })
      expect(unitScales(solved.tree, nested.units, full).copies.get(below.id)).toBe(2 * choice)
    }
  })

  it('keeps the rates and builds whole machines in each copy', () => {
    const two = setUnits(bandages, '0/Bandage', { count: 2, of: 4 })
    const r = solvePlan(two, catalog, mods)
    expect(rowOf(r, below.id).rate).toBeCloseTo(below.rate)
    const logistics = checkLogistics(r.runs, mods)
    const { copies } = unitScales(r.tree, two.units, full)
    const plain = buildingCounts(r.tree, logistics)
    const split = buildingCounts(r.tree, logistics, copies)
    const rows = [...rowsById(r.tree).values()].filter((n) => n.kind === 'produce' && n.run?.process.machine && n.machines > 0)
    const expected = rows.reduce((t, n) => t + (copies.get(n.id) ?? 1) * Math.ceil(n.machines / full(n) / (copies.get(n.id) ?? 1) - 1e-9), 0)
    expect(split.reduce((t, b) => t + b.count, 0)).toBe(expected)
    expect(split.reduce((t, b) => t + b.count, 0)).toBeGreaterThanOrEqual(plain.reduce((t, b) => t + b.count, 0))
  })

  it('rounds a row up in each copy', () => {
    const p = setRoundUp(setUnits(bandages, '0/Bandage', { count: 4, of: 4 }), below.id, true)
    const r = solvePlan(p, catalog, mods)
    expectBalanced(r)
    const each = rowOf(r, below.id).machines / full(below) / 4
    expect(each).toBeCloseTo(Math.round(each))
    expect(each).toBeGreaterThanOrEqual(below.machines / full(below) / 4 - 1e-9)
  })

  it("goes stale when the row's machine count changes, and drops only what went stale", () => {
    const p = setUnits(bandages, '0/Bandage', { count: 2, of: 4 })
    const bigger = solvePlan({ ...p, targets: [{ item: 'Bandage', rate: 36 }] }, catalog, mods)
    const s = unitScales(bigger.tree, p.units, full)
    expect(s.stale).toEqual(['0/Bandage'])
    expect(s.copies.get(below.id)).toBeUndefined()
    expect(dropUnits(p, s.stale, p.units).units).toBeUndefined()
    // Picked again since: kept.
    const again = setUnits(p, '0/Bandage', { count: 3, of: 6 })
    expect(dropUnits(again, s.stale, p.units)).toEqual(again)
  })

  it('undoes cleanly, moves with its target, leaves with its row, and survives a backup', () => {
    expect(setUnits(setUnits(bandages, '0/Bandage', { count: 2, of: 4 }), '0/Bandage', null)).toEqual(bandages)
    const two = setUnits(plan({ targets: [{ item: 'WoodBoard', rate: 10 }, { item: 'Bandage', rate: 24 }] }), '1/Bandage', { count: 2, of: 4 })
    expect(moveTarget(two, 1, 0).units).toEqual({ '0/Bandage': { count: 2, of: 4 } })
    const gone = { ...bandages, units: { '0/Bandage': { count: 2, of: 4 }, '0/Gone': { count: 2, of: 2 } } }
    expect(pruneChoices(gone, catalog)!.units).toEqual({ '0/Bandage': { count: 2, of: 4 } })
    const odd = { ...bandages, units: { a: { count: 2, of: 4 }, b: { count: 3, of: 4 }, c: { count: 1, of: 1 }, d: { count: 2.5, of: 5 }, e: { count: 5, of: 4 } } }
    expect(sanitizePlans([odd], () => 'n')![0].units).toEqual({ a: { count: 2, of: 4 }, b: { count: 3, of: 4 } })
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
