export interface CallerIdentity {
  userId: string
  userName: string
  role?: string
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
    h['X-Lark-User-Id'] = identity.userId
    h['X-Lark-User-Name'] = identity.userName
    if (identity.role) h['X-Lark-Role'] = identity.role
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
