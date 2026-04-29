export interface SniProxyPatch {
  /** 注入到子进程 NODE_OPTIONS=--require 的脚本绝对路径。 */
  scriptPath: string
  socks5Host: string
  socks5Port: number
}

export interface BuildAgentEnvOptions {
  /** HTTP/HTTPS 代理 URL（不带 SNI patch 时使用环境变量代理）。 */
  proxyUrl?: string | null
  /** SOCKS5 SNI patch 配置；若提供则优先使用它而非 proxyUrl。 */
  sniProxyPatch?: SniProxyPatch | null
  /** 注入到 env 的额外键值，会覆盖父进程同名变量。 */
  extraEnv?: Record<string, string>
}

const PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
] as const

const SNI_PATCH_TOKEN = 'agent-socks5-patch'

/**
 * 复制父进程 env，过滤会污染子进程的变量（NODE_OPTIONS / npm_ / ELECTRON_）。
 * 当父进程 NODE_OPTIONS 已包含 SNI patch token 时，保留它以维持 patch 链。
 */
function copyBaseEnv(): { env: Record<string, string>, hasSniPatchInParent: boolean } {
  const parentNodeOptions = process.env.NODE_OPTIONS ?? ''
  const hasSniPatchInParent = parentNodeOptions.includes(SNI_PATCH_TOKEN)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (k === 'NODE_OPTIONS' && !hasSniPatchInParent) continue
    if (k.startsWith('npm_')) continue
    if (k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  return { env, hasSniPatchInParent }
}

function clearProxyEnv(env: Record<string, string>): void {
  for (const k of PROXY_KEYS) delete env[k]
}

function applyProxyEnv(env: Record<string, string>, proxyUrl: string): void {
  for (const k of PROXY_KEYS) env[k] = proxyUrl
}

/**
 * 解析 `socks5://host:port` / `host:port` 形式，提取 host/port。
 * 解析失败回退默认 `127.0.0.1:7890`。
 */
export function parseSocks5(proxyUrl: string): { host: string, port: string } {
  let host = '127.0.0.1'
  let port = '7890'
  try {
    const url = new URL(proxyUrl)
    host = url.hostname || host
    port = url.port || port
  }
  catch {
    const match = proxyUrl.match(/:(\d+)\s*$/)
    if (match) port = match[1]
  }
  return { host, port }
}

/**
 * 由 patch 脚本 + 代理 URL 组合出 SniProxyPatch 配置。
 */
export function buildSniProxyPatch(opts: { scriptPath: string, proxyUrl: string }): SniProxyPatch {
  const { host, port } = parseSocks5(opts.proxyUrl)
  return {
    scriptPath: opts.scriptPath,
    socks5Host: host,
    socks5Port: Number(port),
  }
}

/**
 * 为 agent CLI 子进程构造干净 env:
 *
 * 1. 从 process.env 拷贝并剥离 NODE_OPTIONS / npm_ / ELECTRON_
 * 2. 优先级 sniProxyPatch > 父进程已有 SNI patch > proxyUrl > 不设代理
 * 3. 当走 SNI patch 时强制清空 HTTP_PROXY 等变量，避免双重代理冲突
 * 4. extraEnv 在最后覆盖
 */
export function buildAgentEnv(opts: BuildAgentEnvOptions = {}): Record<string, string> {
  const { env, hasSniPatchInParent } = copyBaseEnv()

  if (opts.sniProxyPatch) {
    const p = opts.sniProxyPatch
    env.NODE_OPTIONS = `--require "${p.scriptPath}"`
    env.AGENT_SOCKS5_HOST = p.socks5Host
    env.AGENT_SOCKS5_PORT = String(p.socks5Port)
    clearProxyEnv(env)
  }
  else if (hasSniPatchInParent) {
    clearProxyEnv(env)
  }
  else if (opts.proxyUrl) {
    applyProxyEnv(env, opts.proxyUrl)
  }

  if (opts.extraEnv) {
    for (const [k, v] of Object.entries(opts.extraEnv)) env[k] = v
  }

  return env
}
