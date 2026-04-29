import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAgentEnv, buildSniProxyPatch, parseSocks5 } from '../../src/cli/env'

const SAVED = { ...process.env }
beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, SAVED)
})
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, SAVED)
})

describe('parseSocks5', () => {
  it('解析 socks5://host:port', () => {
    expect(parseSocks5('socks5://10.0.0.1:1080')).toEqual({ host: '10.0.0.1', port: '1080' })
  })

  it('无 scheme 仅 host:port', () => {
    expect(parseSocks5('1.2.3.4:7890').port).toBe('7890')
  })

  it('解析失败返回默认 127.0.0.1:7890', () => {
    expect(parseSocks5('not a url')).toEqual({ host: '127.0.0.1', port: '7890' })
  })
})

describe('buildSniProxyPatch', () => {
  it('从 proxyUrl 抽出 host/port，附带 scriptPath', () => {
    const p = buildSniProxyPatch({ scriptPath: '/abs/patch.cjs', proxyUrl: 'socks5://127.0.0.1:7890' })
    expect(p).toEqual({ scriptPath: '/abs/patch.cjs', socks5Host: '127.0.0.1', socks5Port: 7890 })
  })
})

describe('buildAgentEnv', () => {
  it('默认剥离父进程 NODE_OPTIONS / npm_ / ELECTRON_', () => {
    process.env.NODE_OPTIONS = '--require unrelated.cjs'
    process.env.npm_config_foo = 'bar'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.PATH = '/usr/bin'

    const env = buildAgentEnv()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.npm_config_foo).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('父进程已带 SNI patch 时 NODE_OPTIONS 被透传，且 proxy env 被清空', () => {
    process.env.NODE_OPTIONS = '--require /abs/agent-socks5-patch.cjs'
    process.env.HTTP_PROXY = 'http://1.2.3.4:8080'
    process.env.https_proxy = 'http://1.2.3.4:8080'

    const env = buildAgentEnv()
    expect(env.NODE_OPTIONS).toContain('agent-socks5-patch')
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.https_proxy).toBeUndefined()
  })

  it('显式传入 sniProxyPatch 时注入 NODE_OPTIONS / AGENT_SOCKS5_*', () => {
    delete process.env.NODE_OPTIONS
    process.env.HTTP_PROXY = 'http://leftover:9999'

    const env = buildAgentEnv({
      sniProxyPatch: { scriptPath: '/abs/patch.cjs', socks5Host: '127.0.0.1', socks5Port: 7890 },
    })
    expect(env.NODE_OPTIONS).toBe('--require "/abs/patch.cjs"')
    expect(env.AGENT_SOCKS5_HOST).toBe('127.0.0.1')
    expect(env.AGENT_SOCKS5_PORT).toBe('7890')
    expect(env.HTTP_PROXY).toBeUndefined()
  })

  it('仅传 proxyUrl 时设置 HTTP_PROXY / https_proxy 等', () => {
    delete process.env.NODE_OPTIONS
    delete process.env.HTTP_PROXY
    delete process.env.https_proxy

    const env = buildAgentEnv({ proxyUrl: 'http://10.0.0.1:1080' })
    expect(env.HTTP_PROXY).toBe('http://10.0.0.1:1080')
    expect(env.HTTPS_PROXY).toBe('http://10.0.0.1:1080')
    expect(env.https_proxy).toBe('http://10.0.0.1:1080')
  })

  it('extraEnv 在最后覆盖父进程同名变量', () => {
    process.env.PATH = '/parent/path'
    const env = buildAgentEnv({ extraEnv: { PATH: '/override', NO_COLOR: '1' } })
    expect(env.PATH).toBe('/override')
    expect(env.NO_COLOR).toBe('1')
  })
})
