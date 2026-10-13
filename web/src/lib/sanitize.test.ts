import { describe, expect, it } from 'vitest'
import { sanitizeCauldronSearch } from './sanitize'

const known = (k: string) => ['Salt', 'Coal', 'Sulfur'].includes(k)

describe('the cauldron search trail', () => {
  it('keeps the known targets above this one, in order', () => {
    const search = sanitizeCauldronSearch({ target: 'Sulfur', trail: ['Salt', 'Gone', 3, 'Coal'] }, known)
    expect(search?.trail).toEqual(['Salt', 'Coal'])
  })

  it('drops the trail without a target, and is empty when missing', () => {
    expect(sanitizeCauldronSearch({ target: 'Gone', trail: ['Salt'] }, known)?.trail).toEqual([])
    expect(sanitizeCauldronSearch({ target: 'Sulfur' }, known)?.trail).toEqual([])
  })
})
