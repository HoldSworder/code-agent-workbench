import { errorMessage } from '../util/error'
import { runLarkCli, type RunLarkCliOptions } from './cli'

interface AuthStatusJson {
  appId?: string
  userOpenId?: string
  userName?: string
  tokenStatus?: string
  expiresAt?: string | null
  refreshExpiresAt?: string | null
}

export interface LarkIdentity {
  userId: string
  userName: string
  tokenStatus: string
  expiresAt: string | null
  appId: string | null
}

export interface LarkIdentityResult {
  installed: boolean
  loggedIn: boolean
  identity: LarkIdentity | null
  error: string | null
}

const STATUS_TIMEOUT_MS = 10_000
const STATUS_MAX_BUFFER = 4 * 1024 * 1024

/**
 * 调用 `lark-cli auth status` 检查飞书登录身份。
 * 失败 / 未登录 / token 异常 时不抛错，统一以 `error` 字段说明原因。
 *
 * 自动续期策略：
 * - access_token 在飞书 OAuth 下默认 2 小时短寿；refresh_token 7 天长寿。
 * - lark-cli 在任何真实 API 调用时会用 refresh_token 静默续期，但 `auth status` 是只读不触发。
 * - 当 status 报 `needs_refresh` 且 `refreshExpiresAt` 仍未过期时，
 *   主动跑一次无副作用 API（`contact +get-user` 取自身信息），让 lark-cli 续上 access_token，
 *   再回头读一次 status；如果仍非 valid 才作为登录失效报出。
 */
export async function getLarkAuthStatus(cli: RunLarkCliOptions = {}): Promise<LarkIdentityResult> {
  let probe = await readStatus(cli)
  if (probe.kind === 'fatal') return probe.result

  if (shouldAutoRefresh(probe.parsed)) {
    try {
      await runLarkCli(['contact', '+get-user'], {
        timeoutMs: STATUS_TIMEOUT_MS,
        maxBuffer: STATUS_MAX_BUFFER,
        ...cli,
      })
      probe = await readStatus(cli)
      if (probe.kind === 'fatal') return probe.result
    }
    catch {
      // get-user 自身失败不阻塞，让下面的统一分支按 needs_refresh 报出。
    }
  }

  return buildResult(probe.parsed)
}

type StatusProbe =
  | { kind: 'parsed', parsed: AuthStatusJson }
  | { kind: 'fatal', result: LarkIdentityResult }

async function readStatus(cli: RunLarkCliOptions): Promise<StatusProbe> {
  let stdout: string
  try {
    const result = await runLarkCli(['auth', 'status'], {
      timeoutMs: STATUS_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BUFFER,
      ...cli,
    })
    stdout = result.stdout.trim()
  }
  catch (err) {
    const msg = errorMessage(err)
    if (/未安装或不在 PATH 中|ENOENT|not found|no such file/i.test(msg))
      return { kind: 'fatal', result: { installed: false, loggedIn: false, identity: null, error: 'lark-cli 未安装或不在 PATH 中' } }
    return { kind: 'fatal', result: { installed: true, loggedIn: false, identity: null, error: msg } }
  }
  if (!stdout)
    return { kind: 'fatal', result: { installed: true, loggedIn: false, identity: null, error: 'lark-cli 未输出任何内容' } }

  try {
    return { kind: 'parsed', parsed: JSON.parse(stdout) as AuthStatusJson }
  }
  catch {
    return { kind: 'fatal', result: { installed: true, loggedIn: false, identity: null, error: `auth status 输出非合法 JSON: ${stdout.slice(0, 200)}` } }
  }
}

/** refresh_token 仍在有效期内、且当前 token 处于 needs_refresh 时才值得自动续期。 */
function shouldAutoRefresh(parsed: AuthStatusJson): boolean {
  if (parsed.tokenStatus !== 'needs_refresh') return false
  if (!parsed.userOpenId || !parsed.userName) return false
  if (!parsed.refreshExpiresAt) return true
  const ts = Date.parse(parsed.refreshExpiresAt)
  if (Number.isNaN(ts)) return true
  return ts > Date.now()
}

function buildResult(parsed: AuthStatusJson): LarkIdentityResult {
  if (!parsed.userOpenId || !parsed.userName)
    return { installed: true, loggedIn: false, identity: null, error: '尚未通过 lark-cli auth login 登录' }

  const tokenStatus = parsed.tokenStatus ?? 'unknown'
  if (tokenStatus !== 'valid')
    return { installed: true, loggedIn: false, identity: null, error: `飞书 token 状态异常: ${tokenStatus}` }

  return {
    installed: true,
    loggedIn: true,
    identity: {
      userId: parsed.userOpenId,
      userName: parsed.userName,
      tokenStatus,
      expiresAt: parsed.expiresAt ?? null,
      appId: parsed.appId ?? null,
    },
    error: null,
  }
}
