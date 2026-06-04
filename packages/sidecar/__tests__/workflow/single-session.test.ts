import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySchema } from '../../src/db/schema'
import { WorkflowEngine } from '../../src/workflow/engine'
import { RepoRepository } from '../../src/db/repositories/repo.repo'
import { RequirementRepository } from '../../src/db/repositories/requirement.repo'
import { RepoTaskRepository } from '../../src/db/repositories/repo-task.repo'
import { MessageRepository } from '../../src/db/repositories/message.repo'
import { ActivatedPhaseRepository } from '../../src/db/repositories/activated-phase.repo'
import type { AgentProvider, PhaseContext, PhaseResult } from '../../src/providers/types'

/**
 * 单会话工作流模式的端到端集成测试。
 *
 * 用真实临时目录作 worktree，自定义可脚本化的 mock provider 模拟 agent
 * 调用 advance-phase 工具（写 .code-agent/advance-request.json + 可选创建产出文件），
 * 端到端驱动 WorkflowEngine 状态机，验证四条核心路径：
 *  1. next 正常推进
 *  2. requires_confirm phase 的 waiting_confirm + 确认后 resume 推进
 *  3. completion_check gate fail → 错误回喂 → 重跑通过
 *  4. target 跳转激活 optional phase
 * 以及 pending_input 主动挂起、terminal 主动终结、bundle 仅首次注入。
 */

const WORKFLOW_YAML = `
name: single-session-test
description: e2e single session test
gate_definitions:
  has_output:
    description: output.txt 必须存在
    checks:
      - type: exists
        path: "output.txt"
stages:
  - id: build
    name: 构建
    phases:
      - id: phase-a
        name: A阶段
        provider: external-cli
        skill: skills/a.md
        requires_confirm: true
      - id: phase-b
        name: B阶段
        provider: external-cli
        skill: skills/b.md
        completion_check: has_output
      - id: phase-opt
        name: 可选阶段
        provider: external-cli
        skill: skills/opt.md
        optional: true
      - id: phase-c
        name: C阶段
        provider: external-cli
        skill: skills/c.md
        is_terminal: true
`

interface ScriptStep {
  /** 写入 advance-request.json 的 mode；不写则不发推进请求 */
  advanceMode?: 'next' | 'target' | 'pending_input' | 'terminal'
  target?: string
  /** 相对 worktree 创建的产出文件 */
  createFiles?: string[]
  status?: PhaseResult['status']
}

interface ScriptedProvider extends AgentProvider {
  sessionId: string | null
  capturedContexts: PhaseContext[]
  callCount: () => number
}

/**
 * 每次 run 按序消费一个 step：先创建产出文件，再写 advance-request.json，
 * 模拟 agent 在本轮回复里调用 advance-phase 工具。
 */
function createScriptedProvider(steps: ScriptStep[]): ScriptedProvider {
  let i = 0
  const capturedContexts: PhaseContext[] = []

  const run = vi.fn(async (context: PhaseContext): Promise<PhaseResult> => {
    capturedContexts.push(context)
    const step = steps[Math.min(i, steps.length - 1)] ?? {}
    i++

    const cwd = context.repoPath
    for (const f of step.createFiles ?? [])
      writeFileSync(join(cwd, f), 'x')

    if (step.advanceMode) {
      const dir = join(cwd, '.code-agent')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'advance-request.json'),
        JSON.stringify({
          fromPhaseId: context.phaseId,
          mode: step.advanceMode,
          target: step.target,
          requestedAt: Math.floor(Date.now() / 1000),
        }),
      )
    }

    return { status: step.status ?? 'success', output: 'done' }
  })

  return {
    run,
    cancel: vi.fn().mockResolvedValue(undefined),
    model: null,
    sessionId: 'sess-1',
    capturedContexts,
    callCount: () => i,
  }
}

