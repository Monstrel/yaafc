import { useEffect, useSyncExternalStore } from 'react'
import { sanitizeMyDefaults, sanitizePlans, sanitizeProgress, sanitizeSavedRecipes } from './sanitize'
import { newId, storedText } from './store'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './types'

/** The player's data that undo steps back through. What a tab is looking at (the open plan, say) isn't. */
export interface Snapshot {
  plans: Plan[]
  saved: SavedRecipe[]
  myDefaults: MyDefaults
  progress: Progress
}

/**
 * The parts of a snapshot a change touched, as they were on one side of it. Plans are kept one by
 * one, so a step holds only the plans it changed: undoing it leaves the rest as they are now.
 */
export interface Delta {
  /** The plans' order, and the plans that differ, as they were. */
  plans?: { order: string[]; changed: Plan[] }
  saved?: SavedRecipe[]
  myDefaults?: MyDefaults
  progress?: Progress
}

export interface Step {
  /** What the change did, in the player's words ("Delete plan “Brandy”"). */
  label: string
  /** When it was last added to (ms), so quick repeats of one change make one step. */
  at: number
  /** What it changed: as it was before (on the undo list), or after (on the redo list). */
  delta: Delta
}

export interface History {
  undo: Step[]
  redo: Step[]
}

export const EMPTY_HISTORY: History = { undo: [], redo: [] }
export const MAX_STEPS = 100
/** Repeats of one change closer together than this (typing a number, say) make one step. */
export const MERGE_MS = 1000

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/** What differs between two snapshots, as `from` has it (null when nothing does). */
export function diff(from: Snapshot, to: Snapshot): Delta | null {
  const delta: Delta = {}
  if (from.plans !== to.plans) {
    const now = new Map(to.plans.map((p) => [p.id, p]))
    const changed = from.plans.filter((p) => now.get(p.id) !== p)
    const order = from.plans.map((p) => p.id)
    if (changed.length || !sameIds(order, to.plans.map((p) => p.id))) delta.plans = { order, changed }
  }
  if (from.saved !== to.saved) delta.saved = from.saved
  if (from.myDefaults !== to.myDefaults) delta.myDefaults = from.myDefaults
  if (from.progress !== to.progress) delta.progress = from.progress
  return Object.keys(delta).length ? delta : null
}

/** A snapshot with a delta put back: `apply(to, diff(from, to))` is `from`. */
export function apply(s: Snapshot, d: Delta): Snapshot {
  let plans = s.plans
  if (d.plans) {
    const then = new Map(d.plans.changed.map((p) => [p.id, p]))
    const now = new Map(s.plans.map((p) => [p.id, p]))
    const put = d.plans.order.flatMap((id) => {
      const p = then.get(id) ?? now.get(id)
      return p ? [p] : []
    })
    // There's always a plan open.
    if (put.length) plans = put
  }
  return {
    plans,
    saved: d.saved ?? s.saved,
    myDefaults: d.myDefaults ?? s.myDefaults,
    progress: d.progress ?? s.progress,
  }
}

/** One step's worth of two in a row: what `first` changed as it was before, then what only `second` did. */
function merge(first: Delta, second: Delta): Delta {
  const plans =
    first.plans && second.plans
      ? {
          order: first.plans.order,
          changed: [...first.plans.changed, ...second.plans.changed.filter((p) => !first.plans!.changed.some((q) => q.id === p.id))],
        }
      : (first.plans ?? second.plans)
  return { ...second, ...first, ...(plans && { plans }) }
}

const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b)

/** The history with a change from `from` to `to` added; it drops what was undone. */
export function record(h: History, label: string, from: Snapshot, to: Snapshot, now: number): History {
  const delta = diff(from, to)
  if (!delta) return h
  const top = h.undo.at(-1)
  if (top && top.label === label && now - top.at < MERGE_MS) {
    const merged = merge(top.delta, delta)
    const rest = h.undo.slice(0, -1)
    // Undone by its own repeat (a box ticked and unticked again): nothing left to undo.
    return { undo: same(apply(to, merged), to) ? rest : [...rest, { label, at: now, delta: merged }], redo: [] }
  }
  return { undo: [...h.undo, { label, at: now, delta }].slice(-MAX_STEPS), redo: [] }
}

