import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
import { sanitizeMyDefaults, sanitizePlans, sanitizeProgress, sanitizeSavedRecipes } from './sanitize'
import { blankTarget, type MyDefaults, type Plan, type Progress, type SavedRecipe } from './types'
import { buildRun } from './updateCheck'

const PREFIX = 'alchemy-calculator:'

/** The text a key holds (null when missing or storage is blocked). */
function readText(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

function parse(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

/** The text `usePersistentState` stored under a key (null when missing or storage is blocked). */
export const storedText = readText

/** What a key holds, parsed but unchecked; its text as it is when that doesn't parse (undefined when missing). */
function readRaw(key: string): unknown {
  const text = readText(key)
  return parse(text) ?? (text || undefined)
}

/** Whether the text was stored (false when storage is full or blocked). */
function writeText(key: string, text: string): boolean {
  try {
    localStorage.setItem(PREFIX + key, text)
    return true
  } catch {
    // Storage full or blocked: keep working in memory.
    return false
  }
}

/** The keys holding the player's data (rather than what a tab is looking at). */
export const DATA_KEYS = ['plans', 'saved-recipes', 'my-defaults', 'progress'] as const
const isData = (key: string) => (DATA_KEYS as readonly string[]).includes(key)

/** Where a copy of stored data that couldn't be read is kept, so starting over doesn't lose it. */
const RESCUED = 'rescued:'

/** Problems keeping the player's data: some couldn't be read (a copy was kept), or can't be saved. */
export interface StorageIssues {
  /** Data keys whose stored data couldn't be read, or only in part: a copy of each is kept. */
  unreadable: string[]
  /** Data keys whose last change couldn't be saved (storage full or blocked). */
  unsaved: string[]
}

/** The problems this tab has had keeping the player's data, as they come and go. */
class IssueStore {
  private issues: StorageIssues = { unreadable: [], unsaved: [] }
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get = () => this.issues

  /** Notes a key as in a kind of trouble, or out of it. */
  set(kind: keyof StorageIssues, key: string, on: boolean) {
    const now = this.issues[kind]
    if (now.includes(key) === on) return
    this.issues = { ...this.issues, [kind]: on ? [...now, key] : now.filter((k) => k !== key) }
    for (const listener of this.listeners) listener()
  }
}

export const storageIssues = new IssueStore()
export const useStorageIssues = () => useSyncExternalStore(storageIssues.subscribe, storageIssues.get)

/**
 * Keeps a copy of a key's text that couldn't be read (or only in part), before anything is saved over
 * it: once per text, however many tabs read it.
 */
function rescue(key: string, text: string) {
  try {
    const kept = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX + RESCUED + key + ':'))
    if (kept.some((k) => localStorage.getItem(k) === text)) return
  } catch {
    return
  }
  writeText(`${RESCUED}${key}:${new Date().toISOString()}`, text)
}

/** Every copy of stored data that couldn't be read, by key (`plans:<when>`). */
export function rescuedData(): Record<string, string> {
  try {
    return Object.fromEntries(
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX + RESCUED))
        .map((k) => [k.slice(PREFIX.length + RESCUED.length), localStorage.getItem(k) ?? '']),
    )
  } catch {
    return {}
  }
}

/** Where the deploy run of the build that last saved the player's data is kept. */
const BUILD_KEY = 'build-run'
const storedRun = () => Number(readText(BUILD_KEY)) || 0

/**
 * Which build a tab runs, against the one that last saved the player's data. A tab whose build is
 * older than that one is outdated: it would drop what the newer build added when it saved (its
 * sanitize doesn't know it), so it stops saving and taking in changes until it's reloaded.
 */
export class TabBuild {
  readonly run: number
  outdated = false
  private listeners = new Set<() => void>()

  constructor(run: number) {
    this.run = run
    this.check()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get = () => this.outdated

  /** Whether the tab is outdated, finding out if a newer build has saved since it last looked. */
  check(): boolean {
    if (!this.outdated && storedRun() > this.run) {
      this.outdated = true
      for (const listener of this.listeners) listener()
    }
    return this.outdated
  }

  /** Marks the stored data as saved by this build, ahead of the data itself, so other tabs see it first. */
  stamp() {
    if (storedRun() !== this.run) writeText(BUILD_KEY, String(this.run))
  }
}

/** This tab's build. */
export const thisTab = new TabBuild(buildRun)

/** Whether this tab runs an older build than the one that last saved the player's data. */
export const useOutdated = () => useSyncExternalStore(thisTab.subscribe, thisTab.get)

/**
 * A value kept in localStorage under a key, as one tab holds it. It tells what's stored (the
 * text last read or written) from what the tab holds (the sanitized value, as text): the two
 * differ whenever sanitize changes what it reads, and only a change to what the tab holds is
 * saved, so a value taken from another tab is never saved straight back.
 */
export class StoredValue<T> {
  /** The text last read from or written to storage. */
  private stored: string | null
  /** What the tab holds, as text; null when it hasn't been saved (nothing was stored). */
  private held: string | null

