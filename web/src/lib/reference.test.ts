import { describe, expect, it } from 'vitest'
import { cauldronIngredients, items, itemsByKey } from './gameData'
import { ITEM_GROUPS } from './referenceGroups'
import { evaluateNormal } from './cauldron'
import { OBLIVION } from './processes'
import {
  BASE_MODS,
  entryReach,
  groupRelations,
  catalogSections,
  craftSeconds,
  heatPerSecond,
  itemShown,
  machineShown,
  processShown,
  isListedItem,
  itemSections,
  referenceItems,
  itemRelations,
  machineGroup,
  machineRelations,
  newReferenceView,
  referenceCatalog,
  referenceMachines,
  referenceSearch,
  sanitizeReferenceView,
} from './reference'
import type { SavedRecipe } from './types'
import { modifiers } from './upgrades'

const catalog = referenceCatalog([])

describe('what the Reference lists', () => {
  it('lists hidden items only when a recipe still uses them', () => {
    // The Refined Sand tiers are hidden in the data but made and used by visible recipes.
    expect(isListedItem('Sand3')).toBe(true)
    for (const i of items.filter((i) => i.hidden && !isListedItem(i.key)))
      expect(itemRelations(catalog, i.key).makers.length + itemRelations(catalog, i.key).uses.length).toBe(0)
  })

  it('folds mirrored machines into their originals', () => {
    expect(referenceMachines.some((b) => b.key.endsWith('_Sym'))).toBe(false)
    expect(machineRelations(catalog, 'Athanor_Sym').runs.map((p) => p.id)).toEqual(machineRelations(catalog, 'Athanor').runs.map((p) => p.id))
    expect(machineRelations(catalog, 'Athanor').mirrors.map((b) => b.key)).toEqual(['Athanor_Sym'])
  })
})

describe('the Item Catalog’s sections', () => {
  it('follows the game’s tabs and order', () => {
    const names = (tab: string) => catalogSections.filter((s) => s.tab === tab).map((s) => s.name)
    expect(names('materials')).toEqual([
      'Raw Materials',
      'Seeds',
      'Herbs',
      'Fuel',
      'Fertilizer',
      'Solid',
      'Mash',
      'Components',
      'Liquid',
      'Gas',
      'Catalyst',
      'Magic',
      'Currency',
    ])
    expect(names('goods')).toEqual(['Sundries', 'Potions', 'Beverage', 'Jewelry', 'Relic'])
  })

  it('files an item in every section it belongs to', () => {
    // Glass is a solid, and sold as sundries.
    expect(itemSections('Glass').map((s) => s.id)).toEqual(['materials:Solid', 'goods:Groceries'])
  })

  it('files every listed item somewhere, the Catalog’s leftovers on their own', () => {
    for (const i of referenceItems) expect(itemSections(i.key).length, i.key).toBeGreaterThan(0)
    expect(itemSections('PortalSigil').map((s) => s.id)).toEqual(['other'])
    // Hidden in game, but used by recipes: with the rest of its tag.
    expect(itemSections('Sand3').map((s) => s.id)).toEqual(['materials:Mash'])
  })
})

describe('item relationships', () => {
  it('links an item to what makes it, what uses it and what it builds', () => {
    const iron = itemRelations(catalog, 'IronIngot')
    expect(iron.makers[0].role).toBe('product')
    expect(iron.uses.some((p) => p.product === 'SteelIngot')).toBe(true)
    expect(iron.builds.some((b) => b.key === 'Athanor')).toBe(true)
  })

  it('tells products from by-products and failed crafts', () => {
    const roles = new Set(items.flatMap((i) => itemRelations(catalog, i.key).makers.map((m) => m.role)))
    expect([...roles].sort()).toEqual(['by-product', 'failed', 'product'])
    // Steel Ingots give back some of their Iron Ingot when a craft fails.
    const fromSteel = itemRelations(catalog, 'IronIngot').makers.find((m) => m.process.product === 'SteelIngot')
    expect(fromSteel?.role).toBe('failed')
  })

  it('lists a seed as used by the Nursery planting it', () => {
    expect(itemRelations(catalog, 'FlaxSeed').uses.some((p) => p.kind === 'nursery' && p.seed === 'FlaxSeed')).toBe(true)
  })

  it('leaves the Paradox Crucible’s inputs to its machine page', () => {
    const oblivion = itemRelations(catalog, OBLIVION)
    expect(oblivion.paradoxMade).toBe(true)
    expect(oblivion.makers.some((m) => m.process.kind === 'paradox')).toBe(false)
    expect(itemRelations(catalog, 'SageSeed').uses.some((p) => p.kind === 'paradox')).toBe(false)
    expect(machineRelations(catalog, 'ParadoxCrucible').runs.length).toBeGreaterThan(100)
  })

  it('offers the player’s saved cauldron recipes, and only theirs', () => {
    const inputs = cauldronIngredients.slice(0, 3).map((i) => i.key)
    const output = evaluateNormal(inputs as [string, string, string])!.output.key
    const saved: SavedRecipe = { id: 's1', mode: 'normal', inputs, output, createdAt: 0 }
    const before = machineRelations(catalog, 'Cauldron').runs.filter((p) => p.kind === 'cauldron')
    expect(before).toEqual([])
    const withSaved = referenceCatalog([saved])
    expect(itemRelations(withSaved, output).makers.some((m) => m.process.id === 'cauldron:s1')).toBe(true)
    expect(machineRelations(withSaved, 'Cauldron').runs.some((p) => p.id === 'cauldron:s1')).toBe(true)
  })
})

