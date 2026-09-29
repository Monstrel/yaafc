import { fmt } from '../lib/format'
import { ItemIcon } from './ItemIcon'

// In-game coin tiers (from the portal stock prices): 1 silver = 1,000 copper, 1 gold = 100 silver.
const TIERS = [
  { coin: 'GoldCoin', name: 'gold', copper: 100_000 },
  { coin: 'SilverCoin', name: 'silver', copper: 1_000 },
  { coin: 'CopperCoin', name: 'copper', copper: 1 },
]

/** An amount of money shown in the largest coin tier it reaches, with that coin's icon. */
export function Money({ copper, suffix = '' }: { copper: number; suffix?: string }) {
  const tier = TIERS.find((t) => copper >= t.copper) ?? TIERS[TIERS.length - 1]
  return (
    <span className="money" title={`${Math.round(copper).toLocaleString()} copper${suffix}`}>
      {fmt(copper / tier.copper)}
      <ItemIcon item={tier.coin} size={16} />
      {suffix}
    </span>
  )
}
