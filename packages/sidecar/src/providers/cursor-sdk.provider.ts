import { type ChildProcess, fork } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type McpServerConfig as SdkMcpServerConfig } from '@cursor/sdk'
import type { McpServerConfig } from '../mcp/config-writer'
import type { WorkerToParent } from './cursor-sdk-ipc'
import { buildPromptFromContext } from './prompt-builder'
import type { AgentProvider, PhaseContext, PhaseResult, RunOptions } from './types'

const LOG_FILE = join(tmpdir(), 'code-agent-provider.log')
function log(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`) }
  catch {}
}

/** 默认模型 id；可被 settings / phase / role 覆盖。 */
export const DEFAULT_CURSOR_MODEL = 'composer-2.5'

export interface CursorSdkProviderConfig {
  /** Cursor API Key。 */
  apiKey: string
  /** 模型 id（不含 params）。 */
  model?: string
  /** 续接的 cursor agentId（来自上一次 run）。 */
  resumeAgentId?: string
  /** app 内代理地址；透传给 worker 设置 undici 全局 dispatcher。空 → 直连。 */
  proxyUrl?: string
}

/**
 * 把 sidecar 内部的 MCP server 配置转换成 @cursor/sdk 的 inline mcpServers 形态。
 * stdio 缺 command、http/sse 缺 url 的条目会被跳过。
 */
export function toSdkMcpServers(servers: McpServerConfig[]): Record<string, SdkMcpServerConfig> {
  const out: Record<string, SdkMcpServerConfig> = {}
  for (const s of servers) {
    if (s.transport === 'stdio') {
      if (!s.command) continue
      out[s.name] = { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {} }
    }
    else {
      if (!s.url) continue
      out[s.name] = { type: s.transport, url: s.url, headers: s.headers ?? {} }
    }
  }
  return out
}

/**
 * 解析 fork 用的 worker 脚本路径。
 * - dist（tsup 打包）：本模块被内联进 dist/index.js，import.meta.url 指向 dist，
 *   worker 同级产出于 dist/cursor-sdk.worker.js。
 * - tsx（直跑源码）：本文件位于 src/providers/，worker 为同目录 .ts，需经 tsx 加载。
 */
function resolveWorkerPath(): { path: string, execArgv?: string[] } {
  const here = dirname(fileURLToPath(import.meta.url))
  const jsPath = join(here, 'cursor-sdk.worker.js')
  if (existsSync(jsPath))
    return { path: jsPath }
  const tsPath = join(here, 'cursor-sdk.worker.ts')
  if (existsSync(tsPath))
    return { path: tsPath, execArgv: ['--import', 'tsx'] }
  return { path: jsPath }
}

/**
 * 基于 @cursor/sdk 的 AgentProvider 实现（单会话工作流主力）。
 *
 * 每次 `run` 都 fork 一个独立子进程（cursor-sdk.worker），并以 worktree 作为
 * 子进程 cwd。这样 SDK 本地执行器的 shell 工具会落在正确目录，且并发 worker
 * 之间彼此进程隔离、互不干扰（不能用 process.chdir，会污染并发任务）。
 *
 * - 子进程内：`Agent.create` / `Agent.resume` → `agent.send` → `run.stream`
 *   映射 onChunk/onActivity → `run.wait` 用 RunResult.status 判定回合结果。
 * - 父进程：仅做 IPC 转发、记录 agentId、处理取消与子进程异常退出。
 */
export class CursorSdkProvider implements AgentProvider {
  private config: CursorSdkProviderConfig
  private worker: ChildProcess | null = null
  private lastAgentId: string | null = null

  constructor(config: CursorSdkProviderConfig) {
    this.config = config
  }

  get sessionId(): string | null {
    return this.lastAgentId
  }

  get model(): string | null {
    return this.config.model ?? null
  }

  async run(context: PhaseContext, options?: RunOptions): Promise<PhaseResult> {
    const prompt = this.buildPrompt(context)
    const mode = context.planMode ? 'plan' as const : 'agent' as const
    const mcpServers = context.sdkMcpServers && Object.keys(context.sdkMcpServers).length > 0
      ? context.sdkMcpServers
      : undefined

    const worker = resolveWorkerPath()

    return new Promise<PhaseResult>((resolve) => {
      let settled = false
      const finish = (result: PhaseResult) => {
        if (settled) return
        settled = true
        this.worker = null
        resolve(result)
      }

      let child: ChildProcess
      try {
        child = fork(worker.path, [], {
          cwd: context.repoPath,
          // 代理不经 env 传递：worker 拿到 config.proxyUrl 后用 net 层 SOCKS5/SNI
          // 补丁透明改道全部出网连接（原生 http2 不读 env、也不走 undici dispatcher）。
          // 这里反而要清掉父进程可能带入的 HTTP(S)_PROXY，避免库各自再做一次代理。
          env: this.buildChildEnv(),
          execArgv: worker.execArgv,
          // stdout/stderr 直通父进程日志；IPC 通道用于结构化消息。
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        })
      }
      catch (err) {
        log(`cursor-sdk: fork failed: ${String(err)}`)
        finish({ status: 'failed', error: `无法启动 SDK 子进程：${err instanceof Error ? err.message : String(err)}` })
        return
      }

      this.worker = child

      child.on('message', (msg: WorkerToParent) => {
        switch (msg.type) {
          case 'agentId':
            this.lastAgentId = msg.agentId
            break
          case 'chunk':
            options?.onChunk?.(msg.text)
            break
          case 'activity':
            options?.onActivity?.(msg.text)
            break
          case 'result':
            finish(msg.result)
            break
          default:
            break
        }
      })

      child.on('error', (err) => {
        log(`cursor-sdk: worker error: ${String(err)}`)
        finish({ status: 'failed', error: `SDK 子进程错误：${err instanceof Error ? err.message : String(err)}` })
      })

      child.on('exit', (code, signal) => {
        // 正常路径下 result 已先到达并 settle；这里只兜底子进程异常退出。
        finish({ status: 'failed', error: `SDK 子进程意外退出（code=${code ?? '-'} signal=${signal ?? '-'}）` })
      })

      try {
        child.send({
          type: 'start',
          config: {
            apiKey: this.config.apiKey,
            model: this.config.model,
            mode,
            prompt,
            cwd: context.repoPath,
            resumeAgentId: this.config.resumeAgentId,
            mcpServers,
            proxyUrl: this.config.proxyUrl,
          },
        })
      }
      catch (err) {
        log(`cursor-sdk: send start failed: ${String(err)}`)
        try { child.kill('SIGKILL') }
        catch {}
        finish({ status: 'failed', error: `向 SDK 子进程发送任务失败：${err instanceof Error ? err.message : String(err)}` })
      }
    })
  }

  async cancel(): Promise<void> {
    const child = this.worker
    if (!child) return
    try { child.send({ type: 'cancel' }) }
    catch (err) { log(`cursor-sdk: cancel send failed: ${String(err)}`) }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') }
        catch {}
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * 构造子进程环境变量：始终清除继承自父进程的 HTTP(S)_PROXY/ALL_PROXY。
   *
   * 代理改由 worker 内的 net 层 SOCKS5/SNI 补丁统一承担（凭 config.proxyUrl）。
   * 若再保留代理 env，undici / connect-node 会各自叠加一层代理，与 net 改道冲突。
   */
  private buildChildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.HTTP_PROXY
    delete env.HTTPS_PROXY
    delete env.ALL_PROXY
    delete env.http_proxy
    delete env.https_proxy
    delete env.all_proxy
    return env
  }

  private buildPrompt(context: PhaseContext): string {
    // resume 续接时只发用户最新反馈，复用会话已有上下文。
    if (this.config.resumeAgentId && context.userMessage)
      return context.userMessage

    if (context.phaseId === 'leader-analyze' && context.skillContent)
      return context.skillContent

    return buildPromptFromContext(context, true)
  }
}
