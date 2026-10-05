// Made once: toLocaleString() builds a new formatter on every call, which shows on big plans.
const grouped = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

/** Compact number for rates: 3 significant digits, thousands grouped. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '–'
  const a = Math.abs(n)
  if (a === 0) return '0'
  if (a >= 1000) return grouped.format(Math.round(n))
  if (a >= 100) return n.toFixed(0)
  if (a >= 10) return n.toFixed(1).replace(/\.0$/, '')
  if (a >= 0.01) return n.toFixed(2).replace(/\.?0+$/, '')
  return n.toPrecision(2)
}

/** Machines to build: never a fraction of one. */
export const wholeMachines = (n: number) => Math.ceil(n - 1e-9)

/** Machines as built, with how much of them is used when it's less: "16 (15.6)". */
export function fmtMachines(n: number): string {
  if (!Number.isFinite(n)) return fmt(n)
  const whole = fmt(wholeMachines(n))
  const used = fmt(n)
  return used === whole ? whole : `${whole} (${used})`
}

export function fmtSeconds(s: number): string {
  return s >= 100 ? `${Math.round(s)}s` : `${fmt(s)}s`
}
