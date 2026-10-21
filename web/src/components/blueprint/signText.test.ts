import { describe, expect, test } from 'vitest'
import { layoutSignText } from './signText'

// Every character half its size wide.
const measure = (s: string, px: number) => s.length * px * 0.5

describe('layoutSignText', () => {
  test('the more characters, the smaller the font, as the game picks it (points at 96 dpi)', () => {
    const px = (n: number) => layoutSignText('x'.repeat(n), measure).px
    expect([px(7), px(8), px(15), px(16), px(31), px(32), px(63), px(64), px(200)]).toEqual(
      [40, 24, 24, 20, 20, 16, 16, 12, 12].map((pt) => (pt * 4) / 3),
    )
  })

  test('wraps between words at 230 pixels, without the spaces at the ends of lines', () => {
    // 24 points is 32 px, 16 a character: 14 characters to a line.
    expect(layoutSignText('This is a sign', measure).lines).toEqual(['This is a sign'])
    // 20 points: 13.3 px, 17 characters to a line.
    expect(layoutSignText('Iron ingots go to the left', measure).lines).toEqual(['Iron ingots go to', 'the left'])
  })

  test('breaks a word too long for a line inside it', () => {
    const { lines } = layoutSignText('a ' + 'x'.repeat(30), measure)
    // 16 points: 21.3 px, 21 characters to a line.
    expect(lines).toEqual(['a', 'x'.repeat(21), 'x'.repeat(9)])
  })

  test('keeps the lines the player wrote, and their empty ones', () => {
    expect(layoutSignText('Up\n\nDown', measure).lines).toEqual(['Up', '', 'Down'])
  })
})
