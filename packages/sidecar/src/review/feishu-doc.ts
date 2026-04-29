/**
 * 飞书云文档操作（review 模块入口）。
 *
 * 实现已下沉到 `@code-agent/shared/lark`；这里仅 re-export，保留 review 内部稳定入口。
 */

export {
  parseLarkDocUrl as parseDocUrl,
  createDoc,
  fetchDoc,
  overwriteDoc,
  appendDoc,
} from '@code-agent/shared/lark'
export type {
  CreateDocOptions,
  CreateDocResult,
} from '@code-agent/shared/lark'
