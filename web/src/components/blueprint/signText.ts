import { CanvasTexture, Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three'

/**
 * A notice board's words, as the game writes them on it (WBP_NoticeBoardText): in a box as big as the
 * widget, 10 pixels in from its edges, the lines centred as a block (each starting at its left),
 * wrapping at 230 pixels, between words where it can and inside a word too long for a line.
 *
 * The font is the game's "NotoSans", whose Regular is Winky Sans, and it's the smaller the more
 * characters there are: 40 points under 8, 24 under 16, 20 under 32, 16 under 64, 12 from there.
 * Slate's points are at 96 dpi, a third more pixels; its lines are the font's ascent and descent
 * apart (1.015 and 0.315 em, with no gap).
 */
const PADDING = 10
const WRAP_AT = 230
const SIZES: [under: number, points: number][] = [
  [8, 40],
  [16, 24],
  [32, 20],
  [64, 16],
]
const SMALLEST = 12
const ASCENT = 1.015
const LINE = 1.33
/** The widget's colour for the words: a brown, in linear. Unlit, the game's tone curve makes it a pale tan. */
const INK = new Color().setRGB(0.489583, 0.34649, 0.224981, LinearSRGBColorSpace)
/** Canvas pixels to each of the widget's, to keep the words sharp close up. */
const SHARPNESS = 4
const FAMILY = 'Winky Sans'

/** How wide `text` is, in pixels, at `px` pixels. */
export type Measure = (text: string, px: number) => number

/** The font's size in pixels for some words, and their lines. */
export function layoutSignText(text: string, measure: Measure): { px: number; lines: string[] } {
  // Unreal's Len, as JavaScript's: UTF-16 units.
  const points = SIZES.find(([under]) => text.length < under)?.[1] ?? SMALLEST
  const px = (points * 96) / 72
  const fits = (s: string) => measure(s.trimEnd(), px) <= WRAP_AT
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ''
    for (const word of paragraph.match(/\S+\s*|\s+/g) ?? ['']) {
      if (fits(line + word)) {
        line += word
        continue
      }
      if (line) lines.push(line.trimEnd())
      line = ''
      // A word too long for a line of its own goes on, a character at a time.
      for (const c of fits(word) ? [word] : word) {
        if (line && !fits(line + c)) {
          lines.push(line.trimEnd())
          line = ''
        }
        line += c
      }
    }
    lines.push(line.trimEnd())
  }
  return { px, lines }
}

let font: Promise<unknown> | undefined

/** Loads the font notice boards write in (with the models); its fallback, should it not load, is the page's sans-serif. */
export function loadSignFont(): Promise<unknown> {
  return (font ??= new FontFace(FAMILY, `url(${new URL('models/WinkySans-Regular.ttf', document.baseURI).href})`)
    .load()
    .then((face) => document.fonts.add(face))
    .catch(() => undefined))
}

/** A notice board's words on a widget `size` pixels across and down, transparent around them. Load the font first. */
export function signTexture(text: string, [width, height]: [number, number]): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = width * SHARPNESS
  canvas.height = height * SHARPNESS
  const ctx = canvas.getContext('2d')!
  ctx.scale(SHARPNESS, SHARPNESS)
  const fontAt = (px: number) => `${px}px "${FAMILY}", sans-serif`
  const { px, lines } = layoutSignText(text, (s, px) => {
    ctx.font = fontAt(px)
    return ctx.measureText(s).width
  })
  ctx.font = fontAt(px)
  ctx.fillStyle = `#${INK.getHexString(SRGBColorSpace)}`
  const block = Math.max(...lines.map((l) => ctx.measureText(l).width))
  const left = (width - block) / 2
  // Centred down the box inside the padding; words that overflow it are cut off at the widget's edges.
  const top = PADDING + (height - 2 * PADDING - lines.length * LINE * px) / 2
  lines.forEach((line, i) => ctx.fillText(line, left, top + (i * LINE + ASCENT) * px))
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 4
  return texture
}
