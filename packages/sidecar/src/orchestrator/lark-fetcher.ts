import { fetchLarkDocContent } from '@code-agent/shared/lark'

/**
 * 通过 lark-cli 获取飞书文档的 Markdown 内容。
 * 自动处理 wiki 链接（先 resolve node → 再 fetch docx）。
 *
 * 仅做一层薄封装保留 sidecar 内部入口，便于上层按业务上下文打 log。
 */
export { fetchLarkDocContent }
