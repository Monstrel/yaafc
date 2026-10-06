/**
 * Steam Boiler output settings (USteamBoilerComponent, build 25321648; not in the data tables).
 * SetBoilingPower (VA 0x144A2E5E0) picks steam per cycle and cycle time; the panel's Low/Medium/High
 * boxes send power 0/1/2. While boiling, the tick (0x144A2AEB0) draws (steam ÷ seconds) × 20 P/s
 * from the heat source under it, scaled by Factory Efficiency like every machine, and a Steam
 * Heating Pad turns each Steam back into 20 P (0x1449D0090, no Fuel Efficiency). So steam carries
 * heat without loss: the fuel a plan burns is the same, just burned under boilers. The plan runs
 * them as recipes (see processes.ts): heat in, Steam out, on the setting the row picks.
 */
export const BOILER_SETTINGS = [
  { name: 'Low', steam: 30, seconds: 6 },
  { name: 'Medium', steam: 100, seconds: 4 },
  { name: 'High', steam: 300, seconds: 2 },
] as const

/** Heat one Steam carries, drawn by the boiler and given back by a heating pad. */
export const STEAM_HEAT = 20
