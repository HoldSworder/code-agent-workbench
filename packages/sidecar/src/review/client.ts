export interface CallerIdentity {
  userId: string
  userName: string
  role?: string
}

/**
 * HTTP 头部值必须是 ByteString（≤0xFF），中文姓名等非 ASCII 字符直接放进去会被
 * `fetch`/undici 抛出 `Cannot convert argument to a ByteString`。统一对身份头做
 * `encodeURIComponent`，配合 review-server 端 `readCallerIdentity` 的 try-decode，
 * 既支持中文名又向后兼容旧的纯 ASCII 客户端。
 *
 * 已经是 ASCII 安全的字符串走 encodeURIComponent 几乎是恒等变换（仅极少数特殊字符
 * 会被转义），不会破坏现有 open_id / role 字符串。
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return encodeURIComponent(value)
}

export interface UpsertSpecInput {
  baseVersion?: number
  content: string
  force?: boolean
}

export interface UpsertSpecResult {
  content: string
  version: number
  conflict: boolean
}

export interface CreateSessionInput {
  requirementId: string
  requirementTitle: string
  feishuRequirementUrl?: string
  feishuSpecDocToken?: string
  feishuSpecDocUrl?: string
  initialSpecMarkdown?: string
  relatedRepos?: string[]
}

export class ReviewServerClient {
  constructor(private baseUrl: string) {
    this.baseUrl = this.baseUrl.replace(/\/+$/, '')
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '')
  }

  private buildHeaders(identity: CallerIdentity): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    h['X-Lark-User-Id'] = encodeHeaderValue(identity.userId)
    h['X-Lark-User-Name'] = encodeHeaderValue(identity.userName)
    if (identity.role) h['X-Lark-Role'] = encodeHeaderValue(identity.role)
    return h
  }

  private async request<T>(path: string, init: { method?: string, identity?: CallerIdentity, body?: unknown } = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = init.identity ? this.buildHeaders(init.identity) : { 'Content-Type': 'application/json' }
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    if (!res.ok) {
      let body: unknown = text
      try { body = JSON.parse(text) } catch {}
      throw new Error(`review-server HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
    }
    return text ? JSON.parse(text) as T : (undefined as T)
  }

  async health(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/api/health', {})
  }

  async listSessions(): Promise<unknown> {
    return this.request('/api/sessions')
  }

  async createSession(identity: CallerIdentity, input: CreateSessionInput): Promise<unknown> {
    return this.request('/api/sessions', { method: 'POST', identity, body: input })
  }

  async getSession(id: string): Promise<unknown> {
    return this.request(`/api/sessions/${id}`)
  }

  async upsertSpec(identity: CallerIdentity, sessionId: string, input: UpsertSpecInput): Promise<UpsertSpecResult> {
    return this.request<UpsertSpecResult>(`/api/spec/${sessionId}/upsert`, { method: 'POST', identity, body: input })
  }

  async submitAssessmentResults(
    identity: CallerIdentity,
    sessionId: string,
    results: Array<{ role: 'frontend' | 'backend' | 'qa', points: number, rationale: string }>,
  ): Promise<unknown> {
    return this.request(`/api/assessment/${sessionId}/results`, { method: 'POST', identity, body: { results } })
  }
}
