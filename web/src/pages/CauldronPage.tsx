import { useEffect, useMemo, useRef, useState } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { IngredientFilter, PrefToggle } from '../components/IngredientFilter'
import { ItemPicker } from '../components/ItemPicker'
import { cauldronStats, evaluate, findRecipes, recipeSignature, type CauldronMode, type CauldronResult } from '../lib/cauldron'
import { cauldronIngredients, cauldronTargets, itemsByKey } from '../lib/gameData'
import { diagnoseNoResults, type FinderQuery } from '../lib/diagnose'
import { fmt, fmtSeconds } from '../lib/format'
import { noun } from '../lib/plural'
import {
  allowedIngredients,
  builtinGroups,
  emptyPrefs,
  onlyItems,
  preferredCount,
  prefOf,
  setPrefs as setItemPrefs,
  type IngredientPrefs,
  type ItemGroup,
} from '../lib/itemGroups'
import { sanitizeCauldronSearch, sanitizePrefs, type CauldronSearch } from '../lib/sanitize'
import { usePersistentState } from '../lib/store'
import type { SavedRecipe } from '../lib/types'

interface Props {
  saved: SavedRecipe[]
  onToggleSave: (mode: CauldronMode, inputs: string[], output: string) => void
  /** Extra preset groups from the active plan (made / overflow). */
  planGroups: ItemGroup[]
}

const PAGE = 50

const newSearch = (): CauldronSearch => ({
  mode: 'normal',
  mix: [null, null, null],
  target: null,
  mustInclude: null,
  sort: 'cost',
  page: 0,
})

