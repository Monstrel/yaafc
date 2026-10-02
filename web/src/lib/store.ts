import { useCallback, useEffect, useState } from 'react'
import { sanitizeMyDefaults, sanitizePlans, sanitizeProgress, sanitizeSavedRecipes } from './sanitize'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './types'

const PREFIX = 'alchemy-calculator:'

/** What a key holds, parsed but unchecked (undefined when missing or unreadable). */
function readRaw(key: string): unknown {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function read<T>(key: string, fallback: T, sanitize: (v: unknown) => T | undefined): T {
  const raw = readRaw(key)
  return raw === undefined ? fallback : (sanitize(raw) ?? fallback)
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: keep working in memory.
  }
}

/**
 * useState that survives reloads via localStorage. `sanitize` checks what was stored (it may be
 * from an older version, or edited by hand) and returns undefined to start from `initial` instead.
 */
export function usePersistentState<T>(key: string, initial: T | (() => T), sanitize: (v: unknown) => T | undefined) {
  const [value, setValue] = useState<T>(() =>
    read(key, typeof initial === 'function' ? (initial as () => T)() : initial, sanitize),
  )
  useEffect(() => write(key, value), [key, value])
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

export function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function emptyPlan(name = 'New plan'): Plan {
  return { id: newId(), name, targets: [], producers: {}, machines: {} }
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
