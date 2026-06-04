import type { McpServerConfig as SdkMcpServerConfig } from '@cursor/sdk'
import type { PhaseResult } from './types'

/**
 * fork 子进程（cursor-sdk.worker）启动一次 agent run 所需的全部配置。
 * 必须可被 structured clone 序列化（IPC 限制），故仅含纯数据。
 */
export interface WorkerStartConfig {
  apiKey: string
  model?: string
  mode: 'agent' | 'plan'
  prompt: string
  /** worktree 绝对路径；同时作为 fork 的 cwd 与 SDK local.cwd。 */
  cwd: string
  resumeAgentId?: string
  mcpServers?: Record<string, SdkMcpServerConfig>
  /** app 内代理地址；worker 启动时据此设置 undici 全局 dispatcher。空 → 直连。 */
  proxyUrl?: string
}

/** 父进程 → worker 的控制消息。 */
export type ParentToWorker =
  | { type: 'start', config: WorkerStartConfig }
  | { type: 'cancel' }

/** worker → 父进程的流式 / 结果消息。 */
export type WorkerToParent =
  | { type: 'agentId', agentId: string }
  | { type: 'chunk', text: string }
  | { type: 'activity', text: string }
  | { type: 'result', result: PhaseResult }
