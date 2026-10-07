import { type RefObject, useEffect } from 'react'

/*
 * Moves animate: every `data-flip` element under a root glides from where it was to where it is
 * now whenever the DOM under the root changes (FLIP: measure, invert, play), and new ones fade in.
 *
 * And the row you just used stays put: after a click or key press, a change that moves the
 * element it happened in scrolls the page to keep that element where it was on screen, so a
 * re-sorted tree moves around it instead of carrying it away. That lasts until you scroll, a jump
 * scrolls elsewhere (releaseScrollAnchor), or a while passes (solves come back from a worker).
 * When the change moves what was used to an element of its own (a row built separately is
 * gathered elsewhere), followScrollAnchor says which one: the page follows it there instead.
 */

const DURATION = 280
const EASING = 'cubic-bezier(0.2, 0, 0, 1)'
const FADE = 180
/** How long after an interaction its element is still kept in place. */
const ARMED_FOR = 10_000

type Box = { x: number; y: number; w: number; h: number }
type Anchor = { key: string; top: number; at: number }
/** Picks, from the keys a change brought in (in page order), the one the held element became. */
type Follow = (fresh: string[]) => string | undefined
type Holder = { anchor: Anchor | null; follow: (to: Follow) => void; following: { to: Follow; known: Set<string> } | null }

const anchored = new Set<Holder>()

/** Lets the page scroll elsewhere (a jump to a row): stop holding the last-used element in place. */
export function releaseScrollAnchor() {
  for (const a of anchored) {
    a.anchor = null
    a.following = null
  }
}

/**
 * The element just used is moving to a new element (a row gathered elsewhere): once a change brings
 * in the one `to` picks, hold that one in place instead, starting from where the old one was.
 */
export function followScrollAnchor(to: Follow) {
  for (const a of anchored) a.follow(to)
}

const keyOf = (el: Element) => (el as HTMLElement).dataset.flip!
const pageBox = (el: Element): Box => {
  const r = el.getBoundingClientRect()
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
}

/**
 * Animates the `data-flip` elements under `root` to their new places, keeping the one last
 * interacted with in place on screen. `fallback` names the element to hold instead when that one
 * is gone (its parent row, say).
 */
