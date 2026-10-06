import { useCallback, useEffect, useState } from 'react'

export type Page = 'home' | 'cauldron' | 'saved' | 'planner' | 'changelog'

export const PAGES: readonly Page[] = ['home', 'cauldron', 'saved', 'planner', 'changelog']

// Where the app lives: the site serves it from a subfolder, and every page sits one level under it,
// so the folder of whatever URL the app was opened at is its root.
const root = new URL('./', location.href).pathname

/** The URL of a page: the root for home, a path under it for the others. */
export const pageHref = (page: Page) => (page === 'home' ? root : root + page)

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

/** The page the URL shows, and a way to move to another one that the browser's back button can undo. */
export function usePage(last: Page) {
  const [page, setPage] = useState<Page>(() => startPage(last))

  useEffect(() => {
    const onPop = () => setPage(pageAt(location.pathname) ?? 'home')
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((to: Page) => {
    if (location.pathname !== pageHref(to)) {
      history.pushState(null, '', pageHref(to))
      scrollTo(0, 0)
    }
    setPage(to)
  }, [])

  return [page, navigate] as const
}
