import { altarYield } from './altar'
import {
  buildings,
  buildingsByKey,
  CATALYSTS,
  HEAT,
  items,
  MAX_TIER,
  machineTier,
  STEAM,
  type Building,
  type Item,
} from './gameData'
import { buildCatalog, OBLIVION, type Process, type ProcessCatalog, type ProcessKind } from './processes'
import type { SavedRecipe } from './types'
import { speedFactor } from './machineRate'
import { entryOf, groupByKey, groupItem, type ItemGroup } from './referenceGroups'
import { modifiers, type Modifiers } from './upgrades'

// The Reference: every item and machine, and the recipes between them, at the player's upgrades,
// with their saved cauldron recipes among the ways to make things.

/** No upgrades: the numbers the game's own panels start from. */
export const BASE_MODS = modifiers({})

/**
 * Every process at the player's upgrades, their saved cauldron recipes included. Recipes run on the
 * first of their machines the research tier unlocks.
 */
export const referenceCatalog = (saved: SavedRecipe[], mods: Modifiers = BASE_MODS, tier = MAX_TIER): ProcessCatalog =>
  buildCatalog({ saved, machines: {}, mods, fertilizer: null, tier })

/** What the Reference shows for the player's game. */
export interface ReferenceScope {
  catalog: ProcessCatalog
  /** The player's upgrades. */
  mods: Modifiers
  /** Research tier reached. */
  tier: number
  /** Whether what's past the research tier stays hidden, so it isn't spoiled. */
  hideLocked: boolean
}

/** Whether an item shows: it can be had by the research tier, unless the player wants to see it all. */
export const itemShown = (s: ReferenceScope, item: string) => !s.hideLocked || entryReach(s.catalog, item) <= s.tier

/** The earliest research tier an item can be had at; for a group, its earliest item's. */
export const entryReach = (catalog: ProcessCatalog, key: string) => {
  const g = groupByKey(key)
  return g ? Math.min(...g.members.map(catalog.itemReach)) : catalog.itemReach(key)
}
/** Whether a machine shows: the research tier lets the player build it. */
export const machineShown = (s: ReferenceScope, key: string) => !s.hideLocked || buildingTier(key) <= s.tier
/** Whether a recipe shows: the research tier runs it, with ingredients it can have. */
export const processShown = (s: ReferenceScope, p: Process) => !s.hideLocked || s.catalog.reach(p) <= s.tier

/**
 * Processes shown as recipes. Burning fuel, spreading fertilizer and paying with coins aren't made
 * on a machine of their own: an item's facts say what it's worth as fuel, fertilizer or money.
 */
const RECIPE_KINDS = new Set<ProcessKind>(['recipe', 'cauldron', 'nursery', 'paradox', 'bank', 'boiler', 'buy'])
const KIND_ORDER: ProcessKind[] = ['recipe', 'nursery', 'cauldron', 'boiler', 'paradox', 'bank', 'buy']

const recipes = (catalog: ProcessCatalog) => [...catalog.byId.values()].filter((p) => RECIPE_KINDS.has(p.kind))

// ---- What the Reference lists ----

/** The building a mirrored copy ("_Sym") is of: it runs the same recipes, its ports flipped. */
export const mirrorOf = (key: string) => (key.endsWith('_Sym') ? key.slice(0, -'_Sym'.length) : null)

const baseCatalog = referenceCatalog([])
const usedItems = new Set<string>()
for (const p of recipes(baseCatalog)) for (const s of [...p.inputs, ...p.outputs]) usedItems.add(s.item)
for (const b of buildings) for (const s of b.cost) usedItems.add(s.item)

/**
 * Items the Reference lists: those the game shows, and hidden ones its recipes still use (the
 * Refined Sand tiers). Hidden items nothing uses are left out, like the game does.
 */
export const referenceItems: Item[] = items.filter((i) => !i.hidden || usedItems.has(i.key))
const listedItems = new Set(referenceItems.map((i) => i.key))
export const isListedItem = (key: string) => listedItems.has(key)

