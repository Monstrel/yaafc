/** A small spinning ring, sized to the text around it: show it once work is slow (useNoticeable). */
export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
}
