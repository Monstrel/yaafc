import { useCallback, useEffect, useState } from 'react'
import type { MyDefaults, Plan, SavedRecipe } from './types'

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

export function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function emptyPlan(name = 'New plan'): Plan {
  return { id: newId(), name, targets: [], producers: {}, machines: {}, upgrades: {} }
}

export interface Backup {
  version: 1
  savedRecipes: SavedRecipe[]
  plans: Plan[]
  /** How the player likes to make items (older backups have none). */
  myDefaults?: MyDefaults
}

/** Download everything as a JSON file (saved recipes + plans). */
export function useBackup(savedRecipes: SavedRecipe[], plans: Plan[], myDefaults: MyDefaults) {
  return useCallback(() => {
    const backup: Backup = { version: 1, savedRecipes, plans, myDefaults }
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `alchemy-calculator-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [savedRecipes, plans, myDefaults])
}

export async function readBackup(file: File): Promise<Backup> {
  const parsed = JSON.parse(await file.text()) as Partial<Backup>
  if (!Array.isArray(parsed.savedRecipes) || !Array.isArray(parsed.plans)) throw new Error('Not an Alchemy Calculator backup file')
  return { version: 1, savedRecipes: parsed.savedRecipes, plans: parsed.plans, myDefaults: parsed.myDefaults }
}
