export interface ConsultMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface ConsultSession {
  id: string
  repoId: string
  repoPath: string
  messages: ConsultMessage[]
  /** 续接用的 cursor agentId（首轮后写入）。 */
  agentId: string | null
  createdAt: number
  clientIp: string | null
}

export interface ConsultSessionSummary {
  id: string
  repoId: string
  repoPath: string
  clientIp: string | null
  messageCount: number
  createdAt: number
  lastActiveAt: number
}

export interface ConsultConfig {
  /** Cursor API Key。 */
  cursorApiKey: string
  model?: string
  port: number
}

export interface ConsultServerStatus {
  running: boolean
  port: number | null
  localIp: string | null
}
