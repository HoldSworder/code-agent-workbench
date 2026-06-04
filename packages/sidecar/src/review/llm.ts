import { Agent, CursorAgentError } from '@cursor/sdk'
import { PromptBuilder } from '@code-agent/shared/util'
import type { AgentRuntimeSettings } from '../providers/factory'
import { DEFAULT_CURSOR_MODEL } from '../providers/cursor-sdk.provider'

export interface LlmCallOptions {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  /** 由调用方从 SettingsRepository 解析后传入，避免本模块依赖 db。 */
  runtime: AgentRuntimeSettings
  /** review 关联的主仓库路径，作为本地 agent cwd；不传走 OS tmpdir。 */
  cwd?: string
}

/**
 * review 场景下的「单轮 system + user → text」调用器。
 *
 * 全面 SDK 化后统一走 `@cursor/sdk` 的 `Agent.prompt`（one-shot，自动 dispose）。
 * system + user 合并为单条 prompt 发送，local agent 以 settingSources=[] 运行，
 * cwd 用于让 agent 能读取仓库内的规则文件。
 *
 * 友好错误：缺 cursorApiKey 时直接抛出指向「设置」页的中文提示。
 */
export async function llmCall(opts: LlmCallOptions): Promise<string> {
  const { runtime } = opts

  if (!runtime.cursorApiKey) {
    throw new Error('未配置 Cursor API Key，请到桌面端「设置」填写后重试。')
  }

  const prompt = new PromptBuilder()
    .section('System', opts.systemPrompt)
    .divider()
    .text(opts.userPrompt)
    .build()

  try {
    const result = await Agent.prompt(prompt, {
      apiKey: runtime.cursorApiKey,
      model: { id: runtime.model ?? DEFAULT_CURSOR_MODEL },
      local: { cwd: opts.cwd ?? process.cwd(), settingSources: [] },
    })
    if (result.status !== 'finished')
      throw new Error(`Cursor run 执行失败（status=${result.status}）`)
    return (result.result ?? '').trim()
  }
  catch (err) {
    if (err instanceof CursorAgentError)
      throw new Error(`Cursor agent 调用失败：${err.message}`)
    throw err
  }
}
