import { describe, expect, it } from 'vitest'
import { noteFor, noteProblems, parseNote, readNotes } from './notes'

describe('Reference notes', () => {
  it('reads every note, each named after an item or machine and linking only to real ones', () => {
    expect(noteProblems).toEqual([])
    expect(noteFor('machine', 'WorldTreeNursery')?.blocks.length).toBeGreaterThan(0)
    expect(noteFor('item', 'IronIngot')).toBeUndefined()
  })

  it('reports notes for nothing, links to nothing, and notes it can’t read', () => {
    const read = readNotes({
      '../../../reference/machines/NotAMachine.md': 'Hi.',
      '../../../reference/items/IronIngot.md': 'See [this](machine:Nowhere).',
      '../../../reference/items/Brick.md': '# Brick',
      '../../../reference/items/Glass.md': 'Fine.',
    })
    expect(read.problems).toEqual([
      'reference/machines/NotAMachine.md: no machine is called NotAMachine',
      'reference/items/IronIngot.md: links to {"machine":"Nowhere"}, which isn\'t in the game data',
      'reference/items/Brick.md line 1: headings are ## or ### (the page has the # title)',
    ])
    expect([...read.item.keys()]).toEqual(['IronIngot', 'Glass'])
  })

  it('joins lines into paragraphs, and reads headings and lists', () => {
    expect(parseNote('One\ntwo.\n\n## Head\n\n- a\n  more\n- b\n\n1. first\n2. second\nAfter.')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'One two.' }] },
      { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Head' }] },
      { kind: 'list', ordered: false, items: [[{ kind: 'text', text: 'a more' }], [{ kind: 'text', text: 'b' }]] },
      { kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'first' }], [{ kind: 'text', text: 'second' }]] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'After.' }] },
    ])
  })

  it('keeps a paragraph after a list together', () => {
    expect(parseNote('1. item\n\nOne\ntwo.')).toEqual([
      { kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'item' }]] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'One two.' }] },
    ])
  })

  it('reads emphasis, code, escapes and links', () => {
    const [p] = parseNote('**Bold *and* em** `x*y` \\*not\\* [Leaf](item:WorldTreeLeaf) [web](https://example.com) snake_case_word')
    expect(p).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'strong', children: [{ kind: 'text', text: 'Bold ' }, { kind: 'em', children: [{ kind: 'text', text: 'and' }] }, { kind: 'text', text: ' em' }] },
        { kind: 'text', text: ' ' },
        { kind: 'code', text: 'x*y' },
        { kind: 'text', text: ' *not* ' },
        { kind: 'link', to: { item: 'WorldTreeLeaf' }, children: [{ kind: 'text', text: 'Leaf' }] },
        { kind: 'text', text: ' ' },
        { kind: 'link', to: { url: 'https://example.com' }, children: [{ kind: 'text', text: 'web' }] },
        { kind: 'text', text: ' snake_case_word' },
      ],
    })
  })

  it('refuses what it doesn’t draw, saying where', () => {
    expect(() => parseNote('# Title')).toThrow(/line 1: headings/)
    expect(() => parseNote('- a\n  - b')).toThrow(/line 2: lists can’t be nested/)
    expect(() => parseNote('ok\n\n[x](javascript:alert(1))')).toThrow(/line 3: links go to/)
    expect(() => parseNote('```\ncode\n```')).toThrow(/line 1: quotes, code blocks/)
    expect(() => parseNote('text\n  indented')).toThrow(/line 2: an indented line/)
  })
})
