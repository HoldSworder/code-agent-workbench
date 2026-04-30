import type { CliBackend, SniProxyPatch } from '@code-agent/shared/cli'
import type { SettingsRepository } from '../db/repositories/settings.repo'
import { ApiProvider } from './api.provider'
import { ExternalCliProvider } from './cli.provider'

/**
 * 设置中可选的 LLM provider：
 * - `cursor-cli` / `claude-code` / `codex`：本地 CLI 子进程
 * - `custom-api`：通过 Anthropic SDK / 兼容 API 调用
 */
export type AgentProviderKind = CliBackend | 'custom-api'

const CLI_BACKENDS: ReadonlySet<string> = new Set<CliBackend>(['cursor-cli', 'claude-code', 'codex'])
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<AgentProviderKind>(['cursor-cli', 'claude-code', 'codex', 'custom-api'])

const DEFAULT_API_MODEL = 'claude-sonnet-4-20250514'

export interface AgentRuntimeSettings {
  /** 全局选定的 LLM provider；CLI 三种或 custom-api。默认 cursor-cli。 */
  provider: AgentProviderKind
  /** 全局默认 model，可被 phase / role 覆盖。 */
  model?: string
  /** 全局 binary 路径覆盖；只在调用全局 CLI provider 时生效，跨 backend 时不传。 */
  binaryPath?: string
  /** custom-api 模式所需的 API Key；优先用 settings，回落 ANTHROPIC_API_KEY。 */
  apiKey: string
  /** custom-api 模式 baseURL 覆盖；优先用 settings，回落 ANTHROPIC_BASE_URL 环境变量。 */
  baseUrl?: string
  /** 全局代理 URL（启用时）。 */
  proxyUrl?: string
  /** SNI patch 配置（由调用方按 sniPatchPath 是否存在决定是否填充）。 */
  sniProxyPatch?: SniProxyPatch
}

export function isCliProvider(provider: AgentProviderKind): provider is CliBackend {
  return CLI_BACKENDS.has(provider)
}

/**
 * 从 SettingsRepository 一次性读出 agent 相关配置（不含 sniProxyPatch），组装成 runtime 快照。
 *
 * sniProxyPatch 通过 overrides 注入：调用方各自决定 patch 脚本路径是否存在、是否需要启用。
 * 这样 factory 不需要文件系统副作用，便于测试与多场景复用。
 */
export function loadAgentRuntimeFromSettings(
  settings: SettingsRepository,
  overrides: { sniProxyPatch?: SniProxyPatch } = {},
): AgentRuntimeSettings {
  const rawProvider = settings.get('agent.provider') ?? 'cursor-cli'
  const provider: AgentProviderKind = KNOWN_PROVIDERS.has(rawProvider)
    ? (rawProvider as AgentProviderKind)
    : 'cursor-cli'

  const model = settings.get('agent.model') ?? undefined
  const binaryPath = settings.get('agent.binaryPath') ?? undefined
  const apiKey = settings.get('agent.apiKey') ?? process.env.ANTHROPIC_API_KEY ?? ''
  const baseUrl = settings.get('agent.baseUrl') ?? process.env.ANTHROPIC_BASE_URL ?? undefined

  const proxyEnabled = settings.get('proxy.enabled') === 'true'
  const proxyUrl = proxyEnabled ? (settings.get('proxy.url') ?? undefined) : undefined

  return {
    provider,
    model,
    binaryPath,
    apiKey,
    baseUrl,
    proxyUrl,
    sniProxyPatch: overrides.sniProxyPatch,
  }
}

export interface CreateCliProviderOptions {
  runtime: AgentRuntimeSettings
  /** phase/role 指定的 backend；不传则用 runtime.provider。 */
  agentOverride?: string
  /** phase/role 指定的 model；不传则用 runtime.model。 */
  modelOverride?: string
  /** 续接的 sessionId，仅 cursor-cli/claude-code 支持。 */
  resumeSessionId?: string
}

/**
 * 统一构造 ExternalCliProvider。
 * 当 backend 与 runtime.provider 不一致时，binaryPath 不复用全局值（避免传错二进制）。
 *
 * 当 runtime.provider 为 `custom-api` 时，没有合理的 fallback CLI backend，调用方应改走
 * `createApiProvider` 或 review 单轮 `runCliSingleShot`，本函数直接抛错而非沉默 fallback。
 */
export function createCliProvider(opts: CreateCliProviderOptions): ExternalCliProvider {
  const { runtime } = opts
  let targetBackend: CliBackend
  if (opts.agentOverride && CLI_BACKENDS.has(opts.agentOverride)) {
    targetBackend = opts.agentOverride as CliBackend
  }
  else if (isCliProvider(runtime.provider)) {
    targetBackend = runtime.provider
  }
  else {
    throw new Error(
      `当前 agent.provider 为 ${runtime.provider}，无法构造 CLI provider；请显式指定 agentOverride 或将设置改为 cursor-cli/claude-code/codex。`,
    )
  }
  const model = opts.modelOverride ?? runtime.model
  const useGlobalBinary = isCliProvider(runtime.provider) && targetBackend === runtime.provider

  return new ExternalCliProvider({
    type: targetBackend,
    model,
    binaryPath: useGlobalBinary ? runtime.binaryPath : undefined,
    proxyUrl: runtime.proxyUrl,
    sniProxyPatch: runtime.sniProxyPatch,
    resumeSessionId: opts.resumeSessionId,
  })
}

export interface CreateApiProviderOptions {
  runtime: AgentRuntimeSettings
  modelOverride?: string
}

/** 统一构造 ApiProvider。model 解析优先级：override → runtime → MODEL 环境变量 → 默认 sonnet。 */
export function createApiProvider(opts: CreateApiProviderOptions): ApiProvider {
  const model = opts.modelOverride ?? opts.runtime.model ?? process.env.MODEL ?? DEFAULT_API_MODEL
  return new ApiProvider({
    type: 'anthropic',
    apiKey: opts.runtime.apiKey,
    baseUrl: opts.runtime.baseUrl,
    model,
  })
}