export interface Move {
  history: History
  /** The data with the step undone or redone. */
  snapshot: Snapshot
  label: string
  /** The plan it changed, to show (none when the step only removed plans or touched no plan). */
  plan?: string
}

/** Takes the last step of one list back, onto the other. */
function move(h: History, current: Snapshot, from: 'undo' | 'redo'): Move | null {
  const to = from === 'undo' ? 'redo' : 'undo'
  const step = h[from].at(-1)
  if (!step) return null
  const snapshot = apply(current, step.delta)
  const back = diff(current, snapshot)
  const before = new Map(current.plans.map((p) => [p.id, p]))
  return {
    history: {
      [from]: h[from].slice(0, -1),
      [to]: back ? [...h[to], { label: step.label, at: 0, delta: back }] : h[to],
    } as unknown as History,
    snapshot,
    label: step.label,
    plan: snapshot.plans.find((p) => before.get(p.id) !== p)?.id,
  }
}

export const undo = (h: History, current: Snapshot) => move(h, current, 'undo')
export const redo = (h: History, current: Snapshot) => move(h, current, 'redo')

// Kept per tab, through reloads: sessionStorage is the tab's own.
const SESSION_KEY = 'alchemy-calculator:undo'
const DATA_KEYS = ['plans', 'saved-recipes', 'my-defaults', 'progress'] as const

/** A short fingerprint of text, to tell whether the stored data is still what the history was kept against. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return `${text.length}:${(h >>> 0).toString(36)}`
}

/** The fingerprint of data as `usePersistentState` stores it. */
const tipOf = (s: Snapshot) => hash([s.plans, s.saved, s.myDefaults, s.progress].map((v) => JSON.stringify(v)).join('\n'))

function sanitizeDelta(v: unknown): Delta | undefined {
  if (!v || typeof v !== 'object') return undefined
  const d = v as Record<string, unknown>
  const delta: Delta = {}
  if (d.plans !== undefined) {
    const p = d.plans as { order?: unknown; changed?: unknown }
    if (!Array.isArray(p?.order) || !p.order.every((id) => typeof id === 'string') || !Array.isArray(p.changed)) return undefined
    const changed = p.changed.length ? sanitizePlans(p.changed, newId) : []
    // A plan that didn't fit would come back changed: keep none rather than undo to something else.
    if (!changed || changed.length !== p.changed.length) return undefined
    delta.plans = { order: p.order, changed }
  }
  if (d.saved !== undefined) {
    const saved = sanitizeSavedRecipes(d.saved, newId)
    if (!saved) return undefined
    delta.saved = saved
  }
  if (d.myDefaults !== undefined) {
    const myDefaults = sanitizeMyDefaults(d.myDefaults)
    if (!myDefaults) return undefined
    delta.myDefaults = myDefaults
  }
  if (d.progress !== undefined) {
    const progress = sanitizeProgress(d.progress)
    if (!progress) return undefined
    delta.progress = progress
  }
  return Object.keys(delta).length ? delta : undefined
}

function sanitizeSteps(v: unknown): Step[] | undefined {
  if (!Array.isArray(v)) return undefined
  const steps: Step[] = []
  for (const s of v as Record<string, unknown>[]) {
    const delta = sanitizeDelta(s?.delta)
    if (!delta || typeof s.label !== 'string' || typeof s.at !== 'number') return undefined
    steps.push({ label: s.label, at: s.at, delta })
  }
  return steps
}

