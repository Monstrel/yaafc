import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { sanitizeMyDefaults, sanitizePlans, sanitizeProgress, sanitizeSavedRecipes } from './sanitize'
import { blankTarget, type MyDefaults, type Plan, type Progress, type SavedRecipe } from './types'

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

/** What a key holds, parsed but unchecked (undefined when missing or unreadable). */
function readRaw(key: string): unknown {
  return parse(readText(key))
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

/**
 * useState that survives reloads via localStorage. `sanitize` checks what was stored (it may be
 * from an older version, or edited by hand) and returns undefined to start from `initial` instead.
 *
 * Other tabs of the app share the stored value: a change in one shows up in the rest, as it
 * happens and again whenever a tab comes back into view. `perTab` values (what a tab is looking
 * at, rather than the player's data) are only read when the tab opens, so each tab keeps its own
 * while the last one changed is what a new tab starts from. `onPull` hears of a value taken from
 * another tab, just before it is.
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  sanitize: (v: unknown) => T | undefined,
  { perTab = false, onPull }: { perTab?: boolean; onPull?: () => void } = {},
) {
  const fresh = () => (typeof initial === 'function' ? (initial as () => T)() : initial)
  const fromText = (text: string | null) => {
    const raw = parse(text)
    return raw === undefined ? fresh() : (sanitize(raw) ?? fresh())
  }
  // The stored text this tab's value came from or was last saved as, so a value taken from
  // another tab isn't saved straight back, and a re-read that finds nothing new changes nothing.
  const synced = useRef<string | null>(null)
  const [value, setValue] = useState<T>(() => fromText(readText(key)))

  useEffect(() => {
    const text = JSON.stringify(value)
    if (text !== synced.current && writeText(key, text)) synced.current = text
  }, [key, value])

  const pull = useEffectEvent(() => {
    const text = readText(key)
    if (text === synced.current) return
    const next = fromText(text)
    // Dropped elsewhere (a deleted plan's folds, say): start over without storing it again.
    synced.current = text ?? JSON.stringify(next)
    onPull?.()
    setValue(next)
  })
  useEffect(() => {
    if (perTab) return
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea === localStorage && (e.key === null || e.key === PREFIX + key)) pull()
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
  return { id: newId(), name, targets: [blankTarget()], producers: {}, machines: {} }
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
 * nothing is lost by starting over.
 */
export function downloadStoredData() {
  downloadJson(
    {
      version: 1,
      savedRecipes: readRaw('saved-recipes') ?? [],
      plans: readRaw('plans') ?? [],
      progress: readRaw('progress'),
      myDefaults: readRaw('my-defaults'),
    },
    'alchemy-calculator-rescue',
  )
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
