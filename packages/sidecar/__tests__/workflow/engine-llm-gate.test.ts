import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { WorkflowEngine } from '../../src/workflow/engine'
import { SettingsRepository } from '../../src/db/repositories/settings.repo'
import type { AgentProvider } from '../../src/providers/types'

const { promptMock } = vi.hoisted(() => ({ promptMock: vi.fn() }))

vi.mock('@cursor/sdk', () => ({
  Agent: { prompt: promptMock },
  CursorAgentError: class CursorAgentError extends Error {},
}))

const WORKFLOW_YAML = `
name: test
description: test workflow
gate_definitions:
  quality_ok:
    description: 质量达标（仅 llm_judge）
    checks:
      - type: llm_judge
        prompt: "产出是否达标？"
stages:
  - id: main
    name: 主阶段
    phases:
      - id: dev
        name: 开发
        provider: external-cli
        skill: skills/dev.md
`

function mockProvider(): AgentProvider {
  return {
    run: vi.fn().mockResolvedValue({ status: 'success', output: 'done' }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
}

describe('WorkflowEngine.evaluateGateAsync (llm_judge)', () => {
  let db: Database.Database
  let engine: WorkflowEngine

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    engine = new WorkflowEngine({
      db,
      workflowYaml: WORKFLOW_YAML,
      resolveProvider: () => mockProvider(),
      resolveSkillContent: () => 'skill content',
    })
    promptMock.mockReset()
  })

  afterEach(() => db.close())

  function evalGate(): Promise<boolean> {
    // 私有方法，测试中以 any 访问；默认 wfConfig 用 engine.config（含上面的 gate）。
    return (engine as any).evaluateGateAsync('quality_ok', '/tmp', 'openspec/changes/x')
  }

  it('LLM 回复 PASS → 门禁通过', async () => {
    new SettingsRepository(db).set('agent.cursorApiKey', 'key_test')
    promptMock.mockResolvedValueOnce({ id: 'r', status: 'finished', result: 'PASS 产出完整' })

    await expect(evalGate()).resolves.toBe(true)
    expect(promptMock).toHaveBeenCalledTimes(1)
  })

  it('LLM 回复 FAIL → 门禁不通过', async () => {
    new SettingsRepository(db).set('agent.cursorApiKey', 'key_test')
    promptMock.mockResolvedValueOnce({ id: 'r', status: 'finished', result: 'FAIL 缺少验收标准' })

    await expect(evalGate()).resolves.toBe(false)
    expect(promptMock).toHaveBeenCalledTimes(1)
  })

  it('未配置 Cursor API Key → fail-open（视为通过），不触发 SDK', async () => {
    await expect(evalGate()).resolves.toBe(true)
    expect(promptMock).not.toHaveBeenCalled()
  })
})
