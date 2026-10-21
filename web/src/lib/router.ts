import { useCallback, useEffect, useState } from 'react'

export type Page = 'home' | 'cauldron' | 'saved' | 'planner' | 'reference' | 'xray' | 'changelog'

export const PAGES: readonly Page[] = ['home', 'cauldron', 'saved', 'planner', 'reference', 'xray', 'changelog']

// Where the app lives: the site serves it from a subfolder, and every page sits one level under it,
// so the folder of whatever URL the app was opened at is its root. What a page shows within itself
// (the Reference's entry) goes in the query string, keeping every address one level deep.
const root = new URL('./', location.href).pathname

/** The URL of a page: the root for home, a path under it for the others; `search` starts with '?'. */
export const pageHref = (page: Page, search = '') => (page === 'home' ? root : root + page) + search

function pageAt(pathname: string): Page | undefined {
  if (pathname === root) return 'home'
  const name = pathname.startsWith(root) ? pathname.slice(root.length) : ''
  return PAGES.find((p) => p !== 'home' && p === name)
}

// Opened from one of the app's own links (say, Home in a new tab) rather than typed or bookmarked.
function fromApp(): boolean {
  try {
    const from = new URL(document.referrer)
    return from.origin === location.origin && from.pathname.startsWith(root)
  } catch {
    return false
  }
}

function startPage(last: Page): Page {
  const at = pageAt(location.pathname)
  if (at && (at !== 'home' || fromApp())) return at
  // The bare root (or a path the app doesn't know) picks up on the page visited last.
  if (location.pathname !== pageHref(last)) history.replaceState(null, '', pageHref(last) + location.search + location.hash)
  return last
}

/**
 * The page the URL shows and its query string, and a way to move to another page (or another
 * query on one) that the browser's back button can undo.
 */
export function usePage(last: Page) {
  const [page, setPage] = useState<Page>(() => startPage(last))
  const [search, setSearch] = useState(() => location.search)

  useEffect(() => {
    const onPop = () => {
      setPage(pageAt(location.pathname) ?? 'home')
      setSearch(location.search)
    }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((to: Page, query = '') => {
    if (location.pathname + location.search !== pageHref(to, query)) {
      history.pushState(null, '', pageHref(to, query))
      scrollTo(0, 0)
    }
    setPage(to)
    setSearch(query)
  }, [])

  return [page, navigate, search] as const
}
