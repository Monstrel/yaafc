import raw from '../data/game-data.json'

// ---- Raw shapes written by tools/extractor (Export.cs) ----

export interface Stack {
  item: string
  count: number
}

export interface Item {
  key: string
  id: number
  name: string
  icon: string | null
  tags: string[]
  hidden: boolean
  liquid: boolean
  maxStack: number
  baseCost: number
  cauldronCost: number
  cauldronTarget: number
  cauldronMulti: number
  heatValue: number
  nutrientValue: number
  nutrientSpeed: number
  /** Copper per item at a purchasing portal; null if portals don't sell it. */
  buyPrice: number | null
  /** Copper per item the shop pays at base prices; null if the shop won't buy it (raw materials, intermediates, fuels). */
  sellPrice: number | null
}

export interface GameRecipe {
  key: string
  id: number
  craftType: string
  time: number
  batch: number
  inputs: Stack[]
  output: Stack
  side: Stack | null
  fail: { rate: number; product: Stack | null }[]
  catalystCost: number
  productSequence: number[]
  unstableSequence: number[]
  alternate: boolean
  hidden: boolean
}

export interface Building {
  key: string
  id: number
  name: string
  icon: string | null
  hidden: boolean
  heatCost: number
  tags: string[]
  ports: Ports
  craftType: string | null
  components: Record<string, string | number | boolean>[]
}

/** Connection cells on a building: belts carry items, pipes carry liquids. */
export interface Ports {
  beltIn: number
  beltOut: number
  pipeIn: number
  pipeOut: number
}

export interface Seed {
  seed: string
  plant: string | null
  side: string | null
  growthSeconds: number
  nutrientCost: number
  count: number
  sideCount: number
}

export interface UpgradeEffect {
  attribute: string
  op: string
  value: number
}

export interface UpgradeSeries {
  key: string
  name: string
  /** Column in the in-game skill tree (left to right), or null for series not in it. */
  column: number | null
  icon: string | null
  levels: UpgradeEffect[][]
  /** The last level (∞ in game) can be bought again, re-applying its effects each time. */
  unlimited: boolean
  /** Cap on purchases of the last level, the first included; 0 means uncapped. */
  unlimitedMax: number
}

interface GameData {
  gameVersion: { steamBuildId: string | null; pakDate: string | null }
  extractedAt: string
  items: Item[]
  recipes: GameRecipe[]
  buildings: Building[]
  seeds: Seed[]
  upgrades: UpgradeSeries[]
  /** Base values of player attributes (e.g. ConveyerSpeed: 60 items/min). */
  attributes: Record<string, number>
  research: Research
}

/** What each research tier (1–9, shown as I–IX in game) unlocks. */
export interface Research {
  tiers: { tier: number; icon: string | null }[]
  /** Tier unlocking each building. */
  machines: Record<string, number>
  /** Tier unlocking a recipe named by a research node; other recipes come with their machine. */
  recipes: Record<string, number>
  /** Tier from which portals sell an item (raw materials and seeds). */
  items: Record<string, number>
  /** Recipes unlocked by a license instead of research (alternate ingots). */
  licenses: Record<string, { name: string; level: number }>
}

const data = raw as unknown as GameData

export const gameVersion = data.gameVersion
export const items = data.items
export const itemsByKey = new Map(items.map((i) => [i.key, i]))
export const gameRecipes = data.recipes
export const buildings = data.buildings
export const buildingsByKey = new Map(buildings.map((b) => [b.key, b]))
export const seeds = data.seeds
export const upgrades = data.upgrades
export const attributeBase = data.attributes

// ---- Research tiers ----

