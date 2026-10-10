import { coinValue, itemsByKey } from './gameData'
import { itemFedBack, targetFedBack, type ItemLedger } from './ledger'
import type { PlanResult } from './solver'
import type { Plan } from './types'

/** An item bought or taken in, per minute, with what one costs in copper. */
export interface MoneyLine {
  item: string
  count: number
  /** Copper per item; null when portals don't sell it. */
  price: number | null
}

/**
 * What an output can feed back into, in place of the bus: what the plan's rows take of the same
 * item from it, or (coins) the plan's money.
 */
export type BusUse = 'plan' | 'money'

/** One source of an output: a target, or overflow (made, but nothing in the plan uses it). */
export interface OutputSource {
  /** Index in the plan's targets; null for overflow. */
  target: number | null
  /** Items per minute it makes. */
  amount: number
  fedBack: boolean
  /** Items per minute the plan uses of it, per what it feeds. */
  used: Partial<Record<BusUse, number>>
  /** For overflow: what overflow targets take of it (index in the plan's targets, items per minute). */
  taken: { target: number; amount: number }[]
  /** For overflow: items per minute broken down at Knowledge Altars (what's left after the rest). */
  altar: number
  /** Part of `altar` the rows making it send there as it comes out (see `Plan.altarOutputs`). */
  atSource: number
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
  /** Items per minute of its overflow broken down at Knowledge Altars instead. */
  altar: number
  /** Copper one is worth: what the shop pays at base prices, or a coin's face value; null if unsellable. */
  price: number | null
}

/**
 * The plan's money, per minute, at base prices. It goes in as coins taken from the bus: what its
 * Purchasing Portals are paid in, and coins its recipes take. Coins the plan makes and feeds back
 * cover part of that at face value (overflow first, then targets in order). Everything else the plan delivers goes out to the
 * bus, worth what the shop pays for it before profit upgrades (coins at face value). How much
 * customers actually buy isn't modeled.
 */
