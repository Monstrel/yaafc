import { describe, expect, it } from 'vitest'
import { findRecipes } from './cauldron'
import {
  HEAT,
  MAX_TIER,
  MONEY,
  NUTRIENTS,
  buyTier,
  cauldronIngredients,
  gameRecipes,
  itemsByKey,
  licenseFor,
  machineTier,
  research,
  targetItems,
} from './gameData'
import { buildCatalog, defaultProducer, STEAM_HEAT_ID, type Process, type ProcessCatalog } from './processes'
import { ledgers } from './ledger'
import { fedOverflow, moneyLedger, type MoneyLedger } from './money'
import { buildingCounts, checkLogistics, checkProcess, resourceUsers } from './logistics'
import { craftsPerMachine } from './machineRate'
import { solvePlan, type PlanResult } from './solver'
import { NO_FLOWS, buildTree, type RowFlows, type TreeNode } from './tree'
import { heatNetworks } from './heatNetworks'
import { setNetworkFuel, setNetworkSource } from './heatChoices'
import {
  chooseProducer,
  migrateInputs,
  migrateLoopFeedback,
  setLoopSource,
  clearBranchChoice,
  addProvider,
  addSupplyTarget,
  setBusSupply,
  convertOverflowTarget,
  linkToSupply,
  migrateCatalysts,
  migrateFeedback,
  moveTarget,
  removeTarget,
  setItemFeedback,
  setAltar,
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
  setRowCatalysts,
} from './choices'
import { sanitizePlans } from './sanitize'
import { dropUnits, setUnits, unitChoices, unitScales, wholePerCopy } from './units'
import { BOILER_HEAT, BUS, isInput, resolveChoice, unfold, type PlanNode } from './unfold'
import { canSeparateShared, organize } from './separateAll'
import { separationsOf } from './separate'
import { BOILER_SETTINGS, STEAM_HEAT } from './steamBoiler'
import type { MyDefaults, Plan, SavedRecipe } from './types'
import { modifiers } from './upgrades'
import { plan, expectBalanced } from './engineTestUtils'

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