/** This tab's history, when the data in storage is still what it was kept against. */
export function loadHistory(): History {
  try {
    const kept = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as { tip?: unknown; undo?: unknown; redo?: unknown } | null
    if (!kept || kept.tip !== hash(DATA_KEYS.map(storedText).join('\n'))) return EMPTY_HISTORY
    const undo = sanitizeSteps(kept.undo)
    const redo = sanitizeSteps(kept.redo)
    return undo && redo ? { undo, redo } : EMPTY_HISTORY
  } catch {
    return EMPTY_HISTORY
  }
}

function saveHistory(h: History, data: Snapshot) {
  let { undo, redo } = h
  try {
    if (!undo.length && !redo.length) return sessionStorage.removeItem(SESSION_KEY)
    const tip = tipOf(data)
    for (;;) {
      try {
        return sessionStorage.setItem(SESSION_KEY, JSON.stringify({ tip, undo, redo }))
      } catch {
        // Too big to keep: drop the oldest steps until it fits (memory still has them all).
        if (!undo.length && !redo.length) return sessionStorage.removeItem(SESSION_KEY)
        undo = undo.slice(Math.ceil(undo.length / 2))
        redo = redo.slice(Math.ceil(redo.length / 2))
      }
    }
  } catch {
    // Storage blocked: the history only lasts until a reload.
  }
}

/**
 * A tab's undo history, kept in sessionStorage. Call `name` with what a change does just before
 * making it: changes made without a name (upkeep the app does by itself) are never steps of their
 * own. A change from another tab (`fromOutside` called just before it) clears the history, so
 * undoing here never takes back what was done there.
 */
export class UndoHistory {
  private history = loadHistory()
  /** The data as last seen (null until the first is). */
  private last: Snapshot | null = null
  private pending: { label: string; at: number } | null = null
  private outside = false
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get = () => this.history

  name = (label: string) => {
    this.pending = { label, at: Date.now() }
  }
  fromOutside = () => {
    this.outside = true
  }

  /** Takes in the data as each change to it lands. */
  see(data: Snapshot) {
    const prev = this.last
    this.last = data
    if (!prev) return
    if (prev.plans === data.plans && prev.saved === data.saved && prev.myDefaults === data.myDefaults && prev.progress === data.progress)
      return
    const named = this.pending
    this.pending = null
    if (this.outside) {
      this.outside = false
      this.set(EMPTY_HISTORY)
    } else if (named && Date.now() - named.at < MERGE_MS) {
      this.set(record(this.history, named.label, prev, data, Date.now()))
    } else {
      // Not a step (a name given for a change that changed nothing names nothing later), but
      // what's kept has to match the data it's kept against.
      saveHistory(this.history, data)
    }
  }

  /** Undoes or redoes the last step, returning the data to restore. */
  step(how: typeof undo): Move | null {
    const m = this.last && how(this.history, this.last)
    if (!m) return null
    // Already where the data is going, so restoring it isn't a change of its own.
    this.last = m.snapshot
    this.set(m.history)
    return m
  }

  /** Every plan the history could bring back. */
  planIds() {
    return [...this.history.undo, ...this.history.redo].flatMap((s) => s.delta.plans?.order ?? [])
  }

  private set(h: History) {
    this.history = h
    if (this.last) saveHistory(h, this.last)
    for (const listener of this.listeners) listener()
  }
}

/** Undo and redo of `data` through `undos`; `restore` puts data back. */
export function useUndo(undos: UndoHistory, { plans, saved, myDefaults, progress }: Snapshot, restore: (s: Snapshot) => void) {
  const history = useSyncExternalStore(undos.subscribe, undos.get)
  useEffect(() => undos.see({ plans, saved, myDefaults, progress }), [undos, plans, saved, myDefaults, progress])

  const step = (how: typeof undo) => {
    const m = undos.step(how)
    if (m) restore(m.snapshot)
    return m
  }

  return {
    /** What undo would take back, if anything. */
    undoLabel: history.undo.at(-1)?.label,
    redoLabel: history.redo.at(-1)?.label,
    undo: () => step(undo),
    redo: () => step(redo),
    name: undos.name,
    planIds: () => undos.planIds(),
  }
}
