import { createContext } from 'react'

/** An item's or a machine's page in the Reference. */
export type ReferenceEntry = { item: string } | { machine: string }

/**
 * Opens a Reference page in place, from anywhere in the app. `row` is the planner row the link was
 * followed from, shown again when the player comes back to the planner. Absent (null) where there's
 * no app to navigate in, as in tests: links then show as plain text.
 */
export const ReferenceNav = createContext<((entry: ReferenceEntry, row?: string) => void) | null>(null)
