import { defineConfig } from 'tsup'

/**
 * 内联 @code-agent/shared 是必须的：
 * shared 的 package.json#exports 直接指向 .ts 源文件（无 dist 产物），
 * 若以 external 形式留在 dist/index.js，Node 启动时会因
 * ERR_UNKNOWN_FILE_EXTENSION 直接崩，导致桌面端卡在“正在启动服务”。
 */
export default defineConfig({
  // worker 必须作为独立入口产出 dist/cursor-sdk.worker.js，供 provider fork。
  entry: {
    'index': 'src/index.ts',
    'cursor-sdk.worker': 'src/providers/cursor-sdk.worker.ts',
  },
  format: 'esm',
  target: 'node20',
  splitting: false,
  // @cursor/sdk 携带平台原生二进制（sqlite3 / connectrpc），必须保持 external，
  // 由运行时从 node_modules resolve，不能被 esbuild 内联。
  external: ['better-sqlite3', '@cursor/sdk'],
  noExternal: ['@code-agent/shared'],
})
