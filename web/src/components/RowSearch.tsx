import { useEffect, useMemo, useRef, useState } from 'react'
import { itemsByKey, type Item } from '../lib/gameData'
import type { TreeNode } from '../lib/tree'
import { ItemPicker } from './ItemPicker'

/** A row, with the ids of the branches above it. */
interface Placed {
  node: TreeNode
  ancestors: string[]
}

interface Props {
  /** Every row of the tree, folded or not, in tree order. */
  rows: Placed[]
  /** Goes to a row: unfolded, scrolled to and pulsed. */
  onGo: (row: Placed) => void
}

/**
 * Finds the rows making an item and steps through them. Sits at the right of the tree's toolbar,
 * and floats in the corner of the window while an item is chosen and the toolbar is scrolled away.
 */
export function RowSearch({ rows, onGo }: Props) {
  // Only items the plan makes are offered: each with the rows making it, in tree order.
  const byItem = useMemo(() => {
    const out = new Map<string, Placed[]>()
    for (const row of rows)
      if (row.node.kind === 'produce' && itemsByKey.has(row.node.item)) {
        const list = out.get(row.node.item)
        if (list) list.push(row)
        else out.set(row.node.item, [row])
      }
    return out
  }, [rows])
  const options = useMemo(() => [...byItem.keys()].map((k) => itemsByKey.get(k)!), [byItem])

  const [item, setItem] = useState<string | null>(null)
  // The match last gone to (none until the first jump).
  const [at, setAt] = useState<number | null>(null)
  const matches = (item && byItem.get(item)) || []
  // Forget the item once the plan no longer makes it.
  if (item && !matches.length) {
    setItem(null)
    setAt(null)
  }
  const index = at === null ? null : Math.min(at, matches.length - 1)

  const go = (i: number) => {
    const n = matches.length
    if (!n) return
    const next = ((i % n) + n) % n
    setAt(next)
    onGo(matches[next])
  }
  const choose = (key: string | null) => {
    setItem(key)
    setAt(null)
    const first = key && byItem.get(key)?.[0]
    if (first) {
      setAt(0)
      onGo(first)
    }
  }

  // Floats while an item is chosen and the toolbar slot has scrolled off the top; the slot keeps
  // the room it took so the toolbar doesn't shift.
  const slot = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [away, setAway] = useState(false)
  useEffect(() => {
    const el = slot.current
    if (!el) return
    const watch = new IntersectionObserver(([e]) => setAway(!e.isIntersecting && e.boundingClientRect.top < 0))
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  const floating = away && !!item
  useEffect(() => {
    const el = slot.current
    if (!el) return
    if (floating && box.current) {
      el.style.width = `${box.current.offsetWidth}px`
      el.style.height = `${box.current.offsetHeight}px`
    } else el.style.width = el.style.height = ''
  }, [floating])

  const name = item ? itemsByKey.get(item)?.name : ''
  return (
    <div className="row-search-slot" ref={slot}>
      <div
        className={`row-search ${floating ? 'floating' : ''}`}
        ref={box}
        role="search"
        aria-label="Find rows making an item"
        onKeyDown={(e) => {
          if (!item || (e.target as HTMLElement).closest('.picker-popover')) return
          if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) go((index ?? -1) + 1)
          else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) go((index ?? 0) - 1)
          else return
          e.preventDefault()
        }}
      >
        <ItemPicker
          value={item}
          options={options}
          onChange={choose}
          placeholder="Find item…"
          compact
          detail={(o: Item) => {
            const n = byItem.get(o.key)?.length ?? 0
            return `${n} ${n === 1 ? 'row' : 'rows'}`
          }}
        />
        {item && (
          <>
            <span className="row-search-count" aria-live="polite">
              {index === null ? `${matches.length} ${matches.length === 1 ? 'row' : 'rows'}` : `${index + 1} of ${matches.length}`}
            </span>
            <button type="button" className="compact-button" title={`Previous row making ${name}`} aria-label="Previous match" onClick={() => go((index ?? 0) - 1)}>
              ▲
            </button>
            <button type="button" className="compact-button" title={`Next row making ${name}`} aria-label="Next match" onClick={() => go((index ?? -1) + 1)}>
              ▼
            </button>
            <button type="button" className="compact-button row-search-clear" title="Stop finding" aria-label="Clear search" onClick={() => choose(null)}>
              ×
            </button>
          </>
        )}
      </div>
    </div>
  )
}
