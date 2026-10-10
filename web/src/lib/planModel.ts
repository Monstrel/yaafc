import { startTransition, useEffect, useMemo, useState } from 'react'
import { MAX_TIER, NUTRIENTS } from './gameData'
import { summarizePlan, type PlanSummary } from './planSummary'
import { buildCatalog, type ProcessCatalog, type ProcessContext } from './processes'
import type { SolveRequest } from './solve.worker'
import type { PlanResult } from './solver'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './types'
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

/** The fertilizer feeding a plan's nurseries. */
export function planFertilizer(plan: Plan): string {
  const choice = plan.producers[NUTRIENTS]
  return choice?.startsWith('fert:') ? choice.slice(5) : 'BasicFertilizer'
}

/** Whether two plans hold the same values in every field (plans change by copying, so a changed field is a new value). */
function sameFields(a: Plan, b: Plan): boolean {
  const keys = Object.keys(a) as (keyof Plan)[]
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
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
export function usePlanModel(plan: Plan, progress: Progress, saved: SavedRecipe[], mine: MyDefaults): PlanModel {
  const mods = useMemo(() => modifiers(progress.upgrades), [progress.upgrades])
  const fertilizer = planFertilizer(plan)
  const context = useMemo<ProcessContext>(
    () => ({ saved, machines: plan.machines, mods, fertilizer, tier: progress.tier, mine }),
    [saved, plan.machines, mods, fertilizer, progress.tier, mine],
  )
  const catalog = useMemo(() => buildCatalog(context), [context])

  // Built marks change nothing the plan makes: ticking them off doesn't solve the plan again.
  const { built: _, ...solving } = plan
  const [toSolve, setToSolve] = useState<Plan>(solving)
  if (!sameFields(toSolve, solving)) setToSolve(solving)

  const [solved, setSolved] = useState<{ planId: string; result: PlanResult } | null>(null)
  useEffect(() => {
    void solveInWorker({ plan: toSolve, context }).then((result) => {
      // Re-rendering a big tree takes a while: as a transition, React can interrupt it for input.
      if (result) startTransition(() => setSolved({ planId: toSolve.id, result }))
    })
  }, [toSolve, context])
  const result = solved?.planId === plan.id ? solved.result : null
  return { mods, catalog, result }
}

// The overview's solves queue in a worker of their own: unlike the open plan's, none may be skipped.
let summaryWorker: Worker | undefined
let summaryQueue: Promise<unknown> = Promise.resolve()

function summarizeInWorker(request: SolveRequest): Promise<PlanSummary> {
  const run = summaryQueue.then(
    () =>
      new Promise<PlanSummary>((resolve) => {
        summaryWorker ??= new Worker(new URL('./solve.worker.ts', import.meta.url), { type: 'module' })
        summaryWorker.onmessage = (e: MessageEvent<PlanSummary>) => resolve(e.data)
        summaryWorker.onerror = (e) => {
          // The worker didn't load (or the solver failed to start): start a fresh one next time.
          summaryWorker?.terminate()
          summaryWorker = undefined
          const message = e.message || 'The solver failed to start'
          const failed: PlanResult = { status: 'error', message, targets: [], runs: [], balances: [], tree: [] }
          resolve(summarizePlan(request.plan, failed, request.context.mods, request.context.tier ?? MAX_TIER))
        }
        summaryWorker.postMessage({ ...request, summarize: true } satisfies SolveRequest)
      }),
  )
  summaryQueue = run
  return run
}

/** Summaries worked out so far, per plan id, with what they were worked out from: kept while the overview is closed. */
const summaries = new Map<string, { key: string; summary: PlanSummary }>()

/** A plan's summary, and whether it's still for the plan as it is (else a newer one is on its way). */
export interface SummaryState {
  summary: PlanSummary
  current: boolean
}

/**
 * Every plan's summary (see planSummary.ts), solved one at a time in the background: the open
 * plan first, then the rest in order. Plans that haven't changed since they were last summarized
 * aren't solved again. A plan missing from the map hasn't been summarized yet.
 */
export function usePlanSummaries(
  plans: Plan[],
  openId: string,
  progress: Progress,
  saved: SavedRecipe[],
  mine: MyDefaults,
): Map<string, SummaryState> {
  const mods = useMemo(() => modifiers(progress.upgrades), [progress.upgrades])
  // Upgrades, saved recipes and defaults change every plan's catalog.
  const shared = useMemo(() => JSON.stringify([progress, saved, mine]), [progress, saved, mine])
  const jobs = useMemo(
    () =>
      plans.map((p) => {
        // Built marks change nothing the plan makes.
        const { built: _, ...plan } = p
        return { plan, key: shared + JSON.stringify(plan) }
      }),
    [plans, shared],
  )
  const [, setDone] = useState(0)
  useEffect(() => {
    const ids = new Set(jobs.map((j) => j.plan.id))
    for (const id of summaries.keys()) if (!ids.has(id)) summaries.delete(id)
    let stopped = false
    const order = [...jobs.filter((j) => j.plan.id === openId), ...jobs.filter((j) => j.plan.id !== openId)]
    void (async () => {
      for (const { plan, key } of order) {
        if (stopped) return
        if (summaries.get(plan.id)?.key === key) continue
        const context = { saved, machines: plan.machines, mods, fertilizer: planFertilizer(plan), tier: progress.tier, mine }
        const summary = await summarizeInWorker({ plan, context })
        summaries.set(plan.id, { key, summary })
        if (!stopped) setDone((n) => n + 1)
      }
    })()
    return () => {
      stopped = true
    }
  }, [jobs, openId, saved, mods, progress.tier, mine])
  const states = new Map<string, SummaryState>()
  for (const { plan, key } of jobs) {
    const s = summaries.get(plan.id)
    if (s) states.set(plan.id, { summary: s.summary, current: s.key === key })
  }
  return states
}
