import { useMemo, useState } from 'react'
import { cauldronIngredients } from '../lib/gameData'
import { onlyGroup, prefOf, setPrefs, type IngredientPrefs, type ItemGroup, type Preference } from '../lib/itemGroups'
import { ItemIcon } from './ItemIcon'

interface Props {
  prefs: IngredientPrefs
  onChange: (prefs: IngredientPrefs) => void
  groups: ItemGroup[]
}

const NEXT: Record<string, Preference | null> = { none: 'prefer', prefer: 'avoid', avoid: null }

/** Prefer/avoid ingredients one by one or by preset group. */
export function IngredientFilter({ prefs, onChange, groups }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(prefs.prefer.length + prefs.avoid.length > 0)
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...cauldronIngredients]
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [query])

  const summary =
    prefs.prefer.length + prefs.avoid.length === 0
      ? 'none set'
      : `${prefs.prefer.length} preferred · ${prefs.avoid.length} avoided${prefs.onlyPreferred ? ' · only preferred' : ''}`

  return (
    <div className="ingredient-filter">
      <button type="button" className="filter-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} Ingredient preferences <span className="hint-inline">({summary})</span>
      </button>
      {open && (
        <div className="filter-body">
          <div className="filter-options">
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.onlyPreferred}
                onChange={(e) => onChange({ ...prefs, onlyPreferred: e.target.checked })}
              />
              Only use preferred ingredients (otherwise they&apos;re ranked first)
            </label>
            <button type="button" className="compact-button" onClick={() => onChange({ prefer: [], avoid: [], onlyPreferred: false })}>
              Reset all
            </button>
          </div>

          <div className="group-list">
            {groups.map((g) => {
              const keys = [...g.items]
              const preferred = keys.filter((k) => prefs.prefer.includes(k)).length
              const avoided = keys.filter((k) => prefs.avoid.includes(k)).length
              return (
                <div className="group-row" key={g.id} title={g.description}>
                  <span className="group-name">
                    {g.name} <span className="hint-inline">({g.items.size})</span>
                  </span>
                  <span className="group-state">
                    {preferred > 0 && <span className="tag pref">{preferred} preferred</span>}
                    {avoided > 0 && <span className="tag avoid">{avoided} avoided</span>}
                  </span>
                  <span className="group-actions">
                    <button type="button" className="compact-button" onClick={() => onChange(setPrefs(prefs, keys, 'prefer'))}>
                      Prefer
                    </button>
                    <button type="button" className="compact-button" onClick={() => onChange(setPrefs(prefs, keys, 'avoid'))}>
                      Avoid
                    </button>
                    <button
                      type="button"
                      className="compact-button"
                      title="Prefer these and avoid everything else"
                      onClick={() => onChange(onlyGroup(prefs, g))}
                    >
                      Only
                    </button>
                    <button type="button" className="compact-button" onClick={() => onChange(setPrefs(prefs, keys, null))}>
                      Clear
                    </button>
                  </span>
                </div>
              )
            })}
          </div>

          <input className="filter-search" placeholder="Search ingredients…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <p className="hint">Click an ingredient to cycle: preferred → avoided → neutral.</p>
          <div className="tile-grid">
            {shown.map((i) => {
              const pref = prefOf(prefs, i.key)
              return (
                <button
                  type="button"
                  key={i.key}
                  className={`tile ${pref ?? ''}`}
                  title={`${i.name}: ${pref ?? 'neutral'}`}
                  onClick={() => onChange(setPrefs(prefs, [i.key], NEXT[pref ?? 'none']))}
                >
                  <ItemIcon item={i.key} size={28} />
                  <span className="tile-name">{i.name}</span>
                  {pref === 'prefer' && <span className="tile-mark">✓</span>}
                  {pref === 'avoid' && <span className="tile-mark">✕</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