export const research = data.research
export const MAX_TIER = research.tiers.length
/** Research tier a building needs (1 when the research tree doesn't list it). */
export const machineTier = (key: string) => research.machines[key] ?? 1
/** Research tier a recipe itself needs, beyond its machine's. */
export const recipeTier = (key: string) => research.recipes[key] ?? 1
/** Research tier from which portals sell an item. */
export const buyTier = (item: string) => research.items[item] ?? 1
/** The license a recipe needs, if any. */
export const licenseFor = (recipe: string) => research.licenses[recipe]?.name

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']
/** A tier as the game writes it (IV). */
export const tierName = (tier: number) => ROMAN[tier - 1] ?? String(tier)
export const tierIcon = (tier: number) => research.tiers.find((t) => t.tier === tier)?.icon ?? null

/**
 * Copper per coin (from the portal stock prices: 1 silver = 1,000 copper, 1 gold = 100 silver),
 * largest first. Coins count at face value wherever a plan takes them in or delivers them.
 */
export const COINS = [
  { coin: 'GoldCoin', name: 'gold', copper: 100_000 },
  { coin: 'SilverCoin', name: 'silver', copper: 1_000 },
  { coin: 'CopperCoin', name: 'copper', copper: 1 },
] as const

export const coinValue = (item: string): number | null => COINS.find((c) => c.coin === item)?.copper ?? null

/** Pseudo-items used by the solver for heat (P) and plant nutrients. */
export const HEAT = '@heat'
export const NUTRIENTS = '@nutrients'

/** Fuel/fertilizer bought from outside, kept apart from the same item made in the plan. */
const BASE_PREFIX = '@base:'
export const baseInputKey = (item: string) => BASE_PREFIX + item
/** The real item behind a key (strips the base-input marker). */
export const realItem = (key: string) => (key.startsWith(BASE_PREFIX) ? key.slice(BASE_PREFIX.length) : key)

export function itemName(key: string): string {
  if (key === HEAT) return 'Heat (P)'
  if (key === NUTRIENTS) return 'Nutrients'
  const real = realItem(key)
  return itemsByKey.get(real)?.name ?? real
}

export function iconUrl(file: string | null | undefined): string | null {
  return file ? `${import.meta.env.BASE_URL}icons/${file}` : null
}

/** Brewing barrel products (Whispering Fields etc.): sold straight from the tap, never held as items. */
const barrelProducts = new Set(gameRecipes.filter((r) => r.craftType === 'LiquidTap').map((r) => r.output.item))

/**
 * Items that can be put into a cauldron: they have a cauldron value, are visible in game, and are
 * belt-transportable (liquids travel by pipe and can't be inserted; barrel products never leave the
 * barrel).
 */
export const cauldronIngredients = items.filter(
  (i) => i.cauldronCost > 0 && !i.hidden && !i.liquid && !barrelProducts.has(i.key),
)

/** Items a cauldron can produce. CauldronMulti scales the distance; 0 means "never selected". */
export const cauldronTargets = items.filter((i) => i.cauldronTarget > 0 && i.cauldronMulti > 0)

// ---- Machines ----

export interface Machine {
  key: string
  name: string
  icon: string | null
  heatCost: number // P/s while running at speed 1
  speed: number // blueprint speed multiplier (e.g. GrindingSpeed)
  /** Output grows with the height it's built at (Thermal Extractor): see `heightMultiplier`. */
  heightScaled: boolean
  usesFactorySpeed: boolean
  ports: Ports
}

/** Craft types whose buildings do not declare FactoryCraftType in their blueprint. */
const CRAFT_TYPE_BUILDINGS: Record<string, string[]> = {
  Extract: ['Extractor', 'ThermalExtractor'],
  Paradox: ['ParadoxCrucible'],
  Cauldron: ['Cauldron'],
  TableSaw: ['TableSaw'],
  Plant: ['SeedPlot'],
  // "Compatible with standard Athanor recipes" (building description).
  Athanor: ['AdvancedAthanor'],
}

