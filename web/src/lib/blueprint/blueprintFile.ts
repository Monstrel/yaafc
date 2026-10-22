import { readProperties, Reader, type Properties, type PropertyValue } from './properties'

/**
 * An Alchemy Factory blueprint file: the game saves each one (and the Steam Workshop shares it) as
 * its 512×512 preview PNG with the blueprint appended after the image:
 *
 *   PNG image · header properties · Oodle Kraken stream · footer
 *
 * The header (title, description, icon, sizes) and the decompressed body (the buildings) are
 * tagged properties. The footer is the length of what comes between the image and it (int32),
 * then a marker, so the blueprint is found from the end of the file.
 */

/** A building in a blueprint. Cells are counted from the blueprint's lowest corner. */
export interface PlacedBuilding {
  /** Its id within the blueprint (the game's SettleKey), which `dependsOn` refers to. */
  id: number
  /** Its row in the game's building table (DT_Buildings), e.g. "Belt", "Athanor". */
  name: string
  /** The cell at its lowest corner: x, y and layer. */
  cell: [number, number, number]
  /** The cells it covers across x and y, as rotated (for a retractable one, its whole run). */
  area: [number, number]
  /** Quarter turns clockwise, seen from above. */
  rotation: 0 | 1 | 2 | 3
  /**
   * Where the game puts the building's origin, in its units (25 to a cell) from the blueprint's
   * lowest corner: x, y, and height (the bottom of its layer).
   */
  position: [number, number, number]
  /** Which shape a belt takes (its row in DT_BeltMeshBuildings), when the building has one. */
  variant?: number
  /** The recipe it's set to, for a machine that has one. */
  recipe?: string
  /** The seed it's set to grow, for a nursery. */
  seed?: string
  /**
   * The ingredient each of a cauldron's slots takes (null: any), when any of them is set. The game
   * saves three; an advanced cauldron uses the first two.
   */
  cauldronFilters?: (string | null)[]
  /** The item it lets through, for a filter. */
  filter?: string
  /** The item it buys, for a purchasing portal. */
  supply?: string
  /** The colour the player tinted it (a storage box's panels), as sRGB red, green and blue, 0–255. */
  color?: [number, number, number]
  /** The words the player wrote on it, for a notice board. */
  text?: string
  /** The buildings it stands on. */
  dependsOn: number[]
  /**
   * For a conveyor lift, the parts stacked on it, a layer each going up (its body sections, then
   * its top end): their building table rows, and their own turns.
   */
  stack?: { name: string; rotation: PlacedBuilding['rotation'] }[]
  /**
   * For a retractable beam or conveyor passage, the parts laid out from it along the ground, a cell
   * each (its body sections, then its far end): their building table rows, turns and origins.
   */
  run?: { name: string; rotation: PlacedBuilding['rotation']; position: [number, number, number] }[]
}

/**
 * How many layers a building fills, given each building table row's height in layers (one each
 * when not known): its own, or a lift's whole stack, each part a layer above the last.
 */
export function layersOf(b: PlacedBuilding, rowLayers: (name: string) => number = () => 1): number {
  let top = rowLayers(b.name)
  b.stack?.forEach((s, k) => (top = Math.max(top, k + 1 + rowLayers(s.name))))
  b.run?.forEach((s) => (top = Math.max(top, rowLayers(s.name))))
  return top
}

/** How many layers a blueprint fills, counting the full height of what stands on its top layer. */
export function blueprintLayers(bp: Blueprint, rowLayers: (name: string) => number): number {
  return Math.max(1, ...bp.buildings.map((b) => b.cell[2] + layersOf(b, rowLayers)))
}

export interface Blueprint {
  title: string
  description: string
  /** The item the player picked as its icon, if any. */
  icon?: string
  /** The game build that saved it. */
  version: number
  /** Its extent in cells: x, y and layers. */
  size: [number, number, number]
  buildings: PlacedBuilding[]
}

export class BlueprintError extends Error {}

const FOOTER_MARKER = 0x5042afd5
/** The game's units across a cell, and up a layer. */
export const CELL = 25
const ROTATIONS: Record<string, PlacedBuilding['rotation']> = {
  'EGridRotation::NoRotation': 0,
  'EGridRotation::ClockWise': 1,
  'EGridRotation::CentralSymmetry': 2,
  'EGridRotation::CounterClockWise': 3,
}

