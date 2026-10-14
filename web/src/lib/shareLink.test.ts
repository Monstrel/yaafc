import { describe, expect, test } from 'vitest'
import { recipeSignature } from './cauldron'
import { mergeBackup } from './importPlans'
import { planFertilizer } from './planModel'
import { buildCatalog } from './processes'
import { sanitizePlans } from './sanitize'
import { asShared, openShared, planToShare, sameSetup, shareLink, sharedCode } from './shareLink'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './types'
import { BUS, unfold, type PlanNode } from './unfold'
import { modifiers } from './upgrades'

const clay: SavedRecipe = { id: 'l5azpc75', mode: 'normal', inputs: ['FlaxFiber', 'SagePowder', 'Redcurrant'], output: 'Clay', createdAt: 2 }
const recipes: SavedRecipe[] = [
  { id: 'h50yn67b', mode: 'normal', inputs: ['Chamomile', 'ChamomilePowder', 'Lavender'], output: 'BlackPowder', createdAt: 1 },
  { id: '8ab0l46w', mode: 'normal', inputs: ['Flax', 'FlaxFiber', 'ClayPowder'], output: 'Coke', createdAt: 3 },
]
const catalogFor = (plan: Plan, saved: SavedRecipe[], mine: MyDefaults, progress: Progress) =>
  buildCatalog({ saved, machines: plan.machines, mods: modifiers(progress.upgrades), fertilizer: planFertilizer(plan), tier: progress.tier, mine })
const plan: Plan = {
  id: 'p1',
  name: 'Clay works',
  targets: [{ item: 'Clay', rate: 10 }],
  producers: {},
  machines: {},
  built: ['0/Clay'],
  roundUp: ['0/Clay'],
}
const PAGE = 'https://example.com/yaafc/planner'