describe('producers per branch', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]
  const solved = (p: Plan) => solvePlan(p, catalog, mods)
  const rows = (r: PlanResult, item: string) => r.tree.flatMap(all).filter((n) => n.item === item)
  // Sol makes Fairy Dust in two branches.
  const sol = plan({ targets: [{ item: 'Sol', rate: 0.25 }] })
  const [first, second] = rows(solved(sol), 'FairyDust')

  // Two targets of Coke: a row each.
  const coke = plan({ targets: [{ item: 'Coke', rate: 10 }, { item: 'Coke', rate: 10 }] })

  it('keeps the picks of rows burning or recovering an item when its other rows change', () => {
    const own = {
      '0/Steel/@heat/Coal': { producer: 'recipe:Coal' },
      '0/Steel/Iron/recover:Coal@recipe:R': { producer: 'recipe:R2' },
    }
    const picked = plan({ branches: { ...own, '0/Steel/Iron/Coal': { producer: 'recipe:Coal_Alt' } } })
    // Taken in on an ingredient row: taken in everywhere, but the fuel and recovery rows keep theirs.
    const taken = chooseProducer(picked, catalog, { item: 'Coal', producer: BUS, row: '0/Steel/Iron/Coal' })
    expect(taken.producers.Coal).toBe(BUS)
    expect(taken.branches).toEqual(own)
    // A pick on a row above them replaces the picks of its item's rows below, not theirs.
    const above = chooseProducer(plan({ branches: own }), catalog, { item: 'Coal', producer: 'recipe:Coal', row: '0/Steel', everywhere: false })
    expect(above.branches).toMatchObject(own)
  })

  it('applies a pick to its own branch only', () => {
    const p = chooseProducer(coke, catalog, { item: 'Coke', producer: 'recipe:Coke_Alt', row: '0/Coke' })
    expect(p.branches).toEqual({ '0/Coke': { producer: 'recipe:Coke_Alt' } })
    const r = solved(p)
    expectBalanced(r)
    const [a, b] = r.tree
    expect(a).toMatchObject({ producer: 'recipe:Coke_Alt', ownChoice: true })
    expect(b).toMatchObject({ producer: 'recipe:Coke', ownChoice: false })
  })

  it("doesn't store a pick the row inherits anyway, and can clear one", () => {
    const same = chooseProducer(coke, catalog, { item: 'Coke', producer: 'recipe:Coke', row: '0/Coke' })
    expect(same.branches ?? {}).toEqual({})
    const picked = chooseProducer(coke, catalog, { item: 'Coke', producer: 'recipe:Coke_Alt', row: '0/Coke' })
    expect(clearBranchChoice(picked, '0/Coke').branches).toEqual({})
  })

  it('takes an item in for every row of it, picked on any of them, and makes it everywhere again', () => {
    const p = chooseProducer(sol, catalog, { item: 'FairyDust', producer: 'bus', row: first.id })
    expect(p.producers.FairyDust).toBe('bus')
    expect(p.branches ?? {}).toEqual({})
    // Every row takes it from plan inputs, after what's recovered into it from other rows' leftovers.
    expect(rows(solved(p), 'FairyDust').every((n) => n.recovery || n.kind === 'bus')).toBe(true)
    const made = chooseProducer(p, catalog, { item: 'FairyDust', producer: 'recipe:FairyDust', row: second.id })
    expect(made.producers.FairyDust).toBe('recipe:FairyDust')
    expect(rows(solved(made), 'FairyDust').every((n) => n.kind === 'produce')).toBe(true)
    // Plans saved with it taken in on one row only: taken in everywhere.
    const legacy = plan({ ...sol, branches: { [first.id]: { producer: 'bus' } } })
    expect(resolveChoice(legacy, catalog, 'FairyDust', second.id).producer).toBe('bus')
    expect(migrateInputs(legacy)).toMatchObject({ producers: { FairyDust: 'bus' }, branches: {} })
    expect(migrateInputs(sol)).toBeNull()
  })

  it('covers rows of the same item further down the branch, the deepest pick winning', () => {
    const p = plan({
      branches: { '0/WoodBoard': { producer: 'recipe:GloomFungus' }, '0/WoodBoard/X/WoodBoard/Y/WoodBoard': { producer: 'recipe:WoodBoard' } },
    })
    expect(resolveChoice(p, catalog, 'WoodBoard', '0/WoodBoard/X/WoodBoard').producer).toBe('recipe:GloomFungus')
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
      expect(pruneChoices(plain, athanor)).toMatchObject({ rowCatalysts: undefined })
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
    expect(pruneChoices({ ...p, targets: [{ item: 'WoodBoard', rate: 1 }] }, catalog)).toMatchObject({ branches: undefined })
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
    expect(pruned.rowCatalysts).toBeUndefined()
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
    const bought = plan({ targets: [{ item: 'Coke', rate: 1 }], ...choices, producers: { CharcoalPowder: 'bus' }, built: ['0/Coke/CharcoalPowder'] })
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
    // The bank, gathering nothing now, goes with its pick as the planner prunes the plan.
    const unbanked = setNetworkSource(banked, catalog, steam[0], BUS)
    const back = pruneChoices(unbanked, catalog) ?? unbanked
    expect(back.separate ?? []).toEqual([])
    const again = heatNetworks(solvePlan(back, catalog, mods).tree)
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ key: 'bus:Steam', uses: { length: bus.uses.length } })
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

  it('takes in only what the plan says: what nothing makes is a shortfall until it does', () => {
    // Nothing makes Automatic Cashiers; the Paradox Crucible can refine them into Mors.
    const mors = plan({ targets: [{ item: 'Mors', rate: 1 }], producers: { Mors: 'paradox:CashRegister' } })
    const short = solvePlan(mors, catalog, mods)
    const cashier = short.tree[0].children.find((c) => c.item === 'CashRegister')!
    expect(cashier).toMatchObject({ kind: 'bus', producer: '', fromBus: 0 })
    expect(cashier.shortfall).toBeGreaterThan(0)
    expect(short.balances.find((b) => b.item === 'CashRegister')).toMatchObject({ fromBus: 0 })
    const taken = solvePlan({ ...mors, producers: { ...mors.producers, CashRegister: 'bus' } }, catalog, mods)
    expectBalanced(taken)
    expect(taken.tree[0].children.find((c) => c.item === 'CashRegister')).toMatchObject({ producer: 'bus', shortfall: 0 })
  })

  it('reads plans that bought what portals never sold as taking it from the bus', () => {
    const p = plan({ targets: [{ item: 'FairyTear', rate: 5 }], producers: { FairyDust: 'import' } })
    expect(resolveChoice(p, catalog, 'FairyDust', '0/FairyTear/FairyDust').producer).toBe('bus')
    const dust = solvePlan(p, catalog, mods).balances.find((b) => b.item === 'FairyDust')!
    expect(dust.fromBus).toBeGreaterThan(0)
    expect(dust.produced).toBe(0)
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
    // The Steel's Charcoal chain makes 400 Planks a minute: they come from the targets first, the
    // first one before the second, and what's left of those covers the burning.
    const fed = { ...base, feedbackItems: ['WoodBoard'] }
    const r = solvePlan(fed, catalog, mods)
    expect(r.targets[0].fedIn).toBeCloseTo(1) // all of it, before the second target
    expect(r.targets[1].fedIn).toBeCloseTo(399)
    const l = planks(fed)
    expect(l.sources).toEqual([expect.objectContaining({ target: 1, amount: expect.closeTo(1e5 - 399), used: expect.closeTo(l.need) })])
    expect(l.covered).toBeCloseTo(l.need)
    expect(l.bus).toBe(0)

    const moved = moveTarget(fed, 1, 0)
    const m = solvePlan(moved, catalog, mods)
    expect(m.targets[0].fedIn).toBeCloseTo(400) // the big target covers it all now
    expect(m.targets[1].fedIn ?? 0).toBe(0)
    expect(planks(moved).sources.find((s) => s.target === 1)?.used ?? 0).toBe(0)
  })

  it('lets a target set its own feedback, and dropping it again restores the plan', () => {
    const fed = { ...base, feedbackItems: ['WoodBoard'] }
    const optedOut = setTargetFeedback(fed, 1, false)
    expect(optedOut.targets[1].feedback).toBe(false)
    const l = planks(optedOut)
    expect(l.sources.find((s) => s.target === 1)).toMatchObject({ fedBack: false, used: 0 })
    expect(l.bus).toBeGreaterThan(0)
    expect(setTargetFeedback(optedOut, 1, true)).toEqual(fed)
    // Turning the item off keeps the target's own setting.
    expect(setItemFeedback(setTargetFeedback(base, 0, true), 'WoodBoard', true).targets[0].feedback).toBe(true)
    expect(setItemFeedback(setItemFeedback(base, 'WoodBoard', true), 'WoodBoard', false)).toEqual({ ...base, feedbackItems: undefined })
  })

  it('changes the factory only where rows making the item take it', () => {
    const off = solvePlan(base, catalog, mods)
    const on = solvePlan({ ...base, feedbackItems: ['WoodBoard'] }, catalog, mods)
    // The Plank Table Saws (and the Logs they cut) give way to the targets' Planks; nothing else moves.
    const planking = new Set(['recipe:WoodBoard', 'buy:Wood'])
    const machines = (r: PlanResult) => new Map(r.runs.filter((x) => !planking.has(x.process.id)).map((x) => [x.key, x.machines]))
    expect(machines(on)).toEqual(machines(off))
    const saws = (r: PlanResult) => r.runs.find((x) => x.process.id === 'recipe:WoodBoard')?.machines ?? 0
    expect(saws(on)).toBeLessThan(saws(off))
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
    // The target ahead of it goes to the Planks the Steel's Charcoal chain makes; it covers the burning.
    const alone = solved(fed([{ item: 'WoodBoard', rate: 50, unit: 'net' }, steel]))
    const { result, fuel } = solved(fed([{ item: 'WoodBoard', rate: 100 }, steel, { item: 'WoodBoard', rate: 50, unit: 'net' }]))
    expect(result.targets[0].fedIn).toBeCloseTo(100)
    const net = fuel.sources.find((s) => s.target === 2)!
    expect(net.used).toBeCloseTo(fuel.need)
    expect(net.amount - net.used).toBeCloseTo(50)
    expect(net.amount).toBeCloseTo(alone.fuel.sources[0].amount)
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

  // A Charcoal row rounded up to whole machines overflows: rows only take other rows' side outputs,
  // so that's overflow the plan can feed back into what it burns.
  const rounded = (targets: Plan['targets']) =>
    plan({
      targets: [{ item: 'Charcoal', rate: 1 }, ...targets, steel],
      producers: { [HEAT]: 'fuel:Charcoal' },
      roundUp: ['0/Charcoal'],
      feedbackItems: ['Charcoal'],
    })

  it('takes fed-back overflow first, then a net target', () => {
    const { fuel } = solved(rounded([{ item: 'Charcoal', rate: 10, unit: 'net' }]), 'Charcoal')
    const overflow = fuel.sources.find((s) => s.target === null)!
    const net = fuel.sources.find((s) => s.target === 1)!
    expect(overflow.amount).toBeGreaterThan(0)
    expect(overflow.used).toBeCloseTo(overflow.amount)
    expect(fuel.sources.reduce((t, s) => t + s.used, 0)).toBeCloseTo(fuel.need)
    expect(net.amount - net.used).toBeCloseTo(10)
  })

  it("doesn't count fed-back overflow as overflow", () => {
    const p = rounded([])
    const { fuel } = solved(p, 'Charcoal')
    const overflow = fuel.sources.find((s) => s.target === null)!
    expect(overflow.amount).toBeGreaterThan(0)
    // The share burned stops being overflow.
    const moneyOf = (q: Plan) => {
      const r = solvePlan(q, catalog, mods)
      return moneyLedger(q, r, ledgers(q, r))
    }
    expect(fedOverflow(moneyOf(p)).get('Charcoal')).toEqual({ share: expect.closeTo(overflow.used / overflow.amount), into: ['plan'] })
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

  it('breaks down overflow at Knowledge Altars instead of sending it out, and only overflow', () => {
    const p = setAltar(plan({ targets: [{ item: 'BlastPotion', rate: 21 }], producers: { Mors: 'paradox:BlackPowder' } }), 'IronIngot', true)
    const { money } = bus(p)
    const iron = out(money, 'IronIngot')
    expect(iron.toBus).toBe(0)
    expect(iron.altar).toBeCloseTo(iron.sources[0].amount)
    expect(iron.sources[0].altar).toBeCloseTo(iron.sources[0].amount)
    expect(fedOverflow(money).get('IronIngot')).toEqual({ share: expect.closeTo(1), into: [], altar: true })
    // A target's own output still goes out.
    const potion = out(bus(setAltar(p, 'BlastPotion', true)).money, 'BlastPotion')
    expect(potion).toMatchObject({ toBus: 21, altar: 0 })
    expect(setAltar(p, 'IronIngot', false).altarItems).toBeUndefined()
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

  it('takes what the plan needs past a cap, saying by how much', () => {
    const open = fc(coke)
    expect(open.line).toMatchObject({ bus: expect.closeTo(0.25), cap: null, overCap: 0 })
    const { result, line, balance } = fc(setBusSupply(coke, 'Catalyst2', 0.1))
    expect(line).toMatchObject({ bus: expect.closeTo(0.25), cap: 0.1, overCap: expect.closeTo(0.15) })
    expect(balance.deficit).toBe(0)
    expect(result.tree[0].children.find((c) => c.item === 'Catalyst2')).toMatchObject({ fromBus: expect.closeTo(0.25), shortfall: 0 })
    // Plenty on the bus: nothing to say.
    expect(fc(setBusSupply(coke, 'Catalyst2', 5)).line.overCap).toBe(0)
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

  it("never gathers the plan's other rows of its item into a supply target's row when organizing", () => {
    // Every Flax nursery on Fertile Catalyst, the supply target's included: set up alike.
    const fertile = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'Catalyst2' })
    const bandages = plan({ targets: [{ item: 'Bandage', rate: 10 }], producers: { [NUTRIENTS]: 'fert:Catalyst2' } })
    const flax = addSupplyTarget(setBusSupply(bandages, 'Catalyst2', 1), 'Flax', 'Catalyst2')
    const organized = organize({ ...flax, autoOrganize: true }, fertile)
    expect(separationsOf(organized.separate).map((s) => s.item)).not.toContain('Flax')
    // Settled: nothing left to gather (gathering it into the target only had it merged back).
    expect(canSeparateShared(organized, fertile)).toBe(false)
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

  it("leaves a target set in machines on the machines it names, rounding the rows below", () => {
    const set = plan({ targets: [{ item: 'Bandage', rate: 2.5, unit: 'machines' }], roundUp: ['0/Bandage', '0/Bandage/Linen'] })
    const r = solvePlan(set, catalog, mods)
    expectBalanced(r)
    expect(r.notice).toBeUndefined()
    expect(rowOf(r, '0/Bandage').machines).toBeCloseTo(2.5)
    const linen = rowOf(r, '0/Bandage/Linen').machines
    expect(linen).toBeCloseTo(Math.round(linen))
  })

  // Every row of a plan rounded up.
  const everyRow = (item: string, rate: number) => {
    const p = plan({ targets: [{ item, rate }] })
    const ids: string[] = []
    const visit = (n: TreeNode) => {
      if (n.kind === 'produce') ids.push(n.id)
      n.children.forEach(visit)
    }
    solvePlan(p, catalog, mods).tree.forEach(visit)
    return { ...p, roundUp: ids }
  }

  it("lets the extra output of rows rounded up overflow, rather than other rows growing to take it", () => {
    // Steam boilers rounded up make far more than 2/min: it overflows, and the rows below (each
    // rounded up too) settle, with no more room for noise than any plan.
    const r = solvePlan(everyRow('Steam', 2), catalog, mods)
    expectBalanced(r)
    expect(r.notice).toBeUndefined()
    expect(r.noise).toBeLessThan(1e-6)
  })

  it("says so when rounding rows up doesn't settle", () => {
    // Each round of Sol's rows rounded up grows the rows below them.
    const r = solvePlan(everyRow('Sol', 2), catalog, mods)
    expect(r.status).toBe('ok')
    expect(r.notice).toMatch(/still use part of one/)
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
    altarOutputs: { '0/A/X': ['Z'], '1/B/X': ['Z'] },
    separate: [{ item: 'X', anchor: 'B', at: '1/B' }, { item: 'Y' }],
  })

  it('moves per-row picks with their target', () => {
    const moved = moveTarget(base, 2, 0)
    expect(moved.targets.map((t) => t.item)).toEqual(['B', 'A', ''])
    expect(moved.branches).toEqual({ '1/A/X': { producer: 'p:a' }, '0/B/X': { producer: 'p:b' } })
    expect(moved.rowCatalysts).toEqual({ '0/B': ['Catalyst1'] })
    expect(moved.altarOutputs).toEqual({ '1/A/X': ['Z'], '0/B/X': ['Z'] })
    expect(moved.separate).toEqual([{ item: 'X', anchor: 'B', at: '0/B' }, { item: 'Y' }])
    expect(moveTarget(moved, 0, 2)).toEqual(base)
  })

  it("drops a removed target's picks and keeps the others with theirs", () => {
    const removed = removeTarget(base, 0)
    expect(removed.targets.map((t) => t.item)).toEqual(['', 'B'])
    expect(removed.branches).toEqual({ '0/B/X': { producer: 'p:b' } })
    expect(removed.rowCatalysts).toEqual({ '0/B': ['Catalyst1'] })
    expect(removed.altarOutputs).toEqual({ '0/B/X': ['Z'] })
    expect(removed.separate).toEqual([{ item: 'X', anchor: 'B', at: '0/B' }, { item: 'Y' }])
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

  it('takes an item in everywhere when the saved default does, but a target still makes it', () => {
    const catalog = catalogWith({ Salt: { producer: BUS } })
    // A target's own row makes its item.
    const [row] = solvePlan(salt, catalog, mods).tree
    expect(row.kind).toBe('produce')
    // Elsewhere it's a plan input: every row takes it in, branch picks or not.
    expect(isInput(salt, catalog, 'Salt')).toBe(true)
    const picked = plan({ branches: { '0/Brine/Salt': { producer: 'recipe:Salt' } } })
    expect(resolveChoice(picked, catalog, 'Salt', '0/Brine/Salt').producer).toBe(BUS)
    // Making it on a row makes it everywhere, as with an input the plan declares.
    const made = chooseProducer(plan({}), catalog, { item: 'Salt', producer: 'recipe:Salt', row: '0/Brine/Salt' })
    expect(made.producers.Salt).toBe('recipe:Salt')
    expect(made.branches ?? {}).toEqual({})
    expect(isInput(made, catalog, 'Salt')).toBe(false)
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

describe('rows covered by other rows’ leftovers', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })

  it('shows a gathered row that leftovers cover idle, without its ingredients, once a row stops using it', () => {
    // Eternal Catalysts drop Gold Dust's ingredients, Silver Powder's Copper Powder uses with them:
    // what's left of them, Bronze Ingot's Copper Powder rows cover with their by-product.
    const before = organize(plan({ targets: [{ item: 'Catalyst4', rate: 1 }], autoOrganize: true }), catalog)
    const gold = '0/Catalyst4/PhilosopherStone/Ruby/GoldDust5/GoldDust3'
    const p = organize(setRowCatalysts(before, gold, ['Catalyst4']), catalog)
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    const row = rowsById(result.tree).get('0/Catalyst4/PhilosopherStone/with:CopperPowder2')!
    expect(row).toMatchObject({ kind: 'byproduct', consolidated: true, machines: 0, children: [] })
    expect(row.fromByproduct).toBeCloseTo(row.rate)
    // No row runs machines for nothing.
    const idle = (n: TreeNode): TreeNode[] => [
      ...(n.kind === 'produce' && n.rate > 0 && n.machines === 0 && n.children.some((c) => c.rate === 0) ? [n] : []),
      ...n.children.flatMap(idle),
    ]
    expect(result.tree.flatMap(idle).map((n) => n.id)).toEqual([])
  })
})

describe('rows looping back into a target', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
  // Eternal Catalysts in the Gold Dust row under an Eternal Catalyst target: its chain uses its item.
  const gold = '0/Catalyst4/PhilosopherStone/Ruby/GoldDust5/GoldDust3'
  const loopRow = `${gold}/Catalyst4`
  const base = setRowCatalysts(plan({ targets: [{ item: 'Catalyst4', rate: 1 }], loopFeedback: true }), gold, ['Catalyst4'])
  const solved = (p: Plan) => {
    const result = solvePlan(p, catalog, mods)
    expectBalanced(result)
    return { result, row: rowsById(result.tree).get(loopRow)!, balance: result.balances.find((b) => b.item === 'Catalyst4')! }
  }

  it('falls short until the target is fed back or the item taken in', () => {
    const { result, row } = solved(base)
    expect(row).toMatchObject({ kind: 'bus', producer: '', loopTarget: 0 })
    expect(row.shortfall).toBeCloseTo(0.05)
    expect(result.targets[0].made).toBeCloseTo(1)
  })

  it('takes what a fed-back target makes, which delivers the rest', () => {
    const fed = setLoopSource(base, catalog, solved(base).row, 'fed', solved(base).result.tree)
    expect(fed).toEqual(setTargetFeedback(base, 0, true))
    const { result, row, balance } = solved(fed)
    expect(row).toMatchObject({ kind: 'loop', loopTarget: 0, shortfall: 0 })
    expect(row.byproductSources.map((s) => s.label)).toEqual(['the Eternal Catalyst target, fed back'])
    expect(result.targets[0]).toMatchObject({ rate: 1, made: 1 })
    expect(result.targets[0].fedIn).toBeCloseTo(0.05)
    expect(balance.target).toBeCloseTo(0.95)
  })

  it('takes the plan input instead, and back', () => {
    const fed = setTargetFeedback(base, 0, true)
    const { row, result } = solved(fed)
    const input = setLoopSource(fed, catalog, row, 'input', result.tree)
    expect(input.producers.Catalyst4).toBe(BUS)
    const taken = solved(input)
    expect(taken.row).toMatchObject({ kind: 'bus', producer: BUS, loopTarget: 0 })
    expect(taken.row.fromBus).toBeCloseTo(0.05)
    expect(taken.result.targets[0].fedIn).toBeUndefined()
    expect(setLoopSource(input, catalog, taken.row, 'fed', taken.result.tree)).toEqual(fed)
  })

  it('offers the target in the outputs as one the plan can use, like coins it spends', () => {
    const output = (p: Plan) => {
      const { result } = solved(p)
      return moneyLedger(p, result, ledgers(p, result)).outputs.find((o) => o.item === 'Catalyst4')!
    }
    const off = output(base)
    expect(off.sources[0]).toMatchObject({ target: 0, fedBack: false, feeds: ['plan'] })
    expect(off.toBus).toBeCloseTo(1)
    const on = output(setTargetFeedback(base, 0, true))
    expect(on.sources[0]).toMatchObject({ target: 0, fedBack: true, feeds: ['plan'] })
    expect(on.used.plan).toBeCloseTo(0.05)
    expect(on.toBus).toBeCloseTo(0.95)
  })

  it('treats a build at the top of the plan used only in the target’s chain as part of it', () => {
    const top = setRowCatalysts(
      plan({ targets: [{ item: 'Catalyst4', rate: 1, feedback: true }], loopFeedback: true, separate: [{ item: 'GoldDust3' }] }),
      'separate/GoldDust3',
      ['Catalyst4'],
    )
    const { nodes } = unfold(top, catalog)
    const row = nodes.find((n) => n.id === 'separate/GoldDust3/Catalyst4')!
    expect(row).toMatchObject({ kind: 'loop', loopTarget: 0, fedBack: true })
    expect(row.ref!.id).toBe('0/Catalyst4')
    // No second Eternal Catalyst chain under it.
    expect(nodes.filter((n) => n.id.startsWith('separate/GoldDust3/Catalyst4/'))).toEqual([])
    const result = solvePlan(top, catalog, mods)
    expectBalanced(result)
    const rows = [...rowsById(result.tree).values()]
    expect(rows.filter((n) => n.rate < 0 || n.machines < 0).map((n) => n.id)).toEqual([])
    expect(rowsById(result.tree).get('separate/GoldDust3/Catalyst4')!.fromByproduct).toBeCloseTo(0.05)
  })

  it('grows a net-surplus target to cover its own chain', () => {
    const net = { ...base, targets: [{ item: 'Catalyst4', rate: 1, unit: 'net' as const, feedback: true }] }
    const { row, balance } = solved(net)
    expect(row).toMatchObject({ kind: 'loop', loopTarget: 0 })
    expect(balance.produced).toBeCloseTo(1.0526)
    expect(balance.target).toBeCloseTo(1)
  })

  it('feeds back the targets loops ran into in plans saved before, once', () => {
    const { loopFeedback: _, ...saved } = base
    const legacy = solved(saved)
    expect(legacy.row.kind).toBe('loop')
    const migrated = migrateLoopFeedback(saved, catalog)!
    expect(migrated).toEqual({ ...saved, loopFeedback: true, targets: [{ item: 'Catalyst4', rate: 1, feedback: true }] })
    expect(solved(migrated).balance).toEqual(legacy.balance)
    expect(migrateLoopFeedback(migrated, catalog)).toBeNull()
    // Turned off afterwards, it stays off.
    expect(migrateLoopFeedback(setTargetFeedback(migrated, 0, false), catalog)).toBeNull()
    // Plans with no such loop only get the marker.
    const plain = plan({ targets: [{ item: 'Brandy', rate: 10 }] })
    expect(migrateLoopFeedback(plain, catalog)).toEqual({ ...plain, loopFeedback: true })
    expect(sanitizePlans([migrated], () => 'x')![0].loopFeedback).toBe(true)
  })
})

describe('a row other rows’ leftovers cover, partly recovered', () => {
  const mods = modifiers({})
  const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })

  it('shows its machines idle, without its ingredients, and the rows recovering into it', () => {
    // Gold Dust needed 20/min: 8 left over by other rows, 12 refined up from their Crude Gold Dust.
    const { roots, nodes } = unfold(plan({ targets: [{ item: 'Catalyst4', rate: 1 }] }), catalog)
    const gold = nodes.find((n) => n.id === '0/Catalyst4/PhilosopherStone/Ruby/GoldDust5/GoldDust3')!
    const recovery = gold.children.find((c) => c.recovers)!
    const flows = new Map<PlanNode, RowFlows>([
      [gold, { ...NO_FLOWS, rate: 20, fromByproduct: 8, fromRecovery: 12, byproductSources: [{ id: 'x', label: 'Gold Dust' }] }],
      [recovery, { ...NO_FLOWS, rate: 12, crafts: 2 }],
    ])
    const row = rowsById(buildTree(roots, flows, mods)).get(gold.id)!
    expect(row).toMatchObject({ kind: 'byproduct', machines: 0 })
    expect(row.children.map((c) => c.id)).toEqual([recovery.id])
  })
})
