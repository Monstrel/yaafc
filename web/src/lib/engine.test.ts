import { describe, expect, it } from 'vitest'
import { cauldronStats, evaluateAdvanced, evaluateNormal, findRecipes } from './cauldron'
import {
  HEAT,
  MAX_TIER,
  NUTRIENTS,
  baseInputKey,
  buyTier,
  cauldronIngredients,
  gameRecipes,
  items,
  itemsByKey,
  licenseFor,
  machineTier,
  research,
  upgrades,
} from './gameData'
import { buildCatalog, defaultProducer, paradoxSeconds, processTitle, type ProcessCatalog } from './processes'
import { ledgers } from './ledger'
import { fedOverflow, moneyLedger, type MoneyLedger } from './money'
import { allowedIngredients, builtinGroups, emptyPrefs, onlyGroup, preferredCount, setPrefs } from './itemGroups'
import { countRecipes, diagnoseNoResults, type FinderQuery } from './diagnose'
import { buildingCounts, checkLogistics, checkProcess, resourceUsers } from './logistics'
import { craftsPerMachine } from './machineRate'
import { solvePlan, type PlanResult } from './solver'
import type { TreeNode } from './tree'
import {
  chooseProducer,
  clearBranchChoice,
  addProvider,
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
  rowsById,
  setRoundUp,
  setRowCatalysts,
} from './choices'
import { resolveChoice } from './unfold'
import { separationsOf, withSeparation } from './separate'
import { buildingNameFor, itemNameFor, noun } from './plural'
import { BOILER_SETTINGS, boilerHeat, boilersFor } from './steamBoiler'
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
    const net = b.produced - b.consumed + b.imported + b.deficit - b.surplus
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
    expect(result.balances.find((b) => b.item === 'Wood')!.imported).toBeGreaterThan(0)
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

  it('treats fertilizer as a base input without expanding its production chain', () => {
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'AdvancedFertilizer' })
    const result = solvePlan(
      plan({ targets: [{ item: 'Flax', rate: 60 }], producers: { [NUTRIENTS]: 'fert:AdvancedFertilizer' } }),
      catalog,
      mods,
    )
    expectBalanced(result)
    expect(result.runs.some((r) => r.process.id === 'recipe:AdvancedFertilizer')).toBe(false)
    const fert = result.balances.find((b) => b.item === baseInputKey('AdvancedFertilizer'))!
    expect(fert.imported).toBeGreaterThan(0)
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
    const fertilizer = (p: Plan, result: PlanResult) => ledgers(p, catalog, result).find((l) => l.resource === 'fertilizer')!

    it('sizes the factory from the target and draws fertilizer from the bus', () => {
      const result = solvePlan(loopPlan(false), catalog, mods)
      expectBalanced(result)
      const fc = result.balances.find((b) => b.item === 'Catalyst2')!
      expect(fc.produced).toBeCloseTo(10)
      expect(fc.deficit).toBe(0) // any shortfall is reported deeper, where the chain breaks
      expect(fc.consumed).toBe(0)
      const ledger = fertilizer(loopPlan(false), result)
      expect(ledger.need).toBeGreaterThan(0)
      expect(ledger.covered).toBe(0)
      expect(ledger.bus!.item).toBe('Catalyst2')
      expect(ledger.bus!.count * ledger.bus!.per).toBeCloseTo(ledger.need)
      expect(ledger.sources).toMatchObject([{ item: 'Catalyst2', target: 0, amount: 10, fedBack: false, used: 0 }])
    })

    it('feedback covers the need from the target without changing the factory', () => {
      const off = solvePlan(loopPlan(false), catalog, mods)
      const on = solvePlan(loopPlan(true), catalog, mods)
      expect(on.runs.map((r) => r.machines)).toEqual(off.runs.map((r) => r.machines))
      const ledger = fertilizer(loopPlan(true), on)
      const [source] = ledger.sources
      expect(source.fedBack).toBe(true)
      expect(source.used).toBeCloseTo(Math.min(10, ledger.need / source.per))
      expect(source.used + ledger.bus!.count).toBeCloseTo(ledger.need / source.per)
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

  it('splits machines by branch and ends in purchased leaves', () => {
    const targets = [{ item: 'WoodBoard', rate: 60 }]
    const [root] = solvePlan(plan({ targets }), catalog, mods).tree
    expect(root.kind).toBe('produce')
    expect(root.machines).toBeCloseTo(2)
    const wood = root.children.find((c) => c.item === 'Wood')!
    expect(wood.kind).toBe('purchase')
    expect(wood.rate).toBeCloseTo(0.3)
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
    expect(defaultProducer(catalog, 'CopperPowder')).toBe('import') // never run just for a failed craft

    // Made separately: its own Athanors run Copper Powder for their failed crafts, nothing reused.
    const own = chooseProducer(base, catalog, { item: 'CopperPowder', producer: 'recipe:CopperPowder2', row: reused.id, reuse: false })
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
    expect(copper.byproducts.find((b) => b.item === 'CopperPowder')!.overflow).toBeGreaterThan(0)

    // Picking reuse on the Copper Ingot side takes them after all.
    const linked = chooseProducer(own, catalog, { item: 'CopperPowder2', producer: '', row: copper.id, reuse: true })
    expect(copperRow(linked).reuseChosen).toBe(true)
    expect(copperRow(linked).fromByproduct).toBeCloseTo(37.5)

    // Reuse again on the Bronze side: back to the plan as it was, the picked side reusing too.
    const back = chooseProducer(own, catalog, { item: 'CopperPowder', producer: '', row: reused.id, reuse: true })
    expect(back.branches).toEqual({ [reused.id]: { producer: '', reuse: true } })
    expect(impureRow(back).fromByproduct).toBeCloseTo(reused.fromByproduct)
    // Everywhere: every row of the item makes its own, and back.
    const all = chooseProducer(base, catalog, { item: 'CopperPowder', producer: 'import', everywhere: true, reuse: false })
    expect(all.noReuse).toEqual(['CopperPowder'])
    expect(impureRow(all).reuse).toBe(false)
    expect(chooseProducer(all, catalog, { item: 'CopperPowder', producer: '', everywhere: true, reuse: true }).noReuse).toBeUndefined()
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
      const bought = result.tree.flatMap(all).find((n) => n.kind === 'purchase')!
      const nodes = solve([{ item: bought.item }]).tree.flatMap(all)
      expect(nodes.some((n) => n.consolidated)).toBe(false)
      expect(nodes.some((n) => n.item === bought.item && n.kind === 'purchase')).toBe(true)
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
    const p = chooseProducer(sol, catalog, { item: 'FairyDust', producer: 'import', row: first.id })
    expect(p.branches).toEqual({ [first.id]: { producer: 'import' } })
    const r = solved(p)
    expectBalanced(r)
    const [a, b] = rows(r, 'FairyDust')
    expect(a.kind).toBe('purchase')
    expect(a.ownChoice).toBe(true)
    expect(b.kind).toBe('produce')
    expect(b.ownChoice).toBe(false)
    const dust = r.balances.find((x) => x.item === 'FairyDust')!
    expect(dust.imported).toBeCloseTo(a.rate)
    expect(dust.produced).toBeCloseTo(b.rate)
  })

  it('applies a pick everywhere on request, clearing branch picks', () => {
    const branch = chooseProducer(sol, catalog, { item: 'FairyDust', producer: 'import', row: first.id })
    const p = chooseProducer(branch, catalog, { item: 'FairyDust', producer: 'import', row: second.id, everywhere: true })
    expect(p.producers.FairyDust).toBe('import')
    expect(p.branches).toEqual({})
    expect(rows(solved(p), 'FairyDust').every((n) => n.kind === 'purchase')).toBe(true)
  })

  it("doesn't store a pick the row inherits anyway, and can clear one", () => {
    const same = chooseProducer(sol, catalog, { item: 'FairyDust', producer: first.producer, row: first.id })
    expect(same.branches ?? {}).toEqual({})
    const picked = chooseProducer(sol, catalog, { item: 'FairyDust', producer: 'import', row: first.id })
    expect(clearBranchChoice(picked, first.id).branches).toEqual({})
  })

  it('covers rows of the same item further down the branch, the deepest pick winning', () => {
    const p = plan({ branches: { '0/WoodBoard': { producer: 'import' }, '0/WoodBoard/X/WoodBoard/Y/WoodBoard': { producer: 'recipe:WoodBoard' } } })
    expect(resolveChoice(p, catalog, 'WoodBoard', '0/WoodBoard/X/WoodBoard').producer).toBe('import')
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

  it('sizes Steam Boilers from the game’s Low/Medium/High settings, scaled by Factory Efficiency', () => {
    expect(BOILER_SETTINGS.map((s) => boilerHeat(s, 1))).toEqual([100, 500, 3000])
    expect(boilerHeat(BOILER_SETTINGS[2], modifiers({ FactorySpeed: 4 }).factorySpeed)).toBeCloseTo(6000)
  })

  it("caps each boiler at what one belt of its fuel brings the furnace under it", () => {
    // Planks: 20 P each, 60/min on a belt = 20 P/s per furnace, below every setting.
    expect(boilersFor(100, 20, 1, 60).map((b) => [b.each, b.count, b.beltLimited])).toEqual([
      [20, 5, true],
      [20, 5, true],
      [20, 5, true],
    ])
    // Coke Powder: 660 P each = 660 P/s per belt, enough for Low and Medium but not High.
    expect(boilersFor(1000, 660, 1, 60).map((b) => [b.each, b.count, b.beltLimited])).toEqual([
      [100, 10, false],
      [500, 2, false],
      [660, 2, true],
    ])
  })

  it('drops a fuel pick that is no longer a fuel (Steam)', () => {
    const steam = plan({ targets: [{ item: 'WoodBoard', rate: 1 }], producers: { [HEAT]: 'fuel:Steam' } })
    expect(catalog.byProduct.get(HEAT)!.map((p) => p.id)).not.toContain('fuel:Steam')
    expect(pruneChoices(steam, catalog)!.producers).toEqual({})
  })

  it('keeps picks still in use', () => {
    expect(pruneChoices(plan({ targets: [{ item: 'Coke', rate: 1 }], ...choices }), catalog)).toBeNull()
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

  it('offers the nursery as the producer of its side product', () => {
    expect(catalog.byProduct.get('GentianNectar')!.some((p) => p.id === 'nursery:GentianSeed')).toBe(true)
    expectBalanced(result)
    expect(result.balances.find((b) => b.item === 'GentianNectar')!.imported).toBe(0)
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
      const check = checkLogistics(result.runs, m).get('nursery:RedcurrantSeed')!
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

  it('follow a smaller Bank Portal stack size', () => {
    const mods = modifiers({}, 10)
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
    const p = [...catalog.byId.values()].find((x) => x.kind === 'recipe' && x.inputs.some((s) => s.item === 'CopperCoin'))!
    const coins = checkProcess(p, mods, 1)!.inputs.find((f) => f.item === 'CopperCoin')!
    expect(coins.slots).toBeCloseTo(coins.perMachine / 10)
    expect(modifiers({}, 0).coinStack).toBe(1)
    expect(modifiers({}, 99).coinStack).toBe(50)
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

describe('bus items used as both fuel and fertilizer', () => {
  // Panacea Potion (internally PanaceaElixir) is the one item that's both fuel and fertilizer.
  it('counts the plan output once: fertilizer takes its share first, heat burns what is left', () => {
    const mods = modifiers({})
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'PanaceaElixir' })
    const both = plan({
      targets: [
        { item: 'PanaceaElixir', rate: 12.5 },
        { item: 'SteelIngot', rate: 10 }, // needs heat
        { item: 'Flax', rate: 60 }, // needs nutrients
      ],
      producers: { [NUTRIENTS]: 'fert:PanaceaElixir', [HEAT]: 'fuel:PanaceaElixir' },
      feedbackItems: ['PanaceaElixir'],
    })
    const [fert, heat] = ledgers(both, catalog, solvePlan(both, catalog, mods))
    expect([fert.resource, heat.resource]).toEqual(['fertilizer', 'heat'])
    const spread = fert.sources[0].used
    const burned = heat.sources[0].used
    expect(spread).toBeGreaterThan(0)
    expect(spread + burned).toBeLessThanOrEqual(12.5 + 1e-9)
    // Whatever the target can't cover comes off the bus, for each use.
    expect(spread + fert.bus!.count).toBeCloseTo(fert.need / fert.sources[0].per)
    expect(burned + heat.bus!.count).toBeCloseTo(heat.need / heat.sources[0].per)
  })
})

describe('heat ledger', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  // Planks (WoodBoard) are a fuel; Steel Ingots need heat; the bus burns Coke Powder.
  const base = plan({
    targets: [
      { item: 'WoodBoard', rate: 1 },
      { item: 'WoodBoard', rate: 1e5 },
      { item: 'SteelIngot', rate: 10 },
    ],
    producers: { [HEAT]: 'fuel:CokePowder' },
  })
  const heatOf = (p: Plan) => ledgers(p, catalog, solvePlan(p, catalog, mods)).find((l) => l.resource === 'heat')!

  it('takes everything from the bus unless the plan feeds back', () => {
    const heat = heatOf(base)
    expect(heat.need).toBeGreaterThan(0)
    expect(heat.covered).toBe(0)
    expect(heat.bus!.item).toBe('CokePowder')
    expect(heat.bus!.count * heat.bus!.per).toBeCloseTo(heat.need)
    expect(heat.sources.map((s) => [s.target, s.fedBack])).toEqual([
      [0, false],
      [1, false],
    ])
  })

  it('burns fed-back targets in target order, then the bus', () => {
    const heat = heatOf({ ...base, feedbackItems: ['WoodBoard'] })
    const [first, second] = heat.sources
    expect(first.used).toBeCloseTo(1) // all of it, before the second target
    expect(second.used).toBeCloseTo((heat.need - first.per) / second.per)
    expect(heat.covered).toBeCloseTo(heat.need)
    expect(heat.bus!.count).toBe(0)

    const moved = heatOf(moveTarget({ ...base, feedbackItems: ['WoodBoard'] }, 1, 0))
    expect(moved.sources[0].target).toBe(0)
    expect(moved.sources[0].amount).toBe(1e5)
    expect(moved.sources[1].used).toBe(0) // the big target covers it all now
  })

  it('lets a target set its own feedback, and dropping it again restores the plan', () => {
    const fed = { ...base, feedbackItems: ['WoodBoard'] }
    const optedOut = setTargetFeedback(fed, 1, false)
    expect(optedOut.targets[1].feedback).toBe(false)
    const heat = heatOf(optedOut)
    expect(heat.sources[1]).toMatchObject({ fedBack: false, used: 0 })
    expect(heat.bus!.count).toBeGreaterThan(0)
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
    const legacy = plan({ ...base, producers: { [HEAT]: 'fuel:WoodBoard' }, feedback: { fuel: true, fertilizer: false } })
    const migrated = migrateFeedback(legacy, catalog)!
    expect(migrated.feedbackItems).toEqual(['WoodBoard'])
    expect(migrated).not.toHaveProperty('feedback')
    expect(migrateFeedback(migrated, catalog)).toBeNull()
  })

  it('forgets fed-back items the plan no longer makes', () => {
    const pruned = pruneChoices({ ...base, feedbackItems: ['WoodBoard', 'PanaceaElixir'] }, catalog)!
    expect(pruned.feedbackItems).toEqual(['WoodBoard'])
  })
})

describe('net-surplus targets', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const solved = (p: Plan) => {
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    return { result, heat: ledgers(p, catalog, result).find((l) => l.resource === 'heat')! }
  }
  const steel = { item: 'SteelIngot', rate: 10 }
  const fed = (targets: Plan['targets']) =>
    plan({ targets, producers: { [HEAT]: 'fuel:CokePowder' }, feedbackItems: ['WoodBoard', 'CokePowder'] })

  it('builds enough to cover the heat and still deliver the rate', () => {
    const { result, heat } = solved(fed([{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel]))
    const [source] = heat.sources
    expect(heat.absorbedBy).toBe(0)
    expect(heat.bus).toBeNull()
    expect(heat.short).toBe(0)
    expect(source.used * source.per).toBeCloseTo(heat.need)
    expect(source.amount - source.used).toBeCloseTo(50)
    expect(result.targets[0]).toMatchObject({ rate: 50 })
    expect(result.targets[0].made).toBeCloseTo(source.amount)
    expect(result.balances.find((b) => b.item === HEAT)!.deficit).toBe(0)
    expect(result.tree[0].rate).toBeCloseTo(source.amount) // the row is built for all of it
  })

  it('covers only what the fed-back targets ahead of it leave', () => {
    const alone = solved(fed([{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel]))
    const { heat } = solved(fed([{ item: 'WoodBoard', rate: 100 }, steel, { item: 'WoodBoard', rate: 50, unit: 'net' }]))
    const [ahead, net] = heat.sources
    expect(ahead.used).toBeCloseTo(100)
    expect(net.target).toBe(2)
    expect(net.used * net.per).toBeCloseTo(heat.need - 100 * ahead.per)
    expect(net.amount - net.used).toBeCloseTo(50)
    expect(net.amount).toBeCloseTo(alone.heat.sources[0].amount - 100)
  })

  it('leaves the targets after it unburned', () => {
    const { heat } = solved(fed([{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel, { item: 'WoodBoard', rate: 100 }]))
    expect(heat.sources.map((s) => s.target)).toEqual([0, 2])
    expect(heat.sources[1].used).toBe(0)
    expect(heat.sources[0].used * heat.sources[0].per).toBeCloseTo(heat.need)
  })

  it('counts the heat its own chain needs', () => {
    // Coke Powder comes from Coke, which Athanors make with heat.
    const { result, heat } = solved(fed([{ item: 'CokePowder', rate: 10, unit: 'net' }]))
    expect(heat.need).toBeGreaterThan(0)
    expect(heat.covered).toBeCloseTo(heat.need)
    expect(heat.sources[0].amount - heat.sources[0].used).toBeCloseTo(10)
    expect(result.runs.some((r) => r.process.id === 'fuel:CokePowder' && r.inputs[0].item === 'CokePowder')).toBe(true)
  })

  it('burns overflow first, though it grows with the target', () => {
    // Without reuse, the Charcoal the Coke Athanors make on the side overflows: more Coke Powder,
    // more of it. The solve settles on a build where the overflow and the target cover the heat.
    const p = { ...fed([{ item: 'CokePowder', rate: 10, unit: 'net' as const }]), noReuse: ['Charcoal'] }
    const { heat } = solved({ ...p, feedbackItems: ['CokePowder', 'Charcoal'] })
    const [overflow, net] = heat.sources
    expect(overflow).toMatchObject({ item: 'Charcoal', target: null })
    expect(overflow.used).toBeCloseTo(overflow.amount)
    expect(overflow.used * overflow.per + net.used * net.per).toBeCloseTo(heat.need)
    expect(net.amount - net.used).toBeCloseTo(10)
    expect(net.used).toBeLessThan(solved(p).heat.sources.find((s) => s.target === 0)!.used)
  })

  it("doesn't count fed-back overflow as overflow, and balances heat from zero", () => {
    const p = { ...fed([steel]), noReuse: ['Charcoal'], feedbackItems: ['Charcoal'] }
    const { heat } = solved(p)
    const [overflow] = heat.sources
    expect(overflow.item).toBe('Charcoal')
    // Steel's Coke Athanors make Charcoal on the side; the share burned stops being overflow.
    const moneyOf = (q: Plan) => {
      const r = solvePlan(q, catalog, mods)
      return moneyLedger(q, catalog, r, ledgers(q, catalog, r))
    }
    expect(fedOverflow(moneyOf(p)).get('Charcoal')).toEqual({ share: expect.closeTo(overflow.used / overflow.amount), into: ['heat'] })
    // Made counts all of it, burned or not; the plan covers whichever is smaller of that and its need.
    expect(heat.made).toBeCloseTo(overflow.amount * overflow.per)
    expect(heat.covered).toBeCloseTo(Math.min(heat.need, heat.made))
    expect(fedOverflow(moneyOf({ ...p, feedbackItems: [] })).size).toBe(0)
  })

  it('sets up a provider as an ordinary target that removing undoes', () => {
    const bus = plan({ targets: [steel], producers: { [HEAT]: 'fuel:CokePowder' } })
    const provided = addProvider(bus, 'CokePowder')
    expect(provided.targets[1]).toEqual({ item: 'CokePowder', rate: 0, unit: 'net', feedback: true })
    const { heat } = solved(provided)
    expect(heat.absorbedBy).toBe(1)
    expect(heat.covered).toBeCloseTo(heat.need)
    expect(heat.sources[0].amount - heat.sources[0].used).toBeCloseTo(0)
    expect(removeTarget(provided, 1)).toEqual(bus)
    // Already fed back for the whole plan: the target just follows that.
    expect(addProvider({ ...bus, feedbackItems: ['CokePowder'] }, 'CokePowder').targets[1]).not.toHaveProperty('feedback')
  })

  it('is a plain items target unless it is fed back', () => {
    const net = plan({ targets: [{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel], producers: { [HEAT]: 'fuel:CokePowder' } })
    const { result, heat } = solved(net)
    expect(heat.absorbedBy).toBeNull()
    expect(heat.bus!.count * heat.bus!.per).toBeCloseTo(heat.need)
    expect(result.targets[0].made).toBe(50)
    expect(result.tree[0].rate).toBeCloseTo(50)
  })
})

describe('the bus: money in, items out', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const bus = (p: Plan, c: ProcessCatalog = catalog) => {
    const result = solvePlan(p, c, mods)
    const l = ledgers(p, c, result)
    return { result, ledgers: l, money: moneyLedger(p, c, result, l) }
  }
  const out = (m: MoneyLedger, item: string) => m.outputs.find((o) => o.item === item)!

  it("values what goes out at the shop's base price, and costs portal purchases", () => {
    const { result, money } = bus(plan({ targets: [{ item: 'Bandage', rate: 10 }, { item: 'WoodBoard', rate: 60 }] }))
    expect(out(money, 'Bandage')).toMatchObject({ toBus: 10, price: 350, feeds: [] })
    expect(out(money, 'WoodBoard')).toMatchObject({ toBus: 60, price: null, feeds: ['heat'] }) // a fuel the shop won't buy
    expect(money.value).toBeCloseTo(3500)
    const bought = result.balances.filter((b) => !b.item.startsWith('@') && b.imported > 0)
    expect(money.need).toBeCloseTo(bought.reduce((t, b) => t + b.imported * itemsByKey.get(b.item)!.buyPrice!, 0))
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
    expect(coins.imported).toBeGreaterThan(0)
    expect(money.coins).toEqual([{ item: 'CopperCoin', count: coins.imported, price: 1 }])
    expect(defaultProducer(catalog, 'GoldCoin')).toBe('import')
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

  it('shows an item that is both fuel and fertilizer as one output, net of both uses', () => {
    const both = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'PanaceaElixir' })
    const p = plan({
      targets: [{ item: 'PanaceaElixir', rate: 12.5 }, { item: 'SteelIngot', rate: 10 }, { item: 'Flax', rate: 60 }],
      producers: { [NUTRIENTS]: 'fert:PanaceaElixir', [HEAT]: 'fuel:PanaceaElixir' },
      feedbackItems: ['PanaceaElixir'],
    })
    const { money } = bus(p, both)
    const panacea = out(money, 'PanaceaElixir')
    expect(panacea.feeds).toEqual(['heat', 'fertilizer'])
    expect(panacea.used.heat).toBeGreaterThan(0)
    expect(panacea.used.fertilizer).toBeGreaterThan(0)
    expect(panacea.toBus).toBeCloseTo(12.5 - panacea.used.heat! - panacea.used.fertilizer!)
    expect(money.value).toBeCloseTo(panacea.toBus * itemsByKey.get('PanaceaElixir')!.sellPrice!) // steel and flax don't sell
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

  it('takes 1500 / value seconds per essence, clamped to 0.5–1500 s', () => {
    expect(paradoxSeconds('SageSeed', mods)).toBeCloseTo(1500 / 360)
    expect(paradoxSeconds('WoodBoard', mods)).toBe(1500) // value 1
    expect(paradoxSeconds('PhilosopherStone', mods)).toBe(0.5)
  })

  it('refines a whole coin stack at once', () => {
    const copper = itemsByKey.get('CopperCoin')!.baseCost
    expect(paradoxSeconds('CopperCoin', modifiers({}, 50))).toBeCloseTo(1500 / (50 * copper))
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
    expect(refine.machines).toBeCloseTo(6 / (60 / (1500 / 360)))
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
    expect(PLANNER_UPGRADES.map((u) => u.key)).toEqual(['Conveyer', 'FactorySpeed', 'AlchemySkill', 'FuelEfficiency', 'FertilizeEfficiency'])
  })

  it('caps levels per series', () => {
    const caps = Object.fromEntries(PLANNER_UPGRADES.map((u) => [u.key, maxLevel(u)]))
    expect(caps).toEqual({ FactorySpeed: 92, Conveyer: 92, FuelEfficiency: Infinity, FertilizeEfficiency: Infinity, AlchemySkill: Infinity })
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
    expect(defaultProducer(at(3), 'Flax')).toBe('recipe:Flax') // seed plot until nurseries
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
