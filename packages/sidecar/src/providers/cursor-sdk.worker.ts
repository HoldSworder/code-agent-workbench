import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, CursorAgentError, type Run, type SDKAgent } from '@cursor/sdk'
import type { ParentToWorker, WorkerStartConfig, WorkerToParent } from './cursor-sdk-ipc'
import { applySocksProxyPatch } from './socks-proxy-patch'
import type { PhaseResult } from './types'

/**
 * cursor-sdk 的 fork 子进程入口。
 *
 * 子进程以 worktree 为 `process.cwd()`（由父进程 fork 时设定），从而让
 * @cursor/sdk 本地执行器的 shell 工具默认在正确的工作目录执行——SDK 的
 * `local.cwd` 在 v1.0.x 不会作用于 shell 工作目录（实测固定取 process.cwd()），
 * 子进程隔离是当前唯一可靠且并发安全的方案。
 */

const LOG_FILE = join(tmpdir(), 'code-agent-provider.log')
function log(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [worker] ${msg}\n`) }
  catch {}
}

function send(msg: WorkerToParent) {
  process.send?.(msg)
}

/**
 * 捕获 @cursor/sdk 流式 end-stream 的真实错误。
 *
 * 已知 SDK 行为（见 Cursor 论坛 161203）：run 在后端失败时，`run.wait()` 只返回
 * bare `{ status: 'error' }`（无 message），真正的 `ConnectError`（如 unauthenticated /
 * resource_exhausted / context 超限）以 `unhandledRejection` 形式泄漏。这里兜住它，
 * 作为 status=error 时的根因细节，避免只剩「状态 ERROR」这种无信息文案。
 */
let lastUnhandled: string | null = null
process.on('unhandledRejection', (reason) => {
  lastUnhandled = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  log(`unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
})
process.on('uncaughtException', (err) => {
  lastUnhandled = `${err.name}: ${err.message}`
  log(`uncaughtException: ${err.stack ?? err.message}`)
})

let currentRun: Run | null = null
let currentAgent: SDKAgent | null = null
// 收到父进程 cancel 时置位，用于中止重试循环（避免取消后仍自动重试）。
let cancelled = false

// 零输出瞬时 ERROR 的重试上限。失败时 agent 未产出任何文本/工具调用，
// 故无副作用，重试 100% 安全；边际网络下重试 2-3 次几乎必然命中一次成功。
const MAX_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 单次 run 尝试：创建/恢复 agent → send → stream → wait。
 * 返回结构化结果，并标记本次是否「有进展」（出现过工具调用或文本输出）。
 * 有进展即说明可能产生了副作用，调用方不得自动重试。
 */
