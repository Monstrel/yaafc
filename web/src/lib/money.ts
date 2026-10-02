import { coinValue, itemsByKey } from './gameData'
import type { ResourceLedger } from './ledger'
import type { PlanResult } from './solver'

/** An item moving in or out of the plan, per minute, with what one is worth in copper. */
export interface MoneyLine {
  item: string
  count: number
  /** Copper per item; null when it has no price (not sold at portals, or the shop won't buy it). */
  price: number | null
}

/**
 * What a plan costs to run and what its output is worth, per minute, at base prices. Costs are
 * portal purchases and coins taken in from outside (at face value); fuel and fertilizer come off
 * the bus and portals don't sell them. Output is what the plan delivers (targets and overflow, less
 * what it feeds back into its own heat or fertilizer): sellable goods at what the shop pays before
 * any profit upgrades, coins at face value. How much customers actually buy isn't modeled.
 */
export interface MoneyLedger {
  /** Bought at portals. */
  purchases: MoneyLine[]
  /** Coins the plan takes in. */
  coins: MoneyLine[]
  cost: number
  /** Sellable goods and coins the plan delivers. */
  sales: MoneyLine[]
  /** Delivered items the shop won't buy. */
  unsold: MoneyLine[]
  value: number
}

export function moneyLedger(result: PlanResult, ledgers: ResourceLedger[]): MoneyLedger {
  const fedBack = new Map<string, number>()
  for (const l of ledgers) for (const s of l.sources) fedBack.set(s.item, (fedBack.get(s.item) ?? 0) + s.used)

  const purchases: MoneyLine[] = []
  const coins: MoneyLine[] = []
  const sales: MoneyLine[] = []
  const unsold: MoneyLine[] = []
  for (const b of result.balances) {
    if (b.item.startsWith('@')) continue
    const face = coinValue(b.item)
    if (b.imported > 0)
      (face !== null ? coins : purchases).push({ item: b.item, count: b.imported, price: face ?? itemsByKey.get(b.item)?.buyPrice ?? null })
    const delivered = b.target + b.surplus - (fedBack.get(b.item) ?? 0)
    if (delivered <= 1e-9 * Math.max(1, b.target + b.surplus)) continue
    const price = face ?? itemsByKey.get(b.item)?.sellPrice ?? null
    ;(price !== null ? sales : unsold).push({ item: b.item, count: delivered, price })
  }
  const total = (lines: MoneyLine[]) => lines.reduce((t, l) => t + l.count * (l.price ?? 0), 0)
  return { purchases, coins, cost: total(purchases) + total(coins), sales, unsold, value: total(sales) }
}
