import text from '../../../CHANGELOG.md?raw'

/** One deployed update: when it went live, and what changed, one line per change. */
export interface Release {
  date: Date
  changes: string[]
}

const HEADING = /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)\s*$/

/**
 * Reads CHANGELOG.md: each `## <UTC time>` heading starts a release, `- ` starts a change, and an
 * indented line continues the change above it. Anything before the first release is the file's own
 * preamble. Throws on lines it can't place, so a malformed edit fails the tests instead of a page.
 */
export function parseChangelog(source: string): Release[] {
  const releases: Release[] = []
  source.split(/\r?\n/).forEach((line, i) => {
    const fail = (why: string) => {
      throw new Error(`CHANGELOG.md line ${i + 1}: ${why}`)
    }
    const heading = HEADING.exec(line)
    const release = releases.at(-1)
    if (heading) {
      const date = new Date(heading[1])
      if (Number.isNaN(date.getTime())) fail(`invalid date ${heading[1]}`)
      releases.push({ date, changes: [] })
    } else if (line.startsWith('## ')) {
      fail('a release heading is "## YYYY-MM-DDTHH:MMZ"')
    } else if (!release || !line.trim()) {
      // The preamble, or a blank line.
    } else if (line.startsWith('- ')) {
      release.changes.push(line.slice(2).trim())
    } else if (/^\s+\S/.test(line) && release.changes.length) {
      release.changes[release.changes.length - 1] += ' ' + line.trim()
    } else {
      fail('expected a "- " change or an indented continuation')
    }
  })
  return releases
}

export const releases = parseChangelog(text)
