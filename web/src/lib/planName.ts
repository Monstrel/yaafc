import { itemName } from './gameData'
import type { Plan } from './types'

/** What plans were called before they were named after their targets. */
const OLD_DEFAULT = 'New plan'

/** Whether the plan is named after its targets: the player hasn't given it a name of their own. */
export function namedAfterTargets(plan: Plan): boolean {
  const name = plan.name.trim()
  return !name || name === OLD_DEFAULT
}

/** The name a plan goes by when the player hasn't named it: the items its targets make. */
export function targetsName(plan: Plan): string {
  const items = [...new Set(plan.targets.map((t) => t.item).filter(Boolean))].map(itemName)
  if (!items.length) return OLD_DEFAULT
  if (items.length <= 3) return items.join(' + ')
  return `${items.slice(0, 2).join(' + ')} + ${items.length - 2} more`
}

/** The name the plan is shown by. */
export function planTitle(plan: Plan): string {
  return namedAfterTargets(plan) ? targetsName(plan) : plan.name
}
