import { HEAT, MONEY, NUTRIENTS } from './gameData'
import { mergeBackup, withDefaults } from './importPlans'
import { planFertilizer } from './planModel'
import { namedAfterTargets } from './planName'
import { buildCatalog } from './processes'
import { decodePlan, encodePlan } from './shareCode'
import { sanitizeBackup, type Backup } from './store'
import type { MyDefaults, Plan, Progress, SavedRecipe } from './types'
import { BUS, planChoice, unfold, type PlanNode } from './unfold'
import { modifiers } from './upgrades'

/** Where a link carries its plan: after the #, so it never reaches the server. */
const HASH = '#plan='

/** The producers a plan's rows choose from, for a player with `mine` for defaults at `progress`. */
const catalogFor = (plan: Plan, saved: SavedRecipe[], mine: MyDefaults, progress: Progress) =>
  buildCatalog({
    saved,
    machines: plan.machines,
    mods: modifiers(progress.upgrades),
    fertilizer: planFertilizer(plan),
    tier: progress.tier,
    mine,
  })

/** What a row is set up as: what it does, its producer and machine, and how that runs. */
const setup = (n: PlanNode) =>
  [n.kind, n.process?.id, n.process?.machine?.key, n.process?.catalysts.join('+'), n.process?.height, n.process?.stack].join(' ')

/**
 * The plan with every choice its rows make written into it, so it's set up the same for whoever
 * opens it: a plan-wide pick for each item and machine for each process, where the plan has none
 * (they come before anyone's defaults, and don't hang on the research tier the way the game's
 * defaults do). Rows those can't hold, checked against players whose defaults and tier differ in
 * every way they can, pick for themselves.
 */
export function pinChoices(plan: Plan, saved: SavedRecipe[], myDefaults: MyDefaults, progress: Progress): Plan {
  const catalog = catalogFor(plan, saved, myDefaults, progress)
  const rows = unfold(plan, catalog).nodes
  const producers = { ...plan.producers }
  const machines = { ...plan.machines }
  for (const item of new Set([...rows.map((n) => n.item), HEAT, NUTRIENTS, MONEY])) {
    const producer = planChoice(plan, catalog, item).producer
    // Not 'bus': a plan-wide pick of it would make the item one of the plan's inputs.
    if (!producers[item] && catalog.byId.has(producer)) producers[item] = producer
  }
  for (const n of rows) {
    const machine = n.process?.machine
    if (n.kind === 'make' && machine && n.process!.machineOptions.length > 1 && !plan.branches?.[n.id]?.machine)
      machines[n.process!.id] ??= machine.key
  }
  let pinned: Plan = { ...plan, producers, machines }

  // Other players: one at the first tier with no defaults, and two whose every default differs.
  const made = rows.filter((n) => n.kind === 'make' && n.process)
  const other = (pick: (n: PlanNode) => string | undefined): MyDefaults =>
    Object.fromEntries(made.flatMap((n) => (pick(n) ? [[n.item, { producer: pick(n)! }]] : [])))
  const others: [MyDefaults, Progress][] = [
    [{}, { ...progress, tier: 1 }],
    [other((n) => catalog.byProduct.get(n.item)?.find((p) => p.id !== n.process!.id)?.id), { ...progress, tier: undefined }],
    [other(() => BUS), { ...progress, tier: undefined }],
  ]
  const wanted = new Map(made.map((n) => [n.id, n]))
  for (let pass = 0; pass < 4; pass++) {
    const branches = { ...pinned.branches }
    for (const [mine, theirs] of others)
      for (const n of unfold(pinned, catalogFor(pinned, saved, mine, theirs)).nodes) {
        const want = wanted.get(n.id)
        if (want && setup(n) !== setup(want) && !branches[n.id])
          branches[n.id] = { producer: want.process!.id, ...(want.process!.machine && { machine: want.process!.machine.key }) }
      }
    if (Object.keys(branches).length === Object.keys(pinned.branches ?? {}).length) break
    pinned = { ...pinned, branches }
  }
  return pinned
}

