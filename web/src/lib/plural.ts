import { buildingsByKey, itemName, itemsByKey, realItem } from './gameData'
import { fmt } from './format'

/**
 * English plurals for counts of things. The game's text has no plural forms ("Cannot delete {0}
 * buildings"), so names are pluralized here: by rule, with the items below kept as they are.
 */

/**
 * Items whose name stays the same for any count: stuff measured rather than counted (Coal, Sand,
 * Steam, every powder, dust, oil and ore), and names (the planetary metals, Whispering Fields).
 */
const SAME_NAME = new Set([
  // A beverage's name, not a plural.
  'WhisperingFields',
  // Herbs, minerals and ores.
  'Flax', 'Sage', 'Lavender', 'Chamomile', 'Gentian', 'GloomFungus',
  'Limestone', 'IronOre', 'Pyrite', 'RockSalt', 'CoalOre', 'QuartzOre', 'Stone', 'Sand', 'Clay',
  'Quicklime', 'Charcoal', 'Coke', 'Coal', 'Sulfur', 'Salt', 'Malachite', 'Turquoise', 'Obsidian',
  'LapisLazuli', 'Marble', 'Diamond1',
  // Materials, liquids and gases.
  'Mortar', 'FlaxFiber', 'LinenThread', 'Linen', 'IronSand', 'PlantAsh', 'Glass', 'Soap', 'PerfumedSoap',
  'MoonlitSoap', 'BasicFertilizer', 'AdvancedFertilizer', 'GentianNectar', 'LinseedOil', 'FruitWine',
  'Limewater', 'SaltWater', 'LavenderEssentialOil', 'Brandy', 'SulfuricAcid', 'StrangeTide',
  'LavenderDream', 'VolcanicAsh', 'Mercury', 'AquaVitae', 'WorldTreeVintage', 'Steam', 'Mors', 'Vitae',
  // Powders and dusts.
  'SagePowder', 'QuicklimePowder', 'CharcoalPowder', 'ClayPowder', 'SoapPowder', 'CokePowder',
  'YeastPowder', 'ChamomilePowder', 'SulfurPowder', 'CopperPowder', 'CopperPowder2', 'BlackPowder',
  'PerfumedSoapPowder', 'GentianPowder', 'SilverPowder', 'SilverPowder2', 'SilverPowder3',
  'GoldDust', 'GoldDust2', 'GoldDust3', 'GoldDust5', 'StarDust', 'FairyDust',
  // Planetary metals: names.
  'Jupiter', 'Saturn', 'Mars', 'Venus', 'MercuryP', 'Luna', 'Sol',
])

/** Items the game names in the plural: their name for a count of one. */
const SINGULAR: Record<string, string> = {
  Wood: 'Log',
  Nails: 'Iron Nail',
  GloomSpores: 'Gloom Spore',
  FlaxSeed: 'Flax Seed',
  SageSeed: 'Sage Seed',
  RedcurrantSeed: 'Redcurrant Seed',
  LavenderSeed: 'Lavender Seed',
  ChamomileSeed: 'Chamomile Seed',
  GentianSeed: 'Gentian Seed',
}

/** Words English doesn't pluralize by rule. */
const IRREGULAR: Record<string, string> = { Leaf: 'Leaves' }

/** A count reads as one only when it's shown as "1" (0.5 and 1.5 are plural, as in English). */
export const isOne = (count: number) => fmt(count) === '1'

/** The plural of a name: its last word pluralized, before any "(Output)"-style qualifier. */
export function pluralize(name: string): string {
  const m = name.match(/^(.*?)(\w+)(\W*(?:\(.*\))?)$/)
  if (!m) return name
  const [, head, word, tail] = m
  return head + pluralWord(word) + tail
}

function pluralWord(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word]
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es'
  return word + 's'
}

/** A plain English noun for a count: noun(1, 'recipe') = "recipe", noun(3, 'recipe') = "recipes". */
export const noun = (count: number, singular: string, plural = pluralWord(singular)) =>
  isOne(count) ? singular : plural

/** An item's name for a count of it: "1 Iron Ingot", "12 Iron Ingots", "12 Coal", "1 Log". */
export function itemNameFor(item: string, count: number): string {
  const name = itemName(item)
  const real = realItem(item)
  if (SINGULAR[real]) return isOne(count) ? SINGULAR[real] : name
  return isOne(count) || SAME_NAME.has(real) || !itemsByKey.has(real) ? name : pluralize(name)
}

/** A building's name for a count of it: "1 Grinder", "2.5 Grinders", "3 Nurseries". */
export const buildingNameFor = (building: string, count: number) =>
  machineNameFor(buildingsByKey.get(building)?.name ?? building, count)

/** A machine's display name for a count of it (machines are all counted, never "some Grinder"). */
export const machineNameFor = (name: string, count: number) => (isOne(count) ? name : pluralize(name))
