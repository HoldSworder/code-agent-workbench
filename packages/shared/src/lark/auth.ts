import { errorMessage } from '../util/error'
import { runLarkCli, type RunLarkCliOptions } from './cli'

interface AuthStatusJson {
  appId?: string
  userOpenId?: string
  userName?: string
  tokenStatus?: string
  expiresAt?: string | null
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

/**
 * 调用 `lark-cli auth status` 检查飞书登录身份。
 * 失败/未登录/token 异常 时不抛错，统一以 `error` 字段说明原因。
 */
export async function getLarkAuthStatus(cli: RunLarkCliOptions = {}): Promise<LarkIdentityResult> {
  let stdout: string
  try {
    const result = await runLarkCli(['auth', 'status'], { timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024, ...cli })
    stdout = result.stdout.trim()
  }
  catch (err) {
    const msg = errorMessage(err)
    if (/未安装或不在 PATH 中|ENOENT|not found|no such file/i.test(msg))
      return { installed: false, loggedIn: false, identity: null, error: 'lark-cli 未安装或不在 PATH 中' }
    return { installed: true, loggedIn: false, identity: null, error: msg }
  }
  if (!stdout)
    return { installed: true, loggedIn: false, identity: null, error: 'lark-cli 未输出任何内容' }

  let parsed: AuthStatusJson
  try { parsed = JSON.parse(stdout) as AuthStatusJson }
  catch {
    return { installed: true, loggedIn: false, identity: null, error: `auth status 输出非合法 JSON: ${stdout.slice(0, 200)}` }
  }

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
