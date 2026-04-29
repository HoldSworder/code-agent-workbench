import { spawn, type ChildProcess } from 'node:child_process'
import {
  extractActivityEntry,
  extractSessionId,
  extractStreamText,
  extractTokenUsage,
  normalizeLine,
  parseJsonOutput,
  parseStreamResult,
} from './stream-parse'

export type CliRunStatus = 'success' | 'failed' | 'cancelled'

export interface CliRunOptions {
  /** 二进制路径，由调用方通过 `resolveBinary` 解析。 */
  binary: string
  args: string[]
  cwd: string
  /** 写入 stdin 的内容；null 表示不写。 */
  stdinData?: string | null
  /** 子进程环境变量；通常由 `buildAgentEnv` 构造。 */
  env: Record<string, string>
  /**
   * stdout 是否是 stream-json：true 走 line-by-line 解析；false 整段 JSON 解析。
   */
  useStreamJson: boolean
  /** 绝对 wall-clock 上限（ms），默认 15 分钟。 */
  timeoutMs?: number
  /** 无 stdout 输出多久判定卡死（ms），默认 3 分钟。 */
  activityTimeoutMs?: number
  /** AbortSignal；触发后强制 SIGTERM → SIGKILL。 */
  signal?: AbortSignal
  /** 增量文本回调（已拼好的可显示文本）。 */
  onText?: (text: string, isComplete: boolean) => void
  /** 活动条目回调（人类可读的 activity 日志，自带换行）。 */
  onActivity?: (entry: string) => void
  /** session_id 回调（如 cursor-cli 的 `session_id`）。 */
  onSessionId?: (id: string) => void
  /** 调试日志回调；通常注入文件 logger。 */
  logger?: (msg: string) => void
}

export interface CliRunResult {
  status: CliRunStatus
  /** 最终拼接的可显示文本。 */
  output: string
  tokenUsage?: number
  /** 失败/取消时的错误说明。 */
  error?: string
  /** 退出码（success/失败均可携带）。 */
  exitCode?: number
}

const DEFAULT_ACTIVITY_TIMEOUT_MS = 3 * 60 * 1000
const DEFAULT_MAX_TIMEOUT_MS = 15 * 60 * 1000
const GRACE_KILL_MS = 5_000

/**
 * 通用 Agent CLI 子进程执行器。
 *
 * 责任边界：spawn / 双 timer / kill / stdin 写入 / stdout 流解析 / 信号回调。
 * 不感知具体 backend 协议（cursor-cli/claude-code/codex 由调用方通过 `useStreamJson` 决定）。
 */
