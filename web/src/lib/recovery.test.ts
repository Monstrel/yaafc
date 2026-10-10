import { describe, expect, it } from 'vitest'
import { buildFlowChart } from './flowChart'
import { buildCatalog } from './processes'
import { solvePlan } from './solver'
import type { TreeNode } from './tree'
import type { Plan } from './types'
import { modifiers } from './upgrades'

const mods = modifiers({})
const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: null })
const plan = (partial: Partial<Plan>): Plan => ({
  id: 't',
  name: 't',
  targets: [],
  producers: {},
  machines: {},
  ...partial,
})
const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)]

describe('recovering what machines output', () => {
  // Gold Dust from Advanced Athanors: 10% Gold Dust, 30% Impure Gold Dust, 60% Crude Gold Dust.
  // Refiners take 2 Crude → 1 Impure, 2 Impure → 1 Gold Dust, 2 Gold Dust → 1 Pure Gold Dust.
  const gold = solvePlan(
    plan({ targets: [{ item: 'GoldIngot', rate: 8.45 }], producers: { GoldDust3: 'recipe:GoldDust3' } }),
    catalog,
    mods,
  )
  const rows = gold.tree.flatMap(all)
  const athanors = rows.find((n) => n.item === 'GoldDust3' && n.producer === 'recipe:GoldDust3')!

  it('climbs every output up to the product it ends in, joining the stream at each grade', () => {
    expect(gold.status).toBe('ok')
    // Each craft yields 0.1 + 0.3 / 2 + 0.6 / 4 = 0.4 Gold Dust: 16.9 a minute takes 42.25 crafts.
    expect(athanors.run!.craftsPerMinute).toBeCloseTo(42.25)
    const [intoDust] = athanors.children.filter((c) => c.recovery)
    expect(intoDust).toMatchObject({ item: 'GoldDust3', producer: 'recipe:GoldDust3_Alt' })
    expect(intoDust.rate).toBeCloseTo(12.675)
    expect(athanors.fromRecovery).toBeCloseTo(12.675)
    // Its Impure Gold Dust: the Athanors' own, and the Crude refined up into it.
    const impure = intoDust.children.find((c) => c.item === 'GoldDust2')!
    expect(impure.fromByproduct).toBeCloseTo(12.675)
    expect(impure.byproductSources.map((s) => s.id)).toEqual([athanors.id])
    const [intoImpure] = impure.children.filter((c) => c.recovery)
    expect(intoImpure).toMatchObject({ item: 'GoldDust2', producer: 'recipe:GoldDust2' })
    expect(intoImpure.rate).toBeCloseTo(12.675)
    expect(intoImpure.children[0]).toMatchObject({
      item: 'GoldDust',
      kind: 'byproduct',
      fromByproduct: expect.closeTo(25.35),
    })
  })

  it('leaves none of the Athanors’ outputs overflowing', () => {
    for (const b of athanors.byproducts) expect(b.overflow).toBe(0)
    const balance = (item: string) => gold.balances.find((b) => b.item === item)!
    for (const item of ['GoldDust', 'GoldDust2', 'GoldDust3']) expect(balance(item).surplus).toBe(0)
  })

  it('shows only recoveries the plan runs', () => {
    for (const n of rows) if (n.recovery) expect(n.rate).toBeGreaterThan(0)
  })

  it('draws the recovered streams beside the Athanors, feeding the Pure Gold Dust Refiners too', () => {
    const pure = rows.find((n) => n.item === 'GoldDust5')!
    const chart = buildFlowChart(gold.tree, pure.id)!
    const into = (id: string) => chart.edges.filter((e) => e.to === id)
    const recovered = rows.find((n) => n.recovery && n.item === 'GoldDust3')!
    // Both Gold Dust streams feed the Pure Gold Dust Refiners.
    expect(into(pure.id).map((e) => e.from)).toEqual(expect.arrayContaining([athanors.id, recovered.id]))
    expect(chart.boxes.get(athanors.id)!.rate).toBeCloseTo(4.225)
    // The Athanors' failed products go up the Refiners on their blue outputs.
    const fails = chart.edges.filter((e) => e.from === athanors.id && e.kind === 'byproduct')
    expect(fails.map((e) => e.item).sort()).toEqual(['GoldDust', 'GoldDust2'])
    expect(fails.every((e) => e.port === 'side')).toBe(true)
    // Nothing loops: every stream only climbs.
    expect(chart.loops).toEqual([])
  })
})

describe('recovery keeping to its own row', () => {
  // A saved cauldron recipe turns Impure Gold Dust into Resonant Catalyst: the Athanors' failed
  // products could be recovered into it, but they climb back into their own Gold Dust first.
  const saved = [{ id: 'rc', mode: 'normal' as const, inputs: ['Flax', 'Catalyst2', 'GoldDust2'], output: 'Catalyst3', createdAt: 0 }]
  const withRecipe = buildCatalog({ saved, machines: {}, mods, fertilizer: null })
  const { tree, status } = solvePlan(
    plan({
      targets: [
        { item: 'GoldDust5', rate: 10 },
        { item: 'Catalyst3', rate: 10 },
      ],
      producers: { GoldDust3: 'recipe:GoldDust3' },
    }),
    withRecipe,
    mods,
  )
  const rows = tree.flatMap(all)

  it('never runs a row harder to feed another item’s recovery', () => {
    expect(status).toBe('ok')
    // 20 Gold Dust a minute at 0.4 per craft, its failed products all climbing back into it.
    const athanors = rows.find((n) => n.id === '0/GoldDust5/GoldDust3')!
    expect(athanors.run!.craftsPerMinute).toBeCloseTo(50)
    for (const b of athanors.byproducts) expect(b.to.every((t) => t.id.startsWith(athanors.id))).toBe(true)
    // With nothing left over, Resonant Catalyst is made by its own machines.
    const catalyst = rows.find((n) => n.id === '1/Catalyst3')!
    expect(catalyst.run!.craftsPerMinute).toBeCloseTo(10)
    expect(catalyst.fromRecovery).toBe(0)
  })
})

