import { describe, expect, it } from 'vitest'
import { evaluateNormal } from './cauldron'
import { NUTRIENTS } from './gameData'
import { buildCatalog, savedRecipeProcess } from './processes'
import { ledgers } from './ledger'
import { fedOverflow, moneyLedger } from './money'
import { solvePlan, type PlanResult } from './solver'
import { onOverflow } from './tree'
import {
  chooseProducer,
  addOverflowTarget,
  convertOverflowTarget,
  linkToOverflow,
  moveTarget,
  removeTarget,
  setTargetFeedback,
  rowsById,
  setRoundUp,
} from './choices'
import { sanitizePlans } from './sanitize'
import { BUS } from './unfold'
import type { MyDefaults, Plan, SavedRecipe } from './types'
import { modifiers } from './upgrades'
import { round1, plan, expectBalanced } from './engineTestUtils'

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

  it('solves when a priority pass reaches an optimum at the solver’s noise floor', () => {
    // A pass here reaches about a millionth: HiGHS called it "Unknown", and the pass after it found
    // no solution within the usual room.
    const r = solvePlan(using(plan({ targets: [{ item: 'Catalyst4', rate: 10 }] }), 'GoldDust2', 'GoldDust'), catalog, mods)
    expect(r.status).toBe('ok')
    expectBalanced(r)
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
    // Mars's Bronze Rivets built separately: they gather in a row of their own, which makes its
    // Impure Copper Powder, rather than in the overflow target's row (which only takes overflow, so
    // it would fall short).
    const mars = plan({ targets: [{ item: 'Mars', rate: 1 }], separate: [{ item: 'BronzeRivet' }] })
    const r = solvePlan(addOverflowTarget(mars, 'BronzeRivet', 'CopperPowder'), catalog, mods)
    expectBalanced(r)
    const byId = rowsById(r.tree)
    expect(byId.get('0/Mars/BronzeRivet')!.kind).toBe('separate')
    const gathered = byId.get('separate/BronzeRivet')!
    expect(gathered.consolidated).toBe(true)
    expect(byId.get('1/BronzeRivet')!.consolidated).toBeFalsy()
    expect(rows(r).every((n) => n.shortfall === 0)).toBe(true)
    // The Copper Bearings' Athanors refine their failed crafts back up themselves, so none is left
    // for the rivets' Impure Copper Powder, and none overflows for the target.
    expect(gathered.children[0].children[0].fromByproduct).toBe(0)
    expect(r.targets[1]).toMatchObject({ rate: 0, overflow: { uses: true, taken: 0 } })
  })

  it('takes only what the rest of the plan leaves once it has recovered what it can', () => {
    // Gold Dust Athanors' failed crafts give Crude Gold Dust, which the plan refines back into Gold
    // Dust: none overflows, so the target makes none, and the Athanors don't run harder to give it
    // some. The plan's recovery rows are held as they are without the target too: measured with it,
    // their Silver Powder went to rows using it directly, leaving them nothing to run on (the solver
    // found no solution).
    const gold = plan({ targets: [{ item: 'GoldDust3', rate: 10 }], producers: { GoldDust3: 'recipe:GoldDust3' } })
    const before = solvePlan(gold, catalog, mods)
    expect(surplus(before, 'GoldDust')).toBe(0)
    expect(rows(before).some((n) => n.id === '0/GoldDust3/recover:GoldDust3@recipe:GoldDust3_Alt' && n.rate > 0)).toBe(true)
    const r = solvePlan(using(gold, 'GoldDust2', 'GoldDust'), catalog, mods)
    expectBalanced(r)
    expect(r.targets[1]).toMatchObject({ rate: 0, overflow: { uses: true, taken: 0, unused: 0, runaway: false } })
    expect(rows(r).every((n) => n.shortfall === 0)).toBe(true)
    const machines = (x: PlanResult) => rows(x).filter((n) => n.id.startsWith('0/')).map((n) => [n.id, round1(n.machines)])
    expect(machines(r)).toEqual(machines(before))
  })

  it('takes the by-products a row gets more of than it needs', () => {
    // The Impure Gold Dust row takes Crude Gold Dust from the bus, and the Athanors' failed crafts
    // give it more than it uses: the rest overflows to the target, not out of that row.
    const gold = plan({
      targets: [{ item: 'GoldDust3', rate: 10 }, { item: 'GoldDust2', rate: 1 }],
      producers: { GoldDust3: 'recipe:GoldDust3' },
      branches: { '1/GoldDust2/GoldDust': { producer: BUS } },
    })
    const crude = surplus(solvePlan(gold, catalog, mods), 'GoldDust')
    expect(crude).toBeGreaterThan(0)
    const r = solvePlan(using(gold, 'GoldDust2', 'GoldDust'), catalog, mods)
    expectBalanced(r)
    expect(r.targets[2].overflow).toMatchObject({ taken: expect.closeTo(crude), unused: 0 })
    expect(surplus(r, 'GoldDust')).toBeCloseTo(0)
  })

  it('feeds back what it makes to the rows making its item, which take it first', () => {
    // Crude Shard crushed from Quartz leaves the Salt rows' Sand over: a Crude Shard target using it,
    // refining the Sand, fed back, covers part of the Crude Shard the plan uses. The crushers make
    // the rest, though overflow targets hold the plan's rows at what they run without them.
    const quartz = plan({ targets: [{ item: 'GoldDust3', rate: 3 }], producers: { Shard1: 'recipe:Shard1_Alt' } })
    const crushers = (r: PlanResult) => r.runs.find((x) => x.process.id === 'recipe:Shard1_Alt')?.craftsPerMinute ?? 0
    const before = solvePlan(quartz, catalog, mods)
    const sand = surplus(before, 'Sand')
    expect(sand).toBeGreaterThan(0)
    const fed = setTargetFeedback(
      chooseProducer(using(quartz, 'Shard1', 'Sand'), catalog, { item: 'Shard1', producer: 'recipe:Shard1', row: '1/Shard1' }),
      1,
      true,
    )
    const r = solvePlan(fed, catalog, mods)
    expectBalanced(r)
    // 128 Sand refine into a Crude Shard.
    expect(r.targets[1]).toMatchObject({ rate: expect.closeTo(sand / 128), fedIn: expect.closeTo(sand / 128) })
    expect(surplus(r, 'Sand')).toBe(0)
    expect(crushers(r) * 80).toBeCloseTo(crushers(before) * 80 - sand / 128)
    const out = moneyLedger(fed, r, ledgers(fed, r)).outputs.find((o) => o.item === 'Shard1')
    expect(out?.toBus ?? 0).toBe(0)

    // The same with the crushers' Quartz Ore built separately: it runs less too, rather than making
    // as much as ever and the crushers overflowing Crude Shard.
    const apart = solvePlan({ ...fed, separate: [{ item: 'QuartzOre', anchor: 'GoldDust3' }] }, catalog, mods)
    expectBalanced(apart)
    expect(apart.targets[1]).toMatchObject({ rate: expect.closeTo(sand / 128), fedIn: expect.closeTo(sand / 128) })
    expect(crushers(apart)).toBeCloseTo(crushers(r))
    expect(surplus(apart, 'Shard1')).toBe(0)
  })

  it('has its output taken first however far down the targets it is', () => {
    // Taking a fed-back target's output is priced by its place, but making the item instead costs its
    // whole chain, down to what the plan takes in: a target 50 places down is still taken first.
    for (const k of [0, 50]) {
      const fillers = Array.from({ length: k }, () => ({ item: 'Salt', rate: 1 }))
      const quartz = plan({ targets: [{ item: 'GoldDust3', rate: 3 }, ...fillers, { item: 'Shard1', rate: 2 }], producers: { Shard1: 'recipe:Shard1_Alt' } })
      const r = solvePlan(setTargetFeedback(quartz, k + 1, true), catalog, mods)
      expectBalanced(r)
      expect(r.targets[k + 1].fedIn).toBeCloseTo(2)
    }
  })

  describe('fed back into a plan sharing by-products between chains', () => {
    // A player's Sol plan: its Perfect Diamond cauldrons take Gold Dust built separately, whose
    // Athanors share their by-products with the other Gold Dust chains (Ruby, Sapphire, Philosopher's
    // Stone). The target refines Shattered Crystal into Perfect Diamonds.
    const mods = modifiers({ FactorySpeed: 12 })
    const cauldron = (id: string, inputs: string[], output: string): SavedRecipe => ({ id, mode: 'normal', inputs, output, createdAt: 0 })
    const recipes = [
      cauldron('pd', ['Flax', 'GoldDust3', 'GoldDust5'], 'Diamond3'),
      cauldron('mal', ['Flax', 'FlaxFiber', 'Gentian'], 'Malachite'),
      cauldron('rc', ['Flax', 'Flax', 'GoldDust3'], 'Catalyst3'),
      cauldron('ps', ['Flax', 'FlaxFiber', 'Crown'], 'PhilosopherStone'),
      cauldron('ruby', ['Flax', 'GoldDust5', 'GoldIngot'], 'Ruby'),
      cauldron('sap', ['GoldDust2', 'GoldDust5', 'Ruby'], 'Sapphire'),
      cauldron('salt', ['Flax', 'FlaxFiber', 'Chamomile'], 'Salt'),
    ]
    const defaults: MyDefaults = {
      Diamond3: { producer: 'cauldron:pd' },
      Obsidian: { producer: 'recipe:Obsidian', catalysts: ['Catalyst4'] },
      Ruby: { producer: 'cauldron:ruby' },
      Sapphire: { producer: 'cauldron:sap' },
      PhilosopherStone: { producer: 'cauldron:ps' },
      Salt: { producer: 'cauldron:salt' },
      Catalyst3: { producer: 'cauldron:rc' },
      GoldDust3: { producer: 'recipe:GoldDust3', catalysts: ['Catalyst3', 'Catalyst4'] },
      LapisLazuli: { producer: 'recipe:LapisLazuli', catalysts: ['Catalyst3', 'Catalyst4'] },
    }
    const sol = (branches: Plan['branches'] = {}) =>
      plan({
        targets: [{ item: 'Diamond3', rate: 0, unit: 'overflow', consumes: 'Crystal1' }, { item: 'Sol', rate: 1, unit: 'machines' }],
        producers: { [NUTRIENTS]: 'fert:PanaceaElixir' },
        branches: { '0/Diamond3': { producer: 'recipe:Diamond3' }, '1/Sol/with:GoldDust3': { producer: 'recipe:GoldDust3_Alt' }, ...branches },
        rowCatalysts: { '1/Sol/with:GoldDust3/GoldDust2/GoldDust': ['Catalyst3', 'Catalyst4'] },
        separate: [{ item: 'GoldDust3', anchor: 'Sol' }, { item: 'GoldIngot' }],
        loopFeedback: true,
      })
    const overflowing = (r: PlanResult) => r.balances.filter((b) => b.surplus > 1e-6).map((b) => b.item)

    it('lets the rows it feeds run as the plan needs, so the chains rebalance as for a standard target', () => {
      // Slowing the cauldrons' chain alone would leave the other chains short of its by-products,
      // and they'd overflow making up for it: some of its Athanors must run a little harder.
      const catalog = buildCatalog({ saved: recipes, machines: {}, mods, fertilizer: 'PanaceaElixir', mine: defaults })
      const p = sol({ '1/Sol/MercuryP/Malachite': { producer: 'cauldron:mal' } })
      const out = solvePlan(p, catalog, mods)
      const made = out.targets[0].rate
      expect(made).toBeGreaterThan(0)
      const fed = solvePlan(setTargetFeedback(p, 0, true), catalog, mods)
      expectBalanced(fed)
      expect(fed.targets[0]).toMatchObject({ rate: expect.closeTo(made), fedIn: expect.closeTo(made) })
      const standard = solvePlan(convertOverflowTarget(setTargetFeedback(p, 0, true), 0, made), catalog, mods)
      expect(overflowing(fed)).toEqual(overflowing(standard))
      expect(overflowing(fed)).toEqual(overflowing(out))
    })

    it('lets rows anywhere in the plan rebalance, not just the chains it feeds', () => {
      // Here Sol's cauldrons make their Gold Dust in their own rows, which take Gold Dust that rows
      // in other branches leave over (one on the alternate recipe). Slowing the cauldrons, they'd
      // take less of it: those rows must run slower too, or it overflows.
      const catalog = buildCatalog({ saved: recipes, machines: {}, mods, fertilizer: 'PanaceaElixir', mine: defaults })
      const inline = plan({
        targets: [{ item: 'Sol', rate: 1, unit: 'machines' }],
        producers: { [NUTRIENTS]: 'fert:PanaceaElixir' },
        branches: {
          '0/Sol/MercuryP/Malachite': { producer: 'cauldron:mal' },
          '0/Sol/MercuryP/LapisLazuli/Catalyst4/Catalyst3/GoldDust3': { producer: 'recipe:GoldDust3_Alt' },
        },
        loopFeedback: true,
      })
      const p = chooseProducer(using(inline, 'Diamond3', 'Crystal1'), catalog, { item: 'Diamond3', producer: 'recipe:Diamond3', row: '1/Diamond3' })
      const out = solvePlan(p, catalog, mods)
      const made = out.targets[1].rate
      expect(made).toBeGreaterThan(0)
      const fed = solvePlan(setTargetFeedback(p, 1, true), catalog, mods)
      expectBalanced(fed)
      expect(fed.targets[1]).toMatchObject({ rate: expect.closeTo(made), fedIn: expect.closeTo(made) })
      expect(overflowing(fed)).toEqual(overflowing(out))
      // Held to what the plan solved without the target (not to the amounts shown), nothing falls short.
      for (const r of [out, fed]) expect(r.balances.filter((b) => b.deficit > 0)).toEqual([])
    })

    it("doesn't run the rows it frees harder to make more of what it takes", () => {
      // Without these defaults the plan overflows no Shattered Crystal, but the Gold Dust chains no
      // longer held could make some for it.
      const mine = { Diamond3: defaults.Diamond3, Obsidian: defaults.Obsidian }
      const catalog = buildCatalog({ saved: recipes.slice(0, 1), machines: {}, mods, fertilizer: 'PanaceaElixir', mine })
      const p = sol()
      expect(solvePlan(p, catalog, mods).targets[0].rate).toBe(0)
      const fed = solvePlan(setTargetFeedback(p, 0, true), catalog, mods)
      expectBalanced(fed)
      expect(fed.targets[0]).toMatchObject({ rate: 0, overflow: { taken: 0 } })
    })
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
