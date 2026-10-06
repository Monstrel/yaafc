import { useState } from 'react'
import { itemName, targetItems } from '../lib/gameData'
import { ItemPicker } from './ItemPicker'

/**
 * Adds a target that uses an item's overflow, or what the plan leaves of the bus's capped supply of
 * it: the planner makes as many of what the player picks as that comes to. Any item can be picked;
 * a cauldron recipe can take almost anything.
 */
export function OverflowTargetForm({
  item,
  supply,
  onAdd,
  onCancel,
}: {
  item: string
  /** Uses the rest of the bus's supply of the item, not its overflow. */
  supply?: boolean
  onAdd: (item: string) => void
  onCancel: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const name = itemName(item)
  return (
    <div className="provider-form">
      <label className="stacked">
        {supply ? `Make from the rest of the bus's ${name}` : 'Make from the overflow'}
        <ItemPicker value={picked} options={targetItems} onChange={setPicked} defaultOpen compact />
      </label>
      <p className="hint">
        {supply
          ? `Adds a target sized to use the ${name} the bus carries that the plan's other rows leave.`
          : `Adds a target sized to use the ${name} nothing else uses.`}{' '}
        If its recipes don&apos;t take {name}, pick ones that do in its rows.
      </p>
      <div className="provider-actions">
        <button className="primary" disabled={!picked} onClick={() => picked && onAdd(picked)}>
          Add {picked ? itemName(picked) : ''} target
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
