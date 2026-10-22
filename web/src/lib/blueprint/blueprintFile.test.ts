import { describe, expect, test } from 'vitest'
import iconUrl from '../../../public/icons/building_AdvancedAlembic.png?inline'
import { BlueprintError, blueprintLayers, layersOf, readBlueprint, type Blueprint } from './blueprintFile'

// Blueprints saved by the game (v1.1, build 20260527), as it writes them to Saved/Blueprints.
const files = import.meta.glob<string>('../../test/blueprints/*.png', { query: '?inline', import: 'default', eager: true })
const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
const fixture = (name: string) => bytes(files[`../../test/blueprints/${name}.png`])
const FIXTURES = ['steel', 'soap-unit', 'fertile-catalyst', 'color-boxes', 'sign', 'retract']

describe('readBlueprint', () => {
  test('reads the header the game shows in its blueprint panel', async () => {
    const bp = await readBlueprint(fixture('steel'))
    expect(bp).toMatchObject({ title: 'Steel', description: '', icon: 'LargeWoodGear', version: 20260527 })
  })

  test('places each building by its cell, rotated footprint and turn', async () => {
    const bp = await readBlueprint(fixture('steel'))
    expect(bp.size).toEqual([3, 7, 2])
    expect(bp.buildings).toHaveLength(20)
    const athanor = bp.buildings.find((b) => b.name === 'Athanor')
    expect(athanor).toMatchObject({ cell: [0, 1, 1], area: [2, 2], rotation: 3, recipe: 'SteelIngot' })
    // Its origin: the middle of its 2×2 cells, at the bottom of layer 1.
    expect(athanor!.position).toEqual([25, 50, 25])
    // The heater it stands on.
    expect(bp.buildings.find((b) => b.id === athanor!.dependsOn[0])?.name).toBe('SteamHeater')
    // A 2×1 merger turned a quarter covers 1×2 cells.
    expect(bp.buildings.find((b) => b.name === 'Merger_Vert')).toMatchObject({ area: [1, 2], rotation: 1 })
    const belts = bp.buildings.filter((b) => b.name === 'Belt')
    expect(belts).toHaveLength(11)
    expect(new Set(belts.map((b) => b.variant))).toEqual(new Set([16, 18, 20, 36, 40]))
  })

  test('stacks a conveyor lift’s parts on it, a layer each', async () => {
    const bp = await readBlueprint(fixture('fertile-catalyst'))
    const lifts = bp.buildings.filter((b) => b.name.startsWith('ConveyerLift'))
    expect(lifts.length).toBeGreaterThan(0)
    for (const lift of lifts) {
      const up = lift.name === 'ConveyerLift_Upwards'
      // Its body sections (none, for a lift two layers high), then its top end.
      expect(lift.stack!.at(-1)!.name).toBe(up ? 'ConveyerLift_EndUpwards' : 'ConveyerLift_EndDownwards')
      expect(lift.stack!.slice(0, -1).every((s) => s.name === 'ConveyerLift_Body')).toBe(true)
    }
    expect(bp.buildings.filter((b) => !b.name.startsWith('ConveyerLift')).every((b) => !b.stack)).toBe(true)
  })

  test('lays a retractable building’s parts along the ground, a cell each, and takes in its whole run', async () => {
    const bp = await readBlueprint(fixture('retract'))
    // The game copied only the cells they start from (1 × 3); their runs reach 7 cells across.
    expect(bp.size).toEqual([8, 3, 1])
    for (const [name, y] of [['ExpandableBeam', 2], ['ExpandableConveyorTunnel', 0]] as const) {
      const b = bp.buildings.find((b) => b.name === name)!
      expect(b).toMatchObject({ cell: [0, y, 0], area: [8, 1], rotation: 1, position: [187.5, y * 25 + 12.5, 0] })
      expect(b.stack).toBeUndefined()
      // Its body sections, then its far end, a cell further along each.
      expect(b.run!.map((s) => s.name)).toEqual([...Array(6).fill(`${name}Body`), name])
      expect(b.run!.map((s) => s.position)).toEqual([6, 5, 4, 3, 2, 1, 0].map((x) => [x * 25 + 12.5, y * 25 + 12.5, 0]))
      expect(layersOf(b)).toBe(1)
    }
    // The beam's far end faces back the other way.
    expect(bp.buildings.find((b) => b.name === 'ExpandableBeam')!.run!.at(-1)!.rotation).toBe(3)
  })

  test('reads the colour each box is tinted, and none for an untinted one', async () => {
    const bp = await readBlueprint(fixture('color-boxes'))
    const colors = Object.fromEntries(bp.buildings.map((b) => [`${b.name} ${b.cell}`, b.color]))
    expect(colors).toEqual({
      'SmallContainer 4,5,0': [255, 64, 255],
      'WoodContainer 0,5,0': [255, 64, 64],
      'MetalContainer 3,0,0': [64, 255, 64],
      'SmallContainer 0,1,0': undefined,
    })
  })

  test('reads the words written on a notice board, and none for other buildings', async () => {
    const bp = await readBlueprint(fixture('sign'))
    expect(bp.buildings.map((b) => [b.name, b.text])).toEqual([['NoticeBoard', 'This is a sign']])
    expect((await readBlueprint(fixture('steel'))).buildings.every((b) => b.text === undefined)).toBe(true)
  })

  test('reads what each machine is set to: its recipe, seed, filter or cauldron slots', async () => {
    const bp = await readBlueprint(fixture('fertile-catalyst'))
    const count = (list: string[]) => list.reduce<Record<string, number>>((n, k) => ({ ...n, [k]: (n[k] ?? 0) + 1 }), {})
    expect(count(bp.buildings.flatMap((b) => (b.seed ? [`${b.name} ${b.seed}`] : [])))).toEqual({
      'AutoNursery LavenderSeed': 3,
      'AutoNursery ChamomileSeed': 1,
      'AutoNursery GentianSeed': 1,
      'AutoNursery RedcurrantSeed': 1,
      'AutoNursery FlaxSeed': 2,
    })
    expect(count(bp.buildings.flatMap((b) => (b.cauldronFilters ? [`${b.name} ${b.cauldronFilters}`] : [])))).toEqual({
      'Cauldron Lavender,Lavender,Chamomile': 4,
      'Cauldron Redcurrant,Gentian,GentianNectar': 3,
    })
    expect(bp.buildings.flatMap((b) => (b.filter ? [[b.name, b.filter]] : []))).toEqual([['Filter_Vert', 'Gentian']])
    expect(bp.buildings.every((b) => !b.supply)).toBe(true)
    // A machine's recipe, and nothing else set on the rest.
    const steel = await readBlueprint(fixture('steel'))
    expect(steel.buildings.filter((b) => b.recipe).map((b) => [b.name, b.recipe])).toEqual([['Athanor', 'SteelIngot']])
    expect(steel.buildings.every((b) => !b.seed && !b.filter && !b.supply && !b.cauldronFilters)).toBe(true)
  })

  test('reads a tall blueprint with every layer', async () => {
    const bp = await readBlueprint(fixture('fertile-catalyst'))
    expect(bp.title).toBe('Fertile Catalyst')
    expect(bp.size).toEqual([9, 28, 11])
    expect(bp.buildings).toHaveLength(326)
    expect(bp.buildings.filter((b) => b.name === 'catapult')).toHaveLength(25)
  })

  test.each(FIXTURES)('%s: every building is inside the blueprint, with its own id', async (name) => {
    const bp: Blueprint = await readBlueprint(fixture(name))
    const [x, y, z] = bp.size
    for (const b of bp.buildings) {
      expect(b.cell.every((c) => c >= 0)).toBe(true)
      expect(b.cell[0] + b.area[0]).toBeLessThanOrEqual(x)
      expect(b.cell[1] + b.area[1]).toBeLessThanOrEqual(y)
      expect(b.cell[2] + layersOf(b)).toBeLessThanOrEqual(z)
      // Its origin is over its cells, on its layer.
      expect(b.position[0]).toBeGreaterThanOrEqual(b.cell[0] * 25)
      expect(b.position[0]).toBeLessThanOrEqual((b.cell[0] + b.area[0]) * 25)
      expect(b.position[1]).toBeGreaterThanOrEqual(b.cell[1] * 25)
      expect(b.position[1]).toBeLessThanOrEqual((b.cell[1] + b.area[1]) * 25)
      expect(b.position[2]).toBe(b.cell[2] * 25)
    }
    expect(new Set(bp.buildings.map((b) => b.id)).size).toBe(bp.buildings.length)
  })

  test('turns down a PNG that isn’t a blueprint', async () => {
    await expect(readBlueprint(bytes(iconUrl))).rejects.toThrow(BlueprintError)
    await expect(readBlueprint(new Uint8Array(3))).rejects.toThrow(BlueprintError)
  })

  test('turns down a damaged blueprint', async () => {
    const bp = fixture('steel')
    // The footer still points at the header, but the compressed data is garbled.
    const garbled = bp.slice()
    const at = garbled.length - 400
    garbled.fill(0x55, at, at + 64)
    await expect(readBlueprint(garbled)).rejects.toThrow(BlueprintError)
  })
})

describe('layers', () => {
  test('a building fills its height in layers; a lift, its whole stack', async () => {
    const bp = await readBlueprint(fixture('fertile-catalyst'))
    const heights: Record<string, number> = { cauldron: 2, conveyerlift_endupwards: 1 }
    const rowLayers = (name: string) => heights[name.toLowerCase()] ?? 1
    const cauldron = bp.buildings.find((b) => b.name === 'Cauldron')!
    expect(layersOf(cauldron, rowLayers)).toBe(2)
    const lift = bp.buildings.find((b) => b.stack)!
    expect(layersOf(lift, rowLayers)).toBe(1 + lift.stack!.length)
  })

  test('a blueprint counts the full height of what stands on its top layer', async () => {
    const bp = await readBlueprint(fixture('steel'))
    expect(blueprintLayers(bp, () => 1)).toBe(bp.size[2])
    // Its Athanor stands on layer 2 (the top one), three layers high.
    expect(blueprintLayers(bp, (name) => (name === 'Athanor' ? 3 : 1))).toBe(4)
  })
})
