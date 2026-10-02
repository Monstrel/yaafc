import { HEAT, NUTRIENTS, iconUrl, itemName, itemsByKey, realItem } from '../lib/gameData'
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
  const src = iconUrl(itemsByKey.get(realItem(item))?.icon)
  return src ? (
    <img className="item-icon" src={src} width={size} height={size} alt="" loading="lazy" />
  ) : (
    <span className="item-icon missing" style={{ width: size, height: size }} aria-hidden />
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
