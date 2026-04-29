import { describe, expect, it } from 'vitest'
import { stripJsonFences, tryParseJson, tryParseJsonLoose } from '../../src/util/json'

describe('tryParseJson', () => {
  it('合法 JSON 返回解析后对象', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('非法 JSON 返回 null', () => {
    expect(tryParseJson('{a:1')).toBeNull()
  })

  it('空字符串返回 null', () => {
    expect(tryParseJson('')).toBeNull()
  })
})

describe('stripJsonFences', () => {
  it('移除 ```json ... ``` 围栏', () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('移除无语言标识 ``` 围栏', () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('无围栏原文返回 trim 结果', () => {
    expect(stripJsonFences('  {"a":1}  ')).toBe('{"a":1}')
  })
})

describe('tryParseJsonLoose', () => {
  it('支持带围栏的 JSON', () => {
    expect(tryParseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
})
