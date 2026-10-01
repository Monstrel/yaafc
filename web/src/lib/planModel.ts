import { startTransition, useEffect, useMemo, useState } from 'react'
import { NUTRIENTS } from './gameData'
import { buildCatalog, type ProcessCatalog, type ProcessContext } from './processes'
import type { SolveRequest } from './solve.worker'
import type { PlanResult } from './solver'
import type { MyDefaults, Plan, SavedRecipe } from './types'
import { modifiers, type Modifiers } from './upgrades'

let worker: Worker | undefined
let running = false
let waiting: { request: SolveRequest; resolve: (r: PlanResult | null) => void } | undefined

/**
 * Solves a plan in a worker, so the page stays responsive while it runs. One solve runs at a time
 * and only the newest request waits behind it: dragging a slider skips the steps in between, each
 * resolving null.
 */
function solveInWorker(request: SolveRequest): Promise<PlanResult | null> {
  return new Promise((resolve) => {
    waiting?.resolve(null)
    waiting = { request, resolve }
    next()
  })
}

function next() {
  if (running || !waiting) return
  const { request, resolve } = waiting
  waiting = undefined
  running = true
  worker ??= new Worker(new URL('./solve.worker.ts', import.meta.url), { type: 'module' })
  const done = (result: PlanResult) => {
    running = false
    resolve(result)
    next()
  }
  worker.onmessage = (e: MessageEvent<PlanResult>) => done(e.data)
  worker.onerror = (e) => {
    // The worker didn't load (or the solver failed to start): start a fresh one next time.
    worker?.terminate()
    worker = undefined
    done({ status: 'error', message: e.message || 'The solver failed to start', targets: [], runs: [], balances: [], tree: [] })
  }
  worker.postMessage(request)
}

export interface PlanModel {
  mods: Modifiers
  catalog: ProcessCatalog
  result: PlanResult | null
}

/**
 * Upgrades and process catalog for a plan, recomputed only when inputs change, and its solved
 * result: the newest one back from the solver, or null until the first one for this plan is.
 */
export function usePlanModel(plan: Plan, saved: SavedRecipe[], mine: MyDefaults): PlanModel {
  const mods = useMemo(() => modifiers(plan.upgrades, plan.coinStack), [plan.upgrades, plan.coinStack])
  const fertChoice = plan.producers[NUTRIENTS]
  const fertilizer = fertChoice?.startsWith('fert:') ? fertChoice.slice(5) : 'BasicFertilizer'
  const context = useMemo<ProcessContext>(
    () => ({ saved, machines: plan.machines, mods, fertilizer, tier: plan.tier, mine }),
    [saved, plan.machines, mods, fertilizer, plan.tier, mine],
  )
  const catalog = useMemo(() => buildCatalog(context), [context])

  const [solved, setSolved] = useState<{ planId: string; result: PlanResult } | null>(null)
  useEffect(() => {
    void solveInWorker({ plan, context }).then((result) => {
      // Re-rendering a big tree takes a while: as a transition, React can interrupt it for input.
      if (result) startTransition(() => setSolved({ planId: plan.id, result }))
    })
  }, [plan, context])
  const result = solved?.planId === plan.id ? solved.result : null
  return { mods, catalog, result }
}
