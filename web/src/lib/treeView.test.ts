import { describe, expect, it } from 'vitest'
import type { TreeNode } from './tree'
import { blankRow, checklistOf, layoutLines, placeAll, shareOf, withReused } from './treeView'

/** A row of `item` with the given fields and children. */
const row = (id: string, item: string, fields: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  ...blankRow(id, children),
  item,
  ...fields,
})

describe('the tree as shown', () => {
  it('shows the part of an ingredient other rows leave over on a line of its own, above what its row makes, gathered', () => {
    const sand = row('0/Glass/Sand', 'Sand', { rate: 10, fromByproduct: 4, byproductSources: [{ id: '0/Glass/Salt', label: 'Salt' }] })
    const shown = withReused(row('0/Glass', 'Glass', { rate: 1 }, [sand]))
    const [gather] = shown.children
    expect([gather.id, gather.kind, gather.rate]).toEqual(['0/Glass/Sand#sources', 'gather', 10])
    expect(gather.children.map((c) => [c.id, c.kind, c.rate])).toEqual([
      ['0/Glass/Sand#reused', 'byproduct', 4],
      ['0/Glass/Sand', 'produce', 6],
    ])
  })

  it('leaves an ingredient whole when leftovers cover all or none of it', () => {
    const all = row('0/Glass/Sand', 'Sand', { rate: 10, fromByproduct: 10 })
    const none = row('0/Glass/Salt', 'Salt', { rate: 3 })
    expect(withReused(row('0/Glass', 'Glass', {}, [all, none])).children.map((c) => c.id).sort()).toEqual(['0/Glass/Salt', '0/Glass/Sand'])
  })

  it('draws a card edge down each open branch, and none into a folded one', () => {
    const tree = [row('0/A', 'A', {}, [row('0/A/B', 'B', {}, [row('0/A/B/C', 'C')]), row('0/A/D', 'D')])]
    const open = layoutLines(tree, new Set())
    expect(open.map((l) => (l.kind === 'row' ? l.node.id : 'with'))).toEqual(['0/A', '0/A/B', '0/A/B/C', '0/A/D'])
    expect(open.map((l) => l.edges.map((e) => `${e.level}${e.piece[0]}`).join(' '))).toEqual(['0t', '1t 0m', '1b 0m', '0b'])
    const folded = layoutLines(tree, new Set(['0/A/B']))
    expect(folded.map((l) => (l.kind === 'row' ? l.node.id : 'with'))).toEqual(['0/A', '0/A/B', '0/A/D'])
  })

  it('splits every amount of a row built in units among its copies', () => {
    const n = row('0/A', 'A', { rate: 12, machines: 3, overflow: 6 })
    expect(shareOf(n, 3)).toMatchObject({ rate: 4, machines: 1, overflow: 2 })
  })
})

describe('the build checklist', () => {
  const machine = { run: { process: { machine: { key: 'M' } } } } as unknown as Partial<TreeNode>
  const view = [
    row('0/A', 'A', machine, [row('0/A/B', 'B', machine), row('0/A/C', 'C', machine), row('0/A/D', 'D', { kind: 'separate', groupId: 'separate/D' })]),
    row('separate/D', 'D', machine),
  ]
  const byId = new Map(placeAll(view).map((p) => [p.node.id, p]))

  it('counts the rows with machines, and those marked built, in each branch', () => {
    const list = checklistOf(view, byId, new Set(['0/A/B']))
    expect(list).toMatchObject({ rows: 4, done: 1 })
    expect(list.below.get('0/A')).toEqual({ rows: 2, built: 1 })
  })

  it('shows a row pointing to machines built elsewhere as built', () => {
    expect(checklistOf(view, byId, new Set()).auto.has('0/A/D')).toBe(false)
    expect(checklistOf(view, byId, new Set(['separate/D'])).auto.has('0/A/D')).toBe(true)
  })
})
