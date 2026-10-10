import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { IngredientFilter, PrefToggle } from '../components/IngredientFilter'
import { ItemPicker } from '../components/ItemPicker'
import { cauldronStats, evaluate, findRecipes, recipeSignature, type CauldronMode, type CauldronResult } from '../lib/cauldron'
import { HEAT, MONEY, NUTRIENTS, cauldronIngredients, cauldronTargets, itemName, itemsByKey } from '../lib/gameData'
import { diagnoseNoResults, type FinderQuery } from '../lib/diagnose'
import { fmt, fmtSeconds } from '../lib/format'
import { noun } from '../lib/plural'
import { placePopover } from '../lib/popover'
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
import { sanitizePrefs, type CauldronSearch } from '../lib/sanitize'
import { usePersistentState } from '../lib/store'
import { pickableRows, type PickableRow, type TreeNode } from '../lib/tree'
import type { SavedRecipe } from '../lib/types'

interface Props {
  saved: SavedRecipe[]
  onToggleSave: (mode: CauldronMode, inputs: string[], output: string) => void
  /** Extra preset groups from the active plan (made / overflow). */
  planGroups: ItemGroup[]
  /** The mix and search, kept by the app so the planner can set one up. */
  search: CauldronSearch
  onSearch: Dispatch<SetStateAction<CauldronSearch>>
  /** The open plan, whose rows a recipe can be put on. */
  planName: string
  /** Its solved rows (null until the first solve). */
  planTree: TreeNode[] | null
  /** Saves the recipe if it isn't yet, and has a row of the plan use it (null: every row of its item). */
  onUse: (mode: CauldronMode, inputs: string[], output: string, row: string | null) => void
}

const PAGE = 50

export function CauldronPage({
  saved,
  onToggleSave,
  planGroups,
  search,
  onSearch: setSearch,
  planName,
  planTree,
  onUse,
}: Props) {
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
  const [prefMenu, setPrefMenu] = useState<{ item: string; at: DOMRect } | null>(null)
  const prefMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!prefMenu || !prefMenuRef.current) return
    prefMenuRef.current.showPopover()
    placePopover(prefMenuRef.current, prefMenu.at)
  }, [prefMenu])
  const openPrefMenu = (item: string, button: HTMLElement) => {
    setPrefMenu({ item, at: button.getBoundingClientRect() })
  }
  // The results reorder (or drop the row) on any change: close rather than point at a moved row.
  const choosePref = (p: IngredientPrefs) => {
    prefMenuRef.current?.hidePopover()
    changePrefs(p)
  }

  // Use: a recipe goes on a row of the open plan making its item; with several rows, a menu says which.
  const rowsOf = (item: string) => (planTree ? pickableRows(planTree, item) : [])
  const [useMenu, setUseMenu] = useState<{ recipe: Recipe; rows: PickableRow[]; at: DOMRect } | null>(null)
  const useMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!useMenu || !useMenuRef.current) return
    useMenuRef.current.showPopover()
    placePopover(useMenuRef.current, useMenu.at, 'right')
  }, [useMenu])
  const applyRecipe = (recipe: Recipe, button: HTMLElement) => {
    const rows = rowsOf(recipe.output)
    if (rows.length === 1) return onUse(recipe.mode, recipe.inputs, recipe.output, rows[0].id)
    setUseMenu({ recipe, rows, at: button.getBoundingClientRect() })
  }
  const applyTo = (row: string | null) => {
    useMenuRef.current?.hidePopover()
    if (useMenu) onUse(useMenu.recipe.mode, useMenu.recipe.inputs, useMenu.recipe.output, row)
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
  // Rows of the open plan that a found recipe can go on.
  const targetRows = target ? rowsOf(target) : []
  const using = targetRows.length > 0
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
              onUse={
                rowsOf(mixResult.output.key).length > 0
                  ? (button) => applyRecipe({ mode, inputs: mixKeys as string[], output: mixResult.output.key }, button)
                  : undefined
              }
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
          {targetItem && using && (
            <p className="hint">
              Use puts a recipe on {targetRows.length === 1 ? 'the' : `one of the ${targetRows.length}`} {targetItem.name}{' '}
              {noun(targetRows.length, 'row')} in “{planName}”, saving it if it isn&apos;t yet.
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
                    {using && <th />}
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
                        {using && (
                          <td className="use-cell">
                            <UseButton onClick={(button) => applyRecipe({ mode: r.mode, inputs: r.inputs, output: r.result.output.key }, button)} />
                          </td>
                        )}
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
        ref={useMenuRef}
        popover="auto"
        className="pref-menu use-menu"
        onToggle={(e) => e.newState === 'closed' && setUseMenu(null)}
      >
        {useMenu && (
          <>
            <div className="pref-menu-title">
              Use on which <ItemLabel item={useMenu.recipe.output} size={18} /> row in “{planName}”?
            </div>
            {useMenu.rows.map((r) => (
              <button type="button" key={r.id} className="use-menu-row" onClick={() => applyTo(r.id)}>
                <span>{rowPlace(r)}</span>
                <span className="hint-inline">{fmt(r.rate)}/min</span>
              </button>
            ))}
            <button type="button" className="use-menu-row use-menu-all" onClick={() => applyTo(null)}>
              All {useMenu.rows.length} rows
            </button>
          </>
        )}
      </div>

      <div
        ref={prefMenuRef}
        popover="auto"
        className="pref-menu"
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

function ResultCard({
  result,
  saved,
  onSave,
  onUse,
}: {
  result: CauldronResult
  saved: boolean
  onSave: () => void
  onUse?: (button: HTMLElement) => void
}) {
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
      {onUse && <UseButton onClick={onUse} />}
    </div>
  )
}

/** A mix to put on a row of the open plan. */
interface Recipe {
  mode: CauldronMode
  inputs: string[]
  output: string
}

const VIA: Record<string, string> = { [HEAT]: 'Burned for', [NUTRIENTS]: 'Spread for', [MONEY]: 'Paid for' }

/** Where a row sits: a target, or what it goes into. */
const rowPlace = (r: PickableRow) => (r.feeds ? `${r.via ? VIA[r.via] : 'For'} ${itemName(r.feeds)}` : 'Target')

/** Puts a recipe on a row of the open plan making its item (saving it, if it isn't yet). */
function UseButton({ onClick }: { onClick: (button: HTMLElement) => void }) {
  return (
    <button
      type="button"
      className="compact-button use-button"
      onClick={(e) => onClick(e.currentTarget)}
      title="Make this item with it in the open plan (saving it, if it isn't yet)"
    >
      Use
    </button>
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
