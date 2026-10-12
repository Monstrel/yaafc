import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Item } from '../lib/gameData'
import { GAP, MARGIN, popoverSide } from '../lib/popover'
import { ItemIcon } from './ItemIcon'

interface Props {
  value: string | null
  options: Item[]
  onChange: (key: string | null) => void
  placeholder?: string
  allowClear?: boolean
  /** Extra text shown on the right of each option (e.g. cauldron value). */
  detail?: (item: Item) => string
  /** Sized to sit beside a compact recipe button (in the production tree). */
  compact?: boolean
  /** Starts open (a row just added, waiting for its item). */
  defaultOpen?: boolean
}

/**
 * A button showing the item chosen, opening a searchable list of items (a combobox: the arrow keys
 * move through the list as you type, Enter chooses, Escape closes). It closes when focus or a click
 * goes elsewhere, and choosing or closing puts focus back on the button.
 */
export function ItemPicker({
  value,
  options,
  onChange,
  placeholder = 'Choose item…',
  allowClear,
  detail,
  compact,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const optionId = (i: number) => `${listId}-${i}`
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

  // Opens below the button, or above it when only that fits, its list shrinking (scrolling) to the
  // room there; shifted left if it would run off the viewport's right edge.
  const pop = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = pop.current
    if (!open || !el || !root.current) return
    const anchor = root.current.getBoundingClientRect()
    el.style.removeProperty('--popover-room')
    const { up, room } = popoverSide(anchor, el.offsetHeight)
    el.style.top = up ? 'auto' : ''
    el.style.bottom = up ? `calc(100% + ${GAP}px)` : ''
    el.style.setProperty('--popover-room', `${room}px`)
    const vw = document.documentElement.clientWidth
    el.style.left = `${Math.max(MARGIN - anchor.left, Math.min(0, vw - MARGIN - anchor.left - el.offsetWidth))}px`
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
    button.current?.focus()
  }
  const choose = (key: string | null) => {
    onChange(key)
    close()
  }
  // The option the arrow keys are on stays in view.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  return (
    <div
      className={`picker ${compact ? 'compact' : ''}`}
      ref={root}
      onBlur={(e) => {
        // Tabbing away closes it too, not only a click elsewhere.
        if (open && !root.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        type="button"
        ref={button}
        className={`picker-button ${selected ? '' : 'empty'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {selected ? (
          <>
            <ItemIcon item={selected.key} size={compact ? 20 : 22} />
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
        <div className="picker-popover" ref={pop}>
          <input
            autoFocus
            className="picker-search"
            placeholder="Search…"
            role="combobox"
            aria-label="Search items"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={filtered[active] ? optionId(active) : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, filtered.length - 1))
              else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
              else if (e.key === 'Enter' && filtered[active]) choose(filtered[active].key)
              else if (e.key === 'Escape') close()
              else return
              e.preventDefault()
            }}
          />
          <div className="picker-list" role="listbox" id={listId} aria-label={placeholder}>
            {allowClear && value && (
              <button type="button" tabIndex={-1} className="picker-option clear" onClick={() => choose(null)}>
                Clear
              </button>
            )}
            {filtered.map((o, i) => (
              <button
                type="button"
                key={o.key}
                id={optionId(i)}
                tabIndex={-1}
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