describe('an item only ever made by failing', () => {
  // Gold Dust's Mercury takes Crude Silver Powder, which only comes out of Advanced Athanors failing
  // at Silver Powder (80% of crafts).
  const { tree, balances, status } = solvePlan(plan({ targets: [{ item: 'GoldDust3', rate: 10 }] }), catalog, mods)
  const rows = tree.flatMap(all)
  const powder = rows.find((n) => n.id === '0/GoldDust3/SilverPowder3')!
  const crude = rows.find((n) => n.id === '0/GoldDust3/Mercury/SilverPowder')!

  it('is made in the plan, by the recipe that fails into it', () => {
    expect(status).toBe('ok')
    expect(crude).toMatchObject({ kind: 'produce', producer: 'recipe:SilverPowder3', fromBus: 0 })
    expect(crude.run!.craftsPerMinute).toBeCloseTo(56.25)
    expect(balances.find((b) => b.item === 'SilverPowder')?.fromBus ?? 0).toBe(0)
  })

  it("keeps each row's failed crafts with that row, and sends what else it makes to the row using it", () => {
    // The Silver Powder row refines all its Crude Silver Powder back up: 0.4 Silver Powder a craft.
    expect(powder.byproducts.find((b) => b.item === 'SilverPowder')!.to.every((t) => t.id.startsWith(powder.id))).toBe(true)
    expect(powder.run!.craftsPerMinute).toBeCloseTo(34.375)
    // The Crude Silver Powder row's Silver Powder makes up the rest of the 25 a minute.
    expect(crude.byproducts.find((b) => b.item === 'SilverPowder3')!.to).toEqual([{ id: powder.id, amount: expect.closeTo(11.25) }])
    expect(powder.fromByproduct).toBeCloseTo(11.25)
    // Named for what that row makes: its Silver Powder isn't "from Silver Powder".
    expect(powder.byproductSources).toEqual([{ id: crude.id, label: 'Crude Silver Powder' }])
  })
})

describe('a target of a number of machines', () => {
  it('runs that many, delivering what they make and what is recovered into it', () => {
    // One Advanced Athanor: 7.5 crafts a minute, 0.75 Gold Dust of its own, and its failed crafts
    // refined back up into 2.25 more.
    const { tree, targets } = solvePlan(plan({ targets: [{ item: 'GoldDust3', rate: 1, unit: 'machines' }] }), catalog, mods)
    const [athanors] = tree
    expect(athanors.machines).toBeCloseTo(1)
    expect(athanors.run!.craftsPerMinute).toBeCloseTo(7.5)
    expect(athanors.fromRecovery).toBeCloseTo(2.25)
    expect(targets[0]).toMatchObject({ rate: expect.closeTo(3), made: expect.closeTo(3) })
  })

  it("draws the chart of its row with the recovery beside its machines, not as a loop into them", () => {
    const { tree } = solvePlan(plan({ targets: [{ item: 'GoldDust3', rate: 1, unit: 'machines' }] }), catalog, mods)
    const chart = buildFlowChart(tree, '0/GoldDust3')!
    expect(chart.loops).toEqual([])
    // What it delivers, fed by its own machines and by the recovery beside them.
    expect(chart.root).toMatchObject({ kind: 'outside', item: 'GoldDust3', rate: expect.closeTo(3) })
    const into = chart.edges.filter((e) => e.to === chart.root.id && e.kind === 'feed')
    expect(into.map((e) => [e.from, e.rate])).toEqual(
      expect.arrayContaining([
        ['0/GoldDust3', expect.closeTo(0.75)],
        ['0/GoldDust3/recover:GoldDust3@recipe:GoldDust3_Alt', expect.closeTo(2.25)],
      ]),
    )
    // To the right of both, which sit in one column.
    const athanors = chart.boxes.get('0/GoldDust3')!
    const recovery = chart.boxes.get('0/GoldDust3/recover:GoldDust3@recipe:GoldDust3_Alt')!
    expect(recovery.x).toBe(athanors.x)
    expect(chart.root.x).toBeGreaterThan(athanors.x + athanors.w)
    expect(chart.width).toBeGreaterThanOrEqual(chart.root.x + chart.root.w)
    // The Athanors' failed crafts go across to the recovery as by-products.
    expect(chart.edges.filter((e) => e.from === '0/GoldDust3' && e.kind === 'byproduct').map((e) => e.item).sort()).toEqual(['GoldDust', 'GoldDust2'])
  })
})

describe('flow chart levels', () => {
  it('keeps every line whose boxes are both shown, at any level limit', () => {
    const { tree } = solvePlan(
      plan({ targets: [{ item: 'GoldIngot', rate: 8.45 }], producers: { GoldDust3: 'recipe:GoldDust3' } }),
      catalog,
      mods,
    )
    const pure = tree.flatMap(all).find((n) => n.item === 'GoldDust5')!
    const full = buildFlowChart(tree, pure.id)!
    const key = (e: { from: string; to: string; item: string; kind: string }) => `${e.kind}:${e.from}>${e.to}:${e.item}`
    for (let levels = 1; levels < full.depth; levels++) {
      const cut = buildFlowChart(tree, pure.id, levels)!
      const drawn = new Set(cut.edges.map(key))
      const missing = full.edges.filter((e) => cut.boxes.has(e.from) && cut.boxes.has(e.to) && !drawn.has(key(e)))
      expect(missing.map(key), `at ${levels} levels`).toEqual([])
    }
  })
})
