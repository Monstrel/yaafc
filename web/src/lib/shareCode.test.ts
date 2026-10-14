import { describe, expect, test } from 'vitest'
import raw from '../data/game-data.json'
import { decodePlan, encodePlan, encodePlanBytes } from './shareCode'
import { BUILDINGS, RECIPES, WORDS } from './shareDictionary'
import { BOILER_SETTINGS } from './steamBoiler'
import type { Plan, SavedRecipe } from './types'

const recipes: SavedRecipe[] = [
  { id: 'h50yn67b', mode: 'normal', inputs: ['Chamomile', 'ChamomilePowder', 'Lavender'], output: 'BlackPowder', createdAt: 1 },
  { id: 'l5azpc75', mode: 'normal', inputs: ['FlaxFiber', 'SagePowder', 'Redcurrant'], output: 'Clay', createdAt: 2, name: 'Clay', note: 'cheap' },
  { id: 'adv00001', mode: 'advanced', inputs: ['Sand', 'Stone'], output: '', createdAt: 3 },
]

/** The plan as a code gives it back: ids, the order of row lists and default fields don't matter. */
function comparable(plan: Plan, saved: SavedRecipe[]) {
  const signature = new Map(saved.map((s) => [s.id, `${s.mode}=${s.inputs.join('+')}`]))
  const text = JSON.stringify({ ...plan, id: '' }).replace(/cauldron:([a-z0-9]+)/g, (_, id) => `cauldron:${signature.get(id) ?? id}`)
  const p = JSON.parse(text) as Plan
  for (const t of p.targets) if (t.unit === 'items') delete t.unit
  p.roundUp?.sort()
  p.built?.sort()
  for (const key of Object.keys(p) as (keyof Plan)[]) {
    const v = p[key]
    if (v && typeof v === 'object' && !Object.keys(v).length && key !== 'producers' && key !== 'machines' && key !== 'targets') delete p[key]
  }
  return p
}

async function roundTrip(plan: Plan, saved = recipes) {
  const code = await encodePlan(plan, saved)
  const back = await decodePlan(code)
  expect(back.plans).toHaveLength(1)
  expect(comparable(back.plans[0], back.savedRecipes)).toEqual(comparable(plan, saved))
  return { code, back }
}

