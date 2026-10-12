import { useState, type InputHTMLAttributes } from 'react'

/**
 * A number box showing `value`, except while it's being typed in: then it keeps what was typed,
 * so a value that only catches up once the plan is solved again can't undo keystrokes.
 */
export function NumberInput({
  value,
  onValue,
  onBlur,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number
  /** What was typed, as typed. */
  onValue: (text: string) => void
}) {
  const [typed, setTyped] = useState<string | null>(null)
  return (
    <input
      {...rest}
      type="number"
      value={typed ?? value}
      onChange={(e) => {
        setTyped(e.target.value)
        onValue(e.target.value)
      }}
      onBlur={(e) => {
        setTyped(null)
        onBlur?.(e)
      }}
    />
  )
}
