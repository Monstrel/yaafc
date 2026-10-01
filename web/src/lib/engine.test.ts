import { describe, expect, it } from 'vitest'
import { cauldronStats, evaluateAdvanced, evaluateNormal, findRecipes } from './cauldron'
import { HEAT, NUTRIENTS, baseInputKey, cauldronIngredients, gameRecipes, items, itemsByKey, upgrades } from './gameData'
import { buildCatalog, defaultProducer, paradoxSeconds } from './processes'
import { busLines } from './baseInputs'
import { allowedIngredients, builtinGroups, emptyPrefs, onlyGroup, preferredCount, setPrefs } from './itemGroups'
import { countRecipes, diagnoseNoResults, type FinderQuery } from './diagnose'
import { checkLogistics, checkProcess } from './logistics'
import { craftsPerMachine } from './machineRate'
import { pruneChoices, solvePlan, type PlanResult } from './solver'
import { buildTree, staleSeparations, type TreeNode } from './tree'
import { separationsOf, withSeparation } from './separate'
import type { Plan, SavedRecipe } from './types'
import { PLANNER_UPGRADES, maxLevel, modifiers, upgradeLevel } from './upgrades'

const round1 = (x: number) => Math.round(x * 10) / 10

function plan(partial: Partial<Plan>): Plan {
  return { id: 't', name: 't', targets: [], producers: {}, machines: {}, upgrades: {}, ...partial }
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

  it('splits machines by branch and ends in purchased leaves', () => {
    const targets = [{ item: 'WoodBoard', rate: 60 }]
    const [root] = buildTree(solvePlan(plan({ targets }), catalog, mods), targets)
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
    const tree = buildTree(result, targets)
    const find = (nodes: TreeNode[]): TreeNode | undefined =>
      nodes.map((n) => (n.kind === 'loop' ? n : find(n.children))).find(Boolean)
    expect(find(tree)?.item).toBe('Vitae')
  })

  describe('building an item separately', () => {
    const targets = [{ item: 'Sol', rate: 0.25 }]
    const result = solvePlan(plan({ targets }), catalog, mods)
    const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
    const machinesOf = (nodes: TreeNode[], processId: string) =>
      nodes.filter((n) => n.run?.process.id === processId).reduce((sum, n) => sum + n.machines, 0)

    it('gathers every use under one root, keeping each machine counted once', () => {
      const roots = buildTree(result, targets, [{ item: 'WorldTreeLeaf' }])
      const nodes = roots.flatMap(all)
      const leafRoots = roots.filter((r) => r.item === 'WorldTreeLeaf')
      expect(leafRoots).toHaveLength(1)
      expect(leafRoots[0].consolidated).toBe(true)
      const balance = result.balances.find((b) => b.item === 'WorldTreeLeaf')!
      expect(leafRoots[0].rate).toBeCloseTo(balance.consumed + balance.target)

      const uses = nodes.filter((n) => n.item === 'WorldTreeLeaf' && !n.consolidated)
      expect(uses.length).toBeGreaterThan(1)
      expect(uses.every((n) => n.kind === 'separate' && n.children.length === 0 && n.machines === 0)).toBe(true)

      for (const run of result.runs.filter((r) => r.machines > 0 && r.process.machine))
        expect(machinesOf(nodes, run.process.id), run.process.label).toBeCloseTo(run.machines)
    })

    it('ignores items no machine makes for the plan', () => {
      const bought = result.balances.find((b) => b.producer === 'import' && b.consumed > 0 && !b.item.startsWith('@'))!
      const roots = buildTree(result, targets, [{ item: bought.item }])
      expect(roots.filter((r) => r.consolidated)).toHaveLength(0)
      expect(roots.flatMap(all).some((n) => n.item === bought.item && n.kind === 'purchase')).toBe(true)
    })

    it('uses the target row itself as the root when the target is separated', () => {
      const roots = buildTree(result, targets, [{ item: 'Sol' }])
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
      const dusts = buildTree(result, targets).flatMap(all).filter((n) => n.item === 'FairyDust' && n.kind === 'produce')
      const chamomileUnder = (n: TreeNode) => all(n).filter((c) => c.item === 'Chamomile' && c !== n)
      const expectMachinesOnce = (nodes: TreeNode[]) => {
        for (const run of result.runs.filter((r) => r.machines > 0 && r.process.machine))
          expect(machinesOf(nodes, run.process.id), run.process.label).toBeCloseTo(run.machines)
      }

      it('finds the example it needs', () => {
        expect(dusts.length).toBeGreaterThan(1)
        expect(dusts.every((d) => chamomileUnder(d).length > 0)).toBe(true)
      })

      it('gathers the uses below every anchor row into a "with" row after its children', () => {
        const sep = { item: 'Chamomile', anchor: 'FairyDust' }
        const roots = buildTree(result, targets, [sep])
        const nodes = roots.flatMap(all)
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
        expect(staleSeparations(roots, [sep])).toEqual([])
        expectMachinesOnce(nodes)
      })

      it('can gather under just one anchor row', () => {
        const sep = { item: 'Chamomile', anchor: 'FairyDust', at: dusts[0].id }
        const nodes = buildTree(result, targets, [sep]).flatMap(all)
        const groups = nodes.filter((n) => n.separation)
        expect(groups).toHaveLength(1)
        expect(groups[0].id).toBe(`${dusts[0].id}/with:Chamomile`)
        const other = nodes.find((n) => n.id === dusts[1].id)!
        expect(chamomileUnder(other).some((n) => n.kind === 'produce')).toBe(true)
        expectMachinesOnce(nodes)
      })

      it('counts machines once when one gathered row feeds another, in either order', () => {
        const powder = { item: 'ChamomilePowder', anchor: 'FairyDust' }
        const herb = { item: 'Chamomile', anchor: 'FairyDust' }
        // Jupiter uses Planks directly and through its Pulleys: built first, the Plank row has to be
        // rebuilt once the Pulley row adds its Planks.
        const plank = { item: 'WoodBoard', anchor: 'Jupiter' }
        const pulley = { item: 'WoodPulley', anchor: 'Jupiter' }
        for (const seps of [
          [powder, herb],
          [herb, powder],
          [plank, pulley],
          [pulley, plank],
        ]) {
          const roots = buildTree(result, targets, seps)
          expect(staleSeparations(roots, seps)).toEqual([])
          expectMachinesOnce(roots.flatMap(all))
        }
        const jupiter = buildTree(result, targets, [plank, pulley])
          .flatMap(all)
          .find((n) => n.item === 'Jupiter')!
        const planks = jupiter.children.find((c) => c.item === 'WoodBoard' && c.consolidated)!
        const uses = all(jupiter).filter((n) => n.item === 'WoodBoard' && n.kind === 'separate')
        expect(uses.length).toBeGreaterThan(1)
        expect(planks.rate).toBeCloseTo(uses.reduce((sum, n) => sum + n.rate, 0))
      })

      it('takes back what a gathered row gave the others when it is rebuilt', () => {
        // R ← X + Q, Q ← X, X ← Y, one craft per minute per machine. Gathered under R in the order
        // X, Y, Q: X is built from R's own X (giving Y 1/min), then Q's row adds another X, so X is
        // rebuilt at 2/min and must not count its first 1/min of Y twice.
        const recipe = (item: string, inputs: string[], crafts: number) => ({
          process: {
            id: item,
            label: item,
            product: item,
            outputs: [{ item, count: 1 }],
            inputs: inputs.map((i) => ({ item: i, count: 1 })),
            machine: { name: 'M' },
          },
          craftsPerMinute: crafts,
          machines: crafts,
          inputs: inputs.map((i) => ({ item: i, count: crafts })),
          outputs: [{ item, count: crafts }],
        })
        const balance = (item: string, made: number, target = 0) =>
          ({ item, producer: item, target, produced: made, consumed: made - target, imported: 0, deficit: 0, surplus: 0 })
        const fake = {
          status: 'ok',
          runs: [recipe('R', ['X', 'Q'], 1), recipe('Q', ['X'], 1), recipe('X', ['Y'], 2), recipe('Y', [], 2)],
          balances: [balance('R', 1, 1), balance('Q', 1), balance('X', 2), balance('Y', 2)],
        } as never as PlanResult
        const seps = ['X', 'Y', 'Q'].map((item) => ({ item, anchor: 'R' }))
        const [root] = buildTree(fake, [{ item: 'R', rate: 1 }], seps)
        const rows = Object.fromEntries(root.children.filter((c) => c.consolidated).map((c) => [c.item, c]))
        expect(rows.X.rate).toBeCloseTo(2)
        expect(rows.Y.rate).toBeCloseTo(2)
        expect(rows.Y.machines).toBeCloseTo(2)
      })

      it('reports a choice whose anchor sits above none of its uses as stale', () => {
        const sep = { item: 'Chamomile', anchor: 'WorldTreeLeaf' }
        expect(staleSeparations(buildTree(result, targets, [sep]), [sep])).toEqual([sep])
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

describe('forgetting choices', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const choices = {
    producers: { Coke: 'recipe:Coke', [HEAT]: 'fuel:x', [NUTRIENTS]: 'fert:x' },
    machines: { 'recipe:Coke': 'AdvancedAthanor' },
    catalysts: { 'recipe:Coke': ['Catalyst1'] },
  }

  it("drops picks for items and processes that left the plan, keeping fuel and fertilizer", () => {
    const pruned = pruneChoices(plan({ targets: [{ item: 'WoodBoard', rate: 1 }], ...choices }), catalog)!
    expect(pruned.producers).toEqual({ [HEAT]: 'fuel:x', [NUTRIENTS]: 'fert:x' })
    expect(pruned.machines).toEqual({})
    expect(pruned.catalysts).toEqual({})
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
  const [root] = buildTree(result, targets)
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
    const [root] = buildTree(result, targets)
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
    const nodes = buildTree(result, targets).flatMap(all)
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