export interface MoneyLedger {
  /** Bought at Purchasing Portals, paid for with some of `coins`. */
  purchases: MoneyLine[]
  /** Coins the plan takes from the bus. */
  coins: MoneyLine[]
  /** Copper those coins are worth, before its own coins cover any. */
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

export function moneyLedger(plan: Plan, result: PlanResult, ledgers: ItemLedger[]): MoneyLedger {
  const purchases: MoneyLine[] = []
  const coins: MoneyLine[] = []
  // One line per item bought, however many runs (paid in different coins) buy it.
  for (const r of result.runs) {
    if (r.process.kind !== 'buy' || r.craftsPerMinute <= 0) continue
    const item = r.process.product
    const line = purchases.find((l) => l.item === item)
    if (line) line.count += r.craftsPerMinute
    else purchases.push({ item, count: r.craftsPerMinute, price: itemsByKey.get(item)?.buyPrice ?? null })
  }
  for (const b of result.balances) {
    const face = coinValue(b.item)
    if (face !== null && b.fromBus > 0) coins.push({ item: b.item, count: b.fromBus, price: face })
  }
  const total = (lines: MoneyLine[]) => lines.reduce((t, l) => t + l.count * (l.price ?? 0), 0)
  const need = total(coins)

  // Every source of every output: targets (in order), then overflow, with what overflow targets take
  // of it (they come first: what they leave is fed back or goes out to the bus).
  let resolved = 0
  const resolvedAt = plan.targets.map((t) => (t.item ? result.targets[resolved++] : undefined))
  const sources: (OutputSource & { item: string })[] = []
  plan.targets.forEach((t, i) => {
    const made = resolvedAt[i]?.made ?? 0
    if (t.item && made > 0) sources.push({ item: t.item, target: i, amount: made, fedBack: targetFedBack(plan, t), used: {}, taken: [], altar: 0, atSource: 0 })
  })
  const taken = new Map<string, { target: number; amount: number }[]>()
  resolvedAt.forEach((r, i) => {
    const o = r?.overflow
    if (o && o.taken > 0) taken.set(o.item, [...(taken.get(o.item) ?? []), { target: i, amount: o.taken }])
  })
  const overflowing = new Set([
    ...result.balances.filter((b) => !b.item.startsWith('@') && (b.surplus > 0 || b.altar > 0)).map((b) => b.item),
    ...taken.keys(),
  ])
  for (const item of overflowing) {
    const to = taken.get(item) ?? []
    const b = result.balances.find((b) => b.item === item)
    // What rows send to Knowledge Altars as it comes out is broken down there, whatever else happens.
    const atSource = b?.altar ?? 0
    const amount = to.reduce((t, x) => t + x.amount, (b?.surplus ?? 0) + atSource)
    sources.push({ item, target: null, amount, fedBack: itemFedBack(plan, item), used: {}, taken: to, altar: atSource, atSource })
  }
  const find = (item: string, target: number | null) => sources.find((s) => s.item === item && s.target === target)

  // What the plan's rows take from the bus took its share already (see ledger.ts).
  for (const l of ledgers)
    for (const s of l.sources) {
      const o = find(s.item, s.target)
      if (o && s.used > 0) o.used.plan = s.used
    }
  // So did what rows making a fed-back target's item took of it in the solve.
  resolvedAt.forEach((r, i) => {
    const o = r?.fedIn ? find(r.item, i) : undefined
    if (o) o.used.plan = (o.used.plan ?? 0) + r!.fedIn!
  })

  // Fed-back coins cover the money need at face value: overflow first, then targets in order.
  let remaining = need
  for (const s of [...sources.filter((s) => s.target === null), ...sources.filter((s) => s.target !== null)]) {
    const face = coinValue(s.item)
    if (face === null || !s.fedBack || remaining <= 0) continue
    const left = s.amount - s.altar - s.taken.reduce((t, x) => t + x.amount, 0)
    const used = Math.min(left, remaining / face)
    s.used.money = used
    remaining -= used * face
  }
  if (remaining < need * 1e-9) remaining = 0

  const drawn = new Set(ledgers.map((l) => l.item))
  const outputs: OutputRow[] = []
  for (const s of sources) {
    let row = outputs.find((o) => o.item === s.item)
    if (!row) {
      const feeds: BusUse[] = []
      if (drawn.has(s.item)) feeds.push('plan')
      if (coinValue(s.item) !== null) feeds.push('money')
      row = { item: s.item, sources: [], feeds, used: {}, toBus: 0, altar: 0, price: coinValue(s.item) ?? itemsByKey.get(s.item)?.sellPrice ?? null }
      outputs.push(row)
    }
    const { item: _, ...source } = s
    row.sources.push(source)
    let used = s.taken.reduce((t, x) => t + x.amount, 0)
    for (const [use, n] of Object.entries(s.used) as [BusUse, number][]) {
      row.used[use] = (row.used[use] ?? 0) + n
      used += n
    }
    // Overflow the player breaks down at Knowledge Altars: whatever the rest leaves of it.
    const left = Math.max(0, s.amount - used - s.altar)
    if (s.target === null && plan.altarItems?.includes(s.item)) source.altar += left < 1e-9 * s.amount ? 0 : left
    else row.toBus += left
    row.altar += source.altar
  }
  for (const o of outputs) if (o.toBus < 1e-9 * Math.max(1, ...o.sources.map((s) => s.amount))) o.toBus = 0
  const value = outputs.reduce((t, o) => t + o.toBus * (o.price ?? 0), 0)
  return { purchases, coins, need, covered: need - remaining, cost: remaining, outputs, value }
}

/** The share of an item's overflow the plan uses after all, and what for. */
export interface FedOverflow {
  share: number
  into: BusUse[]
  /** Overflow targets (index in the plan's targets) taking some of it, if any. */
  taken?: number[]
  /** Part of it is broken down at Knowledge Altars. */
  altar?: boolean
}

/**
 * Per item, the share of its overflow that overflow targets take, the plan feeds back in place of
 * the bus or into its money, or Knowledge Altars break down, and what into: that part isn't
 * overflow, since it's dealt with.
 */
export function fedOverflow(money: MoneyLedger): Map<string, FedOverflow> {
  const fed = new Map<string, FedOverflow>()
  for (const o of money.outputs)
    for (const s of o.sources) {
      const into = (Object.entries(s.used) as [BusUse, number][]).filter(([, n]) => n > 0)
      if (s.target !== null || (!into.length && !s.taken.length && !s.altar) || s.amount <= 0) continue
      const used = into.reduce((t, [, n]) => t + n, 0) + s.taken.reduce((t, x) => t + x.amount, 0) + s.altar
      fed.set(o.item, {
        share: Math.min(1, used / s.amount),
        into: into.map(([use]) => use),
        ...(s.taken.length > 0 && { taken: s.taken.map((x) => x.target) }),
        ...(s.altar > 0 && { altar: true }),
      })
    }
  return fed
}
