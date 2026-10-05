import { useState } from 'react'
import { itemName, targetItems } from '../lib/gameData'
import { ItemPicker } from './ItemPicker'

/**
 * Adds a target that uses an item's overflow: the planner makes as many of what the player picks as
 * that overflow comes to. Any item can be picked; a cauldron recipe can take almost anything.
 */
export function OverflowTargetForm({
  item,
  onAdd,
  onCancel,
}: {
  item: string
  onAdd: (item: string) => void
  onCancel: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  return (
    <div className="provider-form">
      <label className="stacked">
        Make from the overflow
        <ItemPicker value={picked} options={targetItems} onChange={setPicked} defaultOpen compact />
      </label>
      <p className="hint">
        Adds a target sized to use the {itemName(item)} nothing else uses. If its recipes don&apos;t take {itemName(item)},
        pick ones that do in its rows.
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