export function useFlip(root: RefObject<HTMLElement | null>, fallback?: (key: string) => string | null) {
  useEffect(() => {
    const host = root.current
    if (!host) return
    const self: Holder = {
      anchor: null,
      following: null,
      follow: (to) => {
        if (self.anchor) self.following = { to, known: new Set(elements().keys()) }
      },
    }
    anchored.add(self)
    const running = new Map<Element, Animation[]>()
    let boxes = new Map<string, Box>()
    let dirty = false
    // Where our own scrolling left the page: any other scroll is the user's, and lets go.
    let expectedY = scrollY
    // Where the page was scrolled when last drawn. The browser's own scroll anchoring can move it
    // as a change is laid out, before anything is drawn there.
    let shownY = scrollY

    const elements = () => {
      const out = new Map<string, Element>()
      for (const el of host.querySelectorAll('[data-flip]')) out.set(keyOf(el), el)
      return out
    }
    const measure = () => {
      boxes = new Map([...elements()].map(([k, el]) => [k, pageBox(el)]))
      dirty = false
    }
    const track = (el: Element, animation: Animation) => {
      running.set(el, [...(running.get(el) ?? []), animation])
      const done = () => {
        const left = (running.get(el) ?? []).filter((a) => a !== animation)
        if (left.length) running.set(el, left)
        else running.delete(el)
        if (!running.size && dirty) measure()
      }
      animation.addEventListener('finish', done)
      animation.addEventListener('cancel', done)
    }

    const flip = () => {
      // Elements caught mid-move start again from where they are on screen, not where they began.
      const before = new Map(boxes)
      for (const el of running.keys()) if (el.isConnected) before.set(keyOf(el), pageBox(el))
      for (const list of [...running.values()]) for (const a of list) a.cancel()
      running.clear()

      const now = elements()
      const after = new Map([...now].map(([k, el]) => [k, pageBox(el)]))
      const scrolledFrom = shownY

      // What was used became a new element: hold that one, coming from where the old one was.
      if (self.anchor && self.following) {
        const { to, known } = self.following
        const key = to([...now.keys()].filter((k) => !known.has(k)))
        if (key) {
          const was = before.get(self.anchor.key)
          if (was) before.set(key, was)
          self.anchor = { ...self.anchor, key }
          self.following = null
        }
      }

      // Keep the element last used where it was on screen.
      const anchor = self.anchor
      if (anchor && performance.now() - anchor.at < ARMED_FOR) {
        let key: string | null = anchor.key
        while (key !== null && !now.has(key)) key = fallback?.(key) ?? null
        const el = key === null ? undefined : now.get(key)
        if (el) {
          const shift = el.getBoundingClientRect().top - anchor.top
          if (Math.abs(shift) >= 1) scrollTo({ left: scrollX, top: scrollY + shift, behavior: 'instant' })
          expectedY = scrollY
          self.anchor = { ...anchor, key: key! }
        }
      } else {
        self.anchor = null
        self.following = null
      }
      const scrolled = scrollY - scrolledFrom
      shownY = scrollY

      boxes = after
      dirty = false
      if (!before.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return

      // How far each element moved on screen. One holding others moves as a whole only while it
      // fits on screen (a panel taller than that would drag rows far off screen into view): the
      // ones in it then move by what it doesn't, and all of them, so none is left behind.
      const moving = new Map<Element, { dx: number; dy: number }>()
      const seen = (b: Box, y: number) => b.y - y + b.h > 0 && b.y - y < innerHeight
      for (const [key, el] of now) {
        // Parents come before their children in document order.
        let up = el.parentElement?.closest('[data-flip]')
        while (up && host.contains(up) && !moving.has(up)) up = up.parentElement?.closest('[data-flip]')
        const by = up && host.contains(up) ? moving.get(up) : undefined
        const was = before.get(key)
        const is = after.get(key)!
        if (!was) {
          if (by || seen(is, scrollY)) track(el, el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE, easing: 'ease-out' }))
          continue
        }
        if (!by && !seen(was, scrolledFrom) && !seen(is, scrollY)) continue
        const holds = el.querySelector('[data-flip]') !== null
        if (holds && is.h > innerHeight) continue
        const dx = was.x - is.x
        const dy = was.y - is.y + scrolled
        const x = dx - (by?.dx ?? 0)
        const y = dy - (by?.dy ?? 0)
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue
        if (holds) moving.set(el, { dx, dy })
        track(el, el.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], { duration: DURATION, easing: EASING }))
      }
    }

    // Layout that changes without the DOM changing (a resize) only needs measuring again.
    const remeasure = () => {
      if (running.size) dirty = true
      else measure()
    }

    // The element an interaction happened in. In a menu or dialog, the one that opened it (the
    // press that opened it picked it) stays the one held.
    const interact = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null
      if (!target) return
      const inMenu = !!target.closest('[popover], dialog')
      const el = target.closest('[data-flip]')
      const key = inMenu ? self.anchor?.key : el && host.contains(el) ? keyOf(el) : undefined
      if (!inMenu) self.following = null
      const held = key === undefined ? undefined : elements().get(key)
      self.anchor = key && held ? { key, top: held.getBoundingClientRect().top, at: performance.now() } : null
      expectedY = scrollY
    }
    const onScroll = () => {
      shownY = scrollY
      if (Math.abs(scrollY - expectedY) > 2) {
        self.anchor = null
        self.following = null
      }
    }

    measure()
    // Microtasks run before the next paint, so the inverted frame is the first one drawn.
    const observer = new MutationObserver(flip)
    observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] })
    const resize = new ResizeObserver(remeasure)
    resize.observe(host)
    document.addEventListener('pointerdown', interact, true)
    document.addEventListener('keydown', interact, true)
    addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      resize.disconnect()
      document.removeEventListener('pointerdown', interact, true)
      document.removeEventListener('keydown', interact, true)
      removeEventListener('scroll', onScroll)
      for (const list of running.values()) for (const a of list) a.cancel()
      anchored.delete(self)
    }
  }, [root, fallback])
}
