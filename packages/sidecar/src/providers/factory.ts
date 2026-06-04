import type { SettingsRepository } from '../db/repositories/settings.repo'
import { CursorSdkProvider, DEFAULT_CURSOR_MODEL } from './cursor-sdk.provider'

/**
 * 设置中可选的 LLM provider。
 * 目前全面 SDK 化后仅支持 `cursor-sdk`；后续接入 claude / codex 官方 SDK 时在此扩展。
 */
export type AgentProviderKind = 'cursor-sdk'

export interface AgentRuntimeSettings {
  /** 全局选定的 LLM provider；当前恒为 cursor-sdk。 */
  provider: AgentProviderKind
  /** 全局默认 model id，可被 phase / role 覆盖。 */
  model?: string
  /** Cursor API Key；优先用 settings，回落 CURSOR_API_KEY 环境变量。 */
  cursorApiKey: string
  /** app 内启用的代理地址；未启用为 undefined。供 SDK fetch 经此代理出网。 */
  proxyUrl?: string
}

/**
 * 从 SettingsRepository 读出 agent 相关配置，组装成 runtime 快照。
 *
 * 代理由 sidecar 入口的 syncProcessProxyEnv 统一注入到进程环境，SDK 走进程内
 * connectrpc/http 时自动生效，这里不再处理 proxy / sniProxyPatch。
 */
export function loadAgentRuntimeFromSettings(settings: SettingsRepository): AgentRuntimeSettings {
  const model = settings.get('agent.model') ?? undefined
  const cursorApiKey = settings.get('agent.cursorApiKey') ?? process.env.CURSOR_API_KEY ?? ''
  const proxyUrl = settings.get('proxy.enabled') === 'true'
    ? (settings.get('proxy.url') ?? undefined)
    : undefined
  return { provider: 'cursor-sdk', model, cursorApiKey, proxyUrl }
}

export interface CreateCursorSdkProviderOptions {
  runtime: AgentRuntimeSettings
  /** phase / role 指定的 model；不传则用 runtime.model，再回落默认模型。 */
  modelOverride?: string
  /** 续接的 cursor agentId（来自上一次 run）。 */
  resumeAgentId?: string
}

/** 统一构造 CursorSdkProvider。 */
export function createCursorSdkProvider(opts: CreateCursorSdkProviderOptions): CursorSdkProvider {
  const model = opts.modelOverride ?? opts.runtime.model ?? DEFAULT_CURSOR_MODEL
  return new CursorSdkProvider({
    apiKey: opts.runtime.cursorApiKey,
    model,
    resumeAgentId: opts.resumeAgentId,
    proxyUrl: opts.runtime.proxyUrl,
  })
}
