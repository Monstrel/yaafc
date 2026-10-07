import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

/** Where the camera looks: the content's offset in the viewport, in pixels, and its scale. */
export interface Camera {
  x: number
  y: number
  z: number
}

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 2
/** How much of the content stays in view however far it's dragged, in pixels. */
const KEEP = 80
/** Share of the way to the goal covered each frame: an ease-out of about a quarter second. */
const EASE = 0.2
/** Pointer travel before a press becomes a drag (a shorter one stays a click). */
const DRAG_START = 4

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/**
 * Pans and zooms a stage inside a viewport with a CSS transform: dragging anywhere pans (a press
 * that doesn't move stays a click), the wheel pans, Ctrl + wheel or a pinch zooms about the
 * pointer, and every change of zoom eases into place. Runs outside React: it moves the stage every
 * frame, and reports only where the zoom is going.
 */
export class PanZoom {
  private viewport: HTMLElement | null = null
  private stage: HTMLElement | null = null
  /** The content's size, to keep some of it in view. */
  private size = { w: 0, h: 0 }
  private cam: Camera = { x: 0, y: 0, z: 1 }
  private goal: Camera | null = null
  /** For a zoom about a point: the content point (wx, wy) held under the viewport point (sx, sy). */
  private pin: { sx: number; sy: number; wx: number; wy: number } | null = null
  private frame = 0
  private pointers = new Map<number, { x: number; y: number }>()
  private gesture: { start: Camera; from: { x: number; y: number; d: number }; dragging: boolean } | null = null
  /** A drag just ended: the click it ends with isn't a click on what's under it. */
  private swallow = false
  private onZoom: (z: number) => void

  constructor(onZoom: (z: number) => void) {
    this.onZoom = onZoom
  }

  /** The element the content is seen through (null to let go of it). */
  setViewport(el: HTMLElement | null) {
    // Clicks are caught on the way down, so one ending a drag never reaches what's under it.
    const listeners: [string, EventListener, boolean][] = [
      ['wheel', this.wheel as EventListener, false],
      ['pointerdown', this.down as EventListener, false],
      ['pointermove', this.move as EventListener, false],
      ['pointerup', this.up as EventListener, false],
      ['pointercancel', this.up as EventListener, false],
      ['click', this.click as EventListener, true],
    ]
    for (const [type, fn, capture] of listeners) this.viewport?.removeEventListener(type, fn, capture)
    this.viewport = el
    for (const [type, fn, capture] of listeners) el?.addEventListener(type, fn, { capture, passive: false })
  }

  setSize(size: { w: number; h: number }) {
    this.size = size
  }

  /** The element that moves. */
  setStage(el: HTMLElement | null) {
    this.stage = el
    this.apply()
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.setViewport(null)
  }

  /** Eases the camera to `to`. */
  moveTo(to: Camera, about?: { sx: number; sy: number }) {
    const target = this.bounded(to)
    // Hold the point under the pointer still, unless keeping the content in view moves it.
    const c = this.cam
    this.pin =
      about && target.x === to.x && target.y === to.y
        ? { ...about, wx: (about.sx - c.x) / c.z, wy: (about.sy - c.y) / c.z }
        : null
    this.goal = target
    this.onZoom(target.z)
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(this.step)
  }

  /** Puts the camera there at once. */
  jumpTo(to: Camera) {
    this.stop()
    this.cam = this.bounded(to)
    this.onZoom(this.cam.z)
    this.apply()
  }

  /** Zooms by `factor` about a viewport point (its center by default), easing there. */
  zoomBy(factor: number, sx?: number, sy?: number) {
    const v = this.viewport
    if (!v) return
    const z = clampZoom((this.goal ?? this.cam).z * factor)
    const px = sx ?? v.clientWidth / 2
    const py = sy ?? v.clientHeight / 2
    // The content point under (px, py) now stays there.
    const c = this.cam
    const wx = (px - c.x) / c.z
    const wy = (py - c.y) / c.z
    this.moveTo({ z, x: px - wx * z, y: py - wy * z }, { sx: px, sy: py })
  }

  private apply() {
    const { x, y, z } = this.cam
    if (this.stage) this.stage.style.transform = `translate(${x}px, ${y}px) scale(${z})`
  }

  private stop() {
    cancelAnimationFrame(this.frame)
    this.goal = null
    this.pin = null
  }

  /** Keeps some of the content in view. */
  private bounded(c: Camera): Camera {
    const v = this.viewport
    if (!v) return c
    const { w, h } = this.size
    const keepX = Math.min(KEEP, (w * c.z) / 2)
    const keepY = Math.min(KEEP, (h * c.z) / 2)
    return {
      z: c.z,
      x: Math.min(v.clientWidth - keepX, Math.max(keepX - w * c.z, c.x)),
      y: Math.min(v.clientHeight - keepY, Math.max(keepY - h * c.z, c.y)),
    }
  }

