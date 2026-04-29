import { describe, expect, it } from 'vitest'
import { errorMessage } from '../../src/util/error'

describe('errorMessage', () => {
  it('返回 Error 实例的 message', () => {
    expect(errorMessage(new Error('oops'))).toBe('oops')
  })

  it('字符串原样返回', () => {
    expect(errorMessage('boom')).toBe('boom')
  })

  it('null/undefined 返回 Unknown error', () => {
    expect(errorMessage(null)).toBe('Unknown error')
    expect(errorMessage(undefined)).toBe('Unknown error')
  })

  it('其他对象走 String() 转换', () => {
    expect(errorMessage({ code: 500 })).toBe('[object Object]')
    expect(errorMessage(123)).toBe('123')
  })

  it('Error 子类也能拿到 message', () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError('custom'))).toBe('custom')
  })
})
