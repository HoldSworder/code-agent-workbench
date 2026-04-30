import { defineConfig } from 'tsup'

/**
 * 与 sidecar 同步：内联 @code-agent/shared 进 dist，
 * 否则 Node 启动时会因 shared 的 .ts exports 入口而崩溃。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node20',
  splitting: false,
  external: ['better-sqlite3'],
  noExternal: ['@code-agent/shared'],
})
