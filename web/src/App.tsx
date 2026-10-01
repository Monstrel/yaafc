import { useMemo, useRef, useState } from 'react'
import { recipeSignature, type CauldronMode } from './lib/cauldron'
import { planGroups } from './lib/itemGroups'
import { usePlanModel } from './lib/planModel'
import { gameVersion } from './lib/gameData'
import { emptyPlan, newId, readBackup, useBackup, usePersistentState } from './lib/store'
import type { MyDefaults, Plan, SavedRecipe } from './lib/types'
import { useUpdateAvailable } from './lib/updateCheck'
import { CauldronPage } from './pages/CauldronPage'
import { HomePage } from './pages/HomePage'
import { PlannerPage } from './pages/PlannerPage'
import { SavedPage } from './pages/SavedPage'

type Tab = 'home' | 'cauldron' | 'saved' | 'planner'

export default function App() {
  const [tab, setTab] = usePersistentState<Tab>('tab', 'home')
  const [saved, setSaved] = usePersistentState<SavedRecipe[]>('saved-recipes', [])
  const [plans, setPlans] = usePersistentState<Plan[]>('plans', () => [emptyPlan('My factory')])
  const [activePlanId, setActivePlanId] = usePersistentState<string>('active-plan', '')
  const [myDefaults, setMyDefaults] = usePersistentState<MyDefaults>('my-defaults', {})
  const [status, setStatus] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const downloadBackup = useBackup(saved, plans, myDefaults)
  const updateAvailable = useUpdateAvailable()

  const plan = plans.find((p) => p.id === activePlanId) ?? plans[0]
  // What the active plan makes and overflows, offered as ingredient groups in the recipe finder.
  const { result: planResult } = usePlanModel(plan, saved, myDefaults)
  const activePlanGroups = useMemo(
    () =>
      planGroups(
        plan.name,
        planResult.balances.filter((b) => b.produced > 0).map((b) => b.item),
        planResult.balances.filter((b) => b.surplus > 0).map((b) => b.item),
      ),
    [plan.name, planResult],
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

  const useInPlanner = (recipe: SavedRecipe) => {
    updatePlan((p) => ({
      ...p,
      producers: { ...p.producers, [recipe.output]: `cauldron:${recipe.id}` },
      targets: p.targets.some((t) => t.item === recipe.output) ? p.targets : [...p.targets, { item: recipe.output, rate: 10 }],
    }))
    setTab('planner')
  }

  const restore = async (file: File) => {
    try {
      const backup = await readBackup(file)
      setSaved(backup.savedRecipes)
      if (backup.myDefaults) setMyDefaults(backup.myDefaults)
      if (backup.plans.length) {
        setPlans(backup.plans)
        setActivePlanId(backup.plans[0].id)
      }
      setStatus(`Restored ${backup.savedRecipes.length} recipes and ${backup.plans.length} plans.`)
    } catch (e) {
      setStatus(`Could not restore: ${(e as Error).message}`)
    }
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
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'home'} onClick={() => setTab('home')}>
            Home
          </button>
          <button role="tab" aria-selected={tab === 'cauldron'} onClick={() => setTab('cauldron')}>
            Cauldron
          </button>
          <button role="tab" aria-selected={tab === 'saved'} onClick={() => setTab('saved')}>
            Saved recipes <span className="pill">{saved.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'planner'} onClick={() => setTab('planner')}>
            Planner
          </button>
        </nav>
        <div className="header-actions">
          <button onClick={downloadBackup} title="Download saved recipes, plans and your default recipes">
            Export
          </button>
          <button onClick={() => fileInput.current?.click()} title="Restore from an exported file">
            Import
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void restore(f)
              e.target.value = ''
            }}
          />
        </div>
      </header>

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
          onRemove={(id) => setSaved((list) => list.filter((s) => s.id !== id))}
          onUseInPlanner={useInPlanner}
        />
      )}
      {tab === 'planner' && (
        <PlannerPage
          plans={plans}
          plan={plan}
          saved={saved}
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
