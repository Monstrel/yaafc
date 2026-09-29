import { realItem } from './gameData'
import type { PlanResult } from './solver'
import type { Plan } from './types'

/** One use of a bus item: burning it for heat, or spreading it as fertilizer. */
export interface BusUse {
  kind: 'fuel' | 'fertilizer'
  /** Items per minute this use draws from the bus. */
  need: number
  /** Heat (P/s) or nutrients (/s) that amount supplies. */
  supplies: number
  /** Whether the plan's own output of the item is fed back for this use. */
  feedback: boolean
}

/**
 * One item drawn from the factory bus. An item can serve both uses (Panacea Potion is fuel and
 * fertilizer), so uses are merged per item: the plan's output of it must only be counted once.
 */
export interface BusLine {
  item: string
  uses: BusUse[]
  /** Total items per minute drawn from the bus. */
  need: number
  /** Part of the need that uses with feedback want covered by the plan's output. */
  fedBackNeed: number
  /** Part of the need that's simply taken from the bus (no feedback). */
  boughtNeed: number
  /** How much of this item the plan delivers (target + surplus), per minute. */
  planMakes: number
  /** With feedback on any use: planMakes − fedBackNeed (negative = shortfall). */
  net: number | null
}

export function busLines(plan: Plan, result: PlanResult): BusLine[] {
  const lines = new Map<string, BusLine>()
  for (const run of result.runs) {
    const kind = run.process.kind
    if (kind !== 'fuel' && kind !== 'fertilizer') continue
    const input = run.inputs[0]
    if (!input) continue
    const item = realItem(input.item)
    const feedback = !!plan.feedback?.[kind]
    let line = lines.get(item)
    if (!line) {
      const balance = result.balances.find((b) => b.item === item)
      line = {
        item,
        uses: [],
        need: 0,
        fedBackNeed: 0,
        boughtNeed: 0,
        planMakes: (balance?.target ?? 0) + (balance?.surplus ?? 0),
        net: null,
      }
      lines.set(item, line)
    }
    line.uses.push({ kind, need: input.count, supplies: (run.outputs[0]?.count ?? 0) / 60, feedback })
    line.need += input.count
    if (feedback) line.fedBackNeed += input.count
    else line.boughtNeed += input.count
  }
  for (const line of lines.values())
    if (line.uses.some((u) => u.feedback)) line.net = line.planMakes - line.fedBackNeed
  return [...lines.values()]
}
