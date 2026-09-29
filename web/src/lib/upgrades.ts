import { attributeBase, upgrades, type UpgradeSeries } from './gameData'

/** Player's level per improvement series key (e.g. FactorySpeed: 14). */
export type UpgradeLevels = Record<string, number>

/** Series shown in the planner, in display order. */
export const PLANNER_UPGRADES = ['FactorySpeed', 'Conveyer', 'FuelEfficiency', 'FertilizeEfficiency', 'AlchemySkill']
  .map((key) => upgrades.find((u) => u.key === key))
  .filter((u): u is UpgradeSeries => !!u)

export function maxLevel(series: UpgradeSeries): number {
  return series.levels.length + series.unlimitedMax
}

/** Total bonus to an attribute (percent, or flat for Add effects); levels past the table repeat the last ("unlimited") level. */
export function attributeBonus(levels: UpgradeLevels, attribute: string): number {
  let total = 0
  for (const series of upgrades) {
    const level = Math.min(levels[series.key] ?? 0, maxLevel(series))
    for (let i = 0; i < level; i++) {
      const effects = series.levels[Math.min(i, series.levels.length - 1)]
      for (const e of effects) if (e.attribute === attribute) total += e.value
    }
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