describe('share codes', () => {
  test('round-trip a small plan, carrying the saved recipes it uses', async () => {
    const plan: Plan = {
      id: '073cditn',
      name: 'Gold Brewery',
      targets: [
        { item: 'BlastPotion', rate: 4, unit: 'machines' },
        { item: 'BlackPowder', rate: 2, unit: 'machines' },
      ],
      producers: { Clay: 'cauldron:l5azpc75', '@nutrients': 'fert:Catalyst2' },
      machines: {},
      feedbackItems: ['@heat'],
      branches: {
        '0/BlastPotion/Mors': { producer: 'paradox:BlackPowder' },
        '0/BlastPotion/Mors/BlackPowder': { producer: 'cauldron:h50yn67b' },
        '0/BlastPotion/BlackPowder': { producer: 'cauldron:h50yn67b' },
        '0/BlastPotion/Brandy/CokePowder/Coke': { producer: 'import' },
        '1/BlackPowder': { producer: 'cauldron:h50yn67b' },
      },
    }
    const { code, back } = await roundTrip(plan)
    // Only the recipes it uses, once each, without their names or notes.
    expect(back.savedRecipes.map((s) => s.inputs)).toEqual([recipes[1].inputs, recipes[0].inputs])
    expect(back.savedRecipes.map((s) => s.output)).toEqual(['Clay', 'BlackPowder'])
    expect(back.savedRecipes[0].name).toBeUndefined()
    expect(code.length).toBeLessThan(100)
  })

  test('round-trip every field', async () => {
    const plan: Plan = {
      id: 'x',
      name: 'Ünïcödé plan ✓',
      targets: [
        { item: 'Sol', rate: 1 / 3, feedback: false },
        { item: 'GoldCoin', rate: 0, unit: 'overflow', consumes: 'Sand', feedback: true },
        { item: 'Brandy', rate: 2.5, unit: 'dispatch' },
        { item: 'Steam', rate: 12, unit: 'net' },
        { item: 'Clay', rate: 7, unit: 'supply', consumes: 'FlaxFiber' },
      ],
      producers: {
        '@money': 'spend:SilverCoin',
        '@heat': 'boiler:High',
        Flax: 'nursery:FlaxSeed',
        Sapling: 'nursery:TreeStage2',
        SilverCoin: 'bank:GoldCoin:SilverCoin',
        Sand: 'buy:Sand',
        Stone: 'bus',
        Coke: 'fuel:Coke',
        Brandy: 'recipe:' + RECIPES[5],
        Nothing: '',
        Lost: 'cauldron:not-saved',
        Future: 'teleporter:Sand',
      },
      machines: { ['recipe:' + RECIPES[3]]: BUILDINGS[2], 'cauldron:adv00001': 'Cauldron', 'odd:process': 'NotABuilding' },
      autoOrganize: true,
      loopFeedback: true,
      feedbackItems: ['@heat', 'GoldCoin'],
      altarItems: ['Sand', 'ItemFromTheFuture'],
      separate: [{ item: 'Sand' }, { item: 'Stone', anchor: 'Sand' }, { item: 'Coke', anchor: 'Brandy', at: '2/Brandy/with:Coke' }],
      busSupply: { Stone: 120, Sand: 0.125, Clay: Math.PI },
      branches: {
        '0/Sol/Catalyst4': { producer: 'cauldron:adv00001', machine: 'AdvancedCauldron' },
        '0/Sol/Catalyst4/recover:Sand@cauldron:h50yn67b': { producer: 'recipe:' + RECIPES[0] },
        '12/Steam/@heat': { producer: 'boiler:Low' },
      },
      roundUp: ['0/Sol', '0/Sol/Catalyst4', '3/Steam'],
      built: ['0/Sol/Catalyst4/PhilosopherStone', '1/GoldCoin'],
      units: { '0/Sol/Catalyst4': { count: 3, of: 9 } },
      rowStacks: { '1/GoldCoin/@money': 25 },
      rowHeights: { '0/Sol/Catalyst4/PhilosopherStone': 4.5 },
      rowCatalysts: { '0/Sol': ['Catalyst2', 'Catalyst2'], '0/Sol/x/with:Clay': [] },
      altarOutputs: { '0/Sol/Catalyst4': ['Sand', 'Stone'] },
      mixedFeed: { '0/Sol/Catalyst4': true, '0/Sol': false },
    }
    await roundTrip(plan)
  })

  test('round-trip big numbers and a path that isn’t a target’s', async () => {
    await roundTrip({
      id: 'x',
      name: '',
      targets: [{ item: 'Sand', rate: 123456789.001 }],
      producers: {},
      machines: {},
      roundUp: ['weird/Sand'],
      busSupply: { Sand: 1e300, Stone: 2 ** 53 },
    })
  })

  test('deflate a code when that makes it shorter', async () => {
    // Branches repeating the same long chain: the tree can't share it, deflate can.
    const chain = 'Sand8/Sand6/Sand5/Sand4/Sand3/Sand2/Sand/Stone'
    const plan: Plan = {
      id: 'x',
      name: 'Repeats',
      targets: [{ item: 'Sol', rate: 1 }],
      producers: {},
      machines: {},
      roundUp: ['Shard1', 'Shard2', 'Shard3', 'Crystal1', 'Crystal2', 'Crystal3'].map((s) => `0/Sol/${s}/${chain}`),
    }
    const { code } = await roundTrip(plan)
    expect(code.length * 0.75).toBeLessThan(encodePlanBytes(plan, []).length)
  })

  test('reject a deflate bomb', async () => {
    const zeros = new Blob([new Uint8Array(4 << 20)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const body = new Uint8Array(await new Response(zeros).arrayBuffer())
    const code = btoa(String.fromCharCode(0x81, ...body)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    await expect(decodePlan(code)).rejects.toThrow(/too big/)
  })

  test('carry the research tier the plan was set up at', async () => {
    const plan: Plan = { id: 'x', name: 'n', targets: [{ item: 'Sand', rate: 1 }], producers: {}, machines: {} }
    expect((await decodePlan(await encodePlan(plan, [], 4))).progress).toEqual({ upgrades: {}, tier: 4 })
    // Every tier: none in the backup.
    expect((await decodePlan(await encodePlan(plan, []))).progress).toBeUndefined()
  })

  test('reject what isn’t a share code', async () => {
    const code = await encodePlan({ id: 'x', name: 'n', targets: [{ item: 'Sand', rate: 1 }], producers: {}, machines: {} }, [])
    await expect(decodePlan(code.slice(0, -2))).rejects.toThrow()
    await expect(decodePlan(code + 'AA')).rejects.toThrow()
    await expect(decodePlan('not a code!')).rejects.toThrow()
    await expect(decodePlan('')).rejects.toThrow()
    await expect(decodePlan('Ag')).rejects.toThrow() // format 2
  })

  test('codes are URL-safe', async () => {
    const bytes = encodePlanBytes({ id: 'x', name: 'ÿ'.repeat(40), targets: [], producers: {}, machines: {} }, [])
    expect(bytes.length).toBeGreaterThan(40)
    expect(await encodePlan({ id: 'x', name: 'ÿ'.repeat(40), targets: [], producers: {}, machines: {} }, [])).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('share dictionary', () => {
  // Codes decode by place in these lists: new game data must be appended for codes to stay short.
  test('names every item, recipe, building, seed and boiler setting', async () => {
    const words = new Set(WORDS)
    const missing = [
      ...raw.items.map((i) => i.key),
      ...raw.seeds.map((s) => s.seed),
      ...BOILER_SETTINGS.map((s) => s.name),
      '@heat',
      '@nutrients',
      '@money',
    ].filter((k) => !words.has(k))
    const recipeKeys = new Set(RECIPES)
    const buildingKeys = new Set(BUILDINGS)
    missing.push(...raw.recipes.map((r) => r.key).filter((k) => !recipeKeys.has(k)))
    missing.push(...raw.buildings.map((b: { key: string }) => b.key).filter((k) => !buildingKeys.has(k)))
    expect(missing, 'append these to shareDictionary.ts').toEqual([])
  })

  test('lists fit in a byte and name nothing twice', async () => {
    for (const list of [WORDS, RECIPES, BUILDINGS]) {
      expect(list.length).toBeLessThanOrEqual(0xf0)
      expect(new Set(list).size).toBe(list.length)
    }
  })
})
