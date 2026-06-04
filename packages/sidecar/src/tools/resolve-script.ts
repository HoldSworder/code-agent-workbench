import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 解析仓库根目录下 `tools/<toolName>/<scriptFile>` 的绝对路径。
 *
 * tsup 把所有源码打包进单个 `dist/index.js`，运行时 import.meta.url 恒指向
 * `dist/index.js`，与 tsx 直跑源码（`src/tools/`）时的目录深度不同。两种布局下
 * 仓库根分别在 `__dirname` 的上 3 / 上 4 层，这里逐层向上探测，命中真实存在的
 * 脚本即返回，彻底避免硬编码 `..` 层数导致路径错位。
 *
 * 注意：必须用顶层 ESM `import { existsSync }`，不能用 `require('node:fs')`——
 * 打包后的 ESM 模块里没有 `require`，会抛错并退化到错误的候选路径。
 */
export function resolveToolScript(toolName: string, scriptFile: string): string {
  const candidates = [
    resolve(here, '..', '..', '..', '..', 'tools', toolName, scriptFile),
    resolve(here, '..', '..', '..', 'tools', toolName, scriptFile),
    resolve(here, '..', '..', 'tools', toolName, scriptFile),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate))
      return candidate
  }
  return candidates[1]
}
