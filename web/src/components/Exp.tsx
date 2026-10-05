import { buildingsByKey, iconUrl } from '../lib/gameData'
import { fmt } from '../lib/format'

/** An amount of Knowledge Altar EXP, with the altar's icon. */
export function Exp({ exp, suffix = '' }: { exp: number; suffix?: string }) {
  const icon = iconUrl(buildingsByKey.get('KnowledgeAltar')?.icon)
  return (
    <span className="money">
      {fmt(exp)}
      {icon && <img className="item-icon" src={icon} width={16} height={16} alt="" />} EXP{suffix}
    </span>
  )
}
