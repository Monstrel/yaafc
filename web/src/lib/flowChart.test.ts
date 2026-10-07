import { describe, expect, it } from 'vitest'
import { BOX_W, buildFlowChart, labelWidth } from './flowChart'
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

describe('flow chart', () => {
  it('draws a loop back up the tree as a line to the row using it, and boxes the loop', () => {
    // Vitality Essence ← Oblivion Essence ← Vitality Essence (both Paradox Crucible recipes).
    const { tree } = solvePlan(
      plan({ targets: [{ item: 'Vitae', rate: 10 }], producers: { Mors: 'recipe:Mors_Alt' } }),
      catalog,
      mods,
    )
    const chart = buildFlowChart(tree, tree[0].id)!
    const loop = chart.edges.find((e) => e.kind === 'loop')!
    expect(loop.from).toBe(tree[0].id)
    expect(chart.boxes.get(loop.to)!.item).toBe('Mors')
    expect(chart.loops).toHaveLength(1)
    expect(chart.loops[0].boxes).toEqual([tree[0].id, loop.to])
    // It goes back up the tree, so it runs in a lane above the boxes.
    expect(chart.top).toBeLessThan(0)
    expect(loop.label!.y).toBeLessThan(0)
  })

  it('puts the root on the right and each box left of the box it feeds', () => {
    const { tree } = solvePlan(plan({ targets: [{ item: 'SteelIngot', rate: 10 }] }), catalog, mods)
    const chart = buildFlowChart(tree, tree[0].id)!
    for (const e of chart.edges.filter((e) => e.kind === 'feed'))
      expect(chart.boxes.get(e.from)!.x + BOX_W).toBeLessThan(chart.boxes.get(e.to)!.x)
    // Room on the right only for its failed Iron Ingots going back into it.
    expect(chart.root.x + BOX_W).toBeLessThan(chart.width)
  })

  it('draws by-products as their own line, from the row making them', () => {
    // Steel's failed Iron Ingots go back into its own Iron Ingot supply.
    const { tree } = solvePlan(plan({ targets: [{ item: 'SteelIngot', rate: 10 }] }), catalog, mods)
    const [steel] = tree
    const chart = buildFlowChart(tree, steel.id)!
    const failed = chart.edges.find((e) => e.kind === 'byproduct')!
    expect(failed).toMatchObject({ from: steel.id, to: steel.id, item: 'IronIngot' })
    expect(failed.rate).toBeCloseTo(steel.byproducts.find((b) => b.item === 'IronIngot')!.count)
    // Feeding itself makes a loop of one.
    expect(chart.loops.map((l) => l.boxes)).toContainEqual([steel.id])
  })

  it('stops at the level limit, counting the rows left out', () => {
    const { tree } = solvePlan(plan({ targets: [{ item: 'GoldIngot', rate: 10 }] }), catalog, mods)
    const full = buildFlowChart(tree, tree[0].id)!
    expect(full.depth).toBeGreaterThan(2)
    const one = buildFlowChart(tree, tree[0].id, 1)!
    expect(one.depth).toBe(full.depth)
    expect(Math.max(...[...one.boxes.values()].map((b) => b.depth))).toBe(1)
    const cut = [...one.boxes.values()].find((b) => b.more > 0)!
    // Heat, Nutrients and Money rows get no box of their own.
    expect(cut.more).toBe(all(cut.node!).filter((n) => !n.item.startsWith('@')).length - 1)
  })

  it('shows feeds from rows outside the chart as boxes of their own', () => {
    const { tree } = solvePlan(
      plan({ targets: [{ item: 'Vitae', rate: 10 }], producers: { Mors: 'recipe:Mors_Alt' } }),
      catalog,
      mods,
    )
    const mors = all(tree[0]).find((n) => n.item === 'Mors' && n.kind === 'produce')!
    const chart = buildFlowChart(tree, mors.id)!
    const back = [...chart.boxes.values()].find((b) => b.kind === 'outside')!
    expect(back).toMatchObject({ item: 'Vitae', row: tree[0].id })
    expect(chart.loops).toHaveLength(0)
  })
})