  private key: string
  private fresh: () => T
  private sanitize: (v: unknown) => T | undefined
  private tab: TabBuild

  constructor(key: string, fresh: () => T, sanitize: (v: unknown) => T | undefined, tab: TabBuild = thisTab) {
    this.key = key
    this.fresh = fresh
    this.sanitize = sanitize
    this.tab = tab
    this.stored = readText(key)
    this.held = null
  }

  /**
   * The value stored as `text`. The player's data that can't be read, or only in part (a list losing
   * entries it couldn't make sense of), is copied aside first and noted (see `storageIssues`).
   */
  private fromText(text: string | null): T {
    const raw = parse(text)
    const value = raw === undefined ? undefined : this.sanitize(raw)
    if (text && isData(this.key)) {
      const lost = value === undefined || (Array.isArray(raw) && Array.isArray(value) && value.length < raw.length)
      if (lost) {
        rescue(this.key, text)
        storageIssues.set('unreadable', this.key, true)
      }
    }
    return value ?? this.fresh()
  }

  /** The value to start from. Only a value made from nothing stored needs saving. */
  load(): T {
    const value = this.fromText(this.stored)
    if (this.stored !== null) this.held = JSON.stringify(value)
    return value
  }

  /** Saves the value if it changed (false when it can't be: storage full or blocked, or the tab outdated). */
  save(value: T): boolean {
    const text = JSON.stringify(value)
    if (text === this.held) return true
    if (this.tab.check()) return false
    this.tab.stamp()
    const saved = writeText(this.key, text)
    if (isData(this.key)) storageIssues.set('unsaved', this.key, !saved)
    if (!saved) return false
    this.stored = this.held = text
    return true
  }

  /** What another tab stored since, if anything (undefined when nothing changed, or the tab is outdated). */
  pull(): { value: T } | undefined {
    if (this.tab.check()) return undefined
    const text = readText(this.key)
    if (text === this.stored) return undefined
    const value = this.fromText(text)
    // Dropped elsewhere (a deleted plan's folds, say) included: start over without storing it again.
    this.stored = text
    this.held = JSON.stringify(value)
    return { value }
  }
}

/**
 * useState that survives reloads via localStorage. `sanitize` checks what was stored (it may be
 * from an older version, or edited by hand) and returns undefined to start from `initial` instead.
 *
 * Other tabs of the app share the stored value: a change in one shows up in the rest, as it
 * happens and again whenever a tab comes back into view. `perTab` values (what a tab is looking
 * at, rather than the player's data) are only read when the tab opens, so each tab keeps its own
 * while the last one changed is what a new tab starts from. `onPull` hears of a value taken from
 * another tab, just before it is. A tab running an older build than the one that last saved
 * stops saving and taking in changes (see `TabBuild`).
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  sanitize: (v: unknown) => T | undefined,
  { perTab = false, onPull }: { perTab?: boolean; onPull?: () => void } = {},
) {
  const [stored] = useState(
    () => new StoredValue(key, () => (typeof initial === 'function' ? (initial as () => T)() : initial), sanitize),
  )
  const [value, setValue] = useState<T>(() => stored.load())

  useEffect(() => {
    stored.save(value)
  }, [stored, value])

  const pull = useEffectEvent(() => {
    const next = stored.pull()
    if (!next) return
    onPull?.()
    setValue(next.value)
  })
  useEffect(() => {
    if (perTab) return
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return
      if (e.key === PREFIX + BUILD_KEY) thisTab.check()
      else if (e.key === null || e.key === PREFIX + key) pull()
    }
    // Storage events can be missed by a tab the browser froze or kept for back/forward.
    const onVisible = () => {
      if (document.visibilityState === 'visible') pull()
    }
    addEventListener('storage', onStorage)
    addEventListener('pageshow', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      removeEventListener('storage', onStorage)
      removeEventListener('pageshow', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [key, perTab])

  return [value, setValue] as const
}

/** Drops a value stored by `usePersistentState`. */
export function forget(key: string) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    // Storage blocked: nothing to drop.
  }
}

