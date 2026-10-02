import { HEAT, NUTRIENTS, realItem } from './gameData'
import type { ProcessCatalog } from './processes'
import type { PlanResult } from './solver'
import type { Plan, PlanTarget } from './types'
import { planProducer } from './unfold'

/** A bus resource the plan draws on: heat for its machines, nutrients for its nurseries. */
export type Resource = 'heat' | 'fertilizer'

export const PSEUDO: Record<Resource, string> = { heat: HEAT, fertilizer: NUTRIENTS }

/** Something the plan delivers that could cover a resource: a target, or overflow. */
export interface LedgerSource {
  item: string
  /** Index in the plan's targets; null for overflow (made, but nothing in the plan uses it). */
  target: number | null
  /** Items per minute it makes (a net-surplus target: its rate plus what the plan uses of it). */
  amount: number
  /** Heat (P) or nutrients one item supplies. */
  per: number
  fedBack: boolean
  /** Items per minute of it left for this resource (fertilizer takes its share first). */
  available: number
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
  /**
   * Heat or nutrients per minute everything the plan feeds back holds, used or not: with `need`,
   * the plan's own balance (made − need: positive when it makes more than it uses).
   */
  made: number
  /**
   * The net-surplus target (index in the plan's targets) that covers what's left of the need,
   * instead of the bus; null when the bus does.
   */
  absorbedBy: number | null
  /** The bus item covering the rest (null: nothing picked, or a target covers it), and how many per minute. */
  bus: { item: string; per: number; count: number } | null
  /** Heat or nutrients per minute nothing covers (a net-surplus target that can't keep up). */
  short: number
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
 * Per resource, the net-surplus target that covers what's left of the plan's need: the first one
 * in the plan's order that's fed back and can (a fuel for heat, the nurseries' fertilizer).
 */
export function absorbers(plan: Plan, catalog: ProcessCatalog): Map<Resource, { target: number; item: string }> {
  const found = new Map<Resource, { target: number; item: string }>()
  for (const resource of ['fertilizer', 'heat'] as const) {
    const per = carriers(plan, catalog, resource)
    const target = plan.targets.findIndex((t) => t.item && t.unit === 'net' && per.has(t.item) && targetFedBack(plan, t))
    if (target >= 0) found.set(resource, { target, item: plan.targets[target].item })
  }
  return found
}

/**
 * How the plan's heat and fertilizer needs are met. Fed-back sources cover the need in order:
 * overflow, then targets in the plan's order. A net-surplus target there covers all that's left
 * (the solve made its row big enough); otherwise the bus does. Fertilizer goes first, since only
 * one item can cover it; an item that's both (Panacea Potion) burns what's left.
 */
export function ledgers(plan: Plan, catalog: ProcessCatalog, result: PlanResult): ResourceLedger[] {
  const balance = (item: string) => result.balances.find((b) => b.item === item)
  // What's still available of each source after earlier resources took their share.
  const left = new Map<string, number>()
  const sourceKey = (s: { item: string; target: number | null }) => `${s.target ?? 'overflow'}:${s.item}`
  const absorbing = absorbers(plan, catalog)

  // result.targets skips targets with no item yet.
  let resolved = 0
  const made = plan.targets.map((t) => (t.item ? (result.targets[resolved++]?.made ?? 0) : 0))

  return (['fertilizer', 'heat'] as const).map((resource) => {
    const per = carriers(plan, catalog, resource)
    const need = balance(PSEUDO[resource])?.consumed ?? 0
    const sources: LedgerSource[] = []
    const overflow = result.balances.filter((b) => b.surplus > 0 && per.has(b.item))
    for (const b of overflow)
      sources.push({ item: b.item, target: null, amount: b.surplus, per: per.get(b.item)!, fedBack: itemFedBack(plan, b.item), available: 0, used: 0 })
    plan.targets.forEach((t, i) => {
      if (t.item && per.has(t.item) && made[i] > 0)
        sources.push({ item: t.item, target: i, amount: made[i], per: per.get(t.item)!, fedBack: targetFedBack(plan, t), available: 0, used: 0 })
    })

    let remaining = need
    for (const s of sources) {
      const available = left.get(sourceKey(s)) ?? s.amount
      s.available = available
      if (s.fedBack && s.per > 0 && remaining > 0) {
        s.used = Math.min(available, remaining / s.per)
        remaining -= s.used * s.per
      }
      left.set(sourceKey(s), available - s.used)
    }
    if (remaining < need * 1e-9) remaining = 0

    const absorbedBy = absorbing.get(resource)?.target ?? null
    const busProcess = catalog.byId.get(planProducer(plan, catalog, PSEUDO[resource]))
    const busItem = busProcess?.inputs[0]?.item
    const busPer = busProcess?.outputs[0]?.count ?? 0
    const bus =
      absorbedBy === null && busItem && busPer > 0 ? { item: realItem(busItem), per: busPer, count: remaining / busPer } : null
    const held = sources.reduce((t, s) => t + (s.fedBack ? s.available * s.per : 0), 0)
    return { resource, need, sources, covered: need - remaining, made: held, absorbedBy, bus, short: bus ? 0 : remaining }
  })
}

/**
 * Per resource, the heat or nutrients per minute the fed-back sources ahead of its net-surplus
 * target can supply (all they have, not just what's needed), after fertilizer took its share.
 */
export function supplyAhead(plan: Plan, catalog: ProcessCatalog, result: PlanResult): Record<Resource, number> {
  const ahead: Record<Resource, number> = { heat: 0, fertilizer: 0 }
  const taken = new Map<string, number>()
  for (const l of ledgers(plan, catalog, result)) {
    for (const s of l.sources) {
      const key = `${s.target ?? 'overflow'}:${s.item}`
      const isAhead = l.absorbedBy !== null && (s.target === null || s.target < l.absorbedBy)
      if (s.fedBack && isAhead) ahead[l.resource] += (s.amount - (taken.get(key) ?? 0)) * s.per
      taken.set(key, (taken.get(key) ?? 0) + s.used)
    }
  }
  return ahead
}

/**
 * Per item, the share of its overflow the plan feeds back into its own heat or fertilizer, and
 * what into: that part isn't overflow, since the plan burns or spreads it.
 */
export function fedOverflow(ledgers: ResourceLedger[]): Map<string, { share: number; into: Resource[] }> {
  const fed = new Map<string, { share: number; into: Resource[] }>()
  for (const l of ledgers)
    for (const s of l.sources) {
      if (s.target !== null || s.used <= 0 || s.amount <= 0) continue
      const f = fed.get(s.item) ?? { share: 0, into: [] }
      fed.set(s.item, { share: Math.min(1, f.share + s.used / s.amount), into: [...f.into, l.resource] })
    }
  return fed
}
