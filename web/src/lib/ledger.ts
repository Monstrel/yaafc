import { coinValue } from './gameData'
import type { PlanResult } from './solver'
import type { TreeNode } from './tree'
import type { Plan, PlanTarget } from './types'

/** What a row takes an item from the bus for: to burn for heat, to spread for nurseries, or as an ingredient. */
export type DrawUse = 'burn' | 'spread' | 'use'

/** Something the plan delivers that could cover what its rows take from the bus: a target, or overflow. */
export interface LedgerSource {
  item: string
  /** Index in the plan's targets; null for overflow (made, but nothing in the plan uses it). */
  target: number | null
  /** Items per minute it makes (a net-surplus target: its rate plus what the plan takes of it). */
  amount: number
  fedBack: boolean
  /** Items per minute of it the plan uses in place of the bus (0 unless fed back). */
  used: number
}

/** One item the plan's rows take from the bus, and how much of that its own output covers. */
export interface ItemLedger {
  item: string
  /** Items per minute the plan's rows take from the bus, before its own output covers any. */
  need: number
  /** What for, per minute. */
  uses: Partial<Record<DrawUse, number>>
  /** The rows taking it, biggest first. */
  rows: string[]
  /** What the plan delivers of it, in the order it covers the need: overflow, then targets in order. */
  sources: LedgerSource[]
  /** Part of the need its own output covers, per minute. */
  covered: number
  /** Items per minute everything the plan feeds back of it holds, used or not. */
  made: number
  /** The net-surplus target (index in the plan's targets) covering what's left, instead of the bus; null when the bus does. */
  absorbedBy: number | null
  /** Items per minute still taken from the bus. */
  bus: number
  /** Items per minute nothing covers (a net-surplus target whose own chain uses more than it gives). */
  short: number
}

/** Whether every source of an item is fed back, unless a target says otherwise. */
export const itemFedBack = (plan: Plan, item: string) => !!plan.feedbackItems?.includes(item)

export const targetFedBack = (plan: Plan, t: PlanTarget) => t.feedback ?? itemFedBack(plan, t.item)

/** Coins are money: what the plan makes of them covers its spending at face value (see money.ts). */
const isMoney = (item: string) => coinValue(item) !== null

/**
 * Per item, the net-surplus target (index in the plan's targets) that covers what's left of what
 * the plan's rows take of it from the bus: the first one in the plan's order that's fed back.
 */
export function absorbers(plan: Plan): Map<string, number> {
  const found = new Map<string, number>()
  plan.targets.forEach((t, i) => {
    if (t.item && t.unit === 'net' && !isMoney(t.item) && targetFedBack(plan, t) && !found.has(t.item)) found.set(t.item, i)
  })
  return found
}

/** Per item, what the plan's rows take of it from the bus, what for, and which rows. */
export function busDraws(tree: TreeNode[]): Map<string, { need: number; uses: Partial<Record<DrawUse, number>>; rows: TreeNode[] }> {
  const found = new Map<string, { need: number; uses: Partial<Record<DrawUse, number>>; rows: TreeNode[] }>()
  const visit = (n: TreeNode, parent?: TreeNode) => {
    if (n.fromBus > 0) {
      const d = found.get(n.item) ?? { need: 0, uses: {}, rows: [] }
      const kind = parent?.run?.process.kind
      const use: DrawUse = kind === 'fuel' ? 'burn' : kind === 'fertilizer' ? 'spread' : 'use'
      d.need += n.fromBus
      d.uses[use] = (d.uses[use] ?? 0) + n.fromBus
      d.rows.push(n)
      found.set(n.item, d)
    }
    for (const c of n.children) visit(c, n)
  }
  tree.forEach((n) => visit(n))
  return found
}

/**
 * Per item the plan's rows take from the bus (coins aside: they're money), how its own output
 * covers that. Fed-back sources cover it in order: overflow, then targets in the plan's order. A
 * net-surplus target there covers all that's left (the solve made its row big enough); otherwise
 * the bus does.
 */
export function ledgers(plan: Plan, result: PlanResult): ItemLedger[] {
  const absorbing = absorbers(plan)
  // result.targets skips targets with no item yet.
  let resolved = 0
  const made = plan.targets.map((t) => (t.item ? (result.targets[resolved++]?.made ?? 0) : 0))

  return [...busDraws(result.tree)]
    .filter(([item]) => !isMoney(item))
    .map(([item, draws]) => {
      const sources: LedgerSource[] = []
      const surplus = result.balances.find((b) => b.item === item)?.surplus ?? 0
      if (surplus > 0) sources.push({ item, target: null, amount: surplus, fedBack: itemFedBack(plan, item), used: 0 })
      plan.targets.forEach((t, i) => {
        if (t.item === item && made[i] > 0) sources.push({ item, target: i, amount: made[i], fedBack: targetFedBack(plan, t), used: 0 })
      })
      let remaining = draws.need
      for (const s of sources)
        if (s.fedBack && remaining > 0) {
          s.used = Math.min(s.amount, remaining)
          remaining -= s.used
        }
      if (remaining < draws.need * 1e-9) remaining = 0
      const absorbedBy = absorbing.get(item) ?? null
      return {
        item,
        need: draws.need,
        uses: draws.uses,
        rows: [...draws.rows].sort((a, b) => b.fromBus - a.fromBus).map((n) => n.id),
        sources,
        covered: draws.need - remaining,
        made: sources.reduce((t, s) => t + (s.fedBack ? s.amount : 0), 0),
        absorbedBy,
        bus: absorbedBy === null ? remaining : 0,
        short: absorbedBy === null ? 0 : remaining,
      }
    })
}

/**
 * Per item a net-surplus target covers, what the fed-back sources ahead of it can supply (all
 * they have, not just what's needed), per minute.
 */
export function supplyAhead(plan: Plan, result: PlanResult): Map<string, number> {
  const ahead = new Map<string, number>()
  for (const l of ledgers(plan, result)) {
    if (l.absorbedBy === null) continue
    const by = l.absorbedBy
    ahead.set(
      l.item,
      l.sources.reduce((t, s) => t + (s.fedBack && (s.target === null || s.target < by) ? s.amount : 0), 0),
    )
  }
  return ahead
}
