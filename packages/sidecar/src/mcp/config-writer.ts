import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
}

export interface McpConfigWriter {
  write(cwd: string, servers: McpServerConfig[]): void
  backup(cwd: string): void
  restore(cwd: string): void
  cleanup(cwd: string): void
  hasBackup(cwd: string): boolean
  getConfigPath(cwd: string): string
}

const MANAGED_MARKER = '_managedBy'
const MANAGED_VALUE = 'code-agent'
const BACKUP_SUFFIX = '.code-agent-backup'

abstract class BaseMcpConfigWriter implements McpConfigWriter {
  protected abstract configPath(cwd: string): string

  getConfigPath(cwd: string): string {
    return this.configPath(cwd)
  }

  private backupPath(cwd: string): string {
    return this.configPath(cwd) + BACKUP_SUFFIX
  }

  write(cwd: string, servers: McpServerConfig[]): void {
    const configFile = this.configPath(cwd)
    let existing: Record<string, unknown> = {}

    if (existsSync(configFile)) {
      try {
        existing = JSON.parse(readFileSync(configFile, 'utf-8'))
      } catch {
        existing = {}
      }
    }

    const mcpServers = (existing.mcpServers ?? {}) as Record<string, Record<string, unknown>>

    for (const [key, value] of Object.entries(mcpServers)) {
      if (value && typeof value === 'object' && (value as Record<string, unknown>)[MANAGED_MARKER] === MANAGED_VALUE) {
        delete mcpServers[key]
      }
    }

    for (const server of servers) {
      const entry: Record<string, unknown> = { [MANAGED_MARKER]: MANAGED_VALUE }

      if (server.transport === 'stdio') {
        if (server.command) entry.command = server.command
        if (server.args?.length) entry.args = server.args
        if (server.env && Object.keys(server.env).length) entry.env = server.env
      } else {
        if (server.url) entry.url = server.url
        if (server.headers && Object.keys(server.headers).length) entry.headers = server.headers
        if (server.transport === 'http') entry.type = 'http'
        if (server.transport === 'sse') entry.type = 'sse'
      }

      mcpServers[server.name] = entry
    }

    existing.mcpServers = mcpServers

    const dir = dirname(configFile)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(configFile, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  }

  backup(cwd: string): void {
    const configFile = this.configPath(cwd)
    if (existsSync(configFile)) {
      copyFileSync(configFile, this.backupPath(cwd))
    }
  }

  restore(cwd: string): void {
    const backupFile = this.backupPath(cwd)
    if (existsSync(backupFile)) {
      copyFileSync(backupFile, this.configPath(cwd))
      unlinkSync(backupFile)
    }
  }

  cleanup(cwd: string): void {
    const backupFile = this.backupPath(cwd)
    if (existsSync(backupFile)) {
      unlinkSync(backupFile)
    }
  }

  hasBackup(cwd: string): boolean {
    return existsSync(this.backupPath(cwd))
  }
}

export class CursorConfigWriter extends BaseMcpConfigWriter {
  protected configPath(cwd: string): string {
    return join(cwd, '.cursor', 'mcp.json')
  }
}

export class ClaudeCodeConfigWriter extends BaseMcpConfigWriter {
  protected configPath(cwd: string): string {
    return join(cwd, '.mcp.json')
  }
}

export function getConfigWriter(cliType: string): McpConfigWriter {
  switch (cliType) {
    case 'cursor-cli':
      return new CursorConfigWriter()
    case 'claude-code':
      return new ClaudeCodeConfigWriter()
    default:
      return new CursorConfigWriter()
  }
}
