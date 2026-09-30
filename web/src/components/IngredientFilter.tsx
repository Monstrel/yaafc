import { useState } from 'react'
import { cauldronIngredients, iconUrl } from '../lib/gameData'
import { onlyGroup, prefOf, setPrefs, type IngredientPrefs, type ItemGroup, type Preference } from '../lib/itemGroups'
import { ItemLabel } from './ItemIcon'

interface Props {
  prefs: IngredientPrefs
  onChange: (prefs: IngredientPrefs) => void
  groups: ItemGroup[]
}

const byName = [...cauldronIngredients].sort((a, b) => a.name.localeCompare(b.name))

/** Prefer/avoid ingredients in a foldable tree: one branch per group, one row per ingredient. */
export function IngredientFilter({ prefs, onChange, groups }: Props) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((e) => {
      const next = new Set(e)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const q = query.trim().toLowerCase()
  const branches = groups
    .map((g) => ({ group: g, members: byName.filter((i) => g.items.has(i.key) && (!q || i.name.toLowerCase().includes(q))) }))
    .filter((b) => b.members.length > 0)

  const summary =
    prefs.prefer.length + prefs.avoid.length === 0
      ? 'none set'
      : `${prefs.prefer.length} preferred · ${prefs.avoid.length} avoided${prefs.onlyPreferred ? ' · only preferred' : ''}`

  return (
    <div className="ingredient-filter">
      <div className="filter-head">
        <h2>
          Ingredient preferences <span className="hint-inline">({summary})</span>
        </h2>
        <button type="button" className="compact-button" onClick={() => onChange({ prefer: [], avoid: [], onlyPreferred: false })}>
          Reset all
        </button>
      </div>
      <div className="filter-body">
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.onlyPreferred}
            onChange={(e) => onChange({ ...prefs, onlyPreferred: e.target.checked })}
          />
          Only use preferred ingredients (otherwise they&apos;re ranked first)
        </label>
        <p className="pref-key">
          <span className="count-pref">✓</span> prefer · – neutral · <span className="count-avoid">✕</span> avoid · a
          category&apos;s buttons set all of it
        </p>

        <div className="tree-toolbar filter-toolbar">
          <input className="filter-search" placeholder="Search ingredients…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" className="compact-button" onClick={() => setExpanded(new Set(groups.map((g) => g.id)))}>
            Expand all
          </button>
          <button type="button" className="compact-button" onClick={() => setExpanded(new Set())}>
            Collapse all
          </button>
        </div>

        <div className="pref-scroll">
          <table className="pref-tree">
            <tbody>
              {branches.map(({ group, members }) => {
                const keys = [...group.items]
                const preferred = keys.filter((k) => prefs.prefer.includes(k)).length
                const avoided = keys.filter((k) => prefs.avoid.includes(k)).length
                // The group's control shows a state only when every member shares it.
                const uniform: Preference | null | undefined =
                  preferred === keys.length ? 'prefer' : avoided === keys.length ? 'avoid' : preferred + avoided === 0 ? null : undefined
                // Searching opens every branch that has a match.
                const isOpen = !!q || expanded.has(group.id)
                return [
                  <tr className="pref-group" key={group.id} title={group.description}>
                    <td>
                      <div className="tree-cell">
                        <button
                          type="button"
                          className="fold"
                          onClick={() => toggle(group.id)}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? 'Collapse' : 'Expand'}
                          disabled={!!q}
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                        <span className="group-icon" aria-hidden>
                          {group.icon && <img src={iconUrl(group.icon)!} width={22} height={22} alt="" loading="lazy" />}
                          {group.badge && <span className="group-badge">{group.badge}</span>}
                        </span>
                        <button
                          type="button"
                          className="group-name"
                          title={`${group.name}: ${group.description}`}
                          onClick={() => toggle(group.id)}
                          disabled={!!q}
                        >
                          {group.name}
                        </button>
                        <span className="group-count">{group.items.size}</span>
                        {preferred > 0 && (
                          <span className="count-pref" title={`${preferred} preferred`}>
                            ✓{preferred}
                          </span>
                        )}
                        {avoided > 0 && (
                          <span className="count-avoid" title={`${avoided} avoided`}>
                            ✕{avoided}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="pref-controls">
                      <button
                        type="button"
                        className="only-button"
                        title="Prefer these and avoid everything else"
                        onClick={() => onChange(onlyGroup(prefs, group))}
                      >
                        Only
                      </button>
                      <PrefToggle
                        value={uniform}
                        label={`all of ${group.name}`}
                        onChange={(p) => onChange(setPrefs(prefs, keys, p))}
                      />
                    </td>
                  </tr>,
                  ...(isOpen
                    ? members.map((i) => (
                        <tr className={`pref-item ${prefOf(prefs, i.key) ?? ''}`} key={`${group.id}/${i.key}`}>
                          <td>
                            <div className="tree-cell" style={{ paddingLeft: 26 }}>
                              <ItemLabel item={i.key} />
                            </div>
                          </td>
                          <td className="pref-controls">
                            <PrefToggle
                              value={prefOf(prefs, i.key)}
                              label={i.name}
                              onChange={(p) => onChange(setPrefs(prefs, [i.key], p))}
                            />
                          </td>
                        </tr>
                      ))
                    : []),
                ]
              })}
              {branches.length === 0 && (
                <tr>
                  <td className="hint">No ingredients match “{query}”.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const OPTIONS: { value: Preference | null; label: string; glyph: string }[] = [
  { value: 'avoid', label: 'Avoid', glyph: '✕' },
  { value: null, label: 'Neutral', glyph: '–' },
  { value: 'prefer', label: 'Prefer', glyph: '✓' },
]

/** Avoid / Neutral / Prefer button group (✕ – ✓). `undefined` means mixed: nothing is pressed. */
function PrefToggle({
  value,
  label,
  onChange,
}: {
  value: Preference | null | undefined
  label: string
  onChange: (p: Preference | null) => void
}) {
  return (
    <div className="pref-toggle" role="group" aria-label={label}>
      {OPTIONS.map((o) => (
        <button
          type="button"
          key={o.label}
          className={`opt-${o.value ?? 'neutral'}`}
          aria-pressed={value === o.value}
          aria-label={`${o.label} ${label}`}
          title={`${o.label} ${label}`}
          onClick={() => onChange(o.value)}
        >
          {o.glyph}
        </button>
      ))}
    </div>
  )
}