  private step = () => {
    const g = this.goal
    if (!g) return
    const c = this.cam
    const k = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : EASE
    // Zoom eases in proportion (log scale), so zooming in and out feel the same.
    let z = c.z * Math.pow(g.z / c.z, k)
    if (Math.abs(Math.log(g.z / z)) < 0.001) z = g.z
    const p = this.pin
    let x = p ? p.sx - p.wx * z : c.x + (g.x - c.x) * k
    let y = p ? p.sy - p.wy * z : c.y + (g.y - c.y) * k
    const done = z === g.z && Math.abs(x - g.x) < 0.5 && Math.abs(y - g.y) < 0.5
    if (done) {
      x = g.x
      y = g.y
    }
    this.cam = { x, y, z }
    this.apply()
    if (done) this.stop()
    else this.frame = requestAnimationFrame(this.step)
  }

  // Wheel: pan, or zoom with Ctrl (a trackpad pinch comes as Ctrl + wheel). The page never scrolls.
  private wheel = (e: WheelEvent) => {
    const v = this.viewport!
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? v.clientHeight : 1
    const r = v.getBoundingClientRect()
    if (e.ctrlKey) {
      this.zoomBy(Math.exp((-e.deltaY * unit) / 240), e.clientX - r.left, e.clientY - r.top)
      return
    }
    this.stop()
    // Shift + wheel pans sideways, for a mouse with one wheel.
    const sideways = e.shiftKey && !e.deltaX
    const dx = (sideways ? e.deltaY : e.deltaX) * unit
    const dy = (sideways ? 0 : e.deltaY) * unit
    this.cam = this.bounded({ ...this.cam, x: this.cam.x - dx, y: this.cam.y - dy })
    this.apply()
  }

  // Dragging with one pointer pans; two (touch) pinch-zoom about their midpoint.
  private local(e: PointerEvent) {
    const r = this.viewport!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private centroid() {
    const ps = [...this.pointers.values()]
    const x = ps.reduce((t, p) => t + p.x, 0) / ps.length
    const y = ps.reduce((t, p) => t + p.y, 0) / ps.length
    const d = ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 1
    return { x, y, d }
  }

  private begin() {
    this.stop()
    this.gesture = { start: { ...this.cam }, from: this.centroid(), dragging: this.gesture?.dragging ?? false }
  }

  private down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    this.pointers.set(e.pointerId, this.local(e))
    this.begin()
  }

  private move = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return
    this.pointers.set(e.pointerId, this.local(e))
    const g = this.gesture
    if (!g) return
    const now = this.centroid()
    if (!g.dragging) {
      if (Math.hypot(now.x - g.from.x, now.y - g.from.y) < DRAG_START && this.pointers.size < 2) return
      g.dragging = true
      // Only now take the pointer, so a press that doesn't move still clicks what's under it.
      this.viewport!.setPointerCapture(e.pointerId)
      this.viewport!.classList.add('dragging')
    }
    const z = clampZoom(g.start.z * (now.d / g.from.d))
    // The content point that was under the pointers' midpoint stays under it.
    const wx = (g.from.x - g.start.x) / g.start.z
    const wy = (g.from.y - g.start.y) / g.start.z
    this.cam = this.bounded({ z, x: now.x - wx * z, y: now.y - wy * z })
    if (z !== g.start.z) this.onZoom(z)
    this.apply()
  }

  private up = (e: PointerEvent) => {
    if (!this.pointers.delete(e.pointerId)) return
    const dragged = !!this.gesture?.dragging
    if (this.pointers.size) {
      this.begin()
      return
    }
    this.gesture = null
    this.viewport?.classList.remove('dragging')
    if (dragged) {
      this.swallow = true
      // No click follows a drag that ends off the content.
      setTimeout(() => (this.swallow = false), 0)
    }
  }

  private click = (e: MouseEvent) => {
    if (!this.swallow) return
    this.swallow = false
    e.stopPropagation()
    e.preventDefault()
  }
}

/**
 * A `PanZoom` for a component: ref callbacks for its viewport and stage, and the zoom it's going
 * to, for the controls. `size` is the content's size.
 */
export function usePanZoom(size: { w: number; h: number }) {
  const [zoom, setZoom] = useState(1)
  const [pz] = useState(() => new PanZoom(setZoom))
  useLayoutEffect(() => {
    pz.setSize(size)
  }, [pz, size])
  useEffect(() => () => pz.dispose(), [pz])
  const viewport = useCallback((el: HTMLElement | null) => pz.setViewport(el), [pz])
  const stage = useCallback((el: HTMLElement | null) => pz.setStage(el), [pz])
  return { zoom, pz, viewport, stage }
}