async function attemptRun(cfg: WorkerStartConfig, attempt: number): Promise<{
  result: PhaseResult
  madeProgress: boolean
  retryableNoOutput: boolean
}> {
  const mcpServers = cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0
    ? cfg.mcpServers
    : undefined

  // 每次尝试前清空，确保拿到的是「本次」泄漏的根因。
  lastUnhandled = null

  let agent: SDKAgent
  try {
    if (cfg.resumeAgentId) {
      log(`resume agentId=${cfg.resumeAgentId} mode=${cfg.mode} cwd=${process.cwd()} attempt=${attempt}/${MAX_ATTEMPTS}`)
      agent = await Agent.resume(cfg.resumeAgentId, {
        apiKey: cfg.apiKey,
        model: cfg.model ? { id: cfg.model } : undefined,
        local: { cwd: cfg.cwd, settingSources: [] },
        mcpServers,
        mode: cfg.mode,
      })
    }
    else {
      log(`create model=${cfg.model ?? '-'} mode=${cfg.mode} cwd=${process.cwd()} mcp=${mcpServers ? Object.keys(mcpServers).join(',') : '-'} promptChars=${cfg.prompt.length} attempt=${attempt}/${MAX_ATTEMPTS}`)
      agent = await Agent.create({
        apiKey: cfg.apiKey,
        model: cfg.model ? { id: cfg.model } : undefined,
        local: { cwd: cfg.cwd, settingSources: [] },
        mcpServers,
        mode: cfg.mode,
      })
    }
  }
  catch (err) {
    if (err instanceof CursorAgentError) {
      log(`startup failed: ${err.message} retryable=${err.isRetryable}`)
      // 启动期失败同样无副作用，标记为可重试的零输出失败。
      return {
        result: { status: 'failed', error: `Cursor agent 启动失败：${err.message}` },
        madeProgress: false,
        retryableNoOutput: true,
      }
    }
    throw err
  }

  currentAgent = agent
  send({ type: 'agentId', agentId: agent.agentId })

  let assistantText = ''
  let madeProgress = false
  // 捕获流中最后一条 ERROR/异常状态消息，作为 run 失败时的根因线索。
  let lastErrorDetail = ''
  // 诊断：记录最后几个事件类型，便于在 status=error 时回看崩溃前发生了什么。
  const recentEvents: string[] = []
  const pushRecent = (s: string) => {
    recentEvents.push(s)
    if (recentEvents.length > 12) recentEvents.shift()
  }
  try {
    const run = await agent.send(cfg.prompt)
    currentRun = run
    log(`run id=${run.id} agentId=${agent.agentId}`)

    for await (const event of run.stream()) {
      switch (event.type) {
        case 'assistant':
          for (const block of event.message.content) {
            if (block.type === 'text') {
              assistantText += block.text
              if (block.text.trim()) madeProgress = true
              send({ type: 'chunk', text: block.text })
            }
            else if (block.type === 'tool_use') {
              madeProgress = true
              pushRecent(`tool_use:${block.name}`)
              send({ type: 'activity', text: `[tool] ${block.name}\n` })
            }
          }
          break
        case 'thinking':
          send({ type: 'activity', text: `[thinking] ${event.text}\n` })
          break
        case 'tool_call':
          madeProgress = true
          pushRecent(`tool_call:${event.name}:${event.status}`)
          if (event.status === 'error') {
            lastErrorDetail = `工具 ${event.name} 执行出错`
            // 记录工具错误的完整事件，定位是哪个工具 / 什么报错。
            log(`tool_call ERROR ${JSON.stringify(event).slice(0, 1200)}`)
          }
          send({ type: 'activity', text: `[tool] ${event.name} (${event.status})\n` })
          break
        case 'status':
          pushRecent(`status:${event.status}`)
          if (event.status === 'ERROR' || event.status === 'EXPIRED') {
            lastErrorDetail = event.message?.trim() || lastErrorDetail || `状态 ${event.status}`
            // 完整 dump status 事件，看后端是否带了被我们忽略的字段。
            log(`status ERROR raw=${JSON.stringify(event)}`)
          }
          send({ type: 'activity', text: `[status] ${event.status}${event.message ? ` ${event.message}` : ''}\n` })
          break
        default:
          pushRecent(`evt:${event.type}`)
          break
      }
    }

    const result = await run.wait()
    // status=error 时，真实 ConnectError 常在 wait() 之后的微任务里以 unhandledRejection 抛出，
    // 给它一个 tick 落到 lastUnhandled。
    if (result.status !== 'finished')
      await new Promise(r => setTimeout(r, 60))
    log(`run done status=${result.status} durationMs=${result.durationMs ?? '-'} result=${result.result?.slice(0, 300) ?? '-'} errDetail=${lastErrorDetail || '-'} unhandled=${lastUnhandled ?? '-'} recent=[${recentEvents.join(' > ')}] progress=${madeProgress}`)

    const output = assistantText.trim() || result.result?.trim() || ''
    if (result.status === 'finished')
      return { result: { status: 'success', output }, madeProgress, retryableNoOutput: false }
    if (result.status === 'cancelled')
      return { result: { status: 'cancelled', output, error: 'run cancelled' }, madeProgress, retryableNoOutput: false }
    const detail = lastErrorDetail || result.result?.trim() || lastUnhandled || '无更多信息（请查看 code-agent-provider.log）'
    return {
      result: { status: 'failed', output, error: `Cursor run 执行失败（status=${result.status}）：${detail}` },
      madeProgress,
      // 仅「零输出」错误可安全重试：未产生任何副作用。
      retryableNoOutput: !madeProgress,
    }
  }
  catch (err) {
    if (err instanceof CursorAgentError) {
      log(`run error: ${err.message}`)
      return {
        result: { status: 'failed', output: assistantText.trim(), error: `Cursor run 异常：${err.message}` },
        madeProgress,
        retryableNoOutput: !madeProgress,
      }
    }
    throw err
  }
  finally {
    currentRun = null
    try { agent.close() }
    catch {}
    currentAgent = null
  }
}

