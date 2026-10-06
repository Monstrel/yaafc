import { describe, expect, it } from 'vitest'
import { parseChangelog, releases } from './changelog'

describe('changelog', () => {
  it('lists every release newest first, each with changes', () => {
    expect(releases.length).toBeGreaterThan(0)
    for (const [i, r] of releases.entries()) {
      expect(r.changes.length, r.date.toISOString()).toBeGreaterThan(0)
      if (i > 0) expect(r.date.getTime(), r.date.toISOString()).toBeLessThan(releases[i - 1].date.getTime())
    }
  })

  it('joins wrapped lines and skips the preamble', () => {
    const parsed = parseChangelog('# Changelog\n\nAbout.\n\n## 2026-01-02T03:04Z\n\n- One\n  continued.\n- Two\n')
    expect(parsed).toEqual([{ date: new Date('2026-01-02T03:04Z'), changes: ['One continued.', 'Two'] }])
  })

  it('rejects headings and lines it cannot place', () => {
    expect(() => parseChangelog('## 2026-01-02\n- One')).toThrow(/line 1/)
    expect(() => parseChangelog('## 2026-01-02T03:04Z\nstray')).toThrow(/line 2/)
  })
})
