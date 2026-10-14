import type { ReactNode } from 'react'
import { licenseName } from '../lib/dispatch'
import { fmt } from '../lib/format'
import { dispatch, iconUrl, MAX_TIER } from '../lib/gameData'
import type { Progress } from '../lib/types'
import {
  DISPATCH_UPGRADES,
  PLANNER_UPGRADES,
  POTION_BELT,
  SUPPLIER_LICENSES,
  attributeBonus,
  firstLevel,
  maxLevel,
  upgradeLevel,
  type Modifiers,
} from '../lib/upgrades'
import { ResearchTier } from './planner/PlanPanels'

/** What each upgrade series currently does, shown under its name. */
const UPGRADE_EFFECTS: Record<string, (m: Modifiers) => string> = {
  Conveyer: (m) => `${fmt(m.beltSpeed)} items/min per belt`,
  FactorySpeed: (m) => `×${fmt(m.factorySpeed)} crafting speed`,
  AlchemySkill: (m) => `×${fmt(m.extractor)} Extractor & Alembic output`,
  FuelEfficiency: (m) => `×${fmt(m.fuel)} heat per fuel`,
  FertilizeEfficiency: (m) => `×${fmt(m.fertilizer)} nutrients per fertilizer`,
  AltarEfficiency: (m) => `×${fmt(m.altar)} EXP from relics`,
  ContractProfit: (m) => {
    if (!m.licenses) return 'base dispatch limits and pay'
    const held = { [SUPPLIER_LICENSES.key]: m.licenses }
    return `${licenseName(m.licenses)}: +${fmt(attributeBonus(held, 'ContractNum'))}% dispatch limits, +${fmt(attributeBonus(held, 'ContractProfit'))}% pay`
  },
  SleepTime: (m) => `${fmt(m.dayMinutes)}-minute days${m.dayMinutes < 24 ? ', never going to bed early' : ', no sleep'}`,
}

const UPGRADE_TITLES: Record<string, string> = {
  [SUPPLIER_LICENSES.key]: `Supplier Licenses held, for Dispatch Portal targets: ${dispatch.licenses.join(', ')}`,
  [POTION_BELT.key]: 'Potion Belt level, for Dispatch Portal targets: each level above 1 cuts sleep by 2 hours, so the day lasts longer',
}

interface Props {
  progress: Progress
  /** What the upgrades come to. */
  mods: Modifiers
  /** Research tier reached (every tier, when the player hasn't set one). */
  tier: number
  /** Each change says what it does, for undo. */
  onProgress: (label: string, update: (p: Progress) => Progress) => void
  hint: ReactNode
  /** More settings, after the upgrades. */
  children?: ReactNode
}

/** The player's game progress (research tier and upgrade levels), shared by every page that uses it. */
export function UpgradesPanel({ progress, mods, tier, onProgress, hint, children }: Props) {
  return (
    <section className="panel">
      <h2>Upgrades</h2>
      <p className="hint">{hint}</p>
      <ResearchTier
        tier={tier}
        onChange={(t) => onProgress('Change research tier', (p) => ({ ...p, tier: t === MAX_TIER ? undefined : t }))}
      />
      {[...PLANNER_UPGRADES, ...DISPATCH_UPGRADES].map((u) => (
        <label
          className="upgrade-row"
          key={u.key}
          title={
            u.unlimited
              ? `Level ${u.levels.length} is the ∞ node; each level above it is one more purchase of it` +
                (Number.isFinite(maxLevel(u)) ? ` (up to ${maxLevel(u)})` : '')
              : UPGRADE_TITLES[u.key]
          }
        >
          {u.icon && <img className="upgrade-icon" src={iconUrl(u.icon)!} width={32} height={32} alt="" />}
          <span className="upgrade-name">
            {u.name}
            <span className="upgrade-effect">{UPGRADE_EFFECTS[u.key]?.(mods)}</span>
          </span>
          <input
            type="number"
            min={firstLevel(u)}
            max={Number.isFinite(maxLevel(u)) ? maxLevel(u) + firstLevel(u) : undefined}
            value={upgradeLevel(progress.upgrades, u) + firstLevel(u)}
            onChange={(e) =>
              onProgress(`Change ${u.name} level`, (p) => ({
                ...p,
                upgrades: {
                  ...p.upgrades,
                  [u.key]: upgradeLevel({ [u.key]: (Number(e.target.value) || 0) - firstLevel(u) }, u),
                },
              }))
            }
          />
        </label>
      ))}
      {children}
    </section>
  )
}
