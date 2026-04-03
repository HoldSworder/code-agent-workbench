import { spawn } from 'node:child_process'
import type { AgentProvider, PhaseContext, PhaseResult } from './types'

export class ScriptProvider implements AgentProvider {
  private childProcess: ReturnType<typeof spawn> | null = null

  constructor(
    private scriptPath: string,
    private args: string[] = [],
  ) {}

  run(context: PhaseContext): Promise<PhaseResult> {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''

      this.childProcess = spawn(this.scriptPath, this.args, {
        cwd: context.repoPath,
        env: {
          ...process.env,
          OPENSPEC_PATH: context.openspecPath,
          BRANCH_NAME: context.branchName,
          PHASE_ID: context.phaseId,
        },
        shell: true,
      })

      this.childProcess.stdout?.on('data', (data) => {
        stdout += String(data)
      })
      this.childProcess.stderr?.on('data', (data) => {
        stderr += String(data)
      })

      this.childProcess.on('close', (code) => {
        this.childProcess = null
        resolve({
          status: code === 0 ? 'success' : 'failed',
          output: stdout.trim(),
          error: code !== 0 ? stderr.trim() || `Exit code: ${code}` : undefined,
        })
      })
    })
  }

  async cancel(): Promise<void> {
    this.childProcess?.kill('SIGTERM')
  }
}
