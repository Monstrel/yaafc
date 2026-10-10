/** Space kept between a popover and the viewport's edges. */
export const MARGIN = 8
/** Space between a popover and what it opens from. */
export const GAP = 4
/** Less room than this on both sides: a popover covers its anchor rather than shrink to a sliver. */
const MIN_ROOM = 160

/**
 * Which side of its anchor a popover this tall opens on: below when it fits, above when only that
 * fits, else the roomier side. With the room it has there, which may be less than it needs.
 */
export function popoverSide(anchor: DOMRect, height: number): { up: boolean; room: number } {
  const below = document.documentElement.clientHeight - anchor.bottom - GAP - MARGIN
  const above = anchor.top - GAP - MARGIN
  const up = height > below && (height <= above || above > below)
  return { up, room: up ? above : below }
}

/**
 * Places a shown, fixed popover by its anchor (see `popoverSide`), scrolling inside when it doesn't
 * fit. Lined up with the anchor's left (or right) edge, and kept inside the viewport. The room it
 * gets is set as `--popover-room`, for its CSS max-height.
 */
export function placePopover(el: HTMLElement, anchor: DOMRect, align: 'left' | 'right' = 'left') {
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  // Measured at its own size (within the viewport), before any room it was given last time.
  el.style.removeProperty('--popover-room')
  const width = el.offsetWidth
  const height = el.offsetHeight
  const { up, room } = popoverSide(anchor, height)
  el.style.left = `${Math.max(MARGIN, Math.min(align === 'right' ? anchor.right - width : anchor.left, vw - width - MARGIN))}px`
  if (room < Math.min(height, MIN_ROOM)) {
    // Too tight either way: as close to the anchor as fits, over it if need be.
    el.style.top = `${Math.max(MARGIN, Math.min(anchor.bottom + GAP, vh - height - MARGIN))}px`
    el.style.bottom = 'auto'
  } else {
    // Pinned by the edge next to the anchor, so it stays there as its content grows or shrinks.
    el.style.top = up ? 'auto' : `${anchor.bottom + GAP}px`
    el.style.bottom = up ? `${vh - anchor.top + GAP}px` : 'auto'
    el.style.setProperty('--popover-room', `${room}px`)
  }
}
