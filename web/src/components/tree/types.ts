import type { ReactNode } from 'react'
import type { TreeNode } from '../../lib/tree'

/** A target's controls, laid into the tree row that meets it. */
export interface TargetSlot {
  /** The root row meeting the target, once it has one (none without an item). */
  rootId: string | null
  /** Set in machines: its row runs just that many, so it isn't rounded up. */
  byMachines?: boolean
  /** In the item column: which item. */
  item: ReactNode
  /** In the rate column: how much of it. */
  amount: ReactNode
  /** Under the recipe: what the amount comes to, and feeding it back. */
  notes: ReactNode
  /** Before the row actions: move up and down. */
  move: ReactNode
  /** In the first row action slot, in line with "build separately" below it. */
  remove: ReactNode
}

/** Where a link points: every row it matches, in tree order. */
export type Jump = (n: TreeNode) => boolean

/** Renders a link from a row to the rows `match` picks out (see `ProductionTree`). */
export type LinkFn = (from: TreeNode, match: Jump, label: ReactNode, title: string) => ReactNode
