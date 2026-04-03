import { spawn } from 'node:child_process'
import type { AgentProvider, PhaseContext, PhaseResult } from './types'

export interface CliProviderConfig {
  type: 'claude-code' | 'cursor-cli' | 'codex'
  binaryPath?: string
}

export class ExternalCliProvider implements AgentProvider {
  private childProcess: ReturnType<typeof spawn> | null = null
  private config: CliProviderConfig

  constructor(config: CliProviderConfig) {
    this.config = config
  }

  buildArgs(context: PhaseContext): string[] {
    const prompt = this.buildPrompt(context)
    switch (this.config.type) {
      case 'claude-code': {
        const args = ['-p', prompt, '--output-format', 'json']
        if (context.mcpConfig)
          args.push('--mcp-config', context.mcpConfig)
        return args
      }
      case 'cursor-cli':
        return ['--message', prompt]
      case 'codex':
        return ['-p', prompt, '--output-format', 'json']
    }
  }

  run(context: PhaseContext): Promise<PhaseResult> {
    return new Promise((resolve) => {
      const binary = this.config.binaryPath ?? this.defaultBinary()
      const args = this.buildArgs(context)
      let stdout = ''
      let stderr = ''

      this.childProcess = spawn(binary, args, {
        cwd: context.repoPath,
        env: process.env,
      })

      this.childProcess.stdout?.on('data', (data) => {
        stdout += String(data)
      })
      this.childProcess.stderr?.on('data', (data) => {
        stderr += String(data)
      })

      this.childProcess.on('close', (code) => {
        this.childProcess = null
        if (code !== 0) {
          resolve({
            status: 'failed',
            error: stderr || `Exit code: ${code}`,
          })
          return
        }
        const output = this.parseOutput(stdout)
        resolve({
          status: 'success',
          output: output.text,
          tokenUsage: output.tokenUsage,
        })
      })
    })
  }

  async cancel(): Promise<void> {
    this.childProcess?.kill('SIGTERM')
  }

  private buildPrompt(context: PhaseContext): string {
    let prompt = context.skillContent
    if (context.userMessage)
      prompt += `\n\n## 用户反馈\n${context.userMessage}`
    prompt += `\n\n## 上下文\n- 工作目录: ${context.repoPath}\n- OpenSpec: ${context.openspecPath}\n- 分支: ${context.branchName}`
    return prompt
  }

  private defaultBinary(): string {
    return {
      'claude-code': 'claude',
      'cursor-cli': 'cursor',
      'codex': 'codex',
    }[this.config.type]
  }

  private parseOutput(stdout: string): { text: string, tokenUsage?: number } {
    try {
      const json = JSON.parse(stdout) as {
        result?: string
        output?: string
        usage?: { total_tokens?: number }
      }
      return {
        text: json.result ?? json.output ?? stdout,
        tokenUsage: json.usage?.total_tokens,
      }
    }
    catch {
      return { text: stdout }
    }
  }
}
