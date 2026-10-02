import { fmt } from '../lib/format'
import { COINS } from '../lib/gameData'
import { ItemIcon } from './ItemIcon'

/** An amount of money shown in the largest coin tier it reaches, with that coin's icon. */
export function Money({ copper, suffix = '' }: { copper: number; suffix?: string }) {
  const tier = COINS.find((t) => copper >= t.copper) ?? COINS[COINS.length - 1]
  return (
    <span className="money" title={`${Math.round(copper).toLocaleString()} copper${suffix}`}>
      {fmt(copper / tier.copper)}
      <ItemIcon item={tier.coin} size={16} />
      {suffix}
    </span>
  )
}