export async function readBlueprint(file: Uint8Array): Promise<Blueprint> {
  const footer = new Reader(file, file.length - 8)
  const length = file.length >= 8 ? footer.u32() : 0
  if (file.length < 8 || footer.u32() !== FOOTER_MARKER || length > file.length - 8)
    throw new BlueprintError('This isn’t an Alchemy Factory blueprint: the file has no blueprint data in it.')
  const r = new Reader(file, file.length - 8 - length)
  const header = readProperties(r)
  const compressedSize = num(header.CompressedSize)
  const size = num(header.UncompressedSize)
  if (r.pos + compressedSize > file.length - 8) throw new BlueprintError('This blueprint file is cut short.')

  // The decoder (ooz, GPL-3.0) loads with the first blueprint read.
  const { decompress } = await import('ooz-wasm')
  let body: Uint8Array
  try {
    body = decompress(file.subarray(r.pos, r.pos + compressedSize), size)
  } catch {
    throw new BlueprintError('This blueprint’s data couldn’t be unpacked: the file may be damaged.')
  }
  const data = readProperties(new Reader(body))
  // Where the blueprint was copied from, in cells: buildings' positions are in the world's units.
  const origin = list(obj(data.ParentGridGroup).Pivot).map((v) => num(v) * CELL)
  const buildings = list(data.Buildings).map((b) => placed(obj(b), origin))
  // The game copies only the cells a retractable building starts from, so its run can reach past
  // the blueprint's lowest corner: that corner moves out to take it in.
  const shift = [0, 1].map((i) => Math.min(0, ...buildings.map((b) => b.cell[i])))
  if (shift.some((s) => s < 0))
    for (const b of buildings) {
      b.cell = [b.cell[0] - shift[0], b.cell[1] - shift[1], b.cell[2]]
      b.position = [b.position[0] - shift[0] * CELL, b.position[1] - shift[1] * CELL, b.position[2]]
      for (const s of b.run ?? []) s.position = [s.position[0] - shift[0] * CELL, s.position[1] - shift[1] * CELL, s.position[2]]
    }
  return {
    title: str(header.Title),
    description: str(header.Description),
    icon: header.ItemName && header.ItemName !== 'None' ? str(header.ItemName) : undefined,
    version: num(header.Version),
    size: extent(buildings),
    buildings,
  }
}

function placed(b: Properties, origin: number[]): PlacedBuilding {
  const group = obj(b.RelativeGridGroup)
  const building = obj(b.building)
  const [x, y, z] = list(group.Pivot).map(num)
  const [w, d] = list(group.GridArea).map(num)
  const out: PlacedBuilding = {
    id: num(building.SettleKey),
    name: str(building.BuildingName),
    cell: [x, y, z],
    area: [w, d],
    rotation: ROTATIONS[str(building.GridRotation)] ?? 0,
    position: list(building.BuildPos).map((v, i) => num(v) - origin[i]) as [number, number, number],
    dependsOn: list(b.DependKeys ?? []).map(num),
  }
  if (typeof building.BaseActiveIndex === 'number') out.variant = building.BaseActiveIndex
  // Every building saves each of these, "None" where it hasn't one.
  const name = (v: PropertyValue | undefined) => (v === undefined || v === 'None' ? null : str(v))
  const recipe = name(b.RecipeName)
  if (recipe) out.recipe = recipe
  const seed = name(b.SeedName)
  if (seed) out.seed = seed
  const filter = name(b.FilterName)
  if (filter) out.filter = filter
  const supply = name(b.SupplyName)
  if (supply) out.supply = supply
  const slots = [b.CauldronFilterName, b['CauldronFilterName[1]'], b['CauldronFilterName[2]']].map(name)
  if (slots.some(Boolean)) out.cauldronFilters = slots
  // Blue, green, red, alpha; an untinted building's is white with no alpha.
  const [blue, green, red, alpha] = list(b.CustomColor ?? []).map(num)
  if (alpha) out.color = [red, green, blue]
  // Every building saves a NoticeString; only a notice board's has anything in it.
  if (b.NoticeString) out.text = str(b.NoticeString)
  // Its Extension lists its parts, starting with itself. A lift's go up from the bottom, their own
  // positions left at zero; a retractable building's (ExpandableH) go along the ground, each at its own.
  const extension = list(b.Extension ?? []).map(obj)
  const part = (e: Properties) => ({ name: str(e.BuildingName), rotation: ROTATIONS[str(e.GridRotation)] ?? 0 })
  if (extension.length > 1 && b.SettleKeyGroupType === 'ESettleKeyGroupType::ExpandableH') {
    out.run = extension.slice(1).map((e) => ({
      ...part(e),
      position: list(e.BuildPos).map((v, i) => num(v) - origin[i]) as [number, number, number],
    }))
    // It covers every cell its parts are in.
    const cells = out.run.map((s) => s.position.map((v) => Math.floor(v / CELL)))
    const low = [0, 1].map((i) => Math.min(out.cell[i], ...cells.map((c) => c[i])))
    const high = [0, 1].map((i) => Math.max(out.cell[i] + out.area[i], ...cells.map((c) => c[i] + 1)))
    out.cell = [low[0], low[1], z]
    out.area = [high[0] - low[0], high[1] - low[1]]
  } else if (extension.length > 1) out.stack = extension.slice(1).map(part)
  return out
}

function extent(buildings: PlacedBuilding[]): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  for (const b of buildings) {
    x = Math.max(x, b.cell[0] + b.area[0])
    y = Math.max(y, b.cell[1] + b.area[1])
    z = Math.max(z, b.cell[2] + layersOf(b))
  }
  return [x, y, z]
}

const shape = () => new BlueprintError('This blueprint has data the calculator doesn’t recognize.')
function num(v: PropertyValue | undefined): number {
  if (typeof v !== 'number') throw shape()
  return v
}
function str(v: PropertyValue | undefined): string {
  if (typeof v !== 'string') throw shape()
  return v
}
function list(v: PropertyValue | undefined): PropertyValue[] {
  if (!Array.isArray(v)) throw shape()
  return v
}
function obj(v: PropertyValue | undefined): Properties {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw shape()
  return v
}
