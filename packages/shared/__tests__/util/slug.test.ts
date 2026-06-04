import { describe, expect, it } from 'vitest'
import { normalizeSlug } from '../../src/util/slug'

describe('normalizeSlug', () => {
  it('keeps a valid kebab-case slug', () => {
    expect(normalizeSlug('add-user-login')).toBe('add-user-login')
  })

  it('trims quotes and whitespace, lowercases', () => {
    expect(normalizeSlug('  "Add User Login"  ')).toBe('add-user-login')
  })

  it('strips feature/ and feature- prefixes', () => {
    expect(normalizeSlug('feature/refactor-auth')).toBe('refactor-auth')
    expect(normalizeSlug('feature-refactor-auth')).toBe('refactor-auth')
  })

  it('normalizes underscores/spaces and drops illegal chars', () => {
    expect(normalizeSlug('add_user__login!')).toBe('add-user-login')
  })

  it('keeps only the first line', () => {
    expect(normalizeSlug('add-user-login\nor add-login')).toBe('add-user-login')
  })

  it('throws when nothing valid remains', () => {
    expect(() => normalizeSlug('!!!')).toThrow(/无法归一化/)
  })

  it('caps length at 60 on a hyphen boundary', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join('-')
    const out = normalizeSlug(long)
    expect(out.length).toBeLessThanOrEqual(60)
  })
})
