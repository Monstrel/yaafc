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
import { buildCatalog, defaultProducer, paradoxSeconds } from './processes'
import { busLines } from './baseInputs'
import { allowedIngredients, builtinGroups, emptyPrefs, onlyGroup, preferredCount, setPrefs } from './itemGroups'
import { countRecipes, diagnoseNoResults, type FinderQuery } from './diagnose'
import { checkLogistics, checkProcess } from './logistics'
import { craftsPerMachine } from './machineRate'
import { solvePlan, type PlanResult } from './solver'
import type { TreeNode } from './tree'
import {
  chooseProducer,
  clearBranchChoice,
  migrateCatalysts,
  pruneChoices,
  rememberSetup,
  setRowCatalysts,
} from './choices'
import { resolveChoice } from './unfold'
import { separationsOf, withSeparation } from './separate'
import { buildingNameFor, itemNameFor, noun } from './plural'
import { BOILER_SETTINGS, boilerHeat } from './steamBoiler'
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
        feedback: { fertilizer: fertilizerFeedback },
      })

    it('sizes the factory from the target and draws fertilizer from the bus', () => {
      const result = solvePlan(loopPlan(false), catalog, mods)
      expectBalanced(result)
      const fc = result.balances.find((b) => b.item === 'Catalyst2')!
      expect(fc.produced).toBeCloseTo(10)
      expect(fc.deficit).toBe(0) // any shortfall is reported deeper, where the chain breaks
      expect(fc.consumed).toBe(0)
      const [line] = busLines(loopPlan(false), result).filter((l) => l.uses.some((x) => x.kind === 'fertilizer'))
      expect(line.item).toBe('Catalyst2')
      expect(line.need).toBeGreaterThan(0)
      expect(line.net).toBeNull()
    })

    it('feedback reports the net without changing the factory', () => {
      const off = solvePlan(loopPlan(false), catalog, mods)
      const on = solvePlan(loopPlan(true), catalog, mods)
      expect(on.runs.map((r) => r.machines)).toEqual(off.runs.map((r) => r.machines))
      const [line] = busLines(loopPlan(true), on).filter((l) => l.uses.some((x) => x.kind === 'fertilizer'))
      expect(line.planMakes).toBeCloseTo(10)
      expect(line.net).toBeCloseTo(10 - line.need)
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
  it('merges Panacea Potion into one line and counts the plan output once', () => {
    const mods = modifiers({})
    const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'PanaceaElixir' })
    const base = {
      targets: [
        { item: 'PanaceaElixir', rate: 12.5 },
        { item: 'SteelIngot', rate: 10 }, // needs heat
        { item: 'Flax', rate: 60 }, // needs nutrients
      ],
      producers: { [NUTRIENTS]: 'fert:PanaceaElixir', '@heat': 'fuel:PanaceaElixir' },
    }
    const both = plan({ ...base, feedback: { fuel: true, fertilizer: true } })
    const lines = busLines(both, solvePlan(both, catalog, mods)).filter((l) => l.item === 'PanaceaElixir')
    expect(lines).toHaveLength(1)
    const [line] = lines
    expect(line.uses.map((u) => u.kind).sort()).toEqual(['fertilizer', 'fuel'])
    expect(line.need).toBeCloseTo(line.uses[0].need + line.uses[1].need)
    expect(line.net).toBeCloseTo(12.5 - line.need)

    // Only fuel fed back: fertilizer part is taken from the bus, net covers the fuel part only.
    const fuelOnly = plan({ ...base, feedback: { fuel: true } })
    const [partial] = busLines(fuelOnly, solvePlan(fuelOnly, catalog, mods)).filter((l) => l.item === 'PanaceaElixir')
    const fuel = partial.uses.find((u) => u.kind === 'fuel')!
    expect(partial.net).toBeCloseTo(12.5 - fuel.need)
    expect(partial.boughtNeed).toBeCloseTo(partial.uses.find((u) => u.kind === 'fertilizer')!.need)
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

  it('runs in the World Tree Nursery at a fixed 3 s per item, whatever the fertilizer', () => {
    for (const stage of ['TreeStage2', 'TreeStage3']) {
      const p = catalog.byId.get(`nursery:${stage}`)!
      expect(p.machine?.key).toBe('WorldTreeNursery')
      const items = p.outputs.reduce((sum, s) => sum + s.count, 0)
      expect(p.seconds / items).toBeCloseTo(3)
    }
  })

  it('speeds up with Factory Efficiency', () => {
    const mods = modifiers({ FactorySpeed: 2 })
    expect(mods.factorySpeed).toBeGreaterThan(1)
    expect(craftsPerMachine(tree, mods) / craftsPerMachine(tree, modifiers({}))).toBeCloseTo(mods.factorySpeed)
  })

  it('lists the stage 3 trees grown for cores, though leaves come from stage 2', () => {
    const mods = modifiers({})
    const targets = [{ item: 'Sol', rate: 0.25 }]
    const result = solvePlan(plan({ targets }), catalog, mods)
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
    const picked = chooseProducer(sol, catalog, { item: 'WorldTreeLeaf', producer: 'nursery:TreeStage3', row: leaf.id })
    const tree = solvePlan(picked, catalog, mods).tree
    const root = tree[0]
    expect(all(root).some((n) => n.kind === 'separate' && n.item === 'WorldTreeLeaf')).toBe(true)
    expect(rememberSetup(picked, catalog, tree, root).mine.WorldTreeLeaf).toEqual({ producer: 'nursery:TreeStage3' })
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
