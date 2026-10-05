import type { CauldronMode } from './cauldron'
import type { IngredientPrefs } from './itemGroups'
import type { BranchChoice, MyDefault, MyDefaults, Plan, PlanTarget, Progress, SavedRecipe, Separation, Unitizing } from './types'

/**
 * Checks data from outside the code (an imported file, or what localStorage holds) against the
 * shapes the app expects. Each sanitizer returns a fresh value keeping only what fits, or undefined
 * when nothing usable is left, so a bad or hostile file can't crash the app or reach odd code paths.
 */

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined)
const list = <T>(v: unknown, each: (x: unknown) => T | undefined) =>
  Array.isArray(v) ? v.map(each).filter((x): x is T => x !== undefined) : undefined

/** Keys that would reach an object's prototype when assigned with `obj[key] = …`. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function record<T>(v: unknown, each: (x: unknown) => T | undefined): Record<string, T> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, T> = {}
  for (const [k, x] of Object.entries(v)) {
    const value = each(x)
    if (value !== undefined && !UNSAFE_KEYS.has(k)) out[k] = value
  }
  return out
}

/** Copies the defined fields only, so optional fields stay absent rather than undefined. */
function defined<T extends object>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== undefined)) as T
}

/** Gives every entry a distinct id, minting new ones for missing or repeated ids. */
function distinctIds<T extends { id: string }>(items: T[], newId: () => string): T[] {
  const seen = new Set<string>()
  return items.map((x) => {
    let id = x.id
    while (!id || seen.has(id)) id = newId()
    seen.add(id)
    return id === x.id ? x : { ...x, id }
  })
}

const UNITS = new Set(['items', 'machines', 'net', 'overflow'])

function target(v: unknown): PlanTarget | undefined {
  if (!isObj(v)) return undefined
  const item = str(v.item)
  const rate = num(v.rate)
  if (!item || rate === undefined || rate < 0) return undefined
  const consumes = str(v.consumes) || undefined
  let unit = UNITS.has(v.unit as string) ? (v.unit as PlanTarget['unit']) : undefined
  // An overflow target with nothing to consume is an ordinary one.
  if (unit === 'overflow' && !consumes) unit = undefined
  return defined({ item, rate, unit, consumes: unit === 'overflow' ? consumes : undefined, feedback: bool(v.feedback) })
}

function branch(v: unknown): BranchChoice | undefined {
  if (!isObj(v)) return undefined
  const producer = str(v.producer)
  if (producer === undefined) return undefined
  return defined({ producer, machine: str(v.machine), reuse: bool(v.reuse) })
}

function separation(v: unknown): Separation | undefined {
  if (!isObj(v)) return undefined
  const item = str(v.item)
  if (!item) return undefined
  return defined({ item, anchor: str(v.anchor), at: str(v.at) })
}

const wholeNumber = (v: unknown) => {
  const n = num(v)
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined
}

function unitizing(v: unknown): Unitizing | undefined {
  if (!isObj(v)) return undefined
  const count = wholeNumber(v.count)
  const of = wholeNumber(v.of)
  return count && of && count > 1 && of % count === 0 ? { count, of } : undefined
}

function plan(v: unknown, newId: () => string): Plan | undefined {
  if (!isObj(v)) return undefined
  const feedback = isObj(v.feedback) ? defined({ fuel: bool(v.feedback.fuel), fertilizer: bool(v.feedback.fertilizer) }) : undefined
  return defined({
    id: str(v.id) || newId(),
    name: str(v.name) ?? 'Untitled plan',
    targets: list(v.targets, target) ?? [],
    producers: record(v.producers, str) ?? {},
    machines: record(v.machines, str) ?? {},
    branches: record(v.branches, branch),
    upgrades: record(v.upgrades, num),
    tier: num(v.tier),
    feedbackItems: strings(v.feedbackItems),
    feedback,
    coinStack: num(v.coinStack),
    rowCatalysts: record(v.rowCatalysts, strings),
    catalysts: record(v.catalysts, strings),
    rowHeights: record(v.rowHeights, num),
    separate: list(v.separate, separation),
    noReuse: strings(v.noReuse),
    roundUp: strings(v.roundUp),
    units: record(v.units, unitizing),
    built: strings(v.built),
  })
}

/** Valid plans with distinct ids; undefined when none are left. */
export function sanitizePlans(v: unknown, newId: () => string): Plan[] | undefined {
  const plans = list(v, (p) => plan(p, newId))
  return plans?.length ? distinctIds(plans, newId) : undefined
}

function savedRecipe(v: unknown, newId: () => string): SavedRecipe | undefined {
  if (!isObj(v)) return undefined
  const mode = oneOf<CauldronMode>('normal', 'advanced')(v.mode)
  const inputs = strings(v.inputs)
  const output = str(v.output)
  if (!mode || !inputs || inputs.length !== (mode === 'normal' ? 3 : 2) || output === undefined) return undefined
  return defined({
    id: str(v.id) || newId(),
    mode,
    inputs,
    output,
    name: str(v.name),
    note: str(v.note),
    createdAt: num(v.createdAt) ?? 0,
  })
}

/** Valid saved recipes with distinct ids. */
export function sanitizeSavedRecipes(v: unknown, newId: () => string): SavedRecipe[] | undefined {
  const saved = list(v, (s) => savedRecipe(s, newId))
  return saved && distinctIds(saved, newId)
}

export function sanitizeProgress(v: unknown): Progress | undefined {
  if (!isObj(v)) return undefined
  return defined({ upgrades: record(v.upgrades, num) ?? {}, tier: num(v.tier) })
}

function myDefault(v: unknown): MyDefault | undefined {
  if (!isObj(v)) return undefined
  const producer = str(v.producer)
  if (producer === undefined) return undefined
  return defined({ producer, machine: str(v.machine), catalysts: strings(v.catalysts), height: num(v.height) })
}

export const sanitizeMyDefaults = (v: unknown): MyDefaults | undefined => record(v, myDefault)

export function sanitizePrefs(v: unknown): IngredientPrefs | undefined {
  if (!isObj(v)) return undefined
  return { prefer: strings(v.prefer) ?? [], avoid: strings(v.avoid) ?? [], onlyPreferred: v.onlyPreferred === true }
}

export interface CauldronSearch {
  mode: CauldronMode
  mix: (string | null)[]
  target: string | null
  mustInclude: string | null
  sort: 'offset' | 'cost'
  page: number
}

/** The Cauldron tab's mix and search, keeping only item keys `known` accepts. */
export function sanitizeCauldronSearch(v: unknown, known: (key: string) => boolean): CauldronSearch | undefined {
  if (!isObj(v)) return undefined
  const item = (x: unknown) => {
    const k = str(x)
    return k !== undefined && known(k) ? k : null
  }
  const mix = Array.isArray(v.mix) ? v.mix : []
  const page = num(v.page)
  return {
    mode: oneOf<CauldronMode>('normal', 'advanced')(v.mode) ?? 'normal',
    mix: [0, 1, 2].map((i) => item(mix[i])),
    target: item(v.target),
    mustInclude: item(v.mustInclude),
    sort: oneOf<'offset' | 'cost'>('offset', 'cost')(v.sort) ?? 'cost',
    page: page !== undefined && page >= 0 ? Math.floor(page) : 0,
  }
}

export const sanitizeString = str
export const sanitizeStrings = strings

/** One of the given values, else undefined. */
export const oneOf =
  <T extends string>(...values: T[]) =>
  (v: unknown): T | undefined =>
    values.includes(v as T) ? (v as T) : undefined