/** Machines the Reference lists: every building, its mirrored copies folded into the original. */
/**
 * Buildings in the data that players can't build: nothing in it sets them apart (like the Dispatch
 * Portal, they have no research tier), but a game at research tier IX offers only the Bank,
 * Purchasing and Dispatch Portals (Nik, 2026-10-14). LiquidSupplier is a second "Purchasing
 * Portal", for liquids, that never shipped. The flasks here aren't the ones players build, which
 * are logistics, like pipes and belts, and so not listed either: the Reference lists machines that
 * take part in recipes.
 */
const NOT_BUILDABLE = new Set(['Portal_Input', 'Portal_Output', 'LiquidSupplier', 'Flask_Input', 'Flask_Output'])

export const referenceMachines: Building[] = buildings
  .filter((b) => !mirrorOf(b.key) && !NOT_BUILDABLE.has(b.key) && !(b.hidden && !b.description))
  .sort((a, b) => a.name.localeCompare(b.name))
const listedMachines = new Set(referenceMachines.map((b) => b.key))
export const isListedMachine = (key: string) => listedMachines.has(key)

// ---- The in-game Item Catalog's sections ----
// WBP_CatalogPanel.UpdateEntryList (build 25321648): the Materials tab has a section per ingredient
// tag below, in this order, listing every item with that exact tag (so an item can be in several);
// the Goods tab has one per kind of goods the shop sells (SellType), named by GetSellTypeText in
// BP_BeltTDFunctionLib. Both list items in the data table's order and skip hidden ones. Items with
// neither (the Misc. items: Portal Sigils and the like) aren't in the Catalog.

export type CatalogTab = 'materials' | 'goods' | 'other'

export interface CatalogSection {
  id: string
  tab: CatalogTab
  /** As the game names it (ST_Localization Ingredient_Tag_*). */
  name: string
  items: Item[]
}

const MATERIALS: [tag: string, name: string][] = [
  ['RawMaterial', 'Raw Materials'],
  ['PlantSeed', 'Seeds'],
  ['Herb', 'Herbs'],
  ['Fuel', 'Fuel'],
  ['Fertilizer', 'Fertilizer'],
  ['Solid', 'Solid'],
  ['Mash', 'Mash'],
  ['Component', 'Components'],
  ['Liquid', 'Liquid'],
  ['Gas', 'Gas'],
  ['Catalyst', 'Catalyst'],
  ['Magic', 'Magic'],
  ['Currency', 'Currency'],
]

const GOODS: [sellType: string, name: string][] = [
  ['Groceries', 'Sundries'],
  ['Remedies', 'Potions'],
  ['Liquid', 'Beverage'],
  ['Jewelry', 'Jewelry'],
  ['Artcrafts', 'Relic'],
]

export const TAB_NAMES: Record<CatalogTab, string> = { materials: 'Materials', goods: 'Goods', other: 'Not in the Catalog' }

/**
 * The Catalog's sections, with the Reference's extra items in them: the hidden Refined Sand tiers
 * recipes use go with the rest of their tag; Misc. items, which the Catalog leaves out, get a
 * section of their own.
 */
export const catalogSections: CatalogSection[] = (() => {
  const sections: CatalogSection[] = [
    ...MATERIALS.map(([tag, name]) => ({
      id: `materials:${tag}`,
      tab: 'materials' as const,
      name,
      items: referenceItems.filter((i) => i.tags.includes(tag)),
    })),
    ...GOODS.map(([type, name]) => ({
      id: `goods:${type}`,
      tab: 'goods' as const,
      name,
      items: referenceItems.filter((i) => i.sellType === type),
    })),
  ]
  const filed = new Set(sections.flatMap((s) => s.items.map((i) => i.key)))
  sections.push({ id: 'other', tab: 'other', name: 'Misc.', items: referenceItems.filter((i) => !filed.has(i.key)) })
  for (const s of sections) s.items = grouped(s.items)
  return sections.filter((s) => s.items.length)
})()

/** Items with each group's members folded into one item standing for the group. */
function grouped(list: Item[]): Item[] {
  const out: Item[] = []
  for (const i of list) {
    const key = entryOf(i.key)
    if (key === i.key) out.push(i)
    else if (!out.some((o) => o.key === key)) out.push(groupItem(groupByKey(key)!))
  }
  return out
}

