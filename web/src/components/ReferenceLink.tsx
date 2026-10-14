import { useContext, type MouseEvent, type ReactNode } from 'react'
import { itemName } from '../lib/gameData'
import { isListedItem, isListedMachine, referenceSearch } from '../lib/reference'
import { ReferenceNav, type ReferenceEntry } from '../lib/referenceNav'
import { pageHref } from '../lib/router'

interface Props {
  to: ReferenceEntry
  /** The planner row the link sits in, shown again on coming back. */
  row?: string
  className?: string
  title?: string
  children: ReactNode
}

/**
 * An item or machine name that opens its Reference page: a real link (so it opens in a new tab
 * too), plain text where the Reference has no page for it.
 */
export function ReferenceLink({ to, row, className, title, children }: Props) {
  const open = useContext(ReferenceNav)
  const listed = 'item' in to ? isListedItem(to.item) : isListedMachine(to.machine)
  if (!open || !listed) return children
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    open(to, row)
  }
  return (
    <a
      href={pageHref('reference', referenceSearch(to))}
      className={className ? `reference-link ${className}` : 'reference-link'}
      title={title}
      onClick={onClick}
    >
      {children}
    </a>
  )
}

/** A small book beside an item picker, opening the picked item's Reference page. */
export function ReferenceIconLink({ item }: { item: string }) {
  const open = useContext(ReferenceNav)
  if (!item || !open || !isListedItem(item)) return null
  const name = itemName(item)
  return (
    <ReferenceLink to={{ item }} className="reference-icon" title={`${name} in the Reference`}>
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={`${name} in the Reference`}
      >
        <path d="M2.5 3c2-1 4-1 5.5.5v10c-1.5-1.5-3.5-1.5-5.5-.5zM13.5 3c-2-1-4-1-5.5.5v10c1.5-1.5 3.5-1.5 5.5-.5z" />
      </svg>
    </ReferenceLink>
  )
}
