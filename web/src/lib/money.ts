import { coinValue, itemsByKey } from './gameData'
import { carriers, itemFedBack, targetFedBack, type ResourceLedger } from './ledger'
import type { ProcessCatalog } from './processes'
import type { PlanResult } from './solver'
import type { Plan } from './types'

/** An item bought or taken in, per minute, with what one costs in copper. */
export interface MoneyLine {
  item: string
  count: number
  /** Copper per item; null when portals don't sell it (brought in from outside, no price). */
  price: number | null
}

/** What crossing the bus an output can feed back into: the plan's heat, fertilizer or money. */
export type BusUse = 'heat' | 'fertilizer' | 'money'

/** One source of an output: a target, or overflow (made, but nothing in the plan uses it). */
export interface OutputSource {
  /** Index in the plan's targets; null for overflow. */
  target: number | null
  /** Items per minute it makes. */
  amount: number
  fedBack: boolean
  /** Items per minute the plan uses of it, per what it feeds. */
  used: Partial<Record<BusUse, number>>
}

/** An item leaving the plan: all its sources, what the plan feeds back of it, and the rest. */
export interface OutputRow {
  item: string
  sources: OutputSource[]
  /** What it could feed back into (none: it only goes out to the bus). */
  feeds: BusUse[]
  /** Items per minute the plan uses itself, per what it feeds. */
  used: Partial<Record<BusUse, number>>
  /** Items per minute that go out to the bus. */
  toBus: number
  /** Copper one is worth: what the shop pays at base prices, or a coin's face value; null if unsellable. */
  price: number | null
}

/**
 * The plan's money, per minute, at base prices. It goes in as coins: what the Purchase Portals spend
 * on the items they buy, and coins its recipes take. Coins the plan makes and feeds back cover part
 * of that (overflow first, then targets in order). Everything else the plan delivers goes out to the
 * bus, worth what the shop pays for it before profit upgrades (coins at face value). How much
 * customers actually buy isn't modeled.
 */
export interface MoneyLedger {
  /** Bought at Purchase Portals. */
  purchases: MoneyLine[]
  /** Coins taken in by the plan's recipes. */
  coins: MoneyLine[]
  /** Copper the plan's purchases and coins take, before its own coins cover any. */
  need: number
  /** Part of `need` its own fed-back coins cover. */
  covered: number
  /** What it takes from the bus: `need` − `covered`. */
  cost: number
  /** Everything leaving the plan, targets first (in order), then overflow. */
  outputs: OutputRow[]
  /** What the outputs going to the bus are worth. */
  value: number
}

export function moneyLedger(plan: Plan, catalog: ProcessCatalog, result: PlanResult, ledgers: ResourceLedger[]): MoneyLedger {
  const purchases: MoneyLine[] = []
  const coins: MoneyLine[] = []
  for (const b of result.balances) {
    if (b.item.startsWith('@') || b.imported <= 0) continue
    const face = coinValue(b.item)
    ;(face !== null ? coins : purchases).push({ item: b.item, count: b.imported, price: face ?? itemsByKey.get(b.item)?.buyPrice ?? null })
  }
  const total = (lines: MoneyLine[]) => lines.reduce((t, l) => t + l.count * (l.price ?? 0), 0)
  const need = total(purchases) + total(coins)

  // Every source of every output: targets (in order), then overflow.
  let resolved = 0
  const made = plan.targets.map((t) => (t.item ? (result.targets[resolved++]?.made ?? 0) : 0))
  const sources: (OutputSource & { item: string })[] = []
  plan.targets.forEach((t, i) => {
    if (t.item && made[i] > 0) sources.push({ item: t.item, target: i, amount: made[i], fedBack: targetFedBack(plan, t), used: {} })
  })
  for (const b of result.balances)
    if (!b.item.startsWith('@') && b.surplus > 0)
      sources.push({ item: b.item, target: null, amount: b.surplus, fedBack: itemFedBack(plan, b.item), used: {} })
  const find = (item: string, target: number | null) => sources.find((s) => s.item === item && s.target === target)

  // Heat and fertilizer took their share already (see ledger.ts).
  for (const l of ledgers)
    for (const s of l.sources) {
      const o = find(s.item, s.target)
      if (o && s.used > 0) o.used[l.resource] = s.used
    }

  // Fed-back coins cover the money need at face value: overflow first, then targets in order.
  let remaining = need
  for (const s of [...sources.filter((s) => s.target === null), ...sources.filter((s) => s.target !== null)]) {
    const face = coinValue(s.item)
    if (face === null || !s.fedBack || remaining <= 0) continue
    const used = Math.min(s.amount, remaining / face)
    s.used.money = used
    remaining -= used * face
  }
  if (remaining < need * 1e-9) remaining = 0

  const fuels = carriers(plan, catalog, 'heat')
  const fertilizers = carriers(plan, catalog, 'fertilizer')
  const outputs: OutputRow[] = []
  for (const s of sources) {
    let row = outputs.find((o) => o.item === s.item)
    if (!row) {
      const feeds: BusUse[] = []
      if (fuels.has(s.item)) feeds.push('heat')
      if (fertilizers.has(s.item)) feeds.push('fertilizer')
      if (coinValue(s.item) !== null) feeds.push('money')
      row = { item: s.item, sources: [], feeds, used: {}, toBus: 0, price: coinValue(s.item) ?? itemsByKey.get(s.item)?.sellPrice ?? null }
      outputs.push(row)
    }
    const { item: _, ...source } = s
    row.sources.push(source)
    let used = 0
    for (const [use, n] of Object.entries(s.used) as [BusUse, number][]) {
      row.used[use] = (row.used[use] ?? 0) + n
      used += n
    }
    row.toBus += Math.max(0, s.amount - used)
  }
  for (const o of outputs) if (o.toBus < 1e-9 * Math.max(1, ...o.sources.map((s) => s.amount))) o.toBus = 0
  const value = outputs.reduce((t, o) => t + o.toBus * (o.price ?? 0), 0)
  return { purchases, coins, need, covered: need - remaining, cost: remaining, outputs, value }
}

/**
 * Per item, the share of its overflow the plan feeds back into its heat, fertilizer or money, and
 * what into: that part isn't overflow, since the plan uses it.
 */
export function fedOverflow(money: MoneyLedger): Map<string, { share: number; into: BusUse[] }> {
  const fed = new Map<string, { share: number; into: BusUse[] }>()
  for (const o of money.outputs)
    for (const s of o.sources) {
      const into = (Object.entries(s.used) as [BusUse, number][]).filter(([, n]) => n > 0)
      if (s.target !== null || !into.length || s.amount <= 0) continue
      const used = into.reduce((t, [, n]) => t + n, 0)
      fed.set(o.item, { share: Math.min(1, used / s.amount), into: into.map(([use]) => use) })
    }
  return fed
}
