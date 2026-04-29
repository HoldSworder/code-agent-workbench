export type CliBackend = 'cursor-cli' | 'claude-code' | 'codex'

export const DEFAULT_BINARIES: Record<CliBackend, string> = {
  'cursor-cli': 'agent',
  'claude-code': 'claude',
  'codex': 'codex',
}

/**
 * 根据 backend 返回应执行的二进制路径。
 * - 显式 `override` 优先（来自 settings 的 agent.binaryPath）；
 * - 否则回退 backend 默认 binary 名（依赖 PATH 解析）。
 */
export function resolveBinary(backend: CliBackend, override?: string | null): string {
  return (override && override.trim()) || DEFAULT_BINARIES[backend]
}
