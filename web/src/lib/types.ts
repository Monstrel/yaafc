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

/** A target with nothing picked yet: every plan has at least one, so it's never empty. */
export const blankTarget = (): PlanTarget => ({ item: '', rate: 10 })

export interface PlanTarget {
  item: string
  /** Amount wanted, in `unit`. */
  rate: number
  /**
   * 'items' = items per minute (default); 'machines' = that many of the producer's machines' output;
   * 'net' = items per minute left over after the plan's rows take what they need of a fed-back item
   * in place of the bus (the planner sizes the build); 'overflow' = as many as the overflow of
   * `consumes` makes; 'supply' = as many as what's left of the bus's capped supply of `consumes`
   * makes (for both, the planner sizes the build, and `rate` is unused).
   */
  unit?: 'items' | 'machines' | 'net' | 'overflow' | 'supply'
  /**
   * For an 'overflow' target: the item whose overflow (what the rest of the plan makes and nothing
   * uses) its rows of that item take, instead of making or buying it. For a 'supply' target: the
   * item its rows take from the bus, using what the plan's other rows leave of its supply.
   */
  consumes?: string
  /**
   * Whether this target's output covers what the plan's rows take of its item from the bus (or,
   * coins, the plan's money). Absent = as the plan's `feedbackItems` says for the item.
   */
  feedback?: boolean
}

/** Chosen producer for an item: a process id, 'import' to buy it at a Purchase Portal, or 'bus' to take it from the bus. */
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
   * Items whose output the plan feeds back in place of what its rows take of them from the bus (or,
   * coins, into its money): every source of them (overflow, and targets that don't say otherwise).
   * See ledger.ts.
   */
  feedbackItems?: string[]
  /** Plans saved before feedback was per item: per use (moved to `feedbackItems` on load). */
  feedback?: { fuel?: boolean; fertilizer?: boolean }
  /**
   * Coins a row's Bank Portals output per belt entry (the in-game "Conversion Amount", 1–50), per
   * tree row id. Absent = the saved default's, else 50.
   */
  rowStacks?: Record<string, number>
  /** Catalyst item keys loaded into a row's Advanced Athanors, per tree row id. */
  rowCatalysts?: Record<string, string[]>
  /** Plans saved before catalysts were per row: per process id (moved to `rowCatalysts` on load). */
  catalysts?: Record<string, string[]>
  /**
   * Height a row's Thermal Extractors are built at (the in-game "Height", in grid spaces), per tree
   * row id; it sets their output. Absent = the saved default's, else 0 (on the ground).
   */
  rowHeights?: Record<string, number>
  /** Items the production tree builds separately, gathering their uses instead of a copy per branch. */
  separate?: Separation[]
  /** Items whose rows make all of it themselves, taking no other rows' by-products (unless a branch says so). */
  noReuse?: string[]
  /** Tree row ids that run on a whole number of machines, rounded up; the extra output overflows. */
  roundUp?: string[]
  /**
   * Whether a Paradox Crucible row also refines the by-products of the row below it, as they come
   * up the same belt (its input's machines then run only for what those leave), per tree row id.
   * Absent = the saved default's, else not.
   */
  mixedFeed?: Record<string, boolean>
  /** Tree rows built as several identical copies of themselves and everything below them. */
  units?: Record<string, Unitizing>
  /** Tree row ids the player has marked built in their game: a checklist, it changes nothing the plan makes. */
  built?: string[]
  /**
   * Items per minute the bus carries of an item, where it's limited: the plan's rows taking it from
   * the bus share that, and fall short past it. Absent = as much as they take.
   */
  busSupply?: Record<string, number>
}

/** A row built in units: `count` copies of a smaller line, each making its share. */
export interface Unitizing {
  count: number
  /**
   * Whole machines the row ran on (per copy of the line above it) when the units were picked: they
   * only split that many evenly, so they're dropped once it changes.
   */
  of: number
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
  /** Process id, 'import' (bought) or 'bus'. */
  producer: string
  /** Machine to run it on, when it can run on several. */
  machine?: string
  /** Catalysts loaded into it (Advanced Athanor). */
  catalysts?: string[]
  /** Height its machines are built at, when that sets their output (Thermal Extractor). */
  height?: number
  /** Coins per output belt entry, when it converts coins (Bank Portal). */
  stack?: number
  /** It also refines the by-products of the machines making its input (Paradox Crucible). */
  mixed?: boolean
}

/** The player's saved defaults, per item. */
export type MyDefaults = Record<string, MyDefault>
