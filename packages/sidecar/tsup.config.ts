import { defineConfig } from 'tsup'

/**
 * 内联 @code-agent/shared 是必须的：
 * shared 的 package.json#exports 直接指向 .ts 源文件（无 dist 产物），
 * 若以 external 形式留在 dist/index.js，Node 启动时会因
 * ERR_UNKNOWN_FILE_EXTENSION 直接崩，导致桌面端卡在“正在启动服务”。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node20',
  splitting: false,
  external: ['better-sqlite3'],
  noExternal: ['@code-agent/shared'],
})
