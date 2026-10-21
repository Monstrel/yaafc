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

/**
 * Building blocks: what's built only to take up space, holding things up or filling a gap, by the
 * building table's row name in lower case. Shop shelves and stairs have a use, and stay.
 */
const BUILDING_BLOCKS = new Set(
  [
    // Blocks.
    'WoodBlock', 'TriangularWoodBlock', 'StoneBlock', 'CharcoalBlock', 'BrickBlock', 'IronBlock', 'MarbleBlock',
    'CopperBlock', 'BronzeBlock', 'SilverBlock', 'GoldBlock', 'LeafBlock', 'CoreBlock',
    // Beams, stands, platforms and pillars.
    'Beam3', 'Beam5', 'Beam10', 'Beam18',
    'FrameSingle', 'FrameDuo', 'IronStand', 'IronStandDuo',
    'MetalStand', 'MetalStandEmpty', 'MetalStand1', 'MetalStand2',
    'SmallPlatform', 'MediumPlatform', 'CrossPlatform', 'Platform_Wood',
    'Pillar', 'MarblePillar',
    // Floors, walls, roofs and railings.
    'Construct_Floor_Wood', 'Construct_Floor_Wood_8x8', 'Construct_Floor_Brick', 'Construct_Floor_Brick_8x8',
    'Construct_Floor_Marble', 'Construct_Floor_Marble_8x8', 'Floor_Wood', 'FloorEdge_Wood', 'FloorCorner_Wood',
    'Construct_Wall_Wood', 'Construct_Wall_Wood_8x16', 'Construct_Wall_Wood_Window', 'Construct_Wall_Wood_Door',
    'Construct_Wall_Stone', 'Construct_Wall_Stone_8x16', 'Construct_Wall_Stone_Window', 'Construct_Wall_Stone_Door',
    'Construct_Wall_Brick', 'Construct_Wall_Brick_8x16', 'Construct_Wall_Brick_Window', 'Construct_Wall_Brick_Door',
    'Construct_Wall_Marble', 'Construct_Wall_Marble_8x16', 'Construct_Wall_Marble_Window', 'Construct_Wall_Marble_Door',
    'Wall_Wood_Tri', 'Wall_Brick_Tri', 'Wall_Marble_Tri', 'Wall_Wood', 'WallHorizontal_Wood', 'WallVertical_Wood',
    'WallCorner_Wood', 'WallWithDoor_Wood', 'WallWithWindow_Wood', 'Roof_Wood', 'Roof_Wood_2',
    'WoodRailing', 'WoodRailing_Half', 'WoodRail',
  ].map((name) => name.toLowerCase()),
)

/** Whether a building is a building block, there only to take up space. */
export function isBuildingBlock(name: string): boolean {
  return BUILDING_BLOCKS.has(name.toLowerCase())
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
