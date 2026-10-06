import type { MouseEvent, ReactNode } from 'react'
import { pageHref, type Page } from '../lib/router'

interface Props {
  page: Page
  onNavigate: (page: Page) => void
  current?: boolean
  className?: string
  children: ReactNode
}

/** A real link to a page, so it can be opened in a new tab; a plain click switches pages in place. */
export function PageLink({ page, onNavigate, current, className, children }: Props) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onNavigate(page)
  }
  return (
    <a href={pageHref(page)} className={className} aria-current={current ? 'page' : undefined} onClick={onClick}>
      {children}
    </a>
  )
}
