import { attributeBase, dispatch, upgrades, type UpgradeEffect, type UpgradeSeries } from './gameData'

/** Player's level per improvement series key (e.g. FactorySpeed: 14). */
export type UpgradeLevels = Record<string, number>

// Series granted outside the skill tree, which the game files name after Sales Ability. Absent
// (game data without them) = an empty series, level 0.
const series = (key: string, name: string, icon: string | null): UpgradeSeries => {
  const s = upgrades.find((u) => u.key === key)
  return { ...(s ?? { key, levels: [], unlimited: false, unlimitedMax: 0, column: null }), name, icon: icon ?? s?.icon ?? null }
}

/** Supplier Licenses (DT_License): each tier's buff raises Dispatch Portal limits (ContractNum) and payments (ContractProfit). */
export const SUPPLIER_LICENSES = series('ContractProfit', 'Supplier License', dispatch.licenseIcon)

/**
 * Potion Belt upgrades (DT_PlayerGear PotionBelt1–4): each cuts Sleep Time by 2 hours, lengthening the
 * day. The game counts the belt you start with as level 1, so they take it to level 5 (no sleep).
 */
export const POTION_BELT = series('SleepTime', 'Potion Belt', dispatch.potionBeltIcon)

/** The level the game shows before any upgrades of a series: 0, or 1 for the Potion Belt. */
export const firstLevel = (u: UpgradeSeries) => (u.key === POTION_BELT.key ? 1 : 0)

/** Upgrades shown under Dispatch Portals in the planner's upgrades panel. */
export const DISPATCH_UPGRADES = [SUPPLIER_LICENSES, POTION_BELT]

/** Hour of the game clock a day starts at (Sunrise, ABeltTDGameStateBase's constructor). */
const DAY_START = 6
/** Game minutes that pass per real second (DayNight.TimeRate, which no blueprint overrides). */
const TIME_RATE = 1

/**
 * Real minutes the factory runs in a game day, for players who never go to bed: the day starts at
 * 6:00 and ends itself at 6:00 the next morning minus Sleep Time (8 hours at base, 2 less per Potion
 * Belt tier). The clock then jumps to 6:00, so the factory doesn't run through the sleep.
 */
export function dayMinutes(levels: UpgradeLevels): number {
  const sleep = Math.max(0, (attributeBase.SleepTime ?? 8) + attributeBonus(levels, 'SleepTime'))
  const end = DAY_START + 24 - sleep
  // Game minutes awake, at TIME_RATE per real second, in real minutes.
  return ((end - DAY_START) * 60) / TIME_RATE / 60
}

/** Series shown in the planner, in the game's skill-tree order (Logistics, Factory, Alchemy, Fuel, Fertilizer, Relic Knowledge). */
export const PLANNER_UPGRADES = ['FactorySpeed', 'Conveyer', 'FuelEfficiency', 'FertilizeEfficiency', 'AlchemySkill', 'AltarEfficiency']
  .map((key) => upgrades.find((u) => u.key === key))
  .filter((u): u is UpgradeSeries => !!u)
  .sort((a, b) => (a.column ?? Infinity) - (b.column ?? Infinity))

/**
 * Highest level in a series. The last table level (13, shown as ∞ in game) can be bought repeatedly; the game
 * counts every purchase of it, the first included, as a stack capped at `unlimitedMax` (ABeltTDGameStateBase::
 * AllocateSkills). So Factory/Logistics Efficiency top out at 12 + 80 = 92; Fuel, Fertilizer and Alchemy Skill
 * (unlimitedMax 0) have no cap.
 */
export function maxLevel(series: UpgradeSeries): number {
  if (!series.unlimited) return series.levels.length
  return series.unlimitedMax > 0 ? series.levels.length - 1 + series.unlimitedMax : Infinity
}

/** Player's level in a series, clamped to 0..maxLevel (saved plans may hold out-of-range values). */
export function upgradeLevel(levels: UpgradeLevels, series: UpgradeSeries): number {
  return Math.min(maxLevel(series), Math.max(0, Math.floor(levels[series.key] ?? 0)))
}

/**
 * Total bonus to an attribute (percent, or flat for Add effects). Each table level has its own effects;
 * levels past the table repeat the last one, which is often smaller (Factory +5% vs +25% before it).
 */
export function attributeBonus(levels: UpgradeLevels, attribute: string): number {
  const sum = (effects: UpgradeEffect[]) => effects.reduce((t, e) => t + (e.attribute === attribute ? e.value : 0), 0)
  let total = 0
  for (const series of upgrades) {
    const level = upgradeLevel(levels, series)
    const table = series.levels.slice(0, level)
    total += table.reduce((t, effects) => t + sum(effects), 0)
    if (level > table.length) total += (level - table.length) * sum(series.levels[series.levels.length - 1])
  }
  return total
}

export interface Modifiers {
  /** Crafting speed multiplier (Factory Efficiency). Heat use scales equally, so heat per craft is unchanged. */
  factorySpeed: number
  /** Heat obtained per fuel item multiplier. */
  fuel: number
  /** Nutrients obtained per fertilizer item multiplier. */
  fertilizer: number
  /** Output multiplier for Extractors. */
  extractor: number
  /** Output multiplier for Alembics. */
  alembic: number
  /** Items per minute one conveyor belt carries (Logistics Efficiency). */
  beltSpeed: number
  /** EXP multiplier for relics at the Knowledge Altar (Relic Knowledge). */
  altar: number
  /** Supplier Licenses held (0–5): they raise Dispatch Portal limits and payments. */
  licenses: number
  /** Real minutes in a game day, for Dispatch Portal limits (see dispatch.ts). */
  dayMinutes: number
}

export function modifiers(levels: UpgradeLevels): Modifiers {
  const pct = (a: string) => 1 + attributeBonus(levels, a) / 100
  return {
    factorySpeed: pct('FactorySpeed'),
    fuel: pct('FuelEfficiency'),
    fertilizer: pct('FertilizerEfficiency'),
    extractor: pct('ExtractorSkill'),
    alembic: pct('AlembicSkill'),
    beltSpeed: (attributeBase.ConveyerSpeed ?? 60) + attributeBonus(levels, 'ConveyerSpeed'),
    altar: pct('AltarEfficiency'),
    licenses: upgradeLevel(levels, SUPPLIER_LICENSES),
    dayMinutes: dayMinutes(levels),
  }
}