describe('share links', () => {
  test('rows following my defaults pick the same themselves, and the checklist stays behind', () => {
    const shared = planToShare(plan, [clay], { Clay: { producer: 'cauldron:l5azpc75' } }, { upgrades: {} })
    expect(shared.branches?.['0/Clay']?.producer).toBe('cauldron:l5azpc75')
    expect(shared.built).toBeUndefined()
    expect(shared.roundUp).toEqual(['0/Clay'])
  })

  test('a plan named after its targets stays so', () => {
    expect(planToShare({ ...plan, name: 'New plan' }, [], {}, { upgrades: {} }).name).toBe('')
    expect(planToShare(plan, [], {}, { upgrades: {} }).name).toBe('Clay works')
  })

  test('open a link as the other player: the plan and the recipes it uses', async () => {
    const link = await shareLink(PAGE, plan, [clay], { Clay: { producer: 'cauldron:l5azpc75' } }, { upgrades: {} })
    expect(link.url.startsWith(PAGE + '#plan=')).toBe(true)
    expect(link.recipes).toBe(1)
    const code = sharedCode(new URL(link.url).hash)!
    const backup = await openShared(code)
    const [opened] = backup.plans
    expect(opened.name).toBe('Clay works')
    expect(opened.targets).toEqual([{ item: 'Clay', rate: 10 }])
    expect(backup.savedRecipes).toEqual([expect.objectContaining({ mode: 'normal', inputs: clay.inputs, output: 'Clay' })])
    expect(opened.branches?.['0/Clay']?.producer).toBe(`cauldron:${backup.savedRecipes[0].id}`)
    expect(opened.built).toBeUndefined()
  })

  // What the sender sees is what the receiver gets, whatever the receiver's defaults and tier.
  test.each([
    ['a plan with saved recipes', 'Gold', 3],
    ['a deep plan', 'Sol', undefined],
    ['several targets', 'Crown+Luna+Emerald', 6],
  ])('open %s set up as it was shared', async (_, targets, senderTier) => {
    const sender = { saved: [clay, ...recipes], progress: { upgrades: {}, tier: senderTier } }
    const items = targets === 'Gold' ? ['BlastPotion', 'BlackPowder'] : targets.split('+')
    const base: Plan = { id: 's', name: 'Shared', targets: items.map((item) => ({ item, rate: 12 })), producers: {}, machines: {} }
    // The sender picks a few rows and has defaults of their own.
    const senderView = unfold(base, catalogFor(base, sender.saved, {}, sender.progress)).nodes.filter((n) => n.kind === 'make' && n.process)
    const choosy = (n: PlanNode) => catalogFor(base, sender.saved, {}, sender.progress).byProduct.get(n.item)?.find((p) => p.id !== n.process!.id)
    const defaults: MyDefaults = Object.fromEntries(
      senderView.filter((_, i) => i % 5 === 1).flatMap((n) => (choosy(n) ? [[n.item, { producer: choosy(n)!.id }]] : [])),
    )
    const plan: Plan = {
      ...base,
      producers: targets === 'Gold' ? { Clay: 'cauldron:l5azpc75', BlackPowder: 'cauldron:h50yn67b' } : {},
      branches: Object.fromEntries(senderView.filter((_, i) => i % 7 === 3).flatMap((n) => (choosy(n) ? [[n.id, { producer: choosy(n)!.id }]] : []))),
    }

    const link = await shareLink(PAGE, plan, sender.saved, defaults, sender.progress)
    const backup = await openShared(sharedCode(new URL(link.url).hash)!)
    // The receiver: their own saved recipes, and a different default for everything the sender makes.
    const merged = mergeBackup({ saved: [recipes[1]], plans: [] }, backup, () => 'r' + Math.random())
    const sees = (p: Plan, saved: SavedRecipe[], mine: MyDefaults, progress: Progress) => {
      const signatures = new Map(saved.map((s) => [`cauldron:${s.id}`, recipeSignature(s.mode, s.inputs)]))
      const catalog = catalogFor(p, saved, mine, progress)
      return Object.fromEntries(
        unfold(p, catalog).nodes.map((n) => [n.id, `${n.kind} ${signatures.get(n.process?.id ?? '') ?? n.process?.id} ${n.process?.machine?.key}`]),
      )
    }
    const contrary: MyDefaults = Object.fromEntries(
      senderView.map((n) => [n.item, { producer: catalogFor(base, sender.saved, {}, sender.progress).byProduct.get(n.item)?.at(-1)?.id ?? BUS }]),
    )
    const want = sees(plan, sender.saved, defaults, sender.progress)
    expect(sees(merged.added[0], merged.saved, contrary, sender.progress)).toEqual(want)
    // At an earlier tier, every row picks the same; only recovering by-products it can't run yet is missing.
    const early = sees(merged.added[0], merged.saved, contrary, { upgrades: {}, tier: 2 })
    const recovering = (rows: Record<string, string>) => Object.fromEntries(Object.entries(rows).filter(([id]) => !id.includes('/recover:')))
    expect(recovering(early)).toEqual(recovering(want))
  })

  test('choices are pinned on opening, not carried in the link', async () => {
    const sol: Plan = { id: 's', name: '', targets: [{ item: 'Sol', rate: 12 }], producers: {}, machines: {} }
    const link = await shareLink(PAGE, sol, [], {}, { upgrades: {}, tier: 9 })
    expect(link.url.length - PAGE.length).toBeLessThan(30)
    const [opened] = (await openShared(sharedCode(new URL(link.url).hash)!)).plans
    expect(Object.keys(opened.producers).length).toBeGreaterThan(50)
  })

  describe('a plan added from a link', () => {
    const add = async () => {
      const link = await shareLink(PAGE, plan, [clay], { Clay: { producer: 'cauldron:l5azpc75' } }, { upgrades: {} })
      const code = sharedCode(new URL(link.url).hash)!
      const merged = mergeBackup({ saved: [], plans: [] }, await openShared(code), () => 'id' + Math.random())
      return { code, added: merged.added[0], saved: merged.saved }
    }

    test('keeps the code it came from, and isn’t shared again with it', async () => {
      const { code, added, saved } = await add()
      expect(added.shared).toBe(code)
      expect(sanitizePlans([added], () => 'x')![0].shared).toBe(code)
      expect(planToShare(added, saved, {}, { upgrades: {} }).shared).toBeUndefined()
    })

    test('goes back to as it was shared, keeping its id, checklist and the player’s saved recipes', async () => {
      const { added, saved } = await add()
      const mine: SavedRecipe = { ...recipes[0], id: 'mine1' }
      // Changed every which way, its recipe forgotten, some rows marked built.
      const changed: Plan = {
        ...added,
        name: 'Renamed',
        targets: [{ item: 'Clay', rate: 99 }],
        branches: {},
        altarItems: ['Sand'],
        built: ['0/Clay'],
      }
      expect(sameSetup(changed, added)).toBe(false)
      const { plan: back, saved: recipesBack } = await asShared(changed, [mine], () => 'new1')
      expect(back.id).toBe(added.id)
      expect(back.built).toEqual(['0/Clay'])
      expect(sameSetup(back, added)).toBe(true)
      // Its forgotten recipe is saved again, next to the player's own.
      expect(recipesBack.map((s) => s.inputs)).toEqual([mine.inputs, saved[0].inputs])
      expect(back.name).toBe('Clay works')
      expect(back.targets).toEqual(added.targets)
    })

    test('reads as unchanged whatever order or empty fields it was saved with', async () => {
      const { added } = await add()
      const same: Plan = {
        ...added,
        producers: Object.fromEntries(Object.entries(added.producers).reverse()),
        roundUp: [...(added.roundUp ?? [])].reverse(),
        altarItems: [],
        rowStacks: {},
        built: ['0/Clay'],
      }
      expect(sameSetup(same, added)).toBe(true)
      expect(sameSetup({ ...added, targets: [...added.targets, { item: 'Sand', rate: 1 }] }, added)).toBe(false)
    })
  })

  test('only a hash with a code is a shared plan', async () => {
    expect(sharedCode('#plan=')).toBeNull()
    expect(sharedCode('#other=abc')).toBeNull()
    expect(sharedCode('')).toBeNull()
    await expect(openShared('garbage')).rejects.toThrow()
  })
})
