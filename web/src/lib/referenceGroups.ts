import { itemsByKey, type Item } from './gameData'

/**
 * Items the game keeps out of sight, which the Reference shows as one entry: every link to one
 * of them goes to the group's page, which explains them together. The game hides each tier of
 * refined sand (bHideInGame), calls the first five all "Refined Sand", and tells them apart only
 * by their icons.
 */
export interface ItemGroup {
  /** Its address in the Reference (`reference?item=<key>`): not an item key. */
  key: string
  name: string
  /** Its items, in order. */
  members: string[]
}

export const ITEM_GROUPS: ItemGroup[] = [
  { key: 'RefinedSand', name: 'Refined Sand', members: ['Sand2', 'Sand3', 'Sand4', 'Sand5', 'Sand6', 'Sand8'] },
]

const byMember = new Map(ITEM_GROUPS.flatMap((g) => g.members.map((m) => [m, g] as const)))
const byKey = new Map(ITEM_GROUPS.map((g) => [g.key, g]))

/** The group an item is in, if any. */
export const groupOf = (item: string) => byMember.get(item)
/** The group a Reference address names, if it names one. */
export const groupByKey = (key: string) => byKey.get(key)
/** Where the Reference shows an item: its group's page, or its own. */
export const entryOf = (item: string) => byMember.get(item)?.key ?? item

/** The item standing for a group in lists: its first member's icon and data, under the group's name. */
export const groupItem = (g: ItemGroup): Item => ({ ...itemsByKey.get(g.members[0])!, key: g.key, name: g.name, hidden: false })
