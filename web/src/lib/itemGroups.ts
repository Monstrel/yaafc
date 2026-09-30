import { buildingsByKey, cauldronIngredients, cauldronTargets, gameRecipes, items, itemsByKey, seeds } from './gameData'

/** A named set of cauldron ingredients for bulk prefer/avoid in the recipe finder. */
export interface ItemGroup {
  id: string
  name: string
  description: string
  items: Set<string>
  /** Icon file standing in for the group (the game has no category icons). */
  icon?: string
  /** Short mark drawn over the icon, e.g. "+1" for the one-step variants. */
  badge?: string
}

const usable = new Set(cauldronIngredients.map((i) => i.key))
const onlyUsable = (keys: Iterable<string>) => new Set([...keys].filter((k) => usable.has(k)))

/**
 * Items made by one processing step from `base` alone: single-product game recipes (not cauldron
 * or seed-plot recipes) whose every ingredient is in `base`. E.g. Flax → Flax Fiber.
 */
function oneStepFrom(base: Set<string>): Set<string> {
  const result = new Set(base)
  for (const r of gameRecipes) {
    if (r.hidden || r.craftType === 'Cauldron' || r.craftType === 'Plant') continue
    if (r.inputs.length > 0 && r.inputs.every((s) => base.has(s.item))) result.add(r.output.item)
  }
  return result
}

const TAG_DESCRIPTIONS: Record<string, string> = {
  RawMaterial: 'Ores, logs and other raw materials',
  PlantSeed: 'Seeds',
  Herb: 'Harvested herbs',
  Mash: 'Powders and ground materials',
  Solid: 'Ingots, bricks, glass and other solids',
  Component: 'Gears, rivets and other parts',
  Fuel: 'Items that burn for heat',
  Fertilizer: 'Items that feed nurseries',
  Catalyst: 'Catalysts',
  Magic: 'Magical materials',
  Currency: 'Coins',
  Misc: 'Everything else',
}

/** A representative item for each in-game tag. */
const TAG_ICONS: Record<string, string> = {
  RawMaterial: 'IronOre',
  PlantSeed: 'SageSeed',
  Herb: 'Lavender',
  Mash: 'Sand',
  Solid: 'IronIngot',
  Liquid: 'LinseedOil',
  Gas: 'Steam',
  Component: 'WoodGear',
  Fuel: 'WoodBoard',
  Fertilizer: 'BasicFertilizer',
  Catalyst: 'Catalyst3',
  Magic: 'PhilosopherStone',
  Currency: 'GoldCoin',
  Misc: 'PortalSigil',
}

const itemIcon = (key: string) => itemsByKey.get(key)?.icon ?? undefined
const buildingIcon = (key: string) => buildingsByKey.get(key)?.icon ?? undefined

/** Presets derived from the game data. */
export const builtinGroups: ItemGroup[] = (() => {
  const grown = new Set<string>()
  for (const s of seeds) {
    if (s.plant) grown.add(s.plant)
    if (s.side) grown.add(s.side)
  }
  const bought = new Set(items.filter((i) => i.buyPrice != null || i.tags.includes('Currency')).map((i) => i.key))

  const groups: ItemGroup[] = [
    {
      id: 'grown',
      name: 'Nursery-grown',
      description: 'Plants from nurseries (herbs, nectar, World Tree leaf and core)',
      items: onlyUsable(grown),
      icon: itemIcon('Chamomile'),
    },
    {
      id: 'grown+1',
      name: 'Nursery-grown + 1 step',
      description: 'Nursery plants and anything one processing step from only them (powders, fibers…)',
      items: onlyUsable(oneStepFrom(grown)),
      icon: itemIcon('Chamomile'),
      badge: '+1',
    },
    {
      id: 'bought',
      name: 'Portal goods',
      description: 'Bought at purchasing portals, plus coins',
      items: onlyUsable(bought),
      icon: buildingIcon('Portal_Input'),
    },
    {
      id: 'bought+1',
      name: 'Portal goods + 1 step',
      description: 'Portal goods and anything one processing step from only them (planks, stone, ingots…)',
      items: onlyUsable(oneStepFrom(bought)),
      icon: buildingIcon('Portal_Input'),
      badge: '+1',
    },
    {
      id: 'cauldron',
      name: 'Cauldron products',
      description: 'Items a cauldron can make',
      items: onlyUsable(cauldronTargets.map((i) => i.key)),
      icon: buildingIcon('Cauldron'),
    },
  ]

  const tags = [...new Set(cauldronIngredients.flatMap((i) => i.tags))].sort()
  for (const tag of tags)
    groups.push({
      id: `tag:${tag}`,
      name: tag.replace(/([a-z])([A-Z])/g, '$1 $2'),
      description: TAG_DESCRIPTIONS[tag] ?? `In-game category: ${tag}`,
      items: onlyUsable(cauldronIngredients.filter((i) => i.tags.includes(tag)).map((i) => i.key)),
      icon: TAG_ICONS[tag] ? itemIcon(TAG_ICONS[tag]) : undefined,
    })
  // The game leaves its sellable products untagged; group them so every ingredient has a home.
  groups.push({
    id: 'untagged',
    name: 'Finished goods',
    description: 'Potions, gems, relics and other products the game gives no category',
    items: onlyUsable(cauldronIngredients.filter((i) => i.tags.length === 0).map((i) => i.key)),
    icon: itemIcon('HealingPotion'),
  })
  return groups.filter((g) => g.items.size > 0)
})()

