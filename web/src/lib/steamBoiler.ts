/**
 * Steam Boiler output settings (USteamBoilerComponent, build 25321648; not in the data tables).
 * SetBoilingPower (VA 0x144A2E5E0) picks steam per cycle and cycle time; the panel's Low/Medium/High
 * boxes send power 0/1/2. While boiling, the tick (0x144A2AEB0) draws (steam ÷ seconds) × 20 P/s
 * from the heat source under it, scaled by Factory Efficiency like every machine, and a Steam
 * Heating Pad turns each Steam back into 20 P (0x1449D0090, no Fuel Efficiency). So steam carries
 * heat without loss: the fuel a plan burns is the same, just burned under boilers.
 */
export const BOILER_SETTINGS = [
  { name: 'Low', steam: 30, seconds: 6 },
  { name: 'Medium', steam: 100, seconds: 4 },
  { name: 'High', steam: 300, seconds: 2 },
] as const

/** Heat one Steam carries, drawn by the boiler and given back by a heating pad. */
export const STEAM_HEAT = 20

/** Heat (P/s) one boiler turns into steam on a setting, at a Factory Efficiency speed multiplier. */
export const boilerHeat = (setting: (typeof BOILER_SETTINGS)[number], factorySpeed: number) =>
  (setting.steam / setting.seconds) * STEAM_HEAT * factorySpeed

/** Boilers on one setting carrying some heat. */
export interface BoilerCount {
  setting: (typeof BOILER_SETTINGS)[number]
  /** Heat (P/s) each boiler carries: its setting's draw, or less when its fuel belt can't keep up. */
  each: number
  count: number
  /** One belt of the fuel brings its furnace less heat than the setting draws. */
  beltLimited: boolean
}

/**
 * Boilers per setting carrying `heat` P/s from one fuel. Each sits on a furnace (Stone or Blast
 * Furnace) fed by a single belt, so it gets at most a belt's worth of the fuel: `beltSpeed` items per
 * minute × `heatPerItem` P.
 */
export function boilersFor(heat: number, heatPerItem: number, factorySpeed: number, beltSpeed: number): BoilerCount[] {
  const belt = (beltSpeed / 60) * heatPerItem
  return BOILER_SETTINGS.map((setting) => {
    const draw = boilerHeat(setting, factorySpeed)
    const each = Math.min(draw, belt)
    return { setting, each, count: each > 0 ? Math.ceil(heat / each - 1e-9) : Infinity, beltLimited: belt < draw }
  })
}
