import { describe, expect, it } from 'vitest'
import { getMeegleAuthStatus } from '../../src/meegle/auth'

describe('getMeegleAuthStatus', () => {
  it('CLI 未安装时返回 installed=false 且 error 含安装提示', async () => {
    const r = await getMeegleAuthStatus({ binary: '/no/such/meegle' })
    expect(r.installed).toBe(false)
    expect(r.authenticated).toBe(false)
    expect(r.error).toMatch(/未安装/)
    expect(r.host).toBeNull()
    expect(r.expiresInMinutes).toBeNull()
  })

  it('binary 是 node 但参数不识别时，installed=true、authenticated=false、error 非空', async () => {
    const r = await getMeegleAuthStatus({ binary: process.execPath })
    expect(r.installed).toBe(true)
    expect(r.authenticated).toBe(false)
    expect(r.error).toBeTruthy()
  })
})
