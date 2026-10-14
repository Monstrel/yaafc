import { buildingsByKey, itemsByKey } from './gameData'
import { groupByKey } from './referenceGroups'

// Free-text notes for the Reference's pages: reference/items/<item or group key>.md and
// reference/machines/<building key>.md at the repository's root, written in a small part of
// Markdown (see reference/README.md) and drawn as React elements, never as HTML.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em'; children: Inline[] }
  /** To another Reference page (`item:Key`, `machine:Key`), or a web address. */
  | { kind: 'link'; to: { item: string } | { machine: string } | { url: string }; children: Inline[] }

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 2 | 3; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }

const LIST_ITEM = /^(?:[-*]|(\d+)\.)\s+(.*)$/

/**
 * Reads a note: paragraphs (lines joined until a blank one), `##`/`###` headings, and `-`, `*` or
 * `1.` lists whose items continue on indented lines. Throws on what it can't place, so a malformed
 * note fails the tests instead of a page.
 */
export function parseNote(source: string): Block[] {
  const blocks: Block[] = []
  // The paragraph or list item being read, its lines kept until it's complete.
  let open: { item: boolean; lines: string[]; done: (text: string) => void } | null = null
  const close = () => {
    if (open) open.done(open.lines.join(' '))
    open = null
  }
  source.split(/\r?\n/).forEach((raw, i) => {
    const fail = (why: string): never => {
      throw new Error(`line ${i + 1}: ${why}`)
    }
    const line = raw.trimEnd()
    if (!line.trim()) return close()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      close()
      const level = heading[1].length
      if (level !== 2 && level !== 3) fail('headings are ## or ### (the page has the # title)')
      blocks.push({ kind: 'heading', level: level as 2 | 3, children: parseInline(heading[2], fail) })
      return
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      close()
      const ordered = item[1] !== undefined
      let list = blocks.at(-1)
      if (list?.kind !== 'list' || list.ordered !== ordered) blocks.push((list = { kind: 'list', ordered, items: [] }))
      const items = list.items
      open = { item: true, lines: [item[2]], done: (text) => items.push(parseInline(text, fail)) }
      return
    }
    if (/^\s/.test(line)) {
      if (!open?.item) fail('an indented line continues a list item')
      if (LIST_ITEM.test(line.trim())) fail('lists can’t be nested')
      open!.lines.push(line.trim())
      return
    }
    if (/^(>|```|\||---)/.test(line)) fail('quotes, code blocks, tables and rules aren’t supported')
    // A line that isn't indented ends a list item, and starts a paragraph or continues one.
    if (open?.item) close()
    if (!open)
      open = { item: false, lines: [], done: (text) => blocks.push({ kind: 'paragraph', children: parseInline(text, fail) }) }
    open.lines.push(line.trim())
  })
  close()
  return blocks
}

const ENTRY = /^(item|machine):(.+)$/

/** `**strong**`, `*em*` or `_em_`, `` `code` ``, `[text](to)` and `\` escapes. */
function parseInline(text: string, fail: (why: string) => never): Inline[] {
  const out: Inline[] = []
  const push = (s: string) => {
    const last = out.at(-1)
    if (last?.kind === 'text') last.text += s
    else if (s) out.push({ kind: 'text', text: s })
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m: RegExpExecArray | null
    if (rest[0] === '\\' && rest.length > 1) {
      push(rest[1])
      i += 2
    } else if ((m = /^`([^`]+)`/.exec(rest))) {
      out.push({ kind: 'code', text: m[1] })
      i += m[0].length
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      const entry = ENTRY.exec(m[2])
      const to = entry
        ? entry[1] === 'item'
          ? { item: entry[2] }
          : { machine: entry[2] }
        : /^https?:\/\//.test(m[2])
          ? { url: m[2] }
          : fail(`links go to item:Key, machine:Key or an http(s) address, not ${m[2]}`)
      out.push({ kind: 'link', to, children: parseInline(m[1], fail) })
      i += m[0].length
    } else if ((m = /^\*\*(.+?)\*\*/.exec(rest))) {
      out.push({ kind: 'strong', children: parseInline(m[1], fail) })
      i += m[0].length
    } else if ((m = /^(\*|_)(?=\S)(.+?)(?<=\S)\1(?!\w)/.exec(rest))) {
      out.push({ kind: 'em', children: parseInline(m[2], fail) })
      i += m[0].length
    } else {
      push(rest[0])
      i += 1
    }
  }
  return out
}

// ---- The notes ----

const files = import.meta.glob<string>('../../../reference/{items,machines}/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export interface Note {
  blocks: Block[]
  /** The file, for messages about it. */
  file: string
}

const exists = (to: { item: string } | { machine: string }) =>
  'item' in to ? itemsByKey.has(to.item) || !!groupByKey(to.item) : buildingsByKey.has(to.machine)

function* links(inlines: Inline[]): Generator<Extract<Inline, { kind: 'link' }>> {
  for (const x of inlines) {
    if (x.kind === 'link') yield x
    if ('children' in x) yield* links(x.children)
  }
}

export interface Notes {
  item: Map<string, Note>
  machine: Map<string, Note>
  /** What's wrong with them: a file that can't be read, or names or links to nothing. */
  problems: string[]
}

/** Reads note files, by path (…/reference/items/<key>.md or …/reference/machines/<key>.md). */
export function readNotes(sources: Record<string, string>): Notes {
  const read: Notes = { item: new Map(), machine: new Map(), problems: [] }
  for (const [path, source] of Object.entries(sources)) {
    const file = path.slice(path.indexOf('reference/'))
    const [, folder, key] = /reference\/(items|machines)\/(.+)\.md$/.exec(path)!
    const kind = folder === 'items' ? 'item' : 'machine'
    if (!exists(kind === 'item' ? { item: key } : { machine: key })) {
      read.problems.push(`${file}: no ${kind} is called ${key}`)
      continue
    }
    try {
      const blocks = parseNote(source)
      for (const b of blocks)
        for (const l of links(b.kind === 'list' ? b.items.flat() : b.children))
          if (!('url' in l.to) && !exists(l.to)) read.problems.push(`${file}: links to ${JSON.stringify(l.to)}, which isn't in the game data`)
      read[kind].set(key, { blocks, file })
    } catch (e) {
      read.problems.push(`${file} ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return read
}

const notes = readNotes(files)

/** What's wrong with the notes: the tests fail on any. */
export const noteProblems = notes.problems

/** The note written for an item or a machine, if any. */
export const noteFor = (kind: 'item' | 'machine', key: string): Note | undefined => notes[kind].get(key)