export function CauldronPage({ saved, onToggleSave, planGroups }: Props) {
  // Kept across tab switches (and reloads), so coming back shows the same search.
  const [search, setSearch] = usePersistentState<CauldronSearch>(
    'cauldron-search',
    newSearch,
    (v) => sanitizeCauldronSearch(v, (k) => itemsByKey.has(k)),
    { perTab: true },
  )
  const update = (patch: Partial<CauldronSearch>) => setSearch((s) => ({ ...s, ...patch }))
  const { mode, mix, target, mustInclude, sort } = search
  const slots = mode === 'normal' ? 3 : 2
  const [prefs, setPrefs] = usePersistentState<IngredientPrefs>('ingredient-prefs', emptyPrefs, sanitizePrefs)
  const preferred = useMemo(() => new Set(prefs.prefer), [prefs.prefer])
  const groups = useMemo(() => [...planGroups, ...builtinGroups], [planGroups])
  const changePrefs = (p: IngredientPrefs) => {
    setPrefs(p)
    setPage(0)
  }

  // A result's ingredient opens its own preference control, like its row in the preferences tree.
  const [prefMenu, setPrefMenu] = useState<{ item: string; x: number; y: number } | null>(null)
  const prefMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (prefMenu) prefMenuRef.current?.showPopover()
  }, [prefMenu])
  const openPrefMenu = (item: string, button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    setPrefMenu({ item, x: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), y: rect.bottom + 4 })
  }
  // The results reorder (or drop the row) on any change: close rather than point at a moved row.
  const choosePref = (p: IngredientPrefs) => {
    prefMenuRef.current?.hidePopover()
    changePrefs(p)
  }

  const savedSignatures = useMemo(() => new Set(saved.map((s) => recipeSignature(s.mode, s.inputs))), [saved])
  const mixKeys = mix.slice(0, slots)
  const mixResult = mixKeys.every(Boolean) ? evaluate(mode, mixKeys as string[]) : null

  const found = useMemo(() => {
    if (!target) return []
    // Avoided ingredients are never searched; preferred ones rank recipes first.
    const list = findRecipes(target, mode, allowedIngredients(prefs), 20000).filter(
      (r) => !mustInclude || r.inputs.includes(mustInclude),
    )
    const cost = (inputs: string[]) => inputs.reduce((s, k) => s + (itemsByKey.get(k)?.baseCost ?? 0), 0)
    return list.sort(
      (a, b) =>
        preferredCount(prefs, b.inputs) - preferredCount(prefs, a.inputs) ||
        (sort === 'cost'
          ? cost(a.inputs) - cost(b.inputs)
          : Math.abs(a.result.offset) - Math.abs(b.result.offset)),
    )
  }, [target, mode, mustInclude, sort, prefs])

  // The stored page may be past the end if the results changed since.
  const page = Math.min(search.page, Math.max(0, Math.ceil(found.length / PAGE) - 1))
  const setPage = (p: number) => update({ page: p })

  const targetItem = target ? itemsByKey.get(target) : undefined
  const stats = targetItem ? cauldronStats(targetItem.cauldronTarget) : null

  return (
    <div className={`page cauldron-page mode-${mode}`}>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={mode === 'normal'} onClick={() => update({ mode: 'normal', page: 0 })}>
          Cauldron <small>3 ingredients · sum</small>
        </button>
        <button role="tab" aria-selected={mode === 'advanced'} onClick={() => update({ mode: 'advanced', page: 0 })}>
          Advanced Cauldron <small>2 ingredients · difference</small>
        </button>
      </div>

      <section className="panel">
        <h2>Mix</h2>
        <p className="hint">
          {mode === 'normal'
            ? 'Sum of cauldron values; two identical ingredients count 65%, three count 50%. The closest target value wins.'
            : 'Two different ingredients give |A − B| (only targets below the higher one); the same ingredient twice gives the next target above it.'}
        </p>
        <div className="mix-row">
          {Array.from({ length: slots }, (_, i) => (
            <ItemPicker
              key={i}
              value={mix[i]}
              options={cauldronIngredients}
              allowClear
              placeholder={`Ingredient ${i + 1}`}
              detail={(it) => fmt(it.cauldronCost)}
              onChange={(k) => setSearch((s) => ({ ...s, mix: s.mix.map((x, j) => (j === i ? k : x)) }))}
            />
          ))}
          <span className="arrow" aria-hidden>
            →
          </span>
          {mixResult ? (
            <ResultCard
              result={mixResult}
              saved={savedSignatures.has(recipeSignature(mode, mixKeys as string[]))}
              onSave={() => onToggleSave(mode, mixKeys as string[], mixResult.output.key)}
            />
          ) : (
            <div className="result-card empty">Pick {slots} ingredients</div>
          )}
        </div>
      </section>

      <div className="finder-layout">
        <aside className="panel finder-side">
          <IngredientFilter
            prefs={prefs}
            groups={groups}
            onChange={changePrefs}
          />
        </aside>
        <section className="panel">
          <h2>Find recipes</h2>
          <div className="filters">
            <label>
              Target
              <ItemPicker
                value={target}
                options={cauldronTargets}
                detail={(it) => fmt(it.cauldronTarget)}
                onChange={(k) => update({ target: k, page: 0 })}
              />
            </label>
            <label>
              Must include
              <ItemPicker
                value={mustInclude}
                options={cauldronIngredients}
                allowClear
                placeholder="Any ingredient"
                onChange={(k) => update({ mustInclude: k, page: 0 })}
              />
            </label>
            <label>
              Sort by
              <select value={sort} onChange={(e) => update({ sort: e.target.value as 'offset' | 'cost' })}>
                <option value="cost">Cheapest ingredients</option>
                <option value="offset">Closest to target value</option>
              </select>
            </label>
          </div>


          {targetItem && stats && (
            <p className="hint">
              {targetItem.name}: target value {fmt(targetItem.cauldronTarget)} · {fmtSeconds(stats.seconds)} per craft ·{' '}
              {fmt(stats.heatPerSecond)} P/s · {found.length.toLocaleString()} {noun(found.length, 'recipe')}
            </p>
          )}

          {found.length > 0 && (
            <>
              <table className="recipes">
                <thead>
                  <tr>
                    <th />
                    <th colSpan={slots}>Ingredients</th>
                    <th className="num">Value</th>
                    <th className="num">Offset</th>
                  </tr>
                </thead>
                <tbody>
                  {found.slice(page * PAGE, (page + 1) * PAGE).map((r) => {
                    const sig = recipeSignature(r.mode, r.inputs)
                    const isSaved = savedSignatures.has(sig)
                    return (
                      <tr key={sig}>
                        <td>
                          <StarButton saved={isSaved} onClick={() => onToggleSave(r.mode, r.inputs, r.result.output.key)} />
                        </td>
                        {r.inputs.map((k, i) => (
                          <td key={i} className={preferred.has(k) ? 'ingredient preferred-ingredient' : 'ingredient'}>
                            <button
                              type="button"
                              className="ingredient-button"
                              title={`Set preference for ${itemsByKey.get(k)?.name ?? k}`}
                              aria-haspopup="true"
                              onClick={(e) => openPrefMenu(k, e.currentTarget)}
                            >
                              <ItemLabel item={k} />
                            </button>
                          </td>
                        ))}
                        <td className="num">{fmt(r.result.value)}</td>
                        <td className={`num ${r.result.offset >= 0 ? 'over' : 'under'}`}>
                          {r.result.offset >= 0 ? '+' : ''}
                          {fmt(r.result.offset)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="pager">
                <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                  ‹ Prev
                </button>
                <span>
                  {page + 1} / {Math.ceil(found.length / PAGE)}
                </span>
                <button disabled={(page + 1) * PAGE >= found.length} onClick={() => setPage(page + 1)}>
                  Next ›
                </button>
              </div>
            </>
          )}
          {target && found.length === 0 && (
            <NoResults
              target={target}
              mode={mode}
              prefs={prefs}
              mustInclude={mustInclude}
              onApply={(q) => {
                setPrefs(q.prefs)
                update({ mode: q.mode, mustInclude: q.mustInclude, page: 0 })
              }}
            />
          )}
        </section>
      </div>

      <div
        ref={prefMenuRef}
        popover="auto"
        className="pref-menu"
        style={prefMenu ? { left: prefMenu.x, top: prefMenu.y } : undefined}
        onToggle={(e) => e.newState === 'closed' && setPrefMenu(null)}
      >
        {prefMenu && (
          <>
            <div className="pref-menu-title">
              <ItemLabel item={prefMenu.item} size={18} />
            </div>
            <div className="pref-controls">
              <button
                type="button"
                className="only-button"
                title="Prefer this and avoid everything else"
                onClick={() => choosePref(onlyItems(prefs, [prefMenu.item]))}
              >
                Only
              </button>
              <PrefToggle
                value={prefOf(prefs, prefMenu.item)}
                label={itemsByKey.get(prefMenu.item)?.name ?? prefMenu.item}
                onChange={(p) => choosePref(setItemPrefs(prefs, [prefMenu.item], p))}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Why the search came back empty, with one-click fixes. */
function NoResults({ target, mode, prefs, mustInclude, onApply }: FinderQuery & { onApply: (q: FinderQuery) => void }) {
  const { reason, fixes } = useMemo(
    () => diagnoseNoResults({ target, mode, prefs, mustInclude }),
    [target, mode, prefs, mustInclude],
  )
  return (
    <div className="no-results">
      <p>
        <strong>No recipes found.</strong> {reason}
      </p>
      {fixes.length > 0 && (
        <div className="fixes">
          {fixes.map((f) => (
            <button type="button" key={f.label} className="compact-button" onClick={() => onApply(f.query)}>
              {f.label} <span className="hint-inline">· {f.count.toLocaleString()} {noun(f.count, 'recipe')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ResultCard({ result, saved, onSave }: { result: CauldronResult; saved: boolean; onSave: () => void }) {
  const stats = cauldronStats(result.output.cauldronTarget)
  return (
    <div className="result-card">
      <ItemIcon item={result.output.key} size={40} />
      <div>
        <strong>{result.output.name}</strong>
        <div className="meta">
          value {fmt(result.value)} vs target {fmt(result.output.cauldronTarget)} · {fmtSeconds(stats.seconds)} ·{' '}
          {fmt(stats.heatPerSecond)} P/s
        </div>
      </div>
      <StarButton saved={saved} onClick={onSave} />
    </div>
  )
}

export function StarButton({ saved, onClick }: { saved: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`star ${saved ? 'on' : ''}`}
      onClick={onClick}
      title={saved ? 'Remove from saved recipes' : 'Save recipe (usable in the planner)'}
      aria-pressed={saved}
    >
      {saved ? '★' : '☆'}
    </button>
  )
}
