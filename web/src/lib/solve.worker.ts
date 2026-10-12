import { MAX_TIER } from './gameData'
import { buildCatalog, type ProcessContext } from './processes'
import type { PlanSummary } from './planSummary'
import type { PlanResult } from './solver'
import type { Plan } from './types'

/** A plan to solve, with what its process catalog is built from. */
export interface SolveRequest {
  plan: Plan
  context: ProcessContext
  /** Answer with the plan's summary (see planSummary.ts) instead of the whole result. */
  summarize?: boolean
}

// HiGHS loads with a top-level await: imported statically, this worker would only start listening
// once it had, and the page's first request would be lost.
const solver = import('./solver')
const summary = import('./planSummary')

/** Solves plans off the page's thread: HiGHS takes ~40 ms on a plan the size of Sol's. */
self.onmessage = async ({ data: { plan, context, summarize } }: MessageEvent<SolveRequest>) => {
  const failed = (e: unknown): PlanResult => ({ status: 'error', message: String(e), targets: [], runs: [], balances: [], tree: [] })
  let result: PlanResult
  try {
    const { solvePlan } = await solver
    result = solvePlan(plan, buildCatalog(context), context.mods)
  } catch (e) {
    result = failed(e)
  }
  if (!summarize) return postMessage(result)
  // Every request gets an answer: the overview's summaries wait in line for each other.
  const { summarizePlan } = await summary
  const tier = context.tier ?? MAX_TIER
  let out: PlanSummary
  try {
    out = summarizePlan(plan, result, context.mods, tier)
  } catch (e) {
    out = summarizePlan(plan, failed(e), context.mods, tier)
  }
  postMessage(out)
}
