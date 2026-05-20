import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { errorMessage } from '../util/error'

const execAsync = promisify(execFile)

export interface RunMeegleCliOptions {
  /** 命令超时（ms），默认 30s。 */
  timeoutMs?: number
  /** stdout 缓冲上限，默认 16MB。 */
  maxBuffer?: number
  /** 自定义可执行文件名（默认 `meegle`）。 */
  binary?: string
  /** 额外环境变量。 */
  extraEnv?: Record<string, string>
}

export interface MeegleCliRunResult {
  stdout: string
  stderr: string
}

const DEFAULT_OPTIONS: Required<Pick<RunMeegleCliOptions, 'timeoutMs' | 'maxBuffer' | 'binary'>> = {
  timeoutMs: 30_000,
  maxBuffer: 16 * 1024 * 1024,
  binary: 'meegle',
}

/**
 * 通用 meegle-cli 调用器。失败时抛出可读异常（带 stderr 提示）。
 *
 * 与 `runLarkCli` 同构，便于上层用同样心智模型调子进程；仅 binary 默认值不同。
 */
export async function runMeegleCli(args: string[], opts: RunMeegleCliOptions = {}): Promise<MeegleCliRunResult> {
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
      throw new Error(`meegle-cli 未安装或不在 PATH 中: ${o.binary}`)
    }
    const detail = e.stderr ?? e.stdout ?? errorMessage(err)
    throw new Error(`meegle-cli 执行失败: ${detail}`)
  }
}

/** 调 meegle-cli 并把 stdout 解析为 JSON；解析失败抛出。 */
export async function runMeegleCliJson<T = unknown>(args: string[], opts?: RunMeegleCliOptions): Promise<T> {
  const { stdout } = await runMeegleCli(args, opts)
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('meegle-cli 未输出任何内容')
  try {
    return JSON.parse(trimmed) as T
  }
  catch {
    throw new Error(`meegle-cli 输出非合法 JSON: ${trimmed.slice(0, 200)}`)
  }
}

/**
 * 探测 meegle-cli 是否在 PATH 中可用（不依赖登录态）。
 * meegle 没有 `--version`，用 `inspect` 子命令做轻量探测（输出命令清单，必然 exit 0）。
 */
export async function isMeegleInstalled(opts?: RunMeegleCliOptions): Promise<boolean> {
  try {
    await runMeegleCli(['inspect'], { ...opts, timeoutMs: 5_000 })
    return true
  }
  catch (err) {
    return !errorMessage(err).includes('未安装或不在 PATH 中')
  }
}
