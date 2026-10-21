import { describe, expect, test } from 'vitest'
import manifest from '../../../public/models/manifest.json'
import { isBuildingBlock } from './buildingKinds'

// The buildings as the extractor wrote them (`dotnet run -- models`), by row name, with the game's names.
const buildings = manifest.buildings as Record<string, { name: string }>
const named = (pattern: RegExp) => Object.keys(buildings).filter((key) => pattern.test(buildings[key].name))

describe('isBuildingBlock', () => {
  test('takes in every block, beam, stand, platform, pillar, floor, wall, roof and railing, but not miniatures', () => {
    const blocks = named(/^(?!Miniature)(.* Block|Triangular Wooden Block|Beam|Lab Stands|Metal Stand|Reinforced Platform|Wooden Platform|(Marble )?Pillar|.* (Floor|Wall)|Gable Wall|Sloped Roof|Wooden Railing)$/)
    expect(blocks.length).toBeGreaterThan(60)
    expect(blocks.filter((key) => !isBuildingBlock(key))).toEqual([])
  })

  test('goes by the row name in any case', () => {
    expect(isBuildingBlock('woodblock')).toBe(true)
    expect(isBuildingBlock('BEAM18')).toBe(true)
  })

  test('leaves out what has a use', () => {
    for (const key of ['MediumStand', 'PotionStand', 'WallShelf', 'Stairs_Wood', 'ExpandableBeam', 'Belt', 'Cauldron', 'WoodCrate', 'MiniHouse'])
      expect(isBuildingBlock(key), key).toBe(false)
  })
})