/** Where a plan's folded production rows are kept. */
export const foldKey = (planId: string) => `tree-collapsed:${planId}`

/** Drops the folded rows of plans other than `keep` (plans deleted, and past undoing). */
export function forgetFolds(keep: Set<string>) {
  // An outdated tab may not know of plans a newer build's tabs made.
  if (thisTab.check()) return
  const fold = PREFIX + foldKey('')
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(fold) && !keep.has(key.slice(fold.length))) localStorage.removeItem(key)
    }
  } catch {
    // Storage blocked: nothing to drop.
  }
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** A new plan; without a name it's named after its targets (see planName.ts). */
export function emptyPlan(name = ''): Plan {
  return { id: newId(), name, targets: [blankTarget()], producers: {}, machines: {}, loopFeedback: true }
}

/**
 * Progress from plans saved when each plan had its own upgrades: the preferred plan's, else the
 * first plan's that has any. Undefined when no plan carries them.
 */
export function legacyProgress(plans: Plan[], preferId?: string): Progress | undefined {
  const from = [plans.find((p) => p.id === preferId), ...plans].find((p) => p && (p.upgrades || p.tier !== undefined))
  return from && { upgrades: from.upgrades ?? {}, tier: from.tier }
}

/** A plan without the upgrades it kept from before they were global. */
export function withoutLegacyProgress(plan: Plan): Plan {
  if (!plan.upgrades && plan.tier === undefined) return plan
  const { upgrades: _upgrades, tier: _tier, ...rest } = plan
  return rest
}

export interface Backup {
  version: 1
  savedRecipes: SavedRecipe[]
  plans: Plan[]
  /** Upgrade levels and research tier (older backups keep them on each plan). */
  progress?: Progress
  /** How the player likes to make items (older backups have none). */
  myDefaults?: MyDefaults
}

function downloadJson(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** Download everything as a JSON file (saved recipes + plans). */
export function useBackup(savedRecipes: SavedRecipe[], plans: Plan[], progress: Progress, myDefaults: MyDefaults) {
  return useCallback(() => {
    const backup: Backup = { version: 1, savedRecipes, plans, progress, myDefaults }
    downloadJson(backup, 'alchemy-calculator')
  }, [savedRecipes, plans, progress, myDefaults])
}

/**
 * Download what storage holds, as is, in the backup layout: for when the app can't start, so
 * nothing is lost by starting over. A key whose text doesn't parse goes in as that text.
 */
export function downloadStoredData() {
  downloadJson(
    {
      version: 1,
      savedRecipes: readRaw('saved-recipes') ?? [],
      plans: readRaw('plans') ?? [],
      progress: readRaw('progress'),
      myDefaults: readRaw('my-defaults'),
      rescued: rescuedData(),
    },
    'alchemy-calculator-rescue',
  )
}

/** Downloads the copies kept of stored data that couldn't be read, as they were stored. */
export function downloadRescued() {
  downloadJson({ rescued: rescuedData() }, 'alchemy-calculator-unreadable')
}

/** Drops the copies kept of stored data that couldn't be read. */
export function discardRescued() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX + RESCUED)) localStorage.removeItem(key)
  } catch {
    // Storage blocked: nothing to drop.
  }
  for (const key of storageIssues.get().unreadable) storageIssues.set('unreadable', key, false)
}

/** Drops everything the app keeps in storage. */
export function clearStoredData() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key)
  } catch {
    // Storage blocked: nothing to drop.
  }
}

/** Reads a backup file, keeping only the parts that fit (see sanitize.ts). */
export async function readBackup(file: File): Promise<Backup> {
  return parseBackup(await file.text())
}

export function parseBackup(text: string): Backup {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not an Alchemy Calculator backup file')
  }
  return sanitizeBackup(parsed)
}

/** A backup's fields, checked as an imported file's are (a shared plan's too). */
export function sanitizeBackup(parsed: unknown): Backup {
  const fields = (parsed ?? {}) as Partial<Record<keyof Backup, unknown>>
  if (!Array.isArray(fields.savedRecipes) || !Array.isArray(fields.plans)) throw new Error('Not an Alchemy Calculator backup file')
  const plans = sanitizePlans(fields.plans, newId) ?? []
  return {
    version: 1,
    savedRecipes: sanitizeSavedRecipes(fields.savedRecipes, newId) ?? [],
    plans: plans.map(withoutLegacyProgress),
    progress: sanitizeProgress(fields.progress) ?? legacyProgress(plans),
    myDefaults: sanitizeMyDefaults(fields.myDefaults),
  }
}
