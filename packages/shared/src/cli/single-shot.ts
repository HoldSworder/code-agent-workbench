import { tmpdir } from 'node:os'
import { buildCliArgs } from './args'
import { buildAgentEnv } from './env'
import { resolveBinary, type CliBackend } from './binaries'
import { CliRunner } from './runner'
import type { SniProxyPatch } from './env'

export interface RunCliSingleShotOptions {
  backend: CliBackend
  /** 显式 binary 路径覆盖（来自设置 agent.binaryPath）；不传走默认名 + PATH 解析。 */
  binaryPath?: string
  /** system 段提示词。 */
  systemPrompt: string
  /** user 段提示词。 */
  userPrompt: string
  /** 模型名；'auto' 视为不指定。 */
  model?: string
  /** 子进程 cwd；不传走 `os.tmpdir()`，避免污染调用方仓库。 */
  cwd?: string
  /** 透传到 `buildAgentEnv`：HTTP/HTTPS 代理。 */
  proxyUrl?: string
  /** 透传到 `buildAgentEnv`：SOCKS5 SNI patch。 */
  sniProxyPatch?: SniProxyPatch
  /** 绝对超时（ms），默认沿用 CliRunner 默认值。 */
  timeoutMs?: number
  /** 无活动超时（ms），默认沿用 CliRunner 默认值。 */
  activityTimeoutMs?: number
  /** 取消信号。 */
  signal?: AbortSignal
}

export interface RunCliSingleShotResult {
  text: string
  tokenUsage?: number
  sessionId?: string
  exitCode?: number
}

/**
 * 把 cursor-cli / claude-code / codex 当作"单轮 system + user → text"的 LLM 调用器。
 *
 * 用于 review、quick-look、translate 等无需多轮 PhaseContext 的场景，避开 ApiProvider
 * 强依赖 ANTHROPIC_API_KEY 的限制。
 *
 * 实现细节：
 * - prompt 拼为 `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userPrompt}`，三个 backend
 *   均无原生 system 段位，按 markdown 头分隔与 `cli.provider.ts buildPrompt` 一致；
 * - cwd 缺省 `os.tmpdir()`，避免误把 review 用户当前仓库当作 CLI 工作目录；
 * - 失败时抛错，错误信息保留 stderr 尾部，便于桌面端展示。
 */
export async function runCliSingleShot(opts: RunCliSingleShotOptions): Promise<RunCliSingleShotResult> {
  const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : tmpdir()
  const binary = resolveBinary(opts.backend, opts.binaryPath)
  const prompt = `[SYSTEM]\n${opts.systemPrompt}\n\n[USER]\n${opts.userPrompt}`

  const { args, stdinData, useStreamJson } = buildCliArgs({
    backend: opts.backend,
    cwd,
    mode: 'write',
    planMode: false,
    model: opts.model,
    prompt,
  })

  const env = buildAgentEnv({
    proxyUrl: opts.proxyUrl,
    sniProxyPatch: opts.sniProxyPatch,
  })

  let sessionId: string | undefined
  const result = await CliRunner.run({
    binary,
    args,
    cwd,
    stdinData,
    env,
    useStreamJson,
    timeoutMs: opts.timeoutMs,
    activityTimeoutMs: opts.activityTimeoutMs,
    signal: opts.signal,
    onSessionId: id => { sessionId = id },
  })

  if (result.status !== 'success') {
    const reason = result.error ?? '未知错误'
    const isMissing = /not found|ENOENT/i.test(reason)
    if (isMissing) {
      throw new Error(`CLI "${binary}" 未在 PATH 中找到，请到「设置」检查 agent.binaryPath，或安装对应 CLI 后重试。原始错误：${reason}`)
    }
    throw new Error(`CLI ${opts.backend} 单轮调用失败：${reason}`)
  }

  return {
    text: result.output,
    tokenUsage: result.tokenUsage,
    sessionId,
    exitCode: result.exitCode,
  }
}
