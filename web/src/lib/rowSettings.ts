import type { Plan } from './types'
import type { PlanNode } from './unfold'

/**
 * Where each of a plan's settings lives: on tree rows (by row id, `row`), on build-separately
 * choices (which point at a row, `separations`), or on the plan as a whole (`plan`, including
 * per-item settings and fields older plans had). Every field of `Plan` is listed, so a new one
 * can't be added without saying which it is; a row's are then in `ROW_FIELDS`.
 */
const PLAN_FIELDS = {
  id: 'plan',
  name: 'plan',
  targets: 'plan',
  producers: 'plan',
  machines: 'plan',
  branches: 'row',
  upgrades: 'plan',
  tier: 'plan',
  feedbackItems: 'plan',
  loopFeedback: 'plan',
  altarItems: 'plan',
  feedback: 'plan',
  rowStacks: 'row',
  rowCatalysts: 'row',
  catalysts: 'plan',
  rowHeights: 'row',
  separate: 'separations',
  autoOrganize: 'plan',
  altarOutputs: 'row',
  roundUp: 'row',
  mixedFeed: 'row',
  units: 'row',
  built: 'row',
  busSupply: 'plan',
} as const satisfies Record<keyof Plan, 'row' | 'separations' | 'plan'>

/** The plan's settings kept per tree row. */
export type RowKey = { [K in keyof typeof PLAN_FIELDS]: (typeof PLAN_FIELDS)[K] extends 'row' ? K : never }[keyof typeof PLAN_FIELDS]

/** A row setting kept as a value per row id. */
type RecordKey = { [K in RowKey]: NonNullable<Plan[K]> extends unknown[] ? never : K }[RowKey]
type ValueOf<K extends RecordKey> = NonNullable<Plan[K]>[string]

/** What a row setting is, beyond where it's kept. */
type RowField<K extends RowKey> = {
  /** Whether it changes how the plan is made (the build checklist doesn't). */
  makes: boolean
} & (K extends RecordKey
  ? {
      shape: 'record'
      /** What of it a row keeps, as the plan lays the row out (undefined: the row is gone); undefined to drop it. */
      keep: (row: PlanNode | undefined, value: ValueOf<K>) => ValueOf<K> | undefined
    }
  : {
      shape: 'list'
      /** Whether a row keeps it, as the plan lays the row out (undefined: the row is gone). */
      keep: (row: PlanNode | undefined) => boolean
    })

const runs = (n: PlanNode | undefined) => n?.kind === 'make'

/** Every row setting, with what it is: a new one can't be added to `Plan` without one. */
export const ROW_FIELDS: { [K in RowKey]: RowField<K> } = {
  branches: { shape: 'record', makes: true, keep: (n, v) => (n ? v : undefined) },
  // Catalysts stay with a row only while its machines can take them.
  rowCatalysts: { shape: 'record', makes: true, keep: (n, v) => (n?.process?.acceptsCatalysts ? v : undefined) },
  // Heights stay with a row only while its machines' output depends on it.
  rowHeights: { shape: 'record', makes: true, keep: (n, v) => (n?.process?.acceptsHeight ? v : undefined) },
  // Coin stacks stay with a row only while it converts coins.
  rowStacks: { shape: 'record', makes: true, keep: (n, v) => (n?.process?.stack !== undefined ? v : undefined) },
  // A mixed feed stays with a crucible row while the row below it makes something it can refine.
  mixedFeed: { shape: 'record', makes: true, keep: (n, v) => (n?.mixable?.length ? v : undefined) },
  units: { shape: 'record', makes: true, keep: (n, v) => (runs(n) ? v : undefined) },
  // Outputs sent to Knowledge Altars stay with a row while its machines still make them.
  altarOutputs: {
    shape: 'record',
    makes: true,
    keep: (n, items) => {
      const made = runs(n) ? n!.process!.outputs.map((o) => o.item) : []
      const kept = items.filter((item) => made.includes(item))
      return kept.length === items.length ? items : kept.length ? kept : undefined
    },
  },
  // Rounding stays with rows its machines still run on.
  roundUp: { shape: 'list', makes: true, keep: runs },
  // Only machines get built: marks stay with rows that run some.
  built: { shape: 'list', makes: false, keep: runs },
}

export const ROW_KEYS = Object.keys(ROW_FIELDS) as RowKey[]

/** A record setting's entries, or a list setting's ids (each `true`). */
export function rowEntries(plan: Plan, key: RowKey): [string, unknown][] {
  const value = plan[key]
  if (!value) return []
  return ROW_FIELDS[key].shape === 'list' ? (value as string[]).map((id) => [id, true]) : Object.entries(value)
}

/** The setting from entries (row id, value), or undefined for none, as a plan keeps it. */
export function fromEntries<K extends RowKey>(key: K, entries: [string, unknown][]): Plan[K] {
  if (!entries.length) return undefined
  return (ROW_FIELDS[key].shape === 'list' ? [...new Set(entries.map(([id]) => id))] : Object.fromEntries(entries)) as Plan[K]
}

/**
 * What the row settings would be with each kept or dropped by `keep(key, id, value)`: the value to
 * keep (true for a list's), or undefined to drop. Unchanged settings stay the same objects;
 * `changed` says whether any did.
 */
export function mapRowSettings(
  plan: Plan,
  keep: (key: RowKey, id: string, value: unknown) => unknown,
): { settings: Partial<Plan>; changed: boolean } {
  const settings: Partial<Plan> = {}
  let changed = false
  for (const key of ROW_KEYS) {
    const before = rowEntries(plan, key)
    const after: [string, unknown][] = []
    let same = true
    for (const [id, value] of before) {
      const v = keep(key, id, value)
      if (v === undefined) same = false
      else {
        if (v !== value) same = false
        after.push([id, v])
      }
    }
    if (same) continue
    changed = true
    ;(settings as Record<string, unknown>)[key] = fromEntries(key, after)
  }
  return { settings, changed }
}
