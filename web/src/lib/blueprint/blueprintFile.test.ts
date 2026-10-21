import { describe, expect, test } from 'vitest'
import iconUrl from '../../../public/icons/building_AdvancedAlembic.png?inline'
import { BlueprintError, readBlueprint, type Blueprint } from './blueprintFile'

// Blueprints saved by the game (v1.1, build 20260527), as it writes them to Saved/Blueprints.
const files = import.meta.glob<string>('../../test/blueprints/*.png', { query: '?inline', import: 'default', eager: true })
const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
const fixture = (name: string) => bytes(files[`../../test/blueprints/${name}.png`])
const FIXTURES = ['steel', 'soap-unit', 'fertile-catalyst']

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
    // The heater it stands on.
    expect(bp.buildings.find((b) => b.id === athanor!.dependsOn[0])?.name).toBe('SteamHeater')
    // A 2×1 merger turned a quarter covers 1×2 cells.
    expect(bp.buildings.find((b) => b.name === 'Merger_Vert')).toMatchObject({ area: [1, 2], rotation: 1 })
    const belts = bp.buildings.filter((b) => b.name === 'Belt')
    expect(belts).toHaveLength(11)
    expect(new Set(belts.map((b) => b.variant))).toEqual(new Set([16, 18, 20, 36, 40]))
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
      expect(b.cell[2]).toBeLessThan(z)
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
