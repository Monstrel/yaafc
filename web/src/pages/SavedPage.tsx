import { Fragment, useState } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { cauldronStats, evaluate } from '../lib/cauldron'
import { fmt, fmtSeconds } from '../lib/format'
import type { SavedRecipe } from '../lib/types'

interface Props {
  saved: SavedRecipe[]
  onUpdate: (id: string, patch: Partial<SavedRecipe>) => void
  onRemove: (id: string) => void
}

export function SavedPage({ saved, onUpdate, onRemove }: Props) {
  // Recipes whose notes are open for editing.
  const [notesOpen, setNotesOpen] = useState<ReadonlySet<string>>(new Set())
  const toggleNotes = (id: string) =>
    setNotesOpen((open) => {
      const next = new Set(open)
      if (!next.delete(id)) next.add(id)
      return next
    })

  if (saved.length === 0)
    return (
      <div className="page">
        <div className="panel empty-state">
          <h2>No saved recipes yet</h2>
          <p>Star a recipe on the Cauldron tab. Saved recipes become producers you can pick in the Planner.</p>
        </div>
      </div>
    )

  const sorted = [...saved].sort((a, b) => a.output.localeCompare(b.output) || a.createdAt - b.createdAt)
  return (
    <div className="page">
      <section className="panel">
        <p className="hint">
          Saved recipes are offered as producers (★) for their item in the Planner&apos;s production tree.
        </p>
        <div className="table-scroll">
          <table className="saved-table">
            <thead>
              <tr>
                <th>Recipe</th>
                <th>Type</th>
                <th>Ingredients</th>
                <th className="num">Per craft</th>
                <th className="num">Per cauldron</th>
                <th className="num">Heat</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => {
                const result = evaluate(s.mode, s.inputs)
                const stats = result ? cauldronStats(result.output.cauldronTarget) : null
                const changed = result && result.output.key !== s.output
                const open = notesOpen.has(s.id)
                const notesId = `notes-${s.id}`
                return (
                  <Fragment key={s.id}>
                    <tr className={open ? 'notes-open' : ''}>
                      <td>
                        <div className="saved-name">
                          {result && <ItemIcon item={result.output.key} size={28} />}
                          <input
                            className="inline-edit"
                            value={s.name ?? ''}
                            placeholder={result?.output.name ?? s.output}
                            onChange={(e) => onUpdate(s.id, { name: e.target.value || undefined })}
                            aria-label="Recipe name"
                          />
                        </div>
                        {changed && <div className="warn-text">Game data changed: this mix now makes {result.output.name}.</div>}
                        {!result && <div className="warn-text">An ingredient no longer exists in the game data.</div>}
                      </td>
                      <td>
                        <span className="badge">{s.mode === 'normal' ? 'Cauldron' : 'Advanced'}</span>
                      </td>
                      <td>
                        <div className="saved-ingredients">
                          {s.inputs.map((k, i) => (
                            <ItemLabel key={i} item={k} />
                          ))}
                        </div>
                      </td>
                      <td className="num">{stats && fmtSeconds(stats.seconds)}</td>
                      <td className="num">{stats && `${fmt(60 / stats.seconds)}/min`}</td>
                      <td className="num">{stats && `${fmt(stats.heatPerSecond)} P/s`}</td>
                      <td className="saved-actions">
                        <button
                          type="button"
                          className={s.note ? 'has-note' : ''}
                          aria-expanded={open}
                          aria-controls={notesId}
                          title={s.note ? 'Show your notes' : 'Add notes'}
                          aria-label={s.note ? 'Notes (has notes)' : 'Notes'}
                          onClick={() => toggleNotes(s.id)}
                        >
                          Notes{s.note && <span className="note-dot" aria-hidden />}
                        </button>
                        <button type="button" className="danger" onClick={() => onRemove(s.id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="notes-row" id={notesId}>
                        <td colSpan={7}>
                          <textarea
                            className="note"
                            placeholder="Notes…"
                            aria-label={`Notes for ${s.name || result?.output.name || s.output}`}
                            value={s.note ?? ''}
                            onChange={(e) => onUpdate(s.id, { note: e.target.value || undefined })}
                            autoFocus
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
