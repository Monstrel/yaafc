import { attributeBase, upgrades, type UpgradeEffect, type UpgradeSeries } from './gameData'

/** Player's level per improvement series key (e.g. FactorySpeed: 14). */
export type UpgradeLevels = Record<string, number>

/** Series shown in the planner, in display order. */
export const PLANNER_UPGRADES = ['FactorySpeed', 'Conveyer', 'FuelEfficiency', 'FertilizeEfficiency', 'AlchemySkill']
  .map((key) => upgrades.find((u) => u.key === key))
  .filter((u): u is UpgradeSeries => !!u)

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
  /** Coins per belt slot: 50 from machines/containers, or a Bank Portal's 1–50 setting. */
  coinStack: number
}

export const MAX_COIN_STACK = 50

export function modifiers(levels: UpgradeLevels, coinStack = MAX_COIN_STACK): Modifiers {
  const pct = (a: string) => 1 + attributeBonus(levels, a) / 100
  return {
    factorySpeed: pct('FactorySpeed'),
    fuel: pct('FuelEfficiency'),
    fertilizer: pct('FertilizerEfficiency'),
    extractor: pct('ExtractorSkill'),
    alembic: pct('AlembicSkill'),
    beltSpeed: (attributeBase.ConveyerSpeed ?? 60) + attributeBonus(levels, 'ConveyerSpeed'),
    coinStack: Math.min(MAX_COIN_STACK, Math.max(1, Math.round(coinStack))),
  }
}