/** The sections an item (or the group it's in) is in. */
export const itemSections = (item: string) => {
  const key = entryOf(item)
  return catalogSections.filter((s) => s.items.some((i) => i.key === key))
}

/** How the index groups machines, by what the game tags them for. */
export const MACHINE_GROUPS = ['Production', 'Crafting', 'Heating', 'Portals'] as const
export type MachineGroup = (typeof MACHINE_GROUPS)[number]
export function machineGroup(b: Building): MachineGroup {
  if (b.tags.includes('Building.Crafting.Portal')) return 'Portals'
  if (b.tags.includes('Building.Crafting.Heating')) return 'Heating'
  if (b.tags.includes('Building.Crafting.RawProduction') || b.key === 'MiniWorldTree') return 'Production'
  return 'Crafting'
}

// ---- Relationships ----

/** How a recipe gives an item: its product, a by-product every craft, or from its failed crafts. */
export type Role = 'product' | 'by-product' | 'failed'

export interface Making {
  process: Process
  role: Role
}

const roleOf = (p: Process, item: string): Role =>
  p.product === item ? 'product' : p.secondary.includes(item) ? 'by-product' : 'failed'

const ROLE_ORDER: Role[] = ['product', 'by-product', 'failed']

/** Products first, then plain recipes before alternates, the earliest tier first. */
const byKindAndTier = (a: Process, b: Process) =>
  KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || Number(a.alternate) - Number(b.alternate) || a.tier - b.tier

export interface ItemRelations {
  /** Recipes giving the item (Paradox Crucible inputs left to its machine page). */
  makers: Making[]
  /** The Paradox Crucible makes this (Oblivion Essence), from any item: listed on its page instead. */
  paradoxMade: boolean
  /** Recipes taking the item in (or Nurseries planting it). */
  uses: Process[]
  /** Buildings placing one takes the item. */
  builds: Building[]
}

export function itemRelations(catalog: ProcessCatalog, item: string): ItemRelations {
  const all = recipes(catalog)
  const makers = all
    .filter((p) => p.kind !== 'paradox' && p.outputs.some((s) => s.item === item && s.count > 0))
    .map((process) => ({ process, role: roleOf(process, item) }))
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || byKindAndTier(a.process, b.process))
  const uses = all
    .filter((p) => p.kind !== 'paradox' && (p.seed === item || p.inputs.some((s) => s.item === item)))
    // A recipe giving some of its input back (Steel Ingots and their Iron Ingot) uses it.
    .sort((a, b) => byKindAndTier(a, b) || a.label.localeCompare(b.label))
  return {
    makers,
    paradoxMade: item === OBLIVION,
    uses,
    builds: referenceMachines.filter((b) => b.cost.some((s) => s.item === item)),
  }
}

export interface GroupRelations {
  /** Recipes making its items from something else. */
  makers: Making[]
  /** Recipes turning one of its items into another. */
  steps: Process[]
  /** Recipes taking its items in to make something else. */
  uses: Process[]
}

export function groupRelations(catalog: ProcessCatalog, g: ItemGroup): GroupRelations {
  const inGroup = (item: string) => g.members.includes(item)
  const order = (p: Process) => Math.min(...p.outputs.map((o) => g.members.indexOf(o.item)).filter((k) => k >= 0))
  const all = recipes(catalog).filter((p) => p.kind !== 'paradox')
  const takes = (p: Process) => p.inputs.some((s) => inGroup(s.item))
  const makes = (p: Process) => p.outputs.some((s) => inGroup(s.item) && s.count > 0)
  return {
    makers: all
      .filter((p) => makes(p) && !takes(p))
      .map((process) => ({ process, role: roleOf(process, process.outputs.find((o) => inGroup(o.item))!.item) })),
    steps: all.filter((p) => makes(p) && takes(p)).sort((a, b) => order(a) - order(b)),
    uses: all.filter((p) => takes(p) && !makes(p)).sort((a, b) => byKindAndTier(a, b) || a.label.localeCompare(b.label)),
  }
}

