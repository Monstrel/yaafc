import { HEAT, NUTRIENTS, iconUrl, itemName, itemsByKey } from '../lib/gameData'
import { fmt } from '../lib/format'
import { itemNameFor } from '../lib/plural'

const PSEUDO_GLYPH: Record<string, string> = { [HEAT]: '🔥', [NUTRIENTS]: '🌱' }

export function ItemIcon({ item, size = 24 }: { item: string; size?: number }) {
  const glyph = PSEUDO_GLYPH[item]
  if (glyph)
    return (
      <span className="item-icon glyph" style={{ width: size, height: size, fontSize: size * 0.7 }} aria-hidden>
        {glyph}
      </span>
    )
  const src = iconUrl(itemsByKey.get(item)?.icon)
  return src ? (
    <img className="item-icon" src={src} width={size} height={size} alt="" loading="lazy" />
  ) : (
    <span className="item-icon missing" style={{ width: size, height: size }} aria-hidden />
  )
}

/** What a Nursery grows, after its name: " (🌰 Redcurrant)", the seed's icon and the plant. */
export function SeedNote({ seed, plant, size = 14 }: { seed?: string; plant: string; size?: number }) {
  if (!seed) return null
  return (
    <span className="nursery-seed" title={`Plant ${itemName(seed)}`}>
      {' '}
      (<ItemIcon item={seed} size={size} />
      {itemName(plant)})
    </span>
  )
}

/** Icon + name, optionally with a count in front ("12 Iron Ingots", "12 Coal"). */
export function ItemLabel({ item, count, size = 20 }: { item: string; count?: number; size?: number }) {
  return (
    <span className="item-label" title={itemName(item)}>
      <ItemIcon item={item} size={size} />
      {count !== undefined && <span className="count">{fmt(count)}</span>}
      <span className="name">{count === undefined ? itemName(item) : itemNameFor(item, count)}</span>
    </span>
  )
}
