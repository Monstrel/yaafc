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
  /** The cells it covers across x and y, as rotated. */
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
  /** The buildings it stands on. */
  dependsOn: number[]
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
  if (b.RecipeName && b.RecipeName !== 'None') out.recipe = str(b.RecipeName)
  return out
}

function extent(buildings: PlacedBuilding[]): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  for (const b of buildings) {
    x = Math.max(x, b.cell[0] + b.area[0])
    y = Math.max(y, b.cell[1] + b.area[1])
    z = Math.max(z, b.cell[2] + 1)
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