export interface MachineRelations {
  /** Recipes it runs. */
  runs: Process[]
  /** Other machines able to run some of the same recipes (a Grinder and an Enhanced Grinder). */
  alike: Building[]
  /** Its mirrored copies. */
  mirrors: Building[]
}

export function machineRelations(catalog: ProcessCatalog, key: string): MachineRelations {
  const own = mirrorOf(key) ?? key
  const runs = recipes(catalog)
    .filter((p) => p.machineOptions.some((m) => m.key === own))
    .sort((a, b) => byKindAndTier(a, b) || a.label.localeCompare(b.label))
  const alike = new Set<string>()
  for (const p of runs) for (const m of p.machineOptions) if (m.key !== own) alike.add(m.key)
  return {
    runs,
    alike: [...alike].map((k) => buildingsByKey.get(k)).filter((b): b is Building => !!b),
    mirrors: buildings.filter((b) => mirrorOf(b.key) === own),
  }
}

/** The process a recipe runs as on one machine (a Grinder recipe on an Enhanced Grinder). */
export const onMachine = (catalog: ProcessCatalog, p: Process, machine: string) =>
  p.machine?.key === machine || !p.machineOptions.some((m) => m.key === machine) ? p : catalog.variant(p, { machine })

// ---- Facts ----

/** Seconds a craft takes at the player's upgrades. */
export const craftSeconds = (p: Process, mods: Modifiers) => p.seconds / speedFactor(p, mods)

/** Heat a recipe's machine burns while it works, in P/s (0 for none): faster crafting burns it faster. */
export const heatPerSecond = (p: Process, mods: Modifiers) => {
  const heat = p.inputs.find((s) => s.item === HEAT)?.count ?? 0
  return heat > 0 && p.seconds > 0 ? heat / craftSeconds(p, mods) : 0
}

/**
 * Whether a recipe's time is the item's own: a Nursery's depends on the fertilizer it grows on, and a
 * Purchasing Portal's on the coins it's paid in.
 */
export const hasOwnTime = (p: Process) => p.seconds > 0 && !(p.kind === 'nursery' && p.seed) && p.kind !== 'buy'

/** Fuels, the most heat per item first: what a furnace under a machine can burn. */
export const fuels = items
  .filter((i) => i.heatValue > 0 && i.key !== STEAM && isListedItem(i.key))
  .sort((a, b) => b.heatValue - a.heatValue)

/** Fertilizers, the fastest first: what a Nursery grows its plants on. */
export const fertilizers = items
  .filter((i) => i.nutrientValue > 0 && isListedItem(i.key))
  .sort((a, b) => b.nutrientSpeed - a.nutrientSpeed)

/** Items worth more at a Knowledge Altar than their value says: the planets. */
export const relics = items.filter((i) => altarYield(i.key, BASE_MODS)?.relic)

export const catalystFor = (item: string) => CATALYSTS.find((c) => c.key === item) ?? null

/** Research tier a building needs. */
export const buildingTier = (key: string) => machineTier(mirrorOf(key) ?? key)

// ---- The index's view ----

/** What the Reference's index shows, kept while the player looks at entries. */
export interface ReferenceView {
  query: string
  show: 'all' | 'materials' | 'goods' | 'machines'
  /** The Catalog section the index is narrowed to (its id). */
  section: string | null
}

export const newReferenceView = (): ReferenceView => ({ query: '', show: 'all', section: null })

export function sanitizeReferenceView(v: unknown): ReferenceView | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  return {
    query: typeof r.query === 'string' ? r.query : '',
    show: r.show === 'materials' || r.show === 'goods' || r.show === 'machines' ? r.show : 'all',
    section: typeof r.section === 'string' && catalogSections.some((s) => s.id === r.section) ? r.section : null,
  }
}

/** The Reference page's address for an item or a machine (or the index, for neither). */
export const referenceSearch = (entry: { item?: string; machine?: string }) =>
  entry.item ? `?item=${encodeURIComponent(entryOf(entry.item))}` : entry.machine ? `?machine=${encodeURIComponent(entry.machine)}` : ''
