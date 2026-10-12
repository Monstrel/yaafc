import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoredValue, TabBuild } from './store'

// One browser's localStorage, shared by the "tabs" below; `writes` counts what each test stores.
let storage: Map<string, string>
let writes: string[]
beforeEach(() => {
  storage = new Map()
  writes = []
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push(k)
      storage.set(k, v)
    },
    removeItem: (k: string) => storage.delete(k),
  })
})
afterEach(() => vi.unstubAllGlobals())

interface Data {
  a: number
  b: number
}
// Like the app's sanitizers: rebuilds the value, keys in its own order.
const sanitize = (v: unknown): Data | undefined => {
  const d = v as Partial<Data>
  return typeof d?.a === 'number' && typeof d.b === 'number' ? { a: d.a, b: d.b } : undefined
}
const KEY = 'alchemy-calculator:data'
/** A tab of the app holding the data, running `build`. */
const tab = (build: TabBuild) => {
  const value = new StoredValue<Data>('data', () => ({ a: 0, b: 0 }), sanitize, build)
  return { value, start: value.load() }
}

describe('sharing stored data between tabs', () => {
  it('saves a value made from nothing, and not one read back', () => {
    const first = tab(new TabBuild(5))
    expect(first.value.save(first.start)).toBe(true)
    expect(writes).toEqual(['alchemy-calculator:build-run', KEY])

    // Stored in another key order than sanitize gives: reading it isn't a change to save.
    storage.set(KEY, JSON.stringify({ b: 2, a: 1 }))
    writes = []
    const next = tab(new TabBuild(5))
    expect(next.start).toEqual({ a: 1, b: 2 })
    next.value.save(next.start)
    expect(writes).toEqual([])
  })

  it("doesn't save back what it takes from another tab", () => {
    const one = tab(new TabBuild(5))
    const two = tab(new TabBuild(5))
    one.value.save({ b: 3, a: 4 } as Data) // edits build objects in their own key order
    writes = []

    const taken = two.value.pull()
    expect(taken).toEqual({ value: { a: 4, b: 3 } })
    two.value.save(taken!.value)
    expect(writes).toEqual([])
    // So the tab that made the change sees nothing new (and keeps its undo history).
    expect(one.value.pull()).toBeUndefined()
    expect(two.value.pull()).toBeUndefined()
  })

  it('starts over without saving when another tab drops the value', () => {
    const one = tab(new TabBuild(5))
    one.value.save({ a: 1, b: 1 })
    storage.delete(KEY)
    writes = []
    const taken = one.value.pull()
    expect(taken).toEqual({ value: { a: 0, b: 0 } })
    one.value.save(taken!.value)
    expect(writes).toEqual([])
  })

  it('stops a tab running an older build once a newer one saves', () => {
    const older = new TabBuild(4)
    const heard = vi.fn()
    older.subscribe(heard)
    const one = tab(older)
    const two = tab(new TabBuild(5))
    expect(one.value.save({ a: 1, b: 1 })).toBe(true)
    expect(two.value.pull()).toEqual({ value: { a: 1, b: 1 } })

    two.value.save({ a: 2, b: 2 })
    expect(storage.get('alchemy-calculator:build-run')).toBe('5')
    // The older tab takes nothing in, and saves nothing over it.
    expect(one.value.pull()).toBeUndefined()
    expect(older.outdated).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(one.value.save({ a: 9, b: 9 })).toBe(false)
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ a: 2, b: 2 })
    expect(storage.get('alchemy-calculator:build-run')).toBe('5')
  })

  it('opens outdated when a newer build saved last, and not when an older one did', () => {
    storage.set('alchemy-calculator:build-run', '5')
    expect(new TabBuild(4).outdated).toBe(true)
    expect(new TabBuild(5).outdated).toBe(false)
    const newer = tab(new TabBuild(6))
    newer.value.save({ a: 1, b: 2 })
    expect(storage.get('alchemy-calculator:build-run')).toBe('6')
  })
})
