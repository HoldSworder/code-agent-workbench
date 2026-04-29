import { describe, expect, it } from 'vitest'
import { runLarkCli, runLarkCliJson } from '../../src/lark/cli'

const NODE = process.execPath

describe('runLarkCli（用 node 替身）', () => {
  it('成功路径返回 stdout', async () => {
    const out = await runLarkCli(['-e', 'process.stdout.write("hello")'], { binary: NODE })
    expect(out.stdout).toBe('hello')
  })

  it('binary 不存在抛 ENOENT 友好错误', async () => {
    await expect(runLarkCli([], { binary: '/no/such/lark-cli' })).rejects.toThrow('未安装或不在 PATH 中')
  })

  it('exit 非 0 抛错', async () => {
    await expect(runLarkCli(['-e', 'process.exit(2)'], { binary: NODE })).rejects.toThrow('lark-cli 执行失败')
  })
})

describe('runLarkCliJson', () => {
  it('解析合法 JSON', async () => {
    const r = await runLarkCliJson<{ ok: boolean }>(['-e', 'process.stdout.write(JSON.stringify({ok: true}))'], { binary: NODE })
    expect(r).toEqual({ ok: true })
  })

  it('非 JSON 输出抛错', async () => {
    await expect(runLarkCliJson(['-e', 'process.stdout.write("plain")'], { binary: NODE })).rejects.toThrow('非合法 JSON')
  })

  it('空输出抛错', async () => {
    await expect(runLarkCliJson(['-e', ''], { binary: NODE })).rejects.toThrow('未输出任何内容')
  })
})