/**
 * Output multiplier of an extractor built `height` grid spaces up (the inspect panel's "Height"):
 * 1 + height / 128, up to 3×. The panel's "Production Multiplier" shows the bonus, height / 128.
 * From UExtractFacilityComponent (build 25321648): GetProductionMultiplier (0x144A1D3C0) returns
 * bThermal ? clamp(BuiltHeight / 128, 0, 2) : 0, and a finished extraction (0x144A29330) outputs
 * ExtractingLiquidInfo.Count × (1 + that) × the Alchemy Skill multiplier.
 */
export const heightMultiplier = (height: number) => 1 + Math.min(Math.max(height / 128, 0), 2)

/** Machines unaffected by Factory Efficiency. */
const NO_FACTORY_SPEED = new Set(['SeedPlot', 'Portal_Bank'])

function toMachine(b: Building): Machine {
  const speedComponent = b.components.find((c) => typeof c.GrindingSpeed === 'number')
  return {
    key: b.key,
    name: b.name,
    icon: b.icon,
    heatCost: b.heatCost,
    speed: (speedComponent?.GrindingSpeed as number | undefined) ?? 1,
    heightScaled: b.components.some((c) => c.type === 'ExtractFacilityComponent' && c.bThermal === true),
    usesFactorySpeed: !NO_FACTORY_SPEED.has(b.key),
    ports: b.ports,
  }
}

export const machinesByKey = new Map(buildings.map((b) => [b.key, toMachine(b)]))

/** A building belts or pipes can feed or empty: one with none (the Seed Plot) is worked by hand. */
const automated = (m: Machine) => m.ports.beltIn + m.ports.beltOut + m.ports.pipeIn + m.ports.pipeOut > 0

/** Craft types only buildings worked by hand can run: their recipes aren't offered. */
export const manualCraftTypes = new Set<string>()

/** Buildings able to run a craft type, mirrored "_Sym" variants and hand-worked ones removed. */
export const machinesForCraftType: Map<string, Machine[]> = (() => {
  const map = new Map<string, Machine[]>()
  const add = (type: string, key: string) => {
    const m = machinesByKey.get(key)
    if (!m || key.endsWith('_Sym')) return
    const list = map.get(type) ?? []
    if (!list.some((x) => x.key === key)) list.push(m)
    map.set(type, list)
  }
  for (const b of buildings) if (b.craftType) add(b.craftType, b.key)
  for (const [type, keys] of Object.entries(CRAFT_TYPE_BUILDINGS)) for (const k of keys) add(type, k)
  for (const [type, list] of map) {
    const usable = list.filter(automated)
    if (usable.length) map.set(type, usable)
    else {
      map.delete(type)
      manualCraftTypes.add(type)
    }
  }
  return map
})()

export const NURSERY = 'AutoNursery'
export const WORLD_TREE_NURSERY = 'WorldTreeNursery'
export const MINI_WORLD_TREE = 'MiniWorldTree'
export const ADVANCED_CAULDRON = 'AdvancedCauldron'
export const ATHANOR = 'Athanor'
export const ADVANCED_ATHANOR = 'AdvancedAthanor'

// ---- Advanced Athanor catalysts ----

export type CatalystEffect = 'unstable' | 'fertile' | 'resonant' | 'eternal'

export interface Catalyst {
  key: string
  effect: CatalystEffect
  /** Charges one catalyst item provides; a recipe uses CatalystCost charges per craft. */
  charges: number
  /** In-game effect text. */
  description: string
}

/**
 * Charges come from an int32 table [180, 240, 1500, 99999] in the game executable (not in any
 * data asset); effects are the in-game catalyst descriptions.
 */
export const CATALYSTS: Catalyst[] = [
  { key: 'Catalyst1', effect: 'unstable', charges: 180, description: 'Alters product generation probabilities.' },
  { key: 'Catalyst2', effect: 'fertile', charges: 240, description: 'Doubles product output.' },
  { key: 'Catalyst3', effect: 'resonant', charges: 1500, description: 'Generates all products simultaneously.' },
  { key: 'Catalyst4', effect: 'eternal', charges: 99999, description: 'Recipe consumes no materials.' },
]
