import { releases, type Release } from '../lib/changelog'

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** Releases grouped by the day they went live, in the player's own time zone. */
function byDay(list: readonly Release[]) {
  const days: { day: string; releases: Release[] }[] = []
  for (const r of list) {
    const day = dayFormat.format(r.date)
    if (days.at(-1)?.day === day) days.at(-1)!.releases.push(r)
    else days.push({ day, releases: [r] })
  }
  return days
}

export function ChangelogPage() {
  return (
    <div className="page changelog">
      <section className="panel">
        <h2>Changelog</h2>
        <p className="hint">What changed in each update, newest first.</p>
      </section>
      {byDay(releases).map(({ day, releases }) => (
        <section key={day} className="panel">
          <h3>{day}</h3>
          {releases.map((r) => (
            <ReleaseNotes key={r.date.getTime()} release={r} showTime={releases.length > 1} />
          ))}
        </section>
      ))}
    </div>
  )
}

/** One release's changes, with the time it went live when the day had more than one. */
export function ReleaseNotes({ release, showTime }: { release: Release; showTime?: boolean }) {
  return (
    <div className="release">
      {showTime && (
        <time className="release-time" dateTime={release.date.toISOString()}>
          {timeFormat.format(release.date)}
        </time>
      )}
      <ul>
        {release.changes.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </div>
  )
}
