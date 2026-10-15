import { describe, expect, it } from 'vitest'
import { cauldronStats, evaluateAdvanced, evaluateNormal, findRecipes } from './cauldron'
import { cauldronIngredients, gameRecipes, itemsByKey } from './gameData'
import { allowedIngredients, builtinGroups, emptyPrefs, onlyGroup, preferredCount, setPrefs } from './itemGroups'
import { countRecipes, diagnoseNoResults, type FinderQuery } from './diagnose'
import { round1 } from './engineTestUtils'
import { fmt, fmtTenth } from './format'

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

  it('stores the rounded values, as the game does', () => {
    // Charcoal: the curve gives 3.0303… s and 1.1919… P/s; the game keeps 3.0 and 1.2.
    expect(cauldronStats(2).seconds).toBeCloseTo(3, 12)
    expect(cauldronStats(2).heatPerSecond).toBeCloseTo(1.2, 12)
    // Quicklime (6): 3.1515… → 3.2 and 1.9596… → 2.0.
    expect(cauldronStats(6).seconds).toBeCloseTo(3.2, 12)
    expect(cauldronStats(6).heatPerSecond).toBeCloseTo(2, 12)
    // Clamped at both ends.
    expect(cauldronStats(0.1)).toEqual(cauldronStats(1))
    expect(cauldronStats(5e6).seconds).toBeCloseTo(60, 12)
    expect(cauldronStats(5e6).heatPerSecond).toBeCloseTo(1e4, 9)
  })

  it('shows heat to the tenth, as the game panel does', () => {
    // Fairy Dust (3760): 200 + 2760 × 1300/9000 = 598.67 → the game shows 598.7 P/s.
    expect(fmtTenth(cauldronStats(itemsByKey.get('FairyDust')!.cauldronTarget).heatPerSecond)).toBe('598.7')
    expect(fmtTenth(cauldronStats(2).heatPerSecond)).toBe('1.2')
    expect(fmtTenth(cauldronStats(1e4).heatPerSecond)).toBe(fmt(1500))
    expect(fmtTenth(cauldronStats(5e6).heatPerSecond)).toBe(fmt(10000))
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
