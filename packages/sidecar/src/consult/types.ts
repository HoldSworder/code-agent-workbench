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
  /** Currently running CLI child process abort controller */
  abort: AbortController | null
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
  provider: 'cursor-cli' | 'claude-code' | 'codex'
  model?: string
  binaryPath?: string
  port: number
  proxyUrl?: string
  sniProxyPatch?: {
    scriptPath: string
    socks5Host: string
    socks5Port: number
  }
}

export interface ConsultServerStatus {
  running: boolean
  port: number | null
  localIp: string | null
}
