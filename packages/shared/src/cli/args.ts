import type { CliBackend } from './binaries'

export type CliMode = 'write' | 'readonly'

export interface BuildCliArgsOptions {
  backend: CliBackend
  /** 工作目录绝对路径（cursor-cli/codex 需要 `--workspace`/`-C`）。 */
  cwd: string
  /** `write` 模式注入 yolo/full-auto 等放行标志；`readonly` 不带这些。 */
  mode: CliMode
  /** 模型名；'auto' 视为不指定。 */
  model?: string | null
  /** 计划模式，仅对 cursor-cli/claude-code/codex 各自有意义。 */
  planMode?: boolean
  /** 续接历史会话 ID。 */
  resumeSessionId?: string | null
  /** prompt 文本，作为 stdin 传入子进程。 */
  prompt: string
}

export interface BuildCliArgsResult {
  args: string[]
  /** stdin 数据；null 表示不写 stdin（当前所有 backend 都用 stdin，但保留扩展位）。 */
  stdinData: string | null
  /** 子进程 stdout 是否走 stream-json 协议。codex 是普通 JSON 不走 stream-json。 */
  useStreamJson: boolean
}

function applyModel(args: string[], model: string | null | undefined, flag: string): void {
  if (model && model !== 'auto') args.push(flag, model)
}

/**
 * 统一三个 backend × write/readonly 的参数构造。
 *
 * 差异点：
 * - `cursor-cli`：write 增加 `--yolo --trust --approve-mcps`；readonly 仅基础流式 + workspace；
 * - `claude-code`：write/readonly 参数完全相同（无 yolo 概念），仅 plan 模式注入 `--permission-mode plan`；
 * - `codex`：write 用 `--full-auto`，readonly 用 `--approval-mode suggest`；plan 模式通过 prompt 前缀注入。
 */
export function buildCliArgs(opts: BuildCliArgsOptions): BuildCliArgsResult {
  const { backend, cwd, mode, planMode, model, resumeSessionId, prompt } = opts

  switch (backend) {
    case 'cursor-cli': {
      const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output']
      if (mode === 'write') args.push('--yolo', '--trust', '--approve-mcps')
      args.push('--workspace', cwd)
      if (planMode) args.push('--plan')
      applyModel(args, model, '--model')
      if (resumeSessionId) args.push('--resume', resumeSessionId)
      return { args, stdinData: prompt, useStreamJson: true }
    }
    case 'claude-code': {
      const args = ['--print', '-', '--output-format', 'stream-json', '--verbose']
      if (planMode) args.push('--permission-mode', 'plan')
      applyModel(args, model, '--model')
      if (resumeSessionId) args.push('--resume', resumeSessionId)
      return { args, stdinData: prompt, useStreamJson: true }
    }
    case 'codex': {
      const args = ['exec', '-']
      args.push(mode === 'write' ? '--full-auto' : '--approval-mode')
      if (mode === 'readonly') args.push('suggest')
      args.push('-C', cwd)
      applyModel(args, model, '--model')
      const effectivePrompt = planMode
        ? `[PLAN MODE] 你只能分析和输出方案，不得修改任何文件。请输出详细的实施计划。\n\n${prompt}`
        : prompt
      return { args, stdinData: effectivePrompt, useStreamJson: false }
    }
  }
}
