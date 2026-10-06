import { describe, expect, it } from 'vitest'
import type { Plan } from './types'
import { apply, diff, EMPTY_HISTORY, MAX_STEPS, MERGE_MS, record, redo, undo, type History, type Snapshot } from './undo'

const plan = (id: string, name = id): Plan => ({ id, name, targets: [], producers: {}, machines: {} })
const data = (plans: Plan[], rest: Partial<Snapshot> = {}): Snapshot => ({
  plans,
  saved: [],
  myDefaults: {},
  progress: { upgrades: {} },
  ...rest,
})
const rename = (s: Snapshot, id: string, name: string) => ({ ...s, plans: s.plans.map((p) => (p.id === id ? { ...p, name } : p)) })

describe('undo', () => {
  it('puts back what a change touched, and redo puts the change back', () => {
    const a = data([plan('a'), plan('b')])
    const b = rename(a, 'a', 'Brandy')
    const h = record(EMPTY_HISTORY, 'Rename plan', a, b, 0)
    const back = undo(h, b)!
    expect(back.label).toBe('Rename plan')
    expect(back.snapshot).toEqual(a)
    expect(back.plan).toBe('a')
    const again = redo(back.history, back.snapshot)!
    expect(again.snapshot).toEqual(b)
    expect(again.history.undo).toHaveLength(1)
    expect(again.history.redo).toHaveLength(0)
  })

  it('brings a deleted plan back in its place, and shows it', () => {
    const a = data([plan('a'), plan('b'), plan('c')])
    const b = { ...a, plans: [a.plans[0], a.plans[2]] }
    const back = undo(record(EMPTY_HISTORY, 'Delete plan', a, b, 0), b)!
    expect(back.snapshot.plans.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(back.plan).toBe('b')
  })

  it('leaves plans the step did not touch as they are now', () => {
    const a = data([plan('a'), plan('b')])
    const b = rename(a, 'a', 'Brandy')
    const h = record(EMPTY_HISTORY, 'Rename plan', a, b, 0)
    // Changed since without a step of its own (upkeep the app did by itself).
    const c = rename(b, 'b', 'Tidied')
    expect(undo(h, c)!.snapshot.plans.map((p) => p.name)).toEqual(['a', 'Tidied'])
  })

  it('keeps only the slices a change touched', () => {
    const a = data([plan('a')])
    const b = { ...a, progress: { upgrades: { Conveyer: 2 } } }
    expect(diff(a, b)).toEqual({ progress: a.progress })
    expect(diff(a, { ...a })).toBeNull()
    expect(apply(b, diff(a, b)!)).toEqual(a)
  })

  it('makes one step of quick repeats of one change, such as typing', () => {
    let s = data([plan('a')])
    const first = s
    let h: History = EMPTY_HISTORY
    for (const [i, name] of ['B', 'Br', 'Bra'].entries()) {
      const next = rename(s, 'a', name)
      h = record(h, 'Rename plan', s, next, i * 300)
      s = next
    }
    expect(h.undo).toHaveLength(1)
    expect(undo(h, s)!.snapshot).toEqual(first)
    // Slower, or a different change, is a step of its own.
    const later = rename(s, 'a', 'Bran')
    expect(record(h, 'Rename plan', s, later, 600 + MERGE_MS).undo).toHaveLength(2)
    expect(record(h, 'Change Conveyer level', s, later, 700).undo).toHaveLength(2)
  })

  it('drops a step its own quick repeat took back', () => {
    const a = data([plan('a')])
    const b = rename(a, 'a', 'x')
    const h = record(EMPTY_HISTORY, 'Toggle', a, b, 0)
    expect(record(h, 'Toggle', b, rename(b, 'a', 'a'), 100).undo).toHaveLength(0)
  })

  it('forgets what was undone once something new is done', () => {
    const a = data([plan('a')])
    const b = rename(a, 'a', 'b')
    const back = undo(record(EMPTY_HISTORY, 'Rename plan', a, b, 0), b)!
    const h = record(back.history, 'Change research tier', back.snapshot, { ...back.snapshot, progress: { upgrades: {}, tier: 2 } }, 5000)
    expect(h.redo).toHaveLength(0)
    expect(h.undo.map((s) => s.label)).toEqual(['Change research tier'])
  })

  it('keeps at most a set number of steps', () => {
    let s = data([plan('a')])
    let h: History = EMPTY_HISTORY
    for (let i = 0; i < MAX_STEPS + 5; i++) {
      const next = rename(s, 'a', String(i))
      h = record(h, `Step ${i}`, s, next, i * 10_000)
      s = next
    }
    expect(h.undo).toHaveLength(MAX_STEPS)
    expect(h.undo[0].label).toBe('Step 5')
  })
})