/**
 * The plan as it goes in a link: rows following the player's saved defaults pick the same
 * themselves (the rest follow the game's, which the link's research tier settles), without the
 * build checklist.
 */
export function planToShare(plan: Plan, saved: SavedRecipe[], myDefaults: MyDefaults, progress: Progress): Plan {
  const shared = { ...withDefaults(plan, myDefaults, saved, progress) }
  delete shared.built
  // Shared again, it's the player's to share: not the link it came from.
  delete shared.shared
  // A plan named after its targets is named after them for the other player too.
  if (namedAfterTargets(shared)) shared.name = ''
  return shared
}

export interface Shared {
  /** The link: `page` (the planner's address) with the plan after its #. */
  url: string
  /** Saved Cauldron recipes the link carries. */
  recipes: number
}

/** A link to the plan, checked by reading it back as the other player will. */
export async function shareLink(page: string, plan: Plan, saved: SavedRecipe[], myDefaults: MyDefaults, progress: Progress): Promise<Shared> {
  const code = await encodePlan(planToShare(plan, saved, myDefaults, progress), saved, progress.tier)
  const back = await openShared(code)
  return { url: page + HASH + code, recipes: back.savedRecipes.length }
}

/** The share code in a URL's hash, if it has one. */
export const sharedCode = (hash: string) => (hash.startsWith(HASH) && hash.length > HASH.length ? hash.slice(HASH.length) : null)

/**
 * The plan a share code holds, checked as an imported file is, with every choice its rows make
 * pinned as the sharer saw them (at their research tier, with the game's defaults where the link
 * picks nothing), so the opener's own defaults play no part in it, and the code kept on it; throws
 * when it isn't one. Read once per code: a shared plan compares itself with it as it changes.
 */
export function openShared(code: string): Promise<Backup> {
  let opened = opening.get(code)
  if (!opened) {
    opened = readShared(code)
    opening.set(code, opened)
    // A bad code is tried again next time, in case it was a passing failure.
    opened.catch(() => opening.delete(code))
  }
  return opened
}

const opening = new Map<string, Promise<Backup>>()

async function readShared(code: string): Promise<Backup> {
  const backup = sanitizeBackup(await decodePlan(code))
  if (backup.plans.length !== 1) throw new Error('the link doesn’t hold a plan')
  const plan = pinChoices(backup.plans[0], backup.savedRecipes, {}, backup.progress ?? { upgrades: {} })
  // The tier set the plan up; the opener keeps their own progress.
  return { ...backup, plans: [{ ...plan, shared: code }], progress: undefined }
}

/**
 * A shared plan as it was shared, under its own id and keeping its build checklist (the player's,
 * not the link's), with the player's saved recipes and any of the link's they no longer have.
 */
export async function asShared(plan: Plan, saved: SavedRecipe[], newId: () => string): Promise<{ plan: Plan; saved: SavedRecipe[] }> {
  const merged = mergeBackup({ saved, plans: [] }, await openShared(plan.shared!), newId)
  const reverted: Plan = { ...merged.added[0], id: plan.id }
  if (plan.built) reverted.built = plan.built
  return { plan: reverted, saved: merged.saved }
}

/** Whether two plans are set up the same: everything but their id, checklist and link, in any order. */
export const sameSetup = (a: Plan, b: Plan) => setupKey(a) === setupKey(b)

function setupKey(plan: Plan): string {
  const { id: _id, built: _built, shared: _shared, ...setup } = plan
  return JSON.stringify(canonical(setup)) ?? ''
}

/**
 * A value with its keys sorted and nothing empty: fields left empty read as absent. Lists of names
 * (rows rounded up, items fed back…) are sets, so they're sorted too; lists of targets keep order.
 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (!v.length) return undefined
    return v.every((x) => typeof x === 'string') ? [...v].sort() : v.map(canonical)
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
      .map(([k, x]) => [k, canonical(x)] as const)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  return v
}
