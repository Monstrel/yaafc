import { useEffect, useMemo, useRef, useState } from 'react'
import type { Item } from '../lib/gameData'
import { ItemIcon } from './ItemIcon'

interface Props {
  value: string | null
  options: Item[]
  onChange: (key: string | null) => void
  placeholder?: string
  allowClear?: boolean
  /** Extra text shown on the right of each option (e.g. cauldron value). */
  detail?: (item: Item) => string
}

export function ItemPicker({ value, options, onChange, placeholder = 'Choose item…', allowClear, detail }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.key === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? options.filter((o) => o.name.toLowerCase().includes(q) || o.key.toLowerCase().includes(q)) : options
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const choose = (key: string | null) => {
    onChange(key)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="picker" ref={root}>
      <button type="button" className={`picker-button ${selected ? '' : 'empty'}`} onClick={() => setOpen(!open)}>
        {selected ? (
          <>
            <ItemIcon item={selected.key} size={22} />
            <span className="name">{selected.name}</span>
          </>
        ) : (
          <span className="placeholder">{placeholder}</span>
        )}
        <span className="chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="picker-popover" role="listbox">
          <input
            autoFocus
            className="picker-search"
            placeholder="Search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, filtered.length - 1))
              else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
              else if (e.key === 'Enter' && filtered[active]) choose(filtered[active].key)
              else if (e.key === 'Escape') setOpen(false)
              else return
              e.preventDefault()
            }}
          />
          <div className="picker-list">
            {allowClear && value && (
              <button type="button" className="picker-option clear" onClick={() => choose(null)}>
                Clear
              </button>
            )}
            {filtered.map((o, i) => (
              <button
                type="button"
                key={o.key}
                role="option"
                aria-selected={o.key === value}
                className={`picker-option ${i === active ? 'active' : ''} ${o.key === value ? 'selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o.key)}
              >
                <ItemIcon item={o.key} size={22} />
                <span className="name">{o.name}</span>
                {detail && <span className="detail">{detail(o)}</span>}
              </button>
            ))}
            {filtered.length === 0 && <div className="picker-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  )
}
