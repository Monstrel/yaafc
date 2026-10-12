import { type ReactNode } from 'react'
import { fmt } from '../../lib/format'
import type { BusUse, FedOverflow } from '../../lib/money'

const FED_INTO: Record<BusUse, string> = { plan: 'used in the plan in place of the input', money: 'spent in the plan' }

/**
 * What a row makes of an item that nothing uses: the part the plan feeds back in place of the bus
 * or into its money, or breaks down at Knowledge Altars (not overflow: it's dealt with), and the
 * rest, overflowing.
 */
export function OverflowNote({
  item,
  amount,
  fed,
  inline,
  counted,
  using,
  onUse,
}: {
  item: string
  amount: number
  fed: Map<string, FedOverflow>
  /** Picking a target to use the overflow is open. */
  using: boolean
  /** Opens or closes picking a target to use the overflow. */
  onUse: () => void
  /** Part of a by-product line rather than a line of its own. */
  inline?: boolean
  /** Show the amount even inline (the by-product also goes elsewhere). */
  counted?: boolean
}) {
  const f = fed.get(item)
  const used = amount * (f?.share ?? 0)
  const left = amount - used
  const parts: ReactNode[] = []
  if (used > 1e-9 * amount) {
    const into = [
      ...(f!.taken?.length ? [`taken by ${f!.taken.map((i) => `Target ${i + 1}`).join(' and ')}`] : []),
      ...f!.into.map((r) => FED_INTO[r]),
      ...(f!.altar ? ['broken down at Knowledge Altars'] : []),
    ]
    parts.push(
      <span key="fed" className="fed-text">
        {fmt(used)}/min {into.join(' and ')}
      </span>,
    )
  }
  if (left > 1e-9 * amount)
    parts.push(
      <button
        key="left"
        className="tree-link warn-text"
        title="Made by this row's machines but used nowhere in the plan: click to add a target that uses it, or break it down at Knowledge Altars"
        aria-expanded={using}
        onClick={onUse}
      >
        {inline ? `${counted || used > 0 ? `${fmt(left)} ` : ''}overflow` : `+${fmt(left)}/min overflow`}
      </button>,
    )
  const joined = parts.flatMap((p, i) => (i ? [', ', p] : [p]))
  return inline ? <>{joined}</> : <div className="note-line">{joined}</div>
}
