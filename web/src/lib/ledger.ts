import { HEAT, NUTRIENTS, realItem } from './gameData'
import type { ProcessCatalog } from './processes'
import type { PlanResult } from './solver'
import type { Plan, PlanTarget } from './types'
import { planProducer } from './unfold'

/** A bus resource the plan draws on: heat for its machines, nutrients for its nurseries. */
export type Resource = 'heat' | 'fertilizer'

const PSEUDO: Record<Resource, string> = { heat: HEAT, fertilizer: NUTRIENTS }

/** Something the plan delivers that could cover a resource: a target, or overflow. */
export interface LedgerSource {
  item: string
  /** Index in the plan's targets; null for overflow (made, but nothing in the plan uses it). */
  target: number | null
  /** Items per minute it delivers. */
  amount: number
  /** Heat (P) or nutrients one item supplies. */
  per: number
  fedBack: boolean
  /** Items per minute the plan burns or spreads of it (0 unless fed back). */
  used: number
}

export interface ResourceLedger {
  resource: Resource
  /** Heat (P) or nutrients per minute the plan's machines use. */
  need: number
  /** Fuel or fertilizer items the plan delivers that could cover it, in burn order. */
  sources: LedgerSource[]
  /** Part of the need its own output covers, per minute. */
  covered: number
  /** The bus item covering the rest (null: nothing picked), and how many per minute. */
  bus: { item: string; per: number; count: number } | null
}

/** Whether every source of an item is fed back, unless a target says otherwise. */
export const itemFedBack = (plan: Plan, item: string) => !!plan.feedbackItems?.includes(item)

export const targetFedBack = (plan: Plan, t: PlanTarget) => t.feedback ?? itemFedBack(plan, t.item)

/** Heat or nutrients one of each item supplies: any fuel for heat, only the nurseries' fertilizer. */
export function carriers(plan: Plan, catalog: ProcessCatalog, resource: Resource): Map<string, number> {
  const per = new Map<string, number>()
  const add = (id: string | undefined) => {
    const p = id ? catalog.byId.get(id) : undefined
    const item = p?.inputs[0]?.item
    if (item) per.set(realItem(item), p.outputs[0]?.count ?? 0)
  }
  if (resource === 'heat') for (const p of catalog.byProduct.get(HEAT) ?? []) add(p.id)
  else add(planProducer(plan, catalog, NUTRIENTS))
  return per
}

/**
 * How the plan's heat and fertilizer needs are met. Accounting only: the factory is the same either
 * way. Fed-back sources cover the need in order (overflow first, then targets in the plan's
 * order) and the bus covers the rest. Fertilizer goes first, since only one item can cover it;
 * an item that's both (Panacea Potion) burns what's left.
 */
export function ledgers(plan: Plan, catalog: ProcessCatalog, result: PlanResult): ResourceLedger[] {
  const balance = (item: string) => result.balances.find((b) => b.item === item)
  // What's still available of each source after earlier resources took their share.
  const left = new Map<string, number>()
  const sourceKey = (s: { item: string; target: number | null }) => `${s.target ?? 'overflow'}:${s.item}`

  // result.targets skips targets with no item yet.
  let resolved = 0
  const targetRates = plan.targets.map((t) => (t.item ? (result.targets[resolved++]?.rate ?? 0) : 0))

  return (['fertilizer', 'heat'] as const).map((resource) => {
    const per = carriers(plan, catalog, resource)
    const need = balance(PSEUDO[resource])?.consumed ?? 0
    const sources: LedgerSource[] = []
    const overflow = new Set(result.balances.filter((b) => b.surplus > 0 && per.has(b.item)).map((b) => b.item))
    for (const item of overflow)
      sources.push({ item, target: null, amount: balance(item)!.surplus, per: per.get(item)!, fedBack: itemFedBack(plan, item), used: 0 })
    plan.targets.forEach((t, i) => {
      if (t.item && per.has(t.item) && targetRates[i] > 0)
        sources.push({ item: t.item, target: i, amount: targetRates[i], per: per.get(t.item)!, fedBack: targetFedBack(plan, t), used: 0 })
    })

    let remaining = need
    for (const s of sources) {
      const available = left.get(sourceKey(s)) ?? s.amount
      if (s.fedBack && s.per > 0 && remaining > 0) {
        s.used = Math.min(available, remaining / s.per)
        remaining -= s.used * s.per
      }
      left.set(sourceKey(s), available - s.used)
    }
    if (remaining < need * 1e-9) remaining = 0

    const busProcess = catalog.byId.get(planProducer(plan, catalog, PSEUDO[resource]))
    const busItem = busProcess?.inputs[0]?.item
    const busPer = busProcess?.outputs[0]?.count ?? 0
    const bus = busItem && busPer > 0 ? { item: realItem(busItem), per: busPer, count: remaining / busPer } : null
    return { resource, need, sources, covered: need - remaining, bus }
  })
}
