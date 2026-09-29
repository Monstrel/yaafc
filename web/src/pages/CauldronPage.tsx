import { useMemo, useState } from 'react'
import { ItemIcon, ItemLabel } from '../components/ItemIcon'
import { IngredientFilter } from '../components/IngredientFilter'
import { ItemPicker } from '../components/ItemPicker'
import { cauldronStats, evaluate, findRecipes, recipeSignature, type CauldronMode, type CauldronResult } from '../lib/cauldron'
import { cauldronIngredients, cauldronTargets, itemsByKey } from '../lib/gameData'
import { fmt, fmtSeconds } from '../lib/format'
import {
  allowedIngredients,
  builtinGroups,
  emptyPrefs,
  preferredCount,
  type IngredientPrefs,
  type ItemGroup,
} from '../lib/itemGroups'
import { usePersistentState } from '../lib/store'
import type { SavedRecipe } from '../lib/types'

interface Props {
  saved: SavedRecipe[]
  onToggleSave: (mode: CauldronMode, inputs: string[], output: string) => void
  /** Extra preset groups from the active plan (made / overflow). */
  planGroups: ItemGroup[]
}

const PAGE = 50

export function CauldronPage({ saved, onToggleSave, planGroups }: Props) {
  const [mode, setMode] = useState<CauldronMode>('normal')
  const slots = mode === 'normal' ? 3 : 2
  const [mix, setMix] = useState<(string | null)[]>([null, null, null])
  const [target, setTarget] = useState<string | null>(null)
  const [mustInclude, setMustInclude] = useState<string | null>(null)
  const [sort, setSort] = useState<'offset' | 'cost'>('cost')
  const [page, setPage] = useState(0)
  const [prefs, setPrefs] = usePersistentState<IngredientPrefs>('ingredient-prefs', emptyPrefs)
  const preferred = useMemo(() => new Set(prefs.prefer), [prefs.prefer])
  const groups = useMemo(() => [...planGroups, ...builtinGroups], [planGroups])

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

  const targetItem = target ? itemsByKey.get(target) : undefined
  const stats = targetItem ? cauldronStats(targetItem.cauldronTarget) : null

  return (
    <div className={`page cauldron-page mode-${mode}`}>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={mode === 'normal'} onClick={() => { setMode('normal'); setPage(0) }}>
          Cauldron <small>3 ingredients · sum</small>
        </button>
        <button role="tab" aria-selected={mode === 'advanced'} onClick={() => { setMode('advanced'); setPage(0) }}>
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
              onChange={(k) => setMix((m) => m.map((x, j) => (j === i ? k : x)))}
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

      <section className="panel">
        <h2>Find recipes</h2>
        <div className="filters">
          <label>
            Target
            <ItemPicker
              value={target}
              options={cauldronTargets}
              detail={(it) => fmt(it.cauldronTarget)}
              onChange={(k) => { setTarget(k); setPage(0) }}
            />
          </label>
          <label>
            Must include
            <ItemPicker
              value={mustInclude}
              options={cauldronIngredients}
              allowClear
              placeholder="Any ingredient"
              onChange={(k) => { setMustInclude(k); setPage(0) }}
            />
          </label>
          <label>
            Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as 'offset' | 'cost')}>
              <option value="cost">Cheapest ingredients</option>
              <option value="offset">Closest to target value</option>
            </select>
          </label>
        </div>

        <IngredientFilter
          prefs={prefs}
          groups={groups}
          onChange={(p) => {
            setPrefs(p)
            setPage(0)
          }}
        />

        {targetItem && stats && (
          <p className="hint">
            {targetItem.name}: target value {fmt(targetItem.cauldronTarget)} · {fmtSeconds(stats.seconds)} per craft ·{' '}
            {fmt(stats.heatPerSecond)} P/s · {found.length.toLocaleString()} recipes
          </p>
        )}

        {found.length > 0 && (
          <>
            <table className="recipes">
              <thead>
                <tr>
                  <th />
                  <th>Ingredients</th>
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
                      <td><div className="ingredients">
                        {r.inputs.map((k, i) => (
                          <span key={i} className={preferred.has(k) ? 'preferred-ingredient' : ''}>
                            <ItemLabel item={k} />
                          </span>
                        ))}
                      </div></td>
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
        {target && found.length === 0 && <p className="hint">No recipes found with these filters.</p>}
      </section>
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