describe('WorkflowEngine single-session mode', () => {
  let db: Database.Database
  let worktree: string
  let taskId: string

  function makeEngine(provider: AgentProvider): WorkflowEngine {
    return new WorkflowEngine({
      db,
      dbPath: ':memory:',
      workflowYaml: WORKFLOW_YAML,
      resolveProvider: () => provider,
      resolveSkillContent: (p: string) => `# skill ${p}`,
      cliType: 'cursor-cli',
    })
  }

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)

    worktree = mkdtempSync(join(tmpdir(), 'ss-e2e-'))

    const repoRepo = new RepoRepository(db)
    const reqRepo = new RequirementRepository(db)
    const r = repoRepo.create({ name: 'app', local_path: worktree, default_branch: 'main' })
    const req = reqRepo.create({ title: '单会话测试需求', description: 'desc', source: 'manual' })

    const taskRepo = new RepoTaskRepository(db)
    const task = taskRepo.create({
      requirement_id: req.id,
      repo_id: r.id,
      branch_name: 'feature/ss',
      change_id: 'ss',
      openspec_path: 'openspec/changes/ss',
      worktree_path: worktree,
    })
    taskId = task.id
  })

  afterEach(() => {
    db.close()
    rmSync(worktree, { recursive: true, force: true })
  })

  it('路径1+2+3: next 推进、waiting_confirm、gate fail 回喂后通过', async () => {
    // call0 phase-a: advance next（但 requires_confirm → 应停在 waiting_confirm）
    // call1 phase-b 第一次: advance next 但不创建 output.txt → gate fail 回喂
    // call2 phase-b 第二次: 创建 output.txt + advance next → 过 gate
    // call3 phase-c: is_terminal → completed
    const provider = createScriptedProvider([
      { advanceMode: 'next' },
      { advanceMode: 'next' },
      { advanceMode: 'next', createFiles: ['output.txt'] },
      { advanceMode: 'next' },
    ])
    const engine = makeEngine(provider)
    const taskRepo = new RepoTaskRepository(db)
    const msgRepo = new MessageRepository(db)

    await engine.startWorkflow(taskId)

    // 路径2：requires_confirm phase 停在 waiting_confirm
    let task = taskRepo.findById(taskId)!
    expect(task.current_phase).toBe('phase-a')
    expect(task.phase_status).toBe('waiting_confirm')

    // bundle 仅首次注入：第一次 run 的 context 带 workflowSkillBundle
    expect(provider.capturedContexts[0].workflowSkillBundle?.length).toBeGreaterThan(0)
    expect(provider.capturedContexts[0].workflowOverview).toBeTruthy()

    // 路径1+3：确认后推进到 phase-b，触发 gate fail 回喂重跑，最终走到 terminal
    await engine.confirmPhase(taskId, { advance: true })

    task = taskRepo.findById(taskId)!
    expect(task.current_phase).toBe('phase-c')
    expect(task.phase_status).toBe('completed')
    expect(task.workflow_completed).toBeTruthy()

    // 路径3：phase-b 第一次 gate fail 应产生一条回喂 system 消息
    const bMessages = msgRepo.findByTaskAndPhase(taskId, 'phase-b')
    const failMsg = bMessages.find(m => m.role === 'system' && m.content.includes('校验失败'))
    expect(failMsg).toBeTruthy()

    // phase-b 因 gate fail 被调用两次（fail + pass），加上 phase-a、phase-c 共 4 次
    expect(provider.callCount()).toBe(4)

    // resume 推进时不再重复注入 bundle（context.workflowSkillBundle 为空）
    const resumeContexts = provider.capturedContexts.slice(1)
    for (const ctx of resumeContexts)
      expect(ctx.workflowSkillBundle).toBeUndefined()
  })

  it('路径4: target 跳转激活 optional phase', async () => {
    // call0 phase-a: advance next → waiting_confirm
    // call1 phase-b: 创建 output.txt 过 gate + advance target=phase-opt → 激活并跳转
    // call2 phase-opt: advance next → 下一个 next = phase-c
    // call3 phase-c: terminal
    const provider = createScriptedProvider([
      { advanceMode: 'next' },
      { advanceMode: 'target', target: 'phase-opt', createFiles: ['output.txt'] },
      { advanceMode: 'next' },
      { advanceMode: 'next' },
    ])
    const engine = makeEngine(provider)
    const taskRepo = new RepoTaskRepository(db)
    const activatedRepo = new ActivatedPhaseRepository(db)

    await engine.startWorkflow(taskId)
    expect(taskRepo.findById(taskId)!.phase_status).toBe('waiting_confirm')

    await engine.confirmPhase(taskId, { advance: true })

    // optional phase 被 target 激活
    expect(activatedRepo.isActivated(taskId, 'phase-opt')).toBe(true)
    // phase-opt 确实被执行过
    const ranPhaseOpt = provider.capturedContexts.some(c => c.phaseId === 'phase-opt')
    expect(ranPhaseOpt).toBe(true)

    const task = taskRepo.findById(taskId)!
    expect(task.phase_status).toBe('completed')
  })

  it('pending_input: agent 主动挂起等待用户输入', async () => {
    const provider = createScriptedProvider([
      { advanceMode: 'pending_input' },
    ])
    const engine = makeEngine(provider)
    const taskRepo = new RepoTaskRepository(db)

    await engine.startWorkflow(taskId)

    const task = taskRepo.findById(taskId)!
    expect(task.current_phase).toBe('phase-a')
    expect(task.phase_status).toBe('waiting_input')
  })

  it('terminal: agent 主动终结整任务', async () => {
    // phase-a 直接发 terminal（绕过 requires_confirm 与后续阶段）
    const provider = createScriptedProvider([
      { advanceMode: 'terminal' },
    ])
    const engine = makeEngine(provider)
    const taskRepo = new RepoTaskRepository(db)

    await engine.startWorkflow(taskId)

    const task = taskRepo.findById(taskId)!
    expect(task.phase_status).toBe('completed')
    expect(task.workflow_completed).toBeTruthy()
  })

  it('gate fail 后 agent 放弃推进则停在 waiting_input，不会误标 completed', async () => {
    // call0 phase-a: advance next → waiting_confirm
    // call1 phase-b: advance next 但无 output.txt → gate fail → 回喂 re-spawn
    // call2 phase-b: 本轮不再调 advance（agent 暂时放弃）→ 无 advanceRequest，
    //   completion_check 仍 fail → 停 waiting_input（旧路径，不再 re-spawn）
    const provider = createScriptedProvider([
      { advanceMode: 'next' },
      { advanceMode: 'next' },
      {}, // 不发 advance-request
    ])
    const engine = makeEngine(provider)
    const taskRepo = new RepoTaskRepository(db)

    await engine.startWorkflow(taskId)
    await engine.confirmPhase(taskId, { advance: true })

    const task = taskRepo.findById(taskId)!
    expect(task.current_phase).toBe('phase-b')
    expect(task.phase_status).toBe('waiting_input')
    expect(task.phase_status).not.toBe('completed')
  })
})
