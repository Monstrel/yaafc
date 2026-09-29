import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { cauldronStats, evaluate } from '../lib/cauldron'
import { fmt, fmtSeconds } from '../lib/format'
import type { SavedRecipe } from '../lib/types'

interface Props {
  saved: SavedRecipe[]
  onUpdate: (id: string, patch: Partial<SavedRecipe>) => void
  onRemove: (id: string) => void
  onUseInPlanner: (recipe: SavedRecipe) => void
}

export function SavedPage({ saved, onUpdate, onRemove, onUseInPlanner }: Props) {
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
      <div className="saved-grid">
        {sorted.map((s) => {
          const result = evaluate(s.mode, s.inputs)
          const stats = result ? cauldronStats(result.output.cauldronTarget) : null
          const changed = result && result.output.key !== s.output
          return (
            <article key={s.id} className={`panel saved-card mode-${s.mode}`}>
              <header>
                {result && <ItemIcon item={result.output.key} size={36} />}
                <div className="title">
                  <input
                    className="inline-edit"
                    value={s.name ?? ''}
                    placeholder={result?.output.name ?? s.output}
                    onChange={(e) => onUpdate(s.id, { name: e.target.value || undefined })}
                    aria-label="Recipe name"
                  />
                  <span className="badge">{s.mode === 'normal' ? 'Cauldron' : 'Advanced'}</span>
                </div>
              </header>
              <div className="ingredients">
                {s.inputs.map((k, i) => (
                  <ItemLabel key={i} item={k} />
                ))}
              </div>
              {stats && (
                <div className="meta">
                  {fmtSeconds(stats.seconds)} per craft · {fmt(60 / stats.seconds)}/min per cauldron · {fmt(stats.heatPerSecond)} P/s
                </div>
              )}
              {changed && <div className="warning">Game data changed: this mix now makes {result.output.name}.</div>}
              {!result && <div className="warning">An ingredient no longer exists in the game data.</div>}
              <textarea
                className="note"
                placeholder="Notes…"
                value={s.note ?? ''}
                onChange={(e) => onUpdate(s.id, { note: e.target.value || undefined })}
              />
              <footer>
                <button className="primary" disabled={!result} onClick={() => onUseInPlanner(s)}>
                  Use in planner
                </button>
                <button className="danger" onClick={() => onRemove(s.id)}>
                  Delete
                </button>
              </footer>
            </article>
          )
        })}
      </div>
    </div>
  )
}
