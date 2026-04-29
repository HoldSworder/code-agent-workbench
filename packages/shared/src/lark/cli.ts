import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { errorMessage } from '../util/error'

const execAsync = promisify(execFile)

export interface RunLarkCliOptions {
  /** 命令超时（ms），默认 30s。 */
  timeoutMs?: number
  /** stdout 缓冲上限，默认 16MB。 */
  maxBuffer?: number
  /** 自定义可执行文件名（默认 `lark-cli`）。 */
  binary?: string
  /** 额外环境变量。 */
  extraEnv?: Record<string, string>
}

export interface LarkCliRunResult {
  stdout: string
  stderr: string
}

const DEFAULT_OPTIONS: Required<Pick<RunLarkCliOptions, 'timeoutMs' | 'maxBuffer' | 'binary'>> = {
  timeoutMs: 30_000,
  maxBuffer: 16 * 1024 * 1024,
  binary: 'lark-cli',
}

/**
 * 通用 lark-cli 调用器。失败时抛出可读异常（带 stderr 提示）。
 */
export async function runLarkCli(args: string[], opts: RunLarkCliOptions = {}): Promise<LarkCliRunResult> {
  const o = { ...DEFAULT_OPTIONS, ...opts }
  try {
    const result = await execAsync(o.binary, args, {
      encoding: 'utf-8',
      timeout: o.timeoutMs,
      maxBuffer: o.maxBuffer,
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
    })
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  }
  catch (err) {
    const e = err as Error & { stdout?: string, stderr?: string, code?: string | number }
    if (e.code === 'ENOENT') {
      throw new Error(`lark-cli 未安装或不在 PATH 中: ${o.binary}`)
    }
    const detail = e.stderr ?? e.stdout ?? errorMessage(err)
    throw new Error(`lark-cli 执行失败: ${detail}`)
  }
}

/** 调 lark-cli 并把 stdout 解析为 JSON；解析失败抛出。 */
export async function runLarkCliJson<T = unknown>(args: string[], opts?: RunLarkCliOptions): Promise<T> {
  const { stdout } = await runLarkCli(args, opts)
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('lark-cli 未输出任何内容')
  try {
    return JSON.parse(trimmed) as T
  }
  catch {
    throw new Error(`lark-cli 输出非合法 JSON: ${trimmed.slice(0, 200)}`)
  }
}

/**
 * 探测 lark-cli 是否在 PATH 中可用（不依赖登录态）。
 */
export async function isLarkCliInstalled(opts?: RunLarkCliOptions): Promise<boolean> {
  try {
    await runLarkCli(['--version'], { ...opts, timeoutMs: 5_000 })
    return true
  }
  catch (err) {
    return !errorMessage(err).includes('未安装或不在 PATH 中')
  }
}
