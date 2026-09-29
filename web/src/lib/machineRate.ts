import { itemsByKey } from './gameData'
import type { Process } from './processes'
import type { Modifiers } from './upgrades'

/** Items that travel on belts: liquids go through pipes and pseudo-items (heat) don't travel. */
export function onBelt(item: string): boolean {
  if (item.startsWith('@')) return false
  const it = itemsByKey.get(item)
  return !!it && !it.liquid
}

/**
 * How many of an item one belt slot holds. Coins travel in stacks (machines and containers emit
 * full stacks of 50; a Bank Portal can be set to 1–50); everything else is one per slot.
 */
export function itemsPerSlot(item: string, mods: Modifiers): number {
  return itemsByKey.get(item)?.tags.includes('Currency') ? mods.coinStack : 1
}

/** Speed multiplier a process's machine gets from upgrades. */
export function speedFactor(p: Process, mods: Modifiers): number {
  return p.machine && !p.machine.usesFactorySpeed ? 1 : mods.factorySpeed
}

/**
 * Machines throttle themselves to what their output belts can carry (confirmed in game: a
 * Redcurrant nursery on Fertile Catalyst reports exactly the belt speed, and follows Logistics
 * Efficiency upgrades). Returns the fraction of full speed the output belts allow (≤ 1).
 */
export function outputCap(p: Process, mods: Modifiers): number {
  const beltOut = p.machine?.ports.beltOut ?? 0
  if (!p.machine || p.seconds <= 0 || beltOut === 0) return 1
  const crafts = (60 * speedFactor(p, mods)) / p.seconds
  const solidOut = p.outputs
    .filter((s) => onBelt(s.item))
    .reduce((sum, s) => sum + (s.count * crafts) / itemsPerSlot(s.item, mods), 0)
  return solidOut > 0 ? Math.min(1, (beltOut * mods.beltSpeed) / solidOut) : 1
}

/** Crafts per minute one machine actually completes: upgraded speed, capped by its output belts. */
export function craftsPerMachine(p: Process, mods: Modifiers): number {
  if (p.seconds <= 0) return 0
  return ((60 * speedFactor(p, mods)) / p.seconds) * outputCap(p, mods)
}