/**
 * 带有界重试的 run 执行器。
 *
 * 边际网络下，run 常在 ~12s 内未建起模型输出流就被后端判 ERROR，且 agent
 * 零输出（无 thinking/文本/工具）→ 无副作用。这类「零输出瞬时 ERROR」自动
 * 重试 100% 安全且高效。一旦出现过工具调用/文本输出，则可能已有副作用，
 * 不再自动重试，直接返回失败，交由上层人工处理。
 */
async function runAgent(cfg: WorkerStartConfig): Promise<PhaseResult> {
  let last: { result: PhaseResult, madeProgress: boolean, retryableNoOutput: boolean } | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (cancelled)
      return { status: 'cancelled', error: 'run cancelled' }

    last = await attemptRun(cfg, attempt)

    // 成功 / 取消 / 有进展 → 直接返回，不重试。
    if (last.result.status !== 'failed' || last.madeProgress || !last.retryableNoOutput)
      return last.result

    if (cancelled)
      return { status: 'cancelled', error: 'run cancelled' }

    if (attempt < MAX_ATTEMPTS) {
      const backoffMs = attempt * 1000
      log(`retrying after no-output ERROR: attempt ${attempt} failed, backoff ${backoffMs}ms then retry`)
      await sleep(backoffMs)
      continue
    }
  }

  // 重试用尽：给出明确的网络/连接文案，附最后一次根因细节。
  const detail = last?.result.error ?? '无更多信息（请查看 code-agent-provider.log）'
  log(`all ${MAX_ATTEMPTS} attempts exhausted (no-output ERROR)`)
  return {
    status: 'failed',
    output: last?.result.output,
    error: `Cursor run 多次执行失败（疑似网络/到 Cursor 后端的连接不稳，已重试 ${MAX_ATTEMPTS} 次）：${detail}`,
  }
}

process.on('message', async (msg: ParentToWorker) => {
  if (msg.type === 'start') {
    // 关键：@cursor/sdk 的 run 流式走原生 http2，不读 HTTP(S)_PROXY、也不走 undici
    // dispatcher。必须在 net 层透明改道，才能让 SDK 的全部出网连接经 app 内代理。
    if (msg.config.proxyUrl) {
      await applySocksProxyPatch(msg.config.proxyUrl)
      log(`socks patch applied via ${msg.config.proxyUrl}`)
    }
    else {
      log('proxy (direct)')
    }
    let result: PhaseResult
    try {
      result = await runAgent(msg.config)
    }
    catch (err) {
      log(`worker uncaught: ${String(err)}`)
      result = { status: 'failed', error: `SDK 子进程异常：${err instanceof Error ? err.message : String(err)}` }
    }
    send({ type: 'result', result })
    // 给 IPC 一点时间把 result 投递到父进程再退出。
    setTimeout(() => process.exit(0), 50)
  }
  else if (msg.type === 'cancel') {
    log('cancel requested')
    cancelled = true
    try {
      if (currentRun && currentRun.supports('cancel'))
        await currentRun.cancel()
    }
    catch (err) {
      log(`cancel failed: ${String(err)}`)
    }
    try { currentAgent?.close() }
    catch {}
    // run.cancel() 会让 stream/wait 以 cancelled 收尾，runAgent 正常 send result；
    // 若 5s 内仍未结束，兜底强制退出避免僵尸子进程。
    setTimeout(() => process.exit(0), 5000)
  }
})
