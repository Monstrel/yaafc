import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { recipeSignature, type CauldronMode } from './lib/cauldron'
import { planGroups } from './lib/itemGroups'
import { usePlanModel } from './lib/planModel'
import { namedAfterTargets, planTitle } from './lib/planName'
import { ADVANCED_CAULDRON, gameVersion, itemName, itemsByKey, machineTier } from './lib/gameData'
import { chooseProducer } from './lib/choices'
import { pickableRows, type TreeNode } from './lib/tree'
import { noun } from './lib/plural'
import {
  emptyPlan,
  forgetFolds,
  legacyProgress,
  newId,
  readBackup,
  useBackup,
  usePersistentState,
  withoutLegacyProgress,
  type Backup,
} from './lib/store'
import { mergeBackup } from './lib/importPlans'
import {
  oneOf,
  newCauldronSearch,
  sanitizeCauldronSearch,
  sanitizeMyDefaults,
  sanitizePlans,
  sanitizeProgress,
  sanitizeSavedRecipes,
  sanitizeString,
  type CauldronSearch,
} from './lib/sanitize'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './lib/types'
import { UndoHistory, useUndo } from './lib/undo'
import { useUpdateAvailable } from './lib/updateCheck'
import { PAGES, usePage, type Page } from './lib/router'
import { PageLink } from './components/PageLink'
import { CauldronPage } from './pages/CauldronPage'
import { ChangelogPage } from './pages/ChangelogPage'
import { HomePage } from './pages/HomePage'
import { PlannerPage } from './pages/PlannerPage'
import { SavedPage } from './pages/SavedPage'