describe('flow chart across separate builds', () => {
  // Coke Powder built at the top of the plan, used by two Steel Ingot targets.
  const { tree } = solvePlan(
    plan({
      targets: [
        { item: 'SteelIngot', rate: 10 },
        { item: 'SteelIngot', rate: 30 },
      ],
      separate: [{ item: 'CokePowder' }],
    }),
    catalog,
    mods,
  )
  const group = tree.find((n) => n.id === 'separate/CokePowder')!
  const [steel] = tree

  it('brings in an item built elsewhere, with what goes to its other uses', () => {
    expect(group.consolidated).toBe(true)
    const chart = buildFlowChart(tree, steel.id)!
    const coke = chart.boxes.get(group.id)!
    expect(coke).toMatchObject({ group: true, depth: 1, rate: expect.closeTo(group.rate) })
    const use = chart.edges.find((e) => e.from === group.id)!
    expect(use).toMatchObject({ kind: 'separate', to: steel.id })
    expect(coke.elsewhere).toEqual({ rate: expect.closeTo(group.rate - use.rate), uses: 1 })
    // Its own ingredients come with it.
    expect(chart.edges.some((e) => e.to === group.id && e.kind === 'feed')).toBe(true)
    expect(chart.depth).toBeGreaterThan(1)
  })

  it('opened from a separate build, counts every use as elsewhere', () => {
    const chart = buildFlowChart(tree, group.id)!
    expect(chart.root.group).toBe(true)
    expect(chart.root.elsewhere).toMatchObject({ uses: 2 })
  })
})

describe('flow chart labels', () => {
  it('leaves each labelled line between neighbouring columns room for its label', () => {
    const { tree } = solvePlan(
      plan({
        targets: [
          { item: 'SteelIngot', rate: 10 },
          { item: 'SteelIngot', rate: 30 },
        ],
        separate: [{ item: 'CokePowder' }],
      }),
      catalog,
      mods,
    )
    const chart = buildFlowChart(tree, tree[0].id)!
    const curved = chart.edges.filter((e) => e.label && e.label.y > 0 && e.label.y < chart.height + chart.top)
    expect(curved.length).toBeGreaterThan(0)
    for (const e of curved) {
      const a = chart.boxes.get(e.from)!
      const b = chart.boxes.get(e.to)!
      expect(b.x - (a.x + a.w)).toBeGreaterThanOrEqual(labelWidth(e.rate) + 40)
    }
  })
})

describe('flow chart lines between the same boxes', () => {
  it('draws each on a path of its own', () => {
    // Crude Gold Dust comes from failed Gold Dust Athanors, which fail into Impure Gold Dust too, and
    // Impure Gold Dust is refined from Crude:
    // two lines run from the Crude box to the Impure one.
    const { tree } = solvePlan(
      plan({
        targets: [{ item: 'GoldIngot', rate: 8.45 }],
        producers: { GoldDust: 'recipe:GoldDust3', GoldDust3: 'recipe:GoldDust3_Alt' },
        separate: [{ item: 'GoldDust5' }, { item: 'GoldDust2' }, { item: 'GoldDust' }],
      }),
      catalog,
      mods,
    )
    const chart = buildFlowChart(tree, tree[0].id)!
    const pairs = new Map<string, number>()
    for (const e of chart.edges) pairs.set(`${e.from}>${e.to}`, (pairs.get(`${e.from}>${e.to}`) ?? 0) + 1)
    expect(Math.max(...pairs.values())).toBeGreaterThan(1)
    expect(new Set(chart.edges.map((e) => e.path)).size).toBe(chart.edges.length)
  })
})

describe('flow chart output colours', () => {
  it('marks each line with the output it leaves its machine by, as the game colours them', () => {
    // Crude Gold Dust comes from the Gold Dust Athanors' failed crafts: their blue outputs.
    const { tree } = solvePlan(
      plan({
        targets: [{ item: 'GoldIngot', rate: 8.45 }],
        producers: { GoldDust: 'recipe:GoldDust3', GoldDust3: 'recipe:GoldDust3_Alt' },
        separate: [{ item: 'GoldDust5' }, { item: 'GoldDust2' }, { item: 'GoldDust' }],
      }),
      catalog,
      mods,
    )
    const chart = buildFlowChart(tree, tree[0].id)!
    const from = (item: string) => chart.edges.filter((e) => chart.boxes.get(e.from)!.item === item)
    // Its own Crude Gold Dust and the Impure Gold Dust they also fail into leave by blue outputs; the
    // Gold Dust the Athanors are for leaves by the gold one, even taken as a by-product.
    const port = (item: string) => from('GoldDust').find((e) => e.item === item)!.port
    expect(port('GoldDust')).toBe('side')
    expect(port('GoldDust2')).toBe('side')
    expect(port('GoldDust3')).toBe('main')
    // Pure Gold Dust is its Refiners' product: the gold output.
    expect(from('GoldDust5').map((e) => e.port)).toEqual(['main'])
    // What comes off the bus has no machine output.
    expect(chart.edges.filter((e) => chart.boxes.get(e.from)!.kind === 'bus').every((e) => e.port === 'none')).toBe(
      true,
    )
  })
})
