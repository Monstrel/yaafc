import { useCallback, useEffect, useState } from 'react'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './types'

const PREFIX = 'alchemy-calculator:'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: keep working in memory.
  }
}

/** useState that survives reloads via localStorage. */
export function usePersistentState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => read(key, typeof initial === 'function' ? (initial as () => T)() : initial))
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

/** Download everything as a JSON file (saved recipes + plans). */
export function useBackup(savedRecipes: SavedRecipe[], plans: Plan[], progress: Progress, myDefaults: MyDefaults) {
  return useCallback(() => {
    const backup: Backup = { version: 1, savedRecipes, plans, progress, myDefaults }
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `alchemy-calculator-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [savedRecipes, plans, progress, myDefaults])
}

export async function readBackup(file: File): Promise<Backup> {
  const parsed = JSON.parse(await file.text()) as Partial<Backup>
  if (!Array.isArray(parsed.savedRecipes) || !Array.isArray(parsed.plans)) throw new Error('Not an Alchemy Calculator backup file')
  return {
    version: 1,
    savedRecipes: parsed.savedRecipes,
    plans: parsed.plans.map(withoutLegacyProgress),
    progress: parsed.progress ?? legacyProgress(parsed.plans),
    myDefaults: parsed.myDefaults,
  }
}
