import { useEffect, useMemo, useRef, useState } from 'react'
import { recipeSignature, type CauldronMode } from './lib/cauldron'
import { planGroups } from './lib/itemGroups'
import { usePlanModel } from './lib/planModel'
import { gameVersion } from './lib/gameData'
import { noun } from './lib/plural'
import {
  emptyPlan,
  foldKey,
  forget,
  legacyProgress,
  newId,
  readBackup,
  useBackup,
  usePersistentState,
  withoutLegacyProgress,
  type Backup,
} from './lib/store'
import { mergeBackup } from './lib/importPlans'
import { oneOf, sanitizeMyDefaults, sanitizePlans, sanitizeProgress, sanitizeSavedRecipes, sanitizeString } from './lib/sanitize'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './lib/types'
import { useUpdateAvailable } from './lib/updateCheck'
import { PAGES, usePage, type Page } from './lib/router'
import { PageLink } from './components/PageLink'
import { CauldronPage } from './pages/CauldronPage'
import { HomePage } from './pages/HomePage'
import { PlannerPage } from './pages/PlannerPage'
import { SavedPage } from './pages/SavedPage'

export default function App() {
  // The page visited last, which the bare site address opens on.
  const [lastPage, setLastPage] = usePersistentState<Page>('tab', 'home', oneOf(...PAGES))
  const [tab, setTab] = usePage(lastPage)
  useEffect(() => setLastPage(tab), [tab, setLastPage])
  const [saved, setSaved] = usePersistentState<SavedRecipe[]>('saved-recipes', [], (v) => sanitizeSavedRecipes(v, newId))
  const [plans, setPlans] = usePersistentState<Plan[]>('plans', () => [emptyPlan('My factory')], (v) => sanitizePlans(v, newId))
  const [activePlanId, setActivePlanId] = usePersistentState<string>('active-plan', '', sanitizeString)
  const [myDefaults, setMyDefaults] = usePersistentState<MyDefaults>('my-defaults', {}, sanitizeMyDefaults)
  // One game, so one set of upgrades for every plan. Plans saved before that each had their own:
  // start from the open plan's, then drop them from the plans.
  const [progress, setProgress] = usePersistentState<Progress>(
    'progress',
    () => legacyProgress(plans, activePlanId) ?? { upgrades: {} },
    sanitizeProgress,
  )
  useEffect(() => {
    if (plans.some((p) => withoutLegacyProgress(p) !== p)) setPlans((ps) => ps.map(withoutLegacyProgress))
  }, [plans, setPlans])
  const [status, setStatus] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const downloadBackup = useBackup(saved, plans, progress, myDefaults)
  const updateAvailable = useUpdateAvailable()

  const plan = plans.find((p) => p.id === activePlanId) ?? plans[0]
  // What the active plan makes and overflows, offered as ingredient groups in the recipe finder.
  // Also solved for the planner page, from here so each change is solved once.
  const model = usePlanModel(plan, progress, saved, myDefaults)
  const activePlanGroups = useMemo(
    () =>
      planGroups(
        plan.name,
        model.result?.balances.filter((b) => b.produced > 0).map((b) => b.item) ?? [],
        model.result?.balances.filter((b) => b.surplus > 0).map((b) => b.item) ?? [],
      ),
    [plan.name, model.result],
  )
  const updatePlan = (update: (p: Plan) => Plan) => setPlans((ps) => ps.map((p) => (p.id === plan.id ? update(p) : p)))

  const toggleSave = (mode: CauldronMode, inputs: string[], output: string) => {
    const sig = recipeSignature(mode, inputs)
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
      {tab === 'cauldron' && <CauldronPage saved={saved} onToggleSave={toggleSave} planGroups={activePlanGroups} />}
      {tab === 'saved' && (
        <SavedPage
          saved={saved}
          onUpdate={(id, patch) => setSaved((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)))}
          onRemove={(id) => setSaved((list) => list.filter((s) => s.id !== id))}        />
      )}
      {tab === 'planner' && (
        <PlannerPage
          plans={plans}
          plan={plan}
          model={model}
          progress={progress}
          onProgress={setProgress}
          myDefaults={myDefaults}
          onMyDefaults={setMyDefaults}
          onSelectPlan={setActivePlanId}
          onUpdatePlan={updatePlan}
          onNewPlan={() => {
            const p = emptyPlan()
            setPlans((ps) => [...ps, p])
            setActivePlanId(p.id)
          }}
          onDuplicatePlan={() => {
            const p = { ...structuredClone(plan), id: newId(), name: `${plan.name} (copy)` }
            setPlans((ps) => [...ps, p])
            setActivePlanId(p.id)
          }}
          onDeletePlan={() => {
            const rest = plans.filter((p) => p.id !== plan.id)
            forget(foldKey(plan.id))
            setPlans(rest)
            setActivePlanId(rest[0]?.id ?? '')
          }}
        />
      )}

      <footer className="app-footer">
        Game data extracted from Alchemy Factory Steam build {gameVersion.steamBuildId ?? '?'} ({gameVersion.pakDate ?? '?'}).
      </footer>
    </div>
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
