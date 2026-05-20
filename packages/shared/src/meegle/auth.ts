import { errorMessage } from '../util/error'
import { runMeegleCli, type RunMeegleCliOptions } from './cli'

interface AuthStatusJson {
  authenticated?: boolean
  host?: string | null
  source?: string | null
  expires_in_minutes?: number | null
}

export interface MeegleAuthResult {
  installed: boolean
  authenticated: boolean
  host: string | null
  expiresInMinutes: number | null
  error: string | null
}

const STATUS_TIMEOUT_MS = 10_000
const STATUS_MAX_BUFFER = 4 * 1024 * 1024

/**
 * 调用 `meegle auth status --format json` 检查飞书项目登录身份。
 *
 * 不抛错：installed / authenticated / 错误原因统一以字段返回，前端据此渲染状态条。
 * 不主动触发 `meegle auth login`（会弹浏览器、无交互通道），由用户在终端自行执行。
 */
export async function getMeegleAuthStatus(cli: RunMeegleCliOptions = {}): Promise<MeegleAuthResult> {
  let stdout: string
  try {
    const result = await runMeegleCli(['auth', 'status', '--format', 'json'], {
      timeoutMs: STATUS_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BUFFER,
      ...cli,
    })
    stdout = result.stdout.trim()
  }
  catch (err) {
    const msg = errorMessage(err)
    if (/未安装或不在 PATH 中|ENOENT|not found|no such file/i.test(msg)) {
      return {
        installed: false,
        authenticated: false,
        host: null,
        expiresInMinutes: null,
        error: 'meegle-cli 未安装。请运行 `npm i -g meegle-cli` 后重试。',
      }
    }
    return {
      installed: true,
      authenticated: false,
      host: null,
      expiresInMinutes: null,
      error: msg,
    }
  }

  if (!stdout) {
    return {
      installed: true,
      authenticated: false,
      host: null,
      expiresInMinutes: null,
      error: 'meegle auth status 未输出任何内容',
    }
  }

  let parsed: AuthStatusJson
  try {
    parsed = JSON.parse(stdout) as AuthStatusJson
  }
  catch {
    return {
      installed: true,
      authenticated: false,
      host: null,
      expiresInMinutes: null,
      error: `auth status 输出非合法 JSON: ${stdout.slice(0, 200)}`,
    }
  }

  const authenticated = parsed.authenticated === true
  return {
    installed: true,
    authenticated,
    host: parsed.host ?? null,
    expiresInMinutes: typeof parsed.expires_in_minutes === 'number' ? parsed.expires_in_minutes : null,
    error: authenticated
      ? null
      : '尚未登录飞书项目。请在终端运行 `meegle auth login --host project.feishu.cn` 后点击「重新检测」。',
  }
}
