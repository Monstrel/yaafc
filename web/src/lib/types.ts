import type { CauldronMode } from './cauldron'
import type { UpgradeLevels } from './upgrades'

export interface SavedRecipe {
  id: string
  mode: CauldronMode
  /** Ingredient item keys (3 for normal, 2 for advanced); duplicates allowed. */
  inputs: string[]
  /** Output item key at the time of saving (recomputed on load to catch game data changes). */
  output: string
  name?: string
  note?: string
  createdAt: number
}

export interface PlanTarget {
  item: string
  /** Amount wanted, in `unit`. */
  rate: number
  /** 'items' = items per minute (default); 'machines' = that many of the producer's machines' output. */
  unit?: 'items' | 'machines'
}

/** Chosen producer for an item: a process id, or 'import' to bring it in from outside. */
export type ProducerChoice = string

export interface Plan {
  id: string
  name: string
  targets: PlanTarget[]
  producers: Record<string, ProducerChoice>
  /** Machine building chosen per process (defaults to the first capable machine). */
  machines: Record<string, string>
  upgrades: UpgradeLevels
  /**
   * Fuel and fertilizer are base inputs. With feedback on, the plan's own output of the preferred
   * fuel/fertilizer (e.g. Fertile Catalyst from a loop) covers the need before anything is bought.
   */
  feedback?: { fuel?: boolean; fertilizer?: boolean }
  /** Coins per stack on belts (Bank Portal setting, 1–50); machines and containers emit 50. */
  coinStack?: number
  /** Catalyst item keys loaded into the Advanced Athanor, per process id. */
  catalysts?: Record<string, string[]>
}
