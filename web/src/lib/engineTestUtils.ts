// Helpers shared by the engine test files.
import { expect } from 'vitest'
import { type PlanResult } from './solver'
import type { Plan } from './types'

export const round1 = (x: number) => Math.round(x * 10) / 10

export function plan(partial: Partial<Plan>): Plan {
  return { id: 't', name: 't', targets: [], producers: {}, machines: {}, ...partial }
}

export function expectBalanced(result: PlanResult) {
  expect(result.status).toBe('ok')
  for (const b of result.balances) {
    const net = b.produced - b.consumed + b.fromBus + b.deficit - b.surplus - b.altar
    const scale = Math.max(1, b.produced, b.consumed)
    expect(Math.abs(net - b.target) / scale).toBeLessThan(1e-6)
  }
}
