import type { MouseEvent, ReactNode } from 'react'
import { pageHref, type Page } from '../lib/router'
import { preloadPage } from '../pages/lazyPages'

interface Props {
  page: Page
  /** The page's query string, starting with '?'. */
  search?: string
  onNavigate: (page: Page, search?: string) => void
  current?: boolean
  className?: string
  title?: string
  children: ReactNode
}

/**
 * A real link to a page, so it can be opened in a new tab; a plain click switches pages in place.
 * The page starts downloading once the pointer or focus reaches the link, so it's there by the click.
 */
export function PageLink({ page, search, onNavigate, current, className, title, children }: Props) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onNavigate(page, search)
  }
  const preload = () => preloadPage(page)
  return (
    <a
      href={pageHref(page, search)}
      className={className}
      title={title}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      onPointerEnter={preload}
      onFocus={preload}
    >
      {children}
    </a>
  )
}