export class CliRunner {
  static run(opts: CliRunOptions): Promise<CliRunResult> {
    const {
      binary, args, cwd, env, useStreamJson,
      stdinData = null,
      timeoutMs = DEFAULT_MAX_TIMEOUT_MS,
      activityTimeoutMs = DEFAULT_ACTIVITY_TIMEOUT_MS,
      signal, onText, onActivity, onSessionId, logger,
    } = opts

    const log = (msg: string) => { try { logger?.(msg) } catch { /* swallow */ } }

    return new Promise<CliRunResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let lineBuf = ''
      let assistantText = ''
      let resolved = false
      let stdoutChunks = 0
      let lastActivityEntry = ''
      let child: ChildProcess | null = null

      const finish = (result: CliRunResult) => {
        if (resolved) return
        resolved = true
        clearTimeout(maxTimer)
        clearTimeout(activityTimer)
        signal?.removeEventListener('abort', onAbort)
        log(`[CliRunner] finish status=${result.status} chunks=${stdoutChunks} outputLen=${result.output.length} error=${result.error ?? 'none'}`)
        resolve(result)
      }

      const killAgent = (reason: string, status: CliRunStatus) => {
        log(`[CliRunner] kill: ${reason} stderrLen=${stderr.length}`)
        if (stderr) log(`[CliRunner] stderr tail: ${stderr.slice(-500)}`)
        if (child && !child.killed) {
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child && !child.killed) child.kill('SIGKILL')
          }, GRACE_KILL_MS)
        }
        finish({ status, output: assistantText || stdout.slice(0, 2000), error: reason })
      }

      const maxTimer = setTimeout(
        () => killAgent(`Agent exceeded maximum time limit (${timeoutMs / 1000}s)`, 'failed'),
        timeoutMs,
      )
      let activityTimer = setTimeout(
        () => killAgent(`No agent activity for ${activityTimeoutMs / 1000}s`, 'failed'),
        activityTimeoutMs,
      )
      const resetActivityTimer = () => {
        clearTimeout(activityTimer)
        activityTimer = setTimeout(
          () => killAgent(`No agent activity for ${activityTimeoutMs / 1000}s`, 'failed'),
          activityTimeoutMs,
        )
      }

      const onAbort = () => killAgent('Cancelled', 'cancelled')
      signal?.addEventListener('abort', onAbort, { once: true })

      log(`[CliRunner] spawn binary=${binary} cwd=${cwd} argsHead=${JSON.stringify(args.slice(0, 10))} stdinLen=${stdinData?.length ?? 0}`)

      child = spawn(binary, args, {
        cwd,
        env,
        shell: false,
        stdio: [stdinData != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })

      log(`[CliRunner] spawned pid=${child.pid}`)

      child.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT')
          finish({ status: 'failed', output: '', error: `CLI "${binary}" not found. Please install it or update the path in settings.` })
        else
          finish({ status: 'failed', output: '', error: err?.message ?? 'Unknown spawn error' })
      })

      if (stdinData != null && child.stdin) {
        child.stdin.on('error', () => { /* swallow broken pipe */ })
        const ok = child.stdin.write(stdinData)
        if (!ok) child.stdin.once('drain', () => child?.stdin?.end())
        else child.stdin.end()
      }

      const handleStreamLine = (line: string): void => {
        const normalized = normalizeLine(line)
        if (!normalized) return

        if (onSessionId) {
          const sid = extractSessionId(normalized)
          if (sid) onSessionId(sid)
        }

        const { text, isComplete } = extractStreamText(normalized)
        if (text) {
          if (isComplete && assistantText.endsWith(text)) { /* skip */ }
          else {
            assistantText += text
            onText?.(text, isComplete)
          }
        }

        if (onActivity) {
          const entry = extractActivityEntry(normalized)
          if (entry && entry !== lastActivityEntry) {
            lastActivityEntry = entry
            onActivity(`${entry}\n`)
          }
        }
      }

      let debugFirstChunks = 0
      child.stdout?.on('data', (data) => {
        const chunk = String(data)
        stdout += chunk
        stdoutChunks++
        resetActivityTimer()

        if (debugFirstChunks < 3) {
          debugFirstChunks++
          log(`[CliRunner] stdout #${debugFirstChunks}: ${chunk.slice(0, 300)}`)
        }

        if (useStreamJson) {
          lineBuf += chunk
          const lines = lineBuf.split('\n')
          lineBuf = lines.pop()!
          for (const line of lines) handleStreamLine(line)
        }
        else {
          assistantText += chunk
          onText?.(chunk, false)
          onActivity?.(chunk)
        }
      })

      child.stderr?.on('data', (data) => { stderr += String(data) })

      child.on('close', (code, sig) => {
        log(`[CliRunner] close code=${code} signal=${sig} stdoutLen=${stdout.length} stderrLen=${stderr.length}`)

        if (lineBuf.trim()) {
          handleStreamLine(lineBuf)
          lineBuf = ''
        }

        if (sig) {
          finish({
            status: 'failed',
            output: assistantText || stdout.slice(0, 2000),
            error: stderr || `Killed by signal: ${sig}`,
            exitCode: code ?? undefined,
          })
          return
        }

        if (code !== 0 && code !== null) {
          finish({
            status: 'failed',
            output: assistantText || stdout.slice(0, 2000),
            error: stderr || `Exit code: ${code}`,
            exitCode: code,
          })
          return
        }

        if (useStreamJson) {
          const finalOutput = assistantText || parseStreamResult(stdout)
          finish({
            status: 'success',
            output: finalOutput,
            tokenUsage: extractTokenUsage(stdout),
            exitCode: code ?? 0,
          })
        }
        else {
          const parsed = parseJsonOutput(stdout)
          finish({
            status: 'success',
            output: parsed.text,
            tokenUsage: parsed.tokenUsage,
            exitCode: code ?? 0,
          })
        }
      })
    })
  }
}
