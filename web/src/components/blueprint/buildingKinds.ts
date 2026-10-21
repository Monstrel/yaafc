import { buildingsByKey } from '../../lib/gameData'

/**
 * How the X-ray draws a building without a model (while the models load, or one the game draws
 * without static meshes): a box coloured by what it's for.
 */
export type BuildingKind = 'machine' | 'belt' | 'logistics' | 'pipe' | 'frame' | 'support' | 'storage' | 'other'

const COLORS: Record<BuildingKind, string> = {
  machine: '#c77dff',
  belt: '#f0c04a',
  logistics: '#4fb3f0',
  pipe: '#3fd1b5',
  storage: '#b8834f',
  support: '#8d8698',
  frame: '#9a90a8',
  other: '#e07a7a',
}

// By the building table's row name (case varies: the game saves "catapult" for its "Catapult" row).
const PATTERNS: [RegExp, BuildingKind][] = [
  [/^belt(slope(up|down))?$/i, 'belt'],
  [/^(conveyerlift_|splitter|merger|filter|hopper|catapult|drawbridge)/i, 'logistics'],
  [/^pipe/i, 'pipe'],
  [/^frame/i, 'frame'],
  [/(stand|beam|block|shelf)/i, 'support'],
  [/(crate|chest|barrel|warehouse)/i, 'storage'],
]

export function buildingKind(name: string): BuildingKind {
  if (buildingsByKey.has(name)) return 'machine'
  return PATTERNS.find(([pattern]) => pattern.test(name))?.[1] ?? 'other'
}

/** A building's colour: its kind's, with machines told apart by a shade of their own. */
export function buildingColor(name: string, kind = buildingKind(name)): string {
  if (kind !== 'machine') return COLORS[kind]
  // A steady hue per machine, around the machines' violet through to amber.
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0
  const hue = 260 + (hash % 120)
  // Comma-separated: three.js's colour parser doesn't read the space-separated form.
  return `hsl(${hue % 360}, 62%, 64%)`
}

/** The game's name for a machine; for other buildings (until the models' names are in), their table name spelled out. */
export function buildingName(name: string): string {
  const machine = buildingsByKey.get(name)
  if (machine) return machine.name
  const words = name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