export default function App() {
  // The page visited last, which the bare site address opens on.
  const [lastPage, setLastPage] = usePersistentState<Page>('tab', 'home', oneOf(...PAGES), { perTab: true })
  const [tab, setTab] = usePage(lastPage)
  useEffect(() => setLastPage(tab), [tab, setLastPage])
  // This tab's undo history, which a change to the player's data in another tab clears.
  const [undos] = useState(() => new UndoHistory())
  const onPull = undos.fromOutside
  const [saved, setSaved] = usePersistentState<SavedRecipe[]>('saved-recipes', [], (v) => sanitizeSavedRecipes(v, newId), { onPull })
  const [plans, setPlans] = usePersistentState<Plan[]>('plans', () => [emptyPlan('My factory')], (v) => sanitizePlans(v, newId), {
    onPull,
  })
  const [activePlanId, setActivePlanId] = usePersistentState<string>('active-plan', '', sanitizeString, { perTab: true })
  const [myDefaults, setMyDefaults] = usePersistentState<MyDefaults>('my-defaults', {}, sanitizeMyDefaults, { onPull })
  // One game, so one set of upgrades for every plan. Plans saved before that each had their own:
  // start from the open plan's, then drop them from the plans.
  const [progress, setProgress] = usePersistentState<Progress>(
    'progress',
    () => legacyProgress(plans, activePlanId) ?? { upgrades: {} },
    sanitizeProgress,
    { onPull },
  )
  useEffect(() => {
    if (plans.some((p) => withoutLegacyProgress(p) !== p)) setPlans((ps) => ps.map(withoutLegacyProgress))
  }, [plans, setPlans])
  const history = useUndo(undos, { plans, saved, myDefaults, progress }, (s) => {
    setPlans(s.plans)
    setSaved(s.saved)
    setMyDefaults(s.myDefaults)
    setProgress(s.progress)
  })
  const [status, setStatus] = useState<string | null>(null)
  // Undo's notes go by themselves; the rest stay until clicked.
  const fading = useRef<ReturnType<typeof setTimeout>>(undefined)
  const step = (how: 'undo' | 'redo') => {
    const done = history[how]()
    if (!done) return
    if (done.plan) setActivePlanId(done.plan)
    const note = `${how === 'undo' ? 'Undid' : 'Redid'}: ${done.label}`
    setStatus(note)
    clearTimeout(fading.current)
    fading.current = setTimeout(() => setStatus((s) => (s === note ? null : s)), 4000)
  }
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    // Text boxes keep their own undo.
    if (!(e.ctrlKey || e.metaKey) || e.altKey || isTextField(e.target)) return
    const key = e.key.toLowerCase()
    const how = key === 'z' ? (e.shiftKey ? 'redo' : 'undo') : key === 'y' && !e.shiftKey ? 'redo' : null
    if (!how) return
    e.preventDefault()
    step(how)
  })
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e)
    addEventListener('keydown', listener)
    return () => removeEventListener('keydown', listener)
  }, [])
  // Folded rows of deleted plans are kept while undo could bring the plan back.
  const keepFolds = useEffectEvent(() => forgetFolds(new Set([...plans.map((p) => p.id), ...history.planIds()])))
  useEffect(() => keepFolds(), [])
  const fileInput = useRef<HTMLInputElement>(null)
  const downloadBackup = useBackup(saved, plans, progress, myDefaults)
  const updateAvailable = useUpdateAvailable()

  const plan = plans.find((p) => p.id === activePlanId) ?? plans[0]
  const title = planTitle(plan)
  // What the active plan makes and overflows, offered as ingredient groups in the recipe finder.
  // Also solved for the planner page, from here so each change is solved once.
  const model = usePlanModel(plan, progress, saved, myDefaults)
  const activePlanGroups = useMemo(
    () =>
      planGroups(
        title,
        model.result?.balances.filter((b) => b.produced > 0).map((b) => b.item) ?? [],
        model.result?.balances.filter((b) => b.surplus > 0).map((b) => b.item) ?? [],
      ),
    [title, model.result],
  )
  /** Changes the open plan; `label` says how, for undo (null for upkeep the app does by itself). */
  const updatePlan = (label: string | null, update: (p: Plan) => Plan) => {
    if (label) history.name(label)
    setPlans((ps) => ps.map((p) => (p.id === plan.id ? update(p) : p)))
  }

  // The Cauldron page's mix and search, kept across page switches (and reloads) so coming back
  // shows the same search, and set up by the planner when it sends the player to find a recipe.
  const [search, setSearch] = usePersistentState<CauldronSearch>(
    'cauldron-search',
    newCauldronSearch,
    (v) => sanitizeCauldronSearch(v, (k) => itemsByKey.has(k)),
    { perTab: true },
  )
  // The row to show when the planner opens again, after a recipe was put on it from the Cauldron page.
  const [reveal, setReveal] = useState<string | null>(null)
  const revealed = useCallback(() => setReveal(null), [])

  /** Off to the Cauldron page to find a new recipe for a planner row's item. */
  const findCauldron = (row: TreeNode) => {
    const current = row.run?.process
    // A row already on a cauldron looks among that cauldron's mixes; else the page's own mode,
    // unless the plan can't build Advanced Cauldrons yet.
    const mode: CauldronMode =
      current?.kind === 'cauldron'
        ? current.machine?.key === ADVANCED_CAULDRON
          ? 'advanced'
          : 'normal'
        : machineTier(ADVANCED_CAULDRON) > model.catalog.tier
          ? 'normal'
          : search.mode
    setSearch((s) => ({ ...s, mode, target: row.item, mustInclude: null, page: 0 }))
    setTab('cauldron')
  }
  /**
   * Puts a recipe from the Cauldron page on a row of the open plan (null: every row of its item),
   * saving it first if it isn't yet, and goes to that row.
   */
  const applyRecipe = (mode: CauldronMode, inputs: string[], output: string, row: string | null) => {
    const sig = recipeSignature(mode, inputs)
    const known = saved.find((s) => recipeSignature(s.mode, s.inputs) === sig)
    const recipe = known ?? { id: newId(), mode, inputs: [...inputs], output, createdAt: Date.now() }
    history.name(`Use a Cauldron recipe for ${itemName(output)}`)
    if (!known) setSaved((list) => [...list, recipe])
    const pick = { item: output, producer: `cauldron:${recipe.id}`, row: row ?? undefined, everywhere: row === null }
    updatePlan(null, (p) => chooseProducer(p, model.catalog, pick))
    setReveal(row ?? (model.result ? (pickableRows(model.result.tree, output)[0]?.id ?? null) : null))
    setTab('planner')
  }

  const toggleSave = (mode: CauldronMode, inputs: string[], output: string) => {
    const sig = recipeSignature(mode, inputs)
    const has = saved.some((s) => recipeSignature(s.mode, s.inputs) === sig)
    history.name(`${has ? 'Unsave' : 'Save'} recipe for ${itemName(output)}`)
    setSaved((list) =>
      list.some((s) => recipeSignature(s.mode, s.inputs) === sig)
        ? list.filter((s) => recipeSignature(s.mode, s.inputs) !== sig)
        : [...list, { id: newId(), mode, inputs: [...inputs], output, createdAt: Date.now() }],
    )
  }

  // A file read for importing, waiting on the player to add it or replace everything with it.
  const [pending, setPending] = useState<{ name: string; backup: Backup } | null>(null)
  const importDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (pending) importDialog.current?.showModal()
  }, [pending])

  const openFile = async (file: File) => {
    try {
      setPending({ name: file.name, backup: await readBackup(file) })
    } catch (e) {
      setStatus(`Could not import: ${(e as Error).message}`)
    }
  }

  const importFile = (how: ImportChoice) => {
    importDialog.current?.close()
    if (!pending || how === 'cancel') return
    const { backup } = pending
    history.name(`${how === 'add' ? 'Import' : 'Restore'} ${pending.name}`)
    if (how === 'add') {
      const merged = mergeBackup({ saved, plans }, backup, newId)
      setSaved(merged.saved)
      setPlans(merged.plans)
      if (merged.added.length) setActivePlanId(merged.added[0].id)
      const plansAdded = merged.added.length
      setStatus(
        `Added ${plansAdded} ${noun(plansAdded, 'plan')} and ${merged.addedRecipes} new saved ${noun(merged.addedRecipes, 'recipe')}.`,
      )
      return
    }
    setSaved(backup.savedRecipes)
    if (backup.myDefaults) setMyDefaults(backup.myDefaults)
    if (backup.progress) setProgress(backup.progress)
    if (backup.plans.length) {
      setPlans(backup.plans)
      setActivePlanId(backup.plans[0].id)
    }
    const recipes = backup.savedRecipes.length
    const plansRestored = backup.plans.length
    setStatus(`Restored ${recipes} ${noun(recipes, 'recipe')} and ${plansRestored} ${noun(plansRestored, 'plan')}.`)
  }

  return (
    <div className={tab === 'planner' ? 'app app-wide' : 'app'}>
      <header className="app-header">
        <div className="brand">
          <span className="logo" aria-hidden>
            ⚗
          </span>
          <h1>Yet Another Alchemy Factory Calculator</h1>
        </div>
        <nav className="tabs">
          <PageLink page="home" current={tab === 'home'} onNavigate={setTab}>
            Home
          </PageLink>
          <PageLink page="cauldron" current={tab === 'cauldron'} onNavigate={setTab}>
            Cauldron
          </PageLink>
          <PageLink page="saved" current={tab === 'saved'} onNavigate={setTab}>
            Saved recipes <span className="pill">{saved.length}</span>
          </PageLink>
          <PageLink page="planner" current={tab === 'planner'} onNavigate={setTab}>
            Planner
          </PageLink>
        </nav>
        <div className="header-actions">
          <button
            onClick={() => step('undo')}
            disabled={!history.undoLabel}
            title={history.undoLabel ? `Undo: ${history.undoLabel} (${MOD}Z)` : 'Nothing to undo'}
          >
            ↶ Undo
          </button>
          <button
            onClick={() => step('redo')}
            disabled={!history.redoLabel}
            title={history.redoLabel ? `Redo: ${history.redoLabel} (${MOD}Shift+Z)` : 'Nothing to redo'}
          >
            ↷ Redo
          </button>
          <button onClick={downloadBackup} title="Download saved recipes, plans and your default recipes">
            Export
          </button>
          <button onClick={() => fileInput.current?.click()} title="Add plans from an exported file, or restore a backup">
            Import
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void openFile(f)
              e.target.value = ''
            }}
          />
        </div>
      </header>

      <dialog ref={importDialog} className="tree-dialog" onClose={() => setPending(null)}>
        {pending && <ImportChoices name={pending.name} backup={pending.backup} onChoose={importFile} />}
      </dialog>

      {updateAvailable && (
        <div className="toast update-banner" role="status">
          <span>A new version of the calculator is available.</span>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      )}

      {status && (
        <div className="toast" role="status" onClick={() => setStatus(null)}>
          {status}
        </div>
      )}

      {tab === 'home' && <HomePage onNavigate={setTab} />}
      {tab === 'changelog' && <ChangelogPage />}
      {tab === 'cauldron' && (
        <CauldronPage
          saved={saved}
          onToggleSave={toggleSave}
          planGroups={activePlanGroups}
          search={search}
          onSearch={setSearch}
          planName={title}
          planTree={model.result?.tree ?? null}
          onUse={applyRecipe}
        />
      )}
      {tab === 'saved' && (
        <SavedPage
          saved={saved}
          onUpdate={(id, patch) => {
            history.name(`Edit saved recipe for ${itemName(saved.find((s) => s.id === id)?.output ?? '')}`)
            setSaved((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)))
          }}
          onRemove={(id) => {
            history.name(`Remove saved recipe for ${itemName(saved.find((s) => s.id === id)?.output ?? '')}`)
            setSaved((list) => list.filter((s) => s.id !== id))
          }}
        />
      )}
      {tab === 'planner' && (
        <PlannerPage
          plans={plans}
          plan={plan}
          model={model}
          progress={progress}
          onProgress={(label, update) => {
            history.name(label)
            setProgress(update)
          }}
          myDefaults={myDefaults}
          onMyDefaults={(label, defaults) => {
            history.name(label)
            setMyDefaults(defaults)
          }}
          onSelectPlan={setActivePlanId}
          onUpdatePlan={updatePlan}
          onNewPlan={() => {
            const p = emptyPlan()
            history.name('New plan')
            setPlans((ps) => [...ps, p])
            setActivePlanId(p.id)
          }}
          onDuplicatePlan={() => {
            // A copy of a plan named after its targets is too, so it follows its own targets.
            const name = namedAfterTargets(plan) ? '' : `${plan.name} (copy)`
            const p = { ...structuredClone(plan), id: newId(), name }
            history.name(`Duplicate plan “${title}”`)
            setPlans((ps) => [...ps, p])
            setActivePlanId(p.id)
          }}
          onFindCauldron={findCauldron}
          reveal={reveal}
          onRevealed={revealed}
          onDeletePlan={() => {
            const rest = plans.filter((p) => p.id !== plan.id)
            history.name(`Delete plan “${title}”`)
            setPlans(rest)
            setActivePlanId(rest[0]?.id ?? '')
          }}
        />
      )}

      <footer className="app-footer">
        Game data extracted from Alchemy Factory Steam build {gameVersion.steamBuildId ?? '?'} ({gameVersion.pakDate ?? '?'}).{' '}
        <PageLink page="changelog" current={tab === 'changelog'} onNavigate={setTab}>
          Changelog
        </PageLink>
      </footer>
    </div>
  )
}

