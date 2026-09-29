import { useMemo } from 'react'
import { NUTRIENTS } from './gameData'
import { buildCatalog } from './processes'
import { solvePlan } from './solver'
import type { Plan, SavedRecipe } from './types'
import { modifiers } from './upgrades'

/** Upgrades, process catalog and solved result for a plan, recomputed only when inputs change. */
export function usePlanModel(plan: Plan, saved: SavedRecipe[]) {
  const mods = useMemo(() => modifiers(plan.upgrades, plan.coinStack), [plan.upgrades, plan.coinStack])
  const fertChoice = plan.producers[NUTRIENTS]
  const fertilizer = fertChoice?.startsWith('fert:') ? fertChoice.slice(5) : 'BasicFertilizer'
  const catalog = useMemo(
    () => buildCatalog({ saved, machines: plan.machines, mods, fertilizer, catalysts: plan.catalysts }),
    [saved, plan.machines, mods, fertilizer, plan.catalysts],
  )
  const result = useMemo(() => solvePlan(plan, catalog, mods), [plan, catalog, mods])
  return { mods, catalog, result }
}
