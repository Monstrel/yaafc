import { itemsByKey } from './gameData'
import type { Modifiers } from './upgrades'

/**
 * Knowledge Altar (UShrineFacilityComponent, build 25321648; not in the data tables). It breaks down
 * whatever its one input belt brings, a few at a time, for EXP toward the Knowledge Level.
 *
 * Each cycle waits for `stack` units of the item, runs `seconds` (scaled by Factory Efficiency, like
 * every machine: tick 0x144A2AA90), then grants `exp` and consumes the units. Relics have fixed cycles
 * (GameState relic map, filled at 0x144A50ED0); anything else is one unit per cycle, worth
 * 0.0002 × BaseCost EXP over 0.1676 × BaseCost^0.518 s (0x144A4F1C0). Only relics get the Relic
 * Knowledge upgrade (GetExtractingExp 0x144A1C8B0: exp × (1 + AltarEfficiency / 100) when relic).
 *
 * Units are counted like recipes count them: bundle items in fractions, so every relic cycle takes
 * a fifth of a planet (60 of Jupiter's 300, 1 of Sol's 5).
 */
const RELICS: Record<string, { stack: number; seconds: number; exp: number }> = {
  Jupiter: { stack: 60, seconds: 12, exp: 2 },
  Saturn: { stack: 20, seconds: 18, exp: 14.3 },
  Mars: { stack: 15, seconds: 24, exp: 25.2 },
  Venus: { stack: 40, seconds: 30, exp: 102 },
  MercuryP: { stack: 20, seconds: 45, exp: 538.6 },
  Luna: { stack: 15, seconds: 60, exp: 1907.5 },
  Sol: { stack: 1, seconds: 120, exp: 4887.8 },
}

/** What one item is worth broken down at a Knowledge Altar. */
export interface AltarYield {
  /** EXP per item (whole item, for bundles), with Relic Knowledge for relics. */
  exp: number
  /** Seconds one altar takes per item, at Factory Efficiency. */
  seconds: number
  relic: boolean
}

/** One item at a Knowledge Altar; null when it can't go on its belt (liquids) or gives no EXP. */
export function altarYield(item: string, mods: Modifiers): AltarYield | null {
  const it = itemsByKey.get(item)
  if (!it || it.liquid) return null
  const units = it.maxStack < 0 ? -it.maxStack : 1
  const relic = RELICS[item]
  const cycle = relic
    ? { ...relic, exp: relic.exp * mods.altar }
    : { stack: 1, seconds: 0.1676 * it.baseCost ** 0.518, exp: 0.0002 * it.baseCost }
  if (!(cycle.exp > 0)) return null
  const cycles = units / cycle.stack
  return { exp: cycles * cycle.exp, seconds: (cycles * cycle.seconds) / mods.factorySpeed, relic: !!relic }
}

/**
 * Altars it takes to break down `perMinute` of an item: each takes one belt, so an item it breaks
 * down faster than a belt brings them waits on the belt.
 */
export function altarsFor(y: AltarYield, perMinute: number, mods: Modifiers): number {
  return perMinute * Math.max(y.seconds / 60, 1 / mods.beltSpeed)
}
