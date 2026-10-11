import { COINS, dispatch, type Contract } from './gameData'
import { attributeBonus, SUPPLIER_LICENSES, type Modifiers } from './upgrades'

// Dispatch Portal (Portal_Wholesaling), verified natively (tick 0x144A2A2E0, build 25321648): it
// takes only its contract's item off one belt, and once it holds a contract's worth, completes it if
// today's dispatched count of the item (factory-wide, every portal) is under the daily limit, in
// items. Otherwise it stops taking items until the next day. So a whole contract can take the count
// past the limit: buyers take as many contracts as it takes to reach it.

const contracts = new Map(dispatch.contracts.map((c) => [c.item, c]))

/** The Dispatch Portal contract for an item, if buyers take it. */
export const contractFor = (item: string): Contract | null => contracts.get(item) ?? null

/** The Supplier License a tier names (1 = Licensed Supplier). */
export const licenseName = (tier: number) => dispatch.licenses[tier - 1] ?? `Supplier License ${tier}`

// The game's rounding: (int)(2x ± 0.5) >> 1 with the CPU rounding to nearest even (cvtsd2si).
const roundEven = (x: number) => {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}
const roundToInt = (x: number) => Math.floor(roundEven(2 * x + 0.5) / 2)
const floorToInt = (x: number) => Math.floor(roundEven(2 * x - 0.5) / 2)

/** A contract's terms for a player: their licenses, or the ones unlocking it if they have fewer. */
export interface DispatchTerms {
  contract: Contract
  /** Supplier Licenses the terms assume. */
  licenses: number
  /** Whether the player's licenses are fewer than the contract needs (the terms assume it's unlocked). */
  locked: boolean
  /** Contracts buyers take a day. */
  perDay: number
  /** Items dispatched a day: whole contracts. */
  itemsPerDay: number
  /** Real minutes in the day the factory has to make them. */
  dayMinutes: number
  /** Items per minute that reach the daily limit by the end of the day. */
  rate: number
  /** Coins paid per contract, largest first (each denomination rounded down on its own). */
  pay: { coin: string; count: number }[]
  /** Copper value of what one minute's dispatching pays. */
  copperPerMinute: number
}

export function dispatchTerms(item: string, mods: Modifiers): DispatchTerms | null {
  const contract = contractFor(item)
  if (!contract) return null
  const licenses = Math.max(mods.licenses, contract.license)
  const held = { [SUPPLIER_LICENSES.key]: licenses }
  const amount = 1 + attributeBonus(held, 'ContractNum') * 0.01
  const profit = 1 + attributeBonus(held, 'ContractProfit') * 0.01
  const limit = roundToInt(contract.count * contract.dailyLimit * amount)
  const perDay = Math.ceil(limit / contract.count)
  const itemsPerDay = perDay * contract.count
  const pay = COINS.map((c, k) => ({ coin: c.coin, count: floorToInt(contract.reward[k] * profit) })).filter((p) => p.count > 0)
  const copper = pay.reduce((t, p) => t + p.count * COINS.find((c) => c.coin === p.coin)!.copper, 0)
  return {
    contract,
    licenses,
    locked: mods.licenses < contract.license,
    perDay,
    itemsPerDay,
    dayMinutes: mods.dayMinutes,
    rate: itemsPerDay / mods.dayMinutes,
    pay,
    copperPerMinute: (copper * perDay) / mods.dayMinutes,
  }
}
