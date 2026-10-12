import { useEffect, useRef, useState, type KeyboardEvent, type ToggleEvent } from 'react'
import { placePopover } from './popover'

/** What the menu's keys move between: its items, or its buttons. */
const ITEMS = 'button:not(:disabled), [role^="menuitem"]:not(:disabled)'

/**
 * A menu popover opened from a button, about something (`subject`): shown and placed by the button
 * (lined up with its left or right edge), focus moved to its first item, the arrow keys (and Home,
 * End) moving between items, and focus back on the button when it closes from inside (an item
 * chosen, Escape); clicking elsewhere leaves focus where it went. Spread `props` on the popover.
 */
export function useAnchoredMenu<T>(align: 'left' | 'right' = 'left') {
  const [open, setOpen] = useState<{ subject: T; at: DOMRect } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const from = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!open || !el) return
    el.showPopover()
    placePopover(el, open.at, align)
    el.querySelector<HTMLElement>(ITEMS)?.focus()
  }, [open, align])

  const show = (subject: T, button: HTMLElement) => {
    from.current = button
    setOpen({ subject, at: button.getBoundingClientRect() })
  }
  const hide = () => ref.current?.hidePopover()

  const props = {
    ref,
    popover: 'auto' as const,
    onToggle: (e: ToggleEvent<HTMLDivElement>) => {
      if (e.newState !== 'closed') return
      const inside = !document.activeElement || document.activeElement === document.body || ref.current?.contains(document.activeElement)
      if (inside && from.current?.isConnected) from.current.focus()
      from.current = null
      setOpen(null)
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)]
      const at = items.indexOf(document.activeElement as HTMLElement)
      const to =
        e.key === 'ArrowDown' ? (at + 1) % items.length
        : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
        : e.key === 'Home' ? 0
        : e.key === 'End' ? items.length - 1
        : null
      if (to === null || !items.length) return
      e.preventDefault()
      items[to].focus()
    },
  }
  return { subject: open?.subject ?? null, show, hide, props }
}
