import { buildingsByKey, iconUrl } from '../lib/gameData'
import { KNOWLEDGE_ALTAR, altarYield, altarsFor } from '../lib/altar'
import { fmt, fmtMachines, fmtSeconds, wholeMachines } from '../lib/format'
import { buildingNameFor } from '../lib/plural'
import type { Modifiers } from '../lib/upgrades'

/** An amount of Knowledge Altar EXP, with the altar's icon. */
export function Exp({ exp, suffix = '' }: { exp: number; suffix?: string }) {
  const icon = iconUrl(buildingsByKey.get(KNOWLEDGE_ALTAR)?.icon)
  return (
    <span className="money">
      {fmt(exp)}
      {icon && <img className="item-icon" src={icon} width={16} height={16} alt="" />} EXP{suffix}
    </span>
  )
}

/** Knowledge Altars breaking down `perMinute` of an item: how many, and the EXP they make. */
export function AltarDetail({ item, perMinute, mods }: { item: string; perMinute: number; mods: Modifiers }) {
  const y = altarYield(item, mods)
  if (!y) return <span className="warn-text">can&apos;t go on a Knowledge Altar</span>
  const n = altarsFor(y, perMinute, mods)
  return (
    <span
      title={
        `${fmt(y.exp)} EXP each${y.relic ? ' (a relic: Relic Knowledge adds to it)' : ''}, ` +
        `${fmtSeconds(y.seconds)} to break one down`
      }
    >
      {fmtMachines(n)} {buildingNameFor(KNOWLEDGE_ALTAR, wholeMachines(n))} → <Exp exp={perMinute * y.exp} suffix="/min" />
    </span>
  )
}