/** The key held with Z to undo. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])

/** Whether keys pressed in an element type into it, which has an undo of its own. */
function isTextField(el: EventTarget | null) {
  return (
    el instanceof HTMLElement &&
    (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)))
  )
}

type ImportChoice = 'add' | 'replace' | 'cancel'

function ImportChoices({ name, backup, onChoose }: { name: string; backup: Backup; onChoose: (how: ImportChoice) => void }) {
  const plans = backup.plans.length
  const recipes = backup.savedRecipes.length
  return (
    <>
      <h3>Import {name}?</h3>
      <p>
        It has {plans} {noun(plans, 'plan')} and {recipes} saved {noun(recipes, 'recipe')}.
      </p>
      <p>
        <strong>Add to mine</strong> puts its plans and saved recipes next to yours, keeping your upgrades and default
        recipes. <strong>Replace everything</strong> swaps all of your plans, saved recipes, upgrades and defaults for
        the file&apos;s, to restore a backup of your own.
      </p>
      <div className="tree-dialog-actions">
        <button type="button" className="primary" autoFocus onClick={() => onChoose('add')} disabled={!plans && !recipes}>
          Add to mine
        </button>
        <button type="button" className="danger" onClick={() => onChoose('replace')}>
          Replace everything
        </button>
        <button type="button" onClick={() => onChoose('cancel')}>
          Cancel
        </button>
      </div>
    </>
  )
}
