export { DEFAULT_BINARIES, resolveBinary } from './binaries'
export type { CliBackend } from './binaries'

export { buildAgentEnv, parseSocks5, buildSniProxyPatch } from './env'
export type { BuildAgentEnvOptions, SniProxyPatch } from './env'

export { buildCliArgs } from './args'
export type { BuildCliArgsOptions, BuildCliArgsResult, CliMode } from './args'

export { CliRunner } from './runner'
export type { CliRunOptions, CliRunResult, CliRunStatus } from './runner'

export { runCliSingleShot } from './single-shot'
export type { RunCliSingleShotOptions, RunCliSingleShotResult } from './single-shot'

export {
  normalizeLine,
  stripThinkTags,
  extractStreamText,
  extractActivityEntry,
  extractSessionId,
  extractTokenUsage,
  parseStreamResult,
  parseJsonOutput,
} from './stream-parse'