describe('machine relationships', () => {
  it('finds machines running the same recipes', () => {
    expect(machineRelations(catalog, 'Grinder').alike.map((b) => b.key)).toEqual(['EnhancedGrinder'])
    expect(machineRelations(catalog, 'EnhancedGrinder').alike.map((b) => b.key)).toEqual(['Grinder'])
  })
})

describe('the index view', () => {
  it('keeps what it can read of a stored view', () => {
    expect(sanitizeReferenceView(null)).toBeUndefined()
    expect(sanitizeReferenceView({ query: 'iron', show: 'goods', section: 'goods:Jewelry' })).toEqual({
      query: 'iron',
      show: 'goods',
      section: 'goods:Jewelry',
    })
    // Views saved before items were filed by Catalog section show everything.
    expect(sanitizeReferenceView({ query: 3, show: 'items', category: 'Solid' })).toEqual(newReferenceView())
  })

  it('addresses entries by key', () => {
    expect(referenceSearch({ item: 'IronIngot' })).toBe('?item=IronIngot')
    expect(referenceSearch({ machine: 'Omni-Machine' })).toBe('?machine=Omni-Machine')
    expect(referenceSearch({})).toBe('')
  })
})

describe('the player’s game', () => {
  it('times recipes and their heat at the player’s Factory Efficiency', () => {
    const mods = modifiers({ FactorySpeed: 2 })
    const fast = referenceCatalog([], mods)
    const base = itemRelations(catalog, 'IronSand').makers[0].process
    const upgraded = itemRelations(fast, 'IronSand').makers[0].process
    expect(craftSeconds(upgraded, mods)).toBeCloseTo(craftSeconds(base, BASE_MODS) / mods.factorySpeed)
    const smelt = itemRelations(catalog, 'IronIngot').makers[0].process
    expect(heatPerSecond(smelt, mods)).toBeCloseTo(heatPerSecond(smelt, BASE_MODS) * mods.factorySpeed)
  })

  it('hides what’s past the research tier only when asked', () => {
    const early = referenceCatalog([], BASE_MODS, 1)
    const steel = itemRelations(early, 'IronIngot').uses.find((p) => p.product === 'SteelIngot')!
    const hidden = { catalog: early, mods: BASE_MODS, tier: 1, hideLocked: true }
    expect(itemShown(hidden, 'SteelIngot')).toBe(false)
    expect(itemShown(hidden, 'Logs')).toBe(true)
    expect(machineShown(hidden, 'Athanor')).toBe(false)
    expect(machineShown(hidden, 'Grinder')).toBe(true)
    expect(processShown(hidden, steel)).toBe(false)
    const shown = { ...hidden, hideLocked: false }
    expect(itemShown(shown, 'SteelIngot') && machineShown(shown, 'Athanor') && processShown(shown, steel)).toBe(true)
  })
})

describe('grouped items', () => {
  const sand = ITEM_GROUPS.find((g) => g.key === 'RefinedSand')!

  it('groups only real, listed items, each in one group, under a key no item has', () => {
    const seen = new Set<string>()
    for (const g of ITEM_GROUPS) {
      expect(itemsByKey.has(g.key), g.key).toBe(false)
      for (const m of g.members) {
        expect(isListedItem(m), m).toBe(true)
        expect(seen.has(m), m).toBe(false)
        seen.add(m)
      }
    }
  })

  it('shows a group once in the index, where its first item would be', () => {
    const mash = catalogSections.find((s) => s.id === 'materials:Mash')!.items.map((i) => i.key)
    expect(mash.filter((k) => k === 'RefinedSand')).toHaveLength(1)
    expect(mash.some((k) => sand.members.includes(k))).toBe(false)
    expect(itemSections('Sand5').map((s) => s.id)).toEqual(['materials:Mash'])
  })

  it('sends every link to a grouped item to its group', () => {
    for (const m of sand.members) expect(referenceSearch({ item: m })).toBe('?item=RefinedSand')
    expect(referenceSearch({ item: 'Sand' })).toBe('?item=Sand')
  })

  it('splits its recipes into what makes it, its own steps, and what it makes', () => {
    const rel = groupRelations(catalog, sand)
    expect(rel.makers.map((m) => m.process.id)).toEqual(['recipe:Sand2'])
    expect(rel.steps.map((p) => p.id)).toEqual(['recipe:Sand3', 'recipe:Sand4', 'recipe:Sand5', 'recipe:Sand6', 'recipe:Sand8'])
    expect(rel.uses.map((p) => p.id)).toEqual(['recipe:Shard1'])
  })

  it('shows a group as soon as any of its items is reached', () => {
    const scope = { catalog, mods: BASE_MODS, tier: entryReach(catalog, 'Sand2'), hideLocked: true }
    expect(itemShown(scope, 'RefinedSand')).toBe(true)
    expect(itemShown({ ...scope, tier: scope.tier - 1 }, 'RefinedSand')).toBe(false)
  })
})

describe('machines players can build', () => {
  it('lists only the portals the game lets players build, and no flasks', () => {
    const portals = referenceMachines.filter((b) => machineGroup(b) === 'Portals').map((b) => b.key)
    expect(portals.sort()).toEqual(['Portal_AlchGuild', 'Portal_Bank', 'Portal_Wholesaling'])
    expect(referenceMachines.some((b) => b.key.startsWith('Flask'))).toBe(false)
  })

  it('leaves unbuildable machines out of what an item builds', () => {
    expect(itemRelations(catalog, 'PortalSigil').builds.map((b) => b.key).sort()).toEqual([
      'Portal_AlchGuild',
      'Portal_Bank',
      'Portal_Wholesaling',
    ])
  })
})
