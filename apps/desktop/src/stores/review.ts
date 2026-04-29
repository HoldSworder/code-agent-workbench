import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  reviewServerBaseUrl,
  checkLarkIdentity,
  type LarkIdentityResult,
} from '../composables/use-review-server'
import { rpc } from '../composables/use-sidecar'
import type { ParticipantRole } from '../composables/use-review-ws'

export interface FeishuMcpStatus {
  configured: boolean
  healthy: boolean
  mcpId: string | null
  mcpName: string | null
  toolCount: number | null
  lastError: string | null
}

export interface ReviewServerHealth {
  healthy: boolean
  error: string | null
  lastCheckedAt: string | null
}

export interface SessionDto {
  id: string
  requirementId: string
  requirementTitle: string
  feishuRequirementUrl: string | null
  feishuSpecDocToken: string | null
  feishuSpecDocUrl: string | null
  relatedRepos: string[]
  status: 'open' | 'confirmed' | 'closed'
  hostUserId: string
  hostUserName: string
  createdAt: string
}

export interface ClarificationDto {
  id: string
  sessionId: string
  userId: string
  userName: string
  content: string
  parentId: string | null
  createdAt: string
}

export interface AssessmentResultDto {
  role: 'frontend' | 'backend' | 'qa'
  points: number
  rationale: string
}

export interface ParticipantDto {
  userId: string
  userName: string
  role: ParticipantRole
}

export const useReviewStore = defineStore('review', () => {
  const lark = ref<LarkIdentityResult | null>(null)
  const feishuMcp = ref<FeishuMcpStatus | null>(null)
  const reviewServer = ref<ReviewServerHealth>({ healthy: false, error: null, lastCheckedAt: null })
  const baseUrl = ref(reviewServerBaseUrl.value)

  const role = ref<ParticipantRole>('host')
  const session = ref<SessionDto | null>(null)
  const specContent = ref('')
  const specVersion = ref(0)
  const clarifications = ref<ClarificationDto[]>([])
  const participants = ref<ParticipantDto[]>([])
  const assessments = ref<AssessmentResultDto[]>([])
  const wsConnected = ref(false)

  const blocking = computed<{ blocked: boolean, reasons: string[] }>(() => {
    const reasons: string[] = []
    if (!lark.value) reasons.push('尚未检测 lark-cli 状态')
    else if (!lark.value.installed) reasons.push('lark-cli 未安装')
    else if (!lark.value.loggedIn) reasons.push(lark.value.error ?? 'lark-cli 未登录')

    if (!feishuMcp.value) reasons.push('尚未检测飞书项目 MCP')
    else if (!feishuMcp.value.configured) reasons.push('飞书项目 MCP 未在 MCP 页面标记')
    else if (!feishuMcp.value.healthy) reasons.push(feishuMcp.value.lastError ?? '飞书项目 MCP 不健康')

    if (!reviewServer.value.healthy) reasons.push(reviewServer.value.error ?? `评审中心服务不可达（${baseUrl.value}）`)
    return { blocked: reasons.length > 0, reasons }
  })

  async function refreshLarkIdentity(): Promise<void> {
    try { lark.value = await checkLarkIdentity() }
    catch (err) {
      lark.value = { installed: false, loggedIn: false, identity: null, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function refreshFeishuMcpStatus(): Promise<void> {
    try {
      feishuMcp.value = await rpc<FeishuMcpStatus>('review.checkFeishuProjectMcp', {})
    }
    catch (err) {
      feishuMcp.value = {
        configured: false,
        healthy: false,
        mcpId: null,
        mcpName: null,
        toolCount: null,
        lastError: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async function refreshReviewServerHealth(): Promise<void> {
    try {
      const r = await rpc<{ healthy: boolean, error: string | null }>('review.serverHealth', { baseUrl: baseUrl.value })
      reviewServer.value = { healthy: !!r.healthy, error: r.error ?? null, lastCheckedAt: new Date().toISOString() }
    }
    catch (err) {
      reviewServer.value = { healthy: false, error: err instanceof Error ? err.message : String(err), lastCheckedAt: new Date().toISOString() }
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([refreshLarkIdentity(), refreshFeishuMcpStatus(), refreshReviewServerHealth()])
  }

  function applySnapshot(payload: {
    session: SessionDto
    spec: string
    specVersion: number
    clarifications: ClarificationDto[]
    participants: ParticipantDto[]
  }): void {
    session.value = payload.session
    specContent.value = payload.spec
    specVersion.value = payload.specVersion
    clarifications.value = payload.clarifications
    participants.value = payload.participants
  }

  function applySpecUpdated(payload: { version: number, content: string }): void {
    specContent.value = payload.content
    specVersion.value = payload.version
  }

  function applyClarification(c: ClarificationDto): void {
    if (!clarifications.value.some(item => item.id === c.id))
      clarifications.value.push(c)
  }

  function applyParticipantJoined(user: ParticipantDto): void {
    if (!participants.value.some(p => p.userId === user.userId))
      participants.value.push(user)
  }

  function applyParticipantLeft(user: ParticipantDto): void {
    participants.value = participants.value.filter(p => p.userId !== user.userId)
  }

  function applyAssessment(results: AssessmentResultDto[]): void {
    assessments.value = results
  }

  function reset(): void {
    session.value = null
    specContent.value = ''
    specVersion.value = 0
    clarifications.value = []
    participants.value = []
    assessments.value = []
  }

  return {
    lark,
    feishuMcp,
    reviewServer,
    baseUrl,
    role,
    session,
    specContent,
    specVersion,
    clarifications,
    participants,
    assessments,
    wsConnected,
    blocking,
    refreshLarkIdentity,
    refreshFeishuMcpStatus,
    refreshReviewServerHealth,
    refreshAll,
    applySnapshot,
    applySpecUpdated,
    applyClarification,
    applyParticipantJoined,
    applyParticipantLeft,
    applyAssessment,
    reset,
  }
})