/** Groups from the active plan: what it makes, and what it makes but doesn't use. */
export function planGroups(planName: string, made: Iterable<string>, overflow: Iterable<string>): ItemGroup[] {
  return [
    {
      id: 'plan:made',
      name: `Made in "${planName}"`,
      description: 'Everything your active plan produces',
      items: onlyUsable(made),
      icon: buildingIcon('Assembler'),
    },
    {
      id: 'plan:overflow',
      name: `Overflow in "${planName}"`,
      description: 'Made by your active plan but not used — good cauldron fodder',
      items: onlyUsable(overflow),
      icon: buildingIcon('Portal_Output'),
    },
  ].filter((g) => g.items.size > 0)
}

export type Preference = 'prefer' | 'avoid'

/** Per-item preferences; items not listed are neutral. */
export interface IngredientPrefs {
  prefer: string[]
  avoid: string[]
  /** Only allow preferred ingredients (instead of just ranking them first). */
  onlyPreferred: boolean
}

export const emptyPrefs: IngredientPrefs = { prefer: [], avoid: [], onlyPreferred: false }

export function prefOf(prefs: IngredientPrefs, item: string): Preference | null {
  if (prefs.prefer.includes(item)) return 'prefer'
  if (prefs.avoid.includes(item)) return 'avoid'
  return null
}

/** Set some items to a preference (or neutral with null). */
export function setPrefs(prefs: IngredientPrefs, keys: Iterable<string>, pref: Preference | null): IngredientPrefs {
  const set = new Set(keys)
  const prefer = prefs.prefer.filter((k) => !set.has(k))
  const avoid = prefs.avoid.filter((k) => !set.has(k))
  if (pref === 'prefer') prefer.push(...set)
  if (pref === 'avoid') avoid.push(...set)
  return { ...prefs, prefer, avoid }
}

/** Prefer exactly this group and avoid every other ingredient. */
export function onlyGroup(prefs: IngredientPrefs, group: ItemGroup): IngredientPrefs {
  return {
    ...prefs,
    prefer: [...group.items],
    avoid: cauldronIngredients.map((i) => i.key).filter((k) => !group.items.has(k)),
  }
}

/** Ingredients the finder may use under these preferences. */
export function allowedIngredients(prefs: IngredientPrefs) {
  const avoid = new Set(prefs.avoid)
  const prefer = new Set(prefs.prefer)
  return cauldronIngredients.filter((i) => !avoid.has(i.key) && (!prefs.onlyPreferred || prefer.has(i.key)))
}

/** Number of preferred ingredient slots in a recipe (duplicates count). */
export function preferredCount(prefs: IngredientPrefs, inputs: string[]): number {
  const prefer = new Set(prefs.prefer)
  return inputs.filter((k) => prefer.has(k)).length
}

