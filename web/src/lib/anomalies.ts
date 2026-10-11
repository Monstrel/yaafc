import { coinValue } from './gameData'
import { ledgers } from './ledger'
import { moneyLedger } from './money'
import type { PlanResult } from './solver'
import type { TreeNode } from './tree'
import type { Plan } from './types'

/**
 * Kinds of thing a solved plan shouldn't show: what's left of the solver's room passing for part of
 * the plan, and rows laid out before solving that the solve doesn't run.
 */
export type AnomalyRule =
  /** A value below zero: every amount the solve finds is at least 0. */
  | 'negative'
  /** A row shown at a rate the solver's room could account for. */
  | 'noise-row'
  /** A row making its item on no machines, its ingredients still shown under it. */
  | 'idle-chain'
  /** A row's machines making no more than the solver's room: a whole building for nothing. */
  | 'phantom-building'
  /** An amount (overflow, shortfall, leftovers, an output) the solver's room could account for. */
  | 'noise-amount'
  /** A row gathering an item built separately that nothing running uses. */
  | 'orphan-group'

export interface Anomaly {
  rule: AnomalyRule
  /** Tree row id, or `balance:Item`, `output:Item`, `target:i`, `run:key`. */
  at: string
  detail: string
}

const isPseudo = (item: string) => item.startsWith('@')

/** Items per minute below which an amount within the solver's room is taken for noise. */
const NOISE_FLOOR = 1e-5

/**
 * What a solved plan shows that it shouldn't (see `AnomalyRule`). A diagnostic for tests and for
 * checking exported plans: the planner itself doesn't call it.
 */
export function planAnomalies(plan: Plan, result: PlanResult): Anomaly[] {
  if (result.status !== 'ok') return []
  // The room grows with the size of each pass's result: in a big plan it outgrows real amounts (a
  // fuel burned at 0.0006/min). What's left of it in practice is far smaller than this floor.
  const noise = Math.min(result.noise ?? 0, NOISE_FLOOR)
  const found: Anomaly[] = []
  const add = (rule: AnomalyRule, at: string, detail: string) => found.push({ rule, at, detail })
  /** Above zero, but no more than the room: noise. */
  const tiny = (x: number) => x > 0 && x <= noise
  const amounts = (at: string, values: Record<string, number | undefined>) => {
    for (const [name, x] of Object.entries(values)) {
      if (x === undefined) continue
      if (x < 0) add('negative', at, `${name} ${x}`)
      else if (tiny(x)) add('noise-amount', at, `${name} ${x}`)
    }
  }

  // Coins are worth so much that real amounts of them, and of what they're made from or pay for, can
  // be smaller than the room: rows of them and under them aren't checked against it.
  const visit = (n: TreeNode, root: boolean, coined: boolean) => {
    const exact = coined || coinValue(n.item) !== null
    if (n.rate < 0 || n.machines < 0) add('negative', n.id, `rate ${n.rate}, machines ${n.machines}`)
    else if (!isPseudo(n.item) && !exact && tiny(n.rate)) add('noise-row', n.id, `rate ${n.rate}`)
    const rowAmounts = exact ? () => {} : amounts
    rowAmounts(n.id, {
      overflow: n.overflow,
      shortfall: n.shortfall,
      fromByproduct: n.fromByproduct,
      fromBus: n.fromBus,
      fromRecovery: n.fromRecovery,
    })
    for (const b of n.byproducts) {
      rowAmounts(n.id, { [`${b.item} made`]: b.count, [`${b.item} overflow`]: b.overflow, [`${b.item} to altars`]: b.altar })
      for (const t of b.to) rowAmounts(n.id, { [`${b.item} to ${t.id}`]: t.amount })
    }
    const p = n.run?.process
    if (n.kind === 'produce' && p && p.seconds > 0 && !isPseudo(n.item)) {
      const made = Math.max(0, ...(n.run!.outputs.map((s) => s.count)))
      if (!exact && n.machines > 0 && made <= noise) add('phantom-building', n.id, `${n.machines} machines making ${made}/min at most`)
      const ingredients = n.children.filter((c) => !c.recovery)
      if (n.machines === 0 && n.rate > noise && ingredients.length)
        add('idle-chain', n.id, `rate ${n.rate} on no machines, ${ingredients.length} rows under it`)
    }
    if (n.consolidated && n.rate <= noise && (root || n.id.includes('/with:')))
      add('orphan-group', n.id, `gathers ${n.item} at ${n.rate}/min`)
    n.children.forEach((c) => visit(c, false, exact))
  }
  result.tree.forEach((n) => visit(n, true, false))

  for (const b of result.balances)
    amounts(`balance:${b.item}`, { produced: b.produced, consumed: b.consumed, surplus: b.surplus, deficit: b.deficit, fromBus: b.fromBus, altar: b.altar })
  for (const r of result.runs) if (r.craftsPerMinute < 0 || r.machines < 0) add('negative', `run:${r.key}`, `machines ${r.machines}`)
  result.targets.forEach((t, i) => amounts(`target:${i}`, { rate: t.rate, made: t.made, fedIn: t.fedIn }))
  for (const o of moneyLedger(plan, result, ledgers(plan, result)).outputs) {
    amounts(`output:${o.item}`, { out: o.toBus, altar: o.altar })
    for (const s of o.sources)
      amounts(`output:${o.item}`, { [`${s.target ?? 'overflow'} amount`]: s.amount, [`${s.target ?? 'overflow'} used`]: (s.used.plan ?? 0) + (s.used.money ?? 0) })
  }
  return found
}
