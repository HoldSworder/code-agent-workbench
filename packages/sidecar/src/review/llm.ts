import { runCliSingleShot } from '@code-agent/shared/cli'
import { callAnthropic } from '@code-agent/shared/llm'
import type { AgentRuntimeSettings } from '../providers/factory'
import { isCliProvider } from '../providers/factory'

export interface LlmCallOptions {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  /** 由调用方从 SettingsRepository 解析后传入，避免本模块依赖 db。 */
  runtime: AgentRuntimeSettings
  /** review 关联的主仓库路径，作为 CLI 子进程 cwd；不传走 OS tmpdir。 */
  cwd?: string
}

/**
 * review 场景下的"单轮 system + user → text"调用器。
 *
 * 路由策略（与设置中 agent.provider 对齐，不再硬绑 ANTHROPIC_API_KEY）：
 * - cursor-cli / claude-code / codex → `runCliSingleShot`（Spawn CLI 子进程，零 env 依赖）
 * - custom-api → `callAnthropic`（Anthropic SDK，需要 agent.apiKey）
 *
 * 友好错误：custom-api 缺 apiKey 时直接抛出指向「设置」页的中文提示，不再依赖底层 SDK 的英文报错。
 */
export async function llmCall(opts: LlmCallOptions): Promise<string> {
  const { runtime } = opts

  if (isCliProvider(runtime.provider)) {
    const r = await runCliSingleShot({
      backend: runtime.provider,
      binaryPath: runtime.binaryPath,
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      model: runtime.model,
      cwd: opts.cwd,
      proxyUrl: runtime.proxyUrl,
      sniProxyPatch: runtime.sniProxyPatch,
    })
    return r.text.trim()
  }

  // custom-api 分支
  if (!runtime.apiKey) {
    throw new Error('当前 agent.provider 为 custom-api，请到桌面端「设置」填写 agent.apiKey 后重试。')
  }
  const { text } = await callAnthropic({
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    maxTokens: opts.maxTokens,
    model: runtime.model,
    apiKey: runtime.apiKey,
    baseUrl: runtime.baseUrl,
  })
  return text.trim()
}
