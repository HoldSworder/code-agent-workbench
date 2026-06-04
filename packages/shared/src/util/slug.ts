const SLUG_RE = /[a-z0-9][a-z0-9-]*[a-z0-9]/

/**
 * 清洗任意文本为可作为 git 分支后缀的 kebab-case 英文 slug。
 *
 * 去引号/空白/`feature/` 前缀 → 转 kebab-case → 校验合法 → 限长 60。
 * 失败语义：归一化后为空或非法 → 抛错。
 */
export function normalizeSlug(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^["'`]+|["'`]+$/g, '')
  s = s.replace(/^feature[\/-]/, '')
  s = s.split('\n')[0] ?? ''
  s = s.replace(/[\s_]+/g, '-')
  s = s.replace(/[^a-z0-9-]/g, '')
  s = s.replace(/-{2,}/g, '-')
  s = s.replace(/^-+|-+$/g, '')

  const m = s.match(SLUG_RE)
  if (!m) throw new Error(`normalizeSlug: 输出无法归一化为合法 slug: ${JSON.stringify(raw)}`)
  let slug = m[0]
  if (slug.length > 60) {
    const cut = slug.slice(0, 60).replace(/-+[^-]*$/, '')
    slug = cut || slug.slice(0, 60)
  }
  return slug
}
