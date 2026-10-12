import { itemName, itemsByKey } from '../../lib/gameData'
import { fmt } from '../../lib/format'
import type { FedOverflow } from '../../lib/money'
import { type TreeNode } from '../../lib/tree'
import { rowItem } from '../../lib/unfold'
import { ItemLabel } from '../ItemIcon'
import { destinationName } from '../../lib/treeView'
import { OverflowNote } from './OverflowNote'
import type { LinkFn } from './types'

/** Where each of a row's other outputs goes: the rows taking it, what overflows or goes to Knowledge Altars, and sending it there. */
export function ByproductNotes({
  node,
  fed,
  picking,
  link,
  topName,
  canAltar,
  onOutputAltar,
}: {
  node: TreeNode
  fed: Map<string, FedOverflow>
  /** Picking a target to use an item's overflow, on the row. */
  picking: (item: string) => { using: boolean; onUse: () => void }
  link: LinkFn
  /** What items built at the top of the plan are shown "with". */
  topName: string
  canAltar: ((item: string) => boolean) | null
  onOutputAltar: (row: string, item: string, on: boolean) => void
}) {
  return (
    <>
      {node.byproducts.map((b) => (
        <div key={b.item} className="note-line">
          also makes <ItemLabel item={b.item} count={b.count} size={16} /> →{' '}
          {b.to.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ', '}
              {(b.to.length > 1 || b.overflow > 0) && `${fmt(t.amount)} `}
              {link(
                node,
                // The line for the by-products, where the row taking them shows one.
                (n) => n.reusedBy === t.id || (n.id === t.id && !n.reusedApart),
                t.direct ? `${itemName(rowItem(t.id))} crucibles` : destinationName(t.id, topName),
                `Show the ${t.direct ? 'crucibles refining it' : `${itemsByKey.get(b.item)?.name ?? b.item} row it feeds`}`,
              )}
            </span>
          ))}
          {b.overflow > 0 && (
            <>
              {b.to.length > 0 && ', '}
              <OverflowNote
                item={b.item}
                amount={b.overflow}
                fed={fed}
                inline
                counted={b.to.length > 0}
                {...picking(b.item)}
              />
            </>
          )}
          {b.toAltar && (
            <>
              {b.to.length > 0 && ', '}
              <span className="fed-text">{fmt(b.altar)}/min broken down at Knowledge Altars</span>
            </>
          )}
          {node.kind === 'produce' && !node.recovery && (b.toAltar || canAltar?.(b.item)) && (
            <>
              {' · '}
              <button
                type="button"
                className="tree-link"
                title={
                  b.toAltar
                    ? 'Let the rest of the plan take it again'
                    : 'Break it down at Knowledge Altars as it comes out: nothing else takes it, so rows using it make their own'
                }
                onClick={() => onOutputAltar(node.id, b.item, !b.toAltar)}
              >
                {b.toAltar ? 'Route it instead' : 'Send to Knowledge Altars'}
              </button>
            </>
          )}
        </div>
      ))}
    </>
  )
}
