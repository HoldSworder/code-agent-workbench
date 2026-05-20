import { describe, expect, it } from 'vitest'
import { runMeegleCli, runMeegleCliJson } from '../../src/meegle/cli'

const NODE = process.execPath

describe('runMeegleCli（用 node 替身）', () => {
  it('成功路径返回 stdout', async () => {
    const out = await runMeegleCli(['-e', 'process.stdout.write("hi")'], { binary: NODE })
    expect(out.stdout).toBe('hi')
  })

  it('binary 不存在抛 ENOENT 友好错误', async () => {
    await expect(runMeegleCli([], { binary: '/no/such/meegle' })).rejects.toThrow('未安装或不在 PATH 中')
  })

  it('exit 非 0 抛错', async () => {
    await expect(runMeegleCli(['-e', 'process.exit(3)'], { binary: NODE })).rejects.toThrow('meegle-cli 执行失败')
  })
})

describe('runMeegleCliJson', () => {
  it('解析合法 JSON', async () => {
    const r = await runMeegleCliJson<{ ok: boolean }>(['-e', 'process.stdout.write(JSON.stringify({ok: true}))'], { binary: NODE })
    expect(r).toEqual({ ok: true })
  })

  it('非 JSON 输出抛错', async () => {
    await expect(runMeegleCliJson(['-e', 'process.stdout.write("plain")'], { binary: NODE })).rejects.toThrow('非合法 JSON')
  })

  it('空输出抛错', async () => {
    await expect(runMeegleCliJson(['-e', ''], { binary: NODE })).rejects.toThrow('未输出任何内容')
  })
})
