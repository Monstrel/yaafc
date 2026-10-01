import { buildCatalog, type ProcessContext } from './processes'
import type { PlanResult } from './solver'
import type { Plan } from './types'

/** A plan to solve, with what its process catalog is built from. */
export interface SolveRequest {
  plan: Plan
  context: ProcessContext
}

// HiGHS loads with a top-level await: imported statically, this worker would only start listening
// once it had, and the page's first request would be lost.
const solver = import('./solver')

/** Solves plans off the page's thread: HiGHS takes ~40 ms on a plan the size of Sol's. */
self.onmessage = async ({ data: { plan, context } }: MessageEvent<SolveRequest>) => {
  let result: PlanResult
  try {
    const { solvePlan } = await solver
    result = solvePlan(plan, buildCatalog(context), context.mods)
  } catch (e) {
    result = { status: 'error', message: String(e), targets: [], runs: [], balances: [], tree: [] }
  }
  postMessage(result)
}
