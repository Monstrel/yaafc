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
  /**
   * 'items' = items per minute (default); 'machines' = that many of the producer's machines' output;
   * 'net' = items per minute left over after the plan burns or spreads what it needs of a fed-back
   * fuel or fertilizer (the planner sizes the build).
   */
  unit?: 'items' | 'machines' | 'net'
  /**
   * Whether this target's output feeds the plan's own heat or fertilizer need (when the item is a
   * fuel, or the nurseries' fertilizer). Absent = as the plan's `feedbackItems` says for the item.
   */
  feedback?: boolean
}

/** Chosen producer for an item: a process id, or 'import' to bring it in from outside. */
export type ProducerChoice = string

/** A producer picked for one branch of the production tree. */
export interface BranchChoice {
  producer: ProducerChoice
  /** Machine to run it on, when it can run on several (else the plan-wide pick). */
  machine?: string
  /**
   * Whether the rows take other rows' by-products of the item first: false makes all of it with
   * `producer`, keeping to itself; true was picked, so it also takes by-products from rows that make
   * their own (with `producer` '' when only this was picked). Absent = as above (else the plan's
   * `noReuse`, else reuse, but not from rows that make their own).
   */
  reuse?: boolean
}

export interface Plan {
  id: string
  name: string
  targets: PlanTarget[]
  /** Plan-wide producer per item, used wherever a branch doesn't pick its own. */
  producers: Record<string, ProducerChoice>
  /** Machine building chosen per process (defaults to the first capable machine). */
  machines: Record<string, string>
  /**
   * Producers picked per tree row id: they apply to that row and the rows of the same item below
   * it, the deepest pick winning.
   */
  branches?: Record<string, BranchChoice>
  /** Plans saved before upgrades were global: their levels (moved to `Progress` on load). */
  upgrades?: UpgradeLevels
  /** Plans saved before upgrades were global: their research tier (moved to `Progress` on load). */
  tier?: number
  /**
   * Fuel and fertilizer items whose output the plan feeds back into its own heat or fertilizer
   * need: every source of them (overflow, and targets that don't say otherwise). See ledger.ts.
   */
  feedbackItems?: string[]
  /** Plans saved before feedback was per item: per use (moved to `feedbackItems` on load). */
  feedback?: { fuel?: boolean; fertilizer?: boolean }
  /** Coins per stack on belts (Bank Portal setting, 1–50); machines and containers emit 50. */
  coinStack?: number
  /** Catalyst item keys loaded into a row's Advanced Athanors, per tree row id. */
  rowCatalysts?: Record<string, string[]>
  /** Plans saved before catalysts were per row: per process id (moved to `rowCatalysts` on load). */
  catalysts?: Record<string, string[]>
  /** Items the production tree builds separately, gathering their uses instead of a copy per branch. */
  separate?: Separation[]
  /** Items whose rows make all of it themselves, taking no other rows' by-products (unless a branch says so). */
  noReuse?: string[]
}

/** How far the player has got in their game: shared by every plan, since they play one game. */
export interface Progress {
  /** Level per improvement series (e.g. FactorySpeed: 14). */
  upgrades: UpgradeLevels
  /** Research tier reached (1–9): defaults only use what it unlocks. Absent = every tier. */
  tier?: number
}

/** Where the production tree gathers the uses of an item built separately. */
export interface Separation {
  item: string
  /** Item whose rows gather this item's uses from below them; absent = a root at the top of the plan. */
  anchor?: string
  /** Tree row id of the one `anchor` row that gathers them; absent = every `anchor` row. */
  at?: string
}

/**
 * How the player likes to make an item, saved from a production tree row ("use as my default")
 * and used by every plan unless the plan picks something else.
 */
export interface MyDefault {
  /** Process id, or 'import'. */
  producer: string
  /** Machine to run it on, when it can run on several. */
  machine?: string
  /** Catalysts loaded into it (Advanced Athanor). */
  catalysts?: string[]
}

/** The player's saved defaults, per item. */
export type MyDefaults = Record<string, MyDefault>
