import { describe, expect, it } from 'vitest'
import { planAnomalies } from './anomalies'
import { setRowCatalysts } from './choices'
import { buildCatalog } from './processes'
import { organize } from './separateAll'
import { solvePlan, type PlanResult } from './solver'
import type { TreeNode } from './tree'
import type { Plan } from './types'
import { modifiers } from './upgrades'

const mods = modifiers({})
const catalog = buildCatalog({ saved: [], machines: {}, mods, fertilizer: 'BasicFertilizer' })
const plan = (partial: Partial<Plan>): Plan => ({ id: 't', name: 't', targets: [], producers: {}, machines: {}, loopFeedback: true, ...partial })
const anomalies = (p: Plan) => planAnomalies(p, solvePlan(p.autoOrganize ? organize(p, catalog) : p, catalog, mods))

// Eternal Catalysts in the Gold Dust rows under an Eternal Catalyst target (see engine.test.ts).
const gold = '0/Catalyst4/PhilosopherStone/Ruby/GoldDust5/GoldDust3'
const eternal = (partial: Partial<Plan>) => setRowCatalysts(plan({ targets: [{ item: 'Catalyst4', rate: 1, feedback: true }], ...partial }), gold, ['Catalyst4'])

describe('solved plans show nothing the solve doesn’t run', () => {
  const plans: [string, Plan][] = [
    ['Gold Dust', plan({ targets: [{ item: 'GoldDust3', rate: 10 }] })],
    ['Eternal Catalyst, Eternal Catalysts in its Gold Dust rows', eternal({})],
    ['the same, organized', eternal({ autoOrganize: true })],
    ['the same, not fed back', { ...eternal({}), targets: [{ item: 'Catalyst4', rate: 1 }] }],
    [
      'the same, with Gold Coins',
      eternal({ autoOrganize: true, targets: [{ item: 'Catalyst4', rate: 1, feedback: true }, { item: 'GoldCoin', rate: 10, feedback: true }] }),
    ],
    [
      'Gold Dust built separately with Eternal Catalysts',
      setRowCatalysts(plan({ targets: [{ item: 'Catalyst4', rate: 1, feedback: true }], separate: [{ item: 'GoldDust3' }] }), 'separate/GoldDust3', ['Catalyst4']),
    ],
    ['Sol', plan({ targets: [{ item: 'Sol', rate: 0.25 }] })],
    ['Sol, organized', plan({ targets: [{ item: 'Sol', rate: 0.25 }], autoOrganize: true })],
    [
      'Oblivion Essence, crucibles mixing their feed',
      plan({
        targets: [{ item: 'Mors', rate: 180 }, { item: 'GentianNectar', rate: 18 }],
        producers: { Mors: 'paradox:Gentian', Gentian: 'nursery:GentianSeed', GentianNectar: 'nursery:GentianSeed' },
        mixedFeed: { '0/Mors': true },
      }),
    ],
  ]
  for (const [name, p] of plans) it(name, () => expect(anomalies(p)).toEqual([]))
})

describe('planAnomalies', () => {
  const row = (id: string, fields: Partial<TreeNode> = {}): TreeNode =>
    ({
      id,
      item: id.slice(id.lastIndexOf('/') + 1),
      kind: 'produce',
      rate: 10,
      producer: 'recipe:x',
      ownChoice: false,
      mine: false,
      defaultCatalysts: [],
      defaultHeight: 0,
      defaultStack: 50,
      defaultMixed: false,
      machines: 1,
      heat: 0,
      nutrients: 0,
      overflow: 0,
      byproducts: [],
      fromByproduct: 0,
      byproductSources: [],
      fromBus: 0,
      shortfall: 0,
      fromRecovery: 0,
      children: [],
      ...fields,
    }) as TreeNode
  const run = (count: number) => ({
    key: 'k',
    process: { seconds: 1 } as never,
    craftsPerMinute: count,
    machines: count,
    inputs: [],
    outputs: [{ item: 'Stone', count }],
  })
  const solved = (tree: TreeNode[]): PlanResult => ({ status: 'ok', targets: [], runs: [], balances: [], tree, noise: 1e-4 })
  const rules = (tree: TreeNode[]) => planAnomalies(plan({}), solved(tree)).map((a) => `${a.rule} ${a.at}`)

  it('finds each kind', () => {
    expect(
      rules([
        row('0/Brick', {
          run: run(5),
          children: [
            row('0/Brick/Clay', { run: run(0), machines: 0, children: [row('0/Brick/Clay/Sand', { rate: 0 })] }),
            row('0/Brick/Stone', { run: run(1e-6), machines: 1e-6, rate: 1e-6 }),
            row('0/Brick/Sand', { rate: -1e-7 }),
          ],
        }),
        row('separate/Charcoal', { rate: 0, machines: 0, consolidated: true }),
      ]),
    ).toEqual([
      'idle-chain 0/Brick/Clay',
      'noise-row 0/Brick/Stone',
      'phantom-building 0/Brick/Stone',
      'negative 0/Brick/Sand',
      'orphan-group separate/Charcoal',
    ])
  })

  it('leaves coins, and what they pay for, to their own amounts', () => {
    expect(rules([row('0/Wood/@money/GoldCoin', { item: 'GoldCoin', kind: 'bus', rate: 1e-5, fromBus: 1e-5, machines: 0 })])).toEqual([])
  })
})
