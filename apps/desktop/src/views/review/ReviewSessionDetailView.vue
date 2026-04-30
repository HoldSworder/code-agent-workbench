<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useReviewStore, type AssessmentResultDto } from '../../stores/review'
import { useReviewWs, type ServerMessage } from '../../composables/use-review-ws'
import { rpc } from '../../composables/use-sidecar'
import GateBanner from '../../components/review/GateBanner.vue'
import StepProgress, { type StepDef } from '../../components/review/StepProgress.vue'
import RequirementSourceCard from '../../components/review/RequirementSourceCard.vue'
import StepDesignGen from '../../components/review/StepDesignGen.vue'
import StepClarification from '../../components/review/StepClarification.vue'
import StepStoryPoints from '../../components/review/StepStoryPoints.vue'

type RequirementSourceType = 'spec_doc' | 'requirement_doc' | 'description' | 'title_only'
interface RequirementSource {
  workItemUrl: string
  workItemId: string
  projectKey: string
  workItemType: string
  title: string
  sourceType: RequirementSourceType
  sourceFieldLabel: string | null
  docUrl: string | null
  content: string
  warnings: string[]
}

const props = defineProps<{ sessionId: string }>()
const router = useRouter()
const store = useReviewStore()

const errMsg = ref<string | null>(null)
const generating = ref(false)
const evaluating = ref(false)
const fetchingDoc = ref(false)
const requirementSource = ref<RequirementSource | null>(null)
const requirementError = ref<string | null>(null)
const designAutoTriggered = ref(false)

let feishuDebounceTimer: ReturnType<typeof setTimeout> | null = null

const ws = useReviewWs({
  onMessage: handleWsMessage,
  onOpen: () => { store.wsConnected = true },
  onClose: () => { store.wsConnected = false },
})

/**
 * 装饰底层 LLM/CLI 报错为可操作引导：cursor-cli 区域不支持时建议切换 provider。
 */
function decorateLlmError(raw: string): string {
  if (!raw) return raw
  const lower = raw.toLowerCase()
  const isRegion = lower.includes('not supported in your region') || lower.includes('model not available')
  if (!isRegion) return raw
  return `${raw}\n\n提示：cursor-cli 当前账号所在区域不支持。请到「设置 → Agent」切换 provider 为 claude-code / codex / custom-api 后重试。`
}

function isHost(): boolean {
  return store.role === 'host'
    && !!store.session
    && !!store.lark?.identity
    && store.session.hostUserId === store.lark.identity.userId
}

const isHostComputed = computed(() => isHost())

const isPlaceholder = computed(() => {
  const c = store.specContent ?? ''
  return !c || /\(评审中…\)|TBD/.test(c.slice(0, 200))
})

const currentStep = computed<1 | 2 | 3 | 4 | 5>(() => {
  if (!requirementSource.value) return 1
  if (isPlaceholder.value) return 2
  if (store.assessments.length === 0) return 4
  return 5
})

const steps = computed<StepDef[]>(() => {
  const rs = requirementSource.value
  const step1Status: StepDef['status']
    = !rs ? 'current'
    : rs.sourceType === 'title_only' ? 'warning'
    : 'done'
  const step1Detail
    = !rs ? null
    : rs.sourceType === 'spec_doc' ? '命中 SPEC 文档'
    : rs.sourceType === 'requirement_doc' ? '命中需求文档'
    : rs.sourceType === 'description' ? '命中描述字段'
    : '仅标题（请补 spec）'

  const step2Status: StepDef['status']
    = !rs ? 'pending'
    : isPlaceholder.value ? (currentStep.value === 2 ? 'current' : 'pending')
    : 'done'
  const step2Detail
    = !rs ? null
    : isPlaceholder.value ? '尚未生成 design'
    : `v${store.specVersion} · ${store.specContent.length} 字`

  const step3Status: StepDef['status']
    = store.clarifications.length > 0 ? 'done'
    : currentStep.value >= 3 ? 'pending'
    : 'pending'
  const step3Detail = store.clarifications.length > 0
    ? `${store.clarifications.length} 条澄清`
    : '可选'

  const step4Status: StepDef['status']
    = store.assessments.length > 0 ? 'done'
    : currentStep.value === 4 ? 'current'
    : 'pending'
  const step4Detail = store.assessments.length > 0
    ? store.assessments.map(a => `${a.role}=${a.points}`).join(' / ')
    : null

  const step5Status: StepDef['status']
    = store.assessments.length > 0 && currentStep.value === 5 ? 'current'
    : store.assessments.length > 0 ? 'done'
    : 'pending'

  return [
    { id: 'pull', index: 1, title: '拉取需求', status: step1Status, detail: step1Detail },
    { id: 'design', index: 2, title: '生成 design', status: step2Status, detail: step2Detail },
    { id: 'clarify', index: 3, title: '澄清评审', status: step3Status, detail: step3Detail },
    { id: 'evaluate', index: 4, title: '评估故事点', status: step4Status, detail: step4Detail },
    { id: 'writeback', index: 5, title: '写回飞书', status: step5Status, detail: null },
  ]
})

function scheduleFeishuFlush(): void {
  if (!isHost()) return
  if (!store.session?.feishuSpecDocToken && !store.session?.feishuSpecDocUrl) return
  if (feishuDebounceTimer) clearTimeout(feishuDebounceTimer)
  feishuDebounceTimer = setTimeout(() => { void flushFeishu() }, 1500)
}

async function flushFeishu(): Promise<void> {
  if (!isHost()) return
  const tokenOrUrl = store.session?.feishuSpecDocToken ?? store.session?.feishuSpecDocUrl
  if (!tokenOrUrl) return
  try { await rpc('review.feishuDocOverwrite', { tokenOrUrl, content: store.specContent }) }
  catch (err) { console.error('[review] feishuDocOverwrite failed:', err) }
}

function handleWsMessage(msg: ServerMessage): void {
  if (msg.type === 'session.snapshot') {
    const m = msg as unknown as Parameters<typeof store.applySnapshot>[0]
    store.applySnapshot(m)
    void onSessionReady()
  }
  else if (msg.type === 'spec.updated') {
    store.applySpecUpdated({ version: msg.version as number, content: msg.content as string })
    scheduleFeishuFlush()
  }
  else if (msg.type === 'spec.conflict') {
    store.applySpecUpdated({ version: msg.currentVersion as number, content: msg.content as string })
  }
  else if (msg.type === 'clarify.added')
    store.applyClarification(msg.clarification as Parameters<typeof store.applyClarification>[0])
  else if (msg.type === 'participant.joined')
    store.applyParticipantJoined(msg.user as Parameters<typeof store.applyParticipantJoined>[0])
  else if (msg.type === 'participant.left')
    store.applyParticipantLeft(msg.user as Parameters<typeof store.applyParticipantLeft>[0])
  else if (msg.type === 'assessment.completed')
    store.applyAssessment(msg.results as AssessmentResultDto[])
}

async function reconnectWs(): Promise<void> {
  if (!store.lark?.identity) return
  ws.connect(store.lark.identity, store.role)
}

async function joinSession(): Promise<void> {
  if (!store.lark?.identity) return
  await reconnectWs()
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (store.wsConnected) { clearInterval(timer); resolve() }
    }, 50)
    setTimeout(() => { clearInterval(timer); resolve() }, 3000)
  })
  ws.send({ type: 'join', sessionId: props.sessionId })
}

/**
 * session 首次加载到本地后的副作用：
 * 1. 自动按需求SPEC文档 / 需求文档 / 描述顺序拉取需求来源；
 * 2. 命中后再自动调 generateFrontendDesign（仅当当前 specContent 还是初始占位文本时，避免覆盖人工修改）。
 */
async function onSessionReady(): Promise<void> {
  if (!store.session) return
  if (designAutoTriggered.value) return
  designAutoTriggered.value = true

  if (!store.session.feishuRequirementUrl) {
    requirementError.value = '会话未关联飞书工作项 URL，跳过自动拉取需求来源'
    return
  }

  await fetchRequirementSource()
  if (isHost() && isPlaceholder.value && requirementSource.value) {
    await generateFrontendDesign()
  }
}

async function fetchRequirementSource(): Promise<void> {
  if (!store.session?.feishuRequirementUrl) return
  fetchingDoc.value = true
  requirementError.value = null
  try {
    const res = await rpc<RequirementSource>('review.fetchRequirementDoc', {
      workItemUrl: store.session.feishuRequirementUrl,
    })
    requirementSource.value = res
  }
  catch (err) {
    requirementError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    fetchingDoc.value = false
  }
}

/** 用户在 RequirementSourceCard 里手动粘贴需求文档时，覆盖当前 source.content 让后续 design 生成可用。 */
function handleManualContent(content: string): void {
  if (!requirementSource.value) return
  requirementSource.value = {
    ...requirementSource.value,
    sourceType: 'description',
    sourceFieldLabel: '手动粘贴',
    content,
    warnings: [...requirementSource.value.warnings, '需求来源由用户在桌面端手动粘贴覆盖'],
  }
}

async function generateFrontendDesign(): Promise<void> {
  if (!store.session) return
  if (!isHost()) {
    errMsg.value = '仅会话主持人（host）可以生成前端开发设计'
    return
  }
  if (!requirementSource.value) {
    errMsg.value = '尚未拉取到需求来源；请先点击「重新拉取」'
    return
  }
  generating.value = true
  errMsg.value = null
  try {
    const repos = store.session.relatedRepos.map(p => ({ path: p }))
    const res = await rpc<{ content: string, error?: string }>('review.generateFrontendDesign', {
      sessionId: store.session.id,
      requirementSource: requirementSource.value,
      relatedRepos: repos,
      existingDesign: store.specContent,
      reviewServerBaseUrl: store.baseUrl,
      identity: store.lark?.identity
        ? { userId: store.lark.identity.userId, userName: store.lark.identity.userName, role: store.role }
        : undefined,
    })
    if (res.error) errMsg.value = decorateLlmError(res.error)
  }
  catch (err) {
    errMsg.value = decorateLlmError(err instanceof Error ? err.message : String(err))
  }
  finally {
    generating.value = false
  }
}

function commitSpec(draft: string): void {
  if (!store.session) return
  ws.send({
    type: 'spec.patch',
    sessionId: store.session.id,
    baseVersion: store.specVersion,
    content: draft,
  })
}

function addClarification(content: string): void {
  if (!store.session) return
  ws.send({
    type: 'clarify.add',
    sessionId: store.session.id,
    content,
  })
}

async function confirmAndEvaluate(payload: {
  writebackTool: string
  fields: Array<{ fieldKey: string, role: 'frontend' | 'backend' | 'qa' }>
}): Promise<void> {
  if (!store.session) return
  if (!isHost()) {
    errMsg.value = '仅会话主持人可触发评估并写回飞书项目'
    return
  }
  evaluating.value = true
  errMsg.value = null
  try {
    const writebackPlan = payload.fields.length > 0 && payload.writebackTool
      ? { tool: payload.writebackTool, requirementId: store.session.requirementId, fields: payload.fields }
      : undefined
    const res = await rpc<{ results: AssessmentResultDto[], warnings: string[] }>('review.evaluateStoryPoints', {
      sessionId: store.session.id,
      requirementTitle: store.session.requirementTitle,
      specMarkdown: store.specContent,
      feishuSpecDocTokenOrUrl: store.session.feishuSpecDocToken ?? store.session.feishuSpecDocUrl ?? undefined,
      writebackPlan,
      reviewServerBaseUrl: store.baseUrl,
      identity: store.lark?.identity
        ? { userId: store.lark.identity.userId, userName: store.lark.identity.userName, role: store.role }
        : undefined,
    })
    store.applyAssessment(res.results)
    if (res.warnings?.length) errMsg.value = decorateLlmError(`部分步骤有告警：\n${res.warnings.join('\n')}`)
  }
  catch (err) {
    errMsg.value = decorateLlmError(err instanceof Error ? err.message : String(err))
  }
  finally {
    evaluating.value = false
  }
}

function scrollToStep(step: StepDef): void {
  const id = `step-${step.id}`
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

onMounted(async () => {
  await store.refreshAll()
  if (!store.blocking.blocked) await joinSession()
})

onBeforeUnmount(() => {
  if (feishuDebounceTimer) { clearTimeout(feishuDebounceTimer); feishuDebounceTimer = null }
  store.reset()
})
</script>

<template>
  <div class="h-full overflow-y-auto p-5">
    <div class="max-w-6xl mx-auto space-y-5">
      <header class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <button
            class="text-[12px] text-gray-500 hover:text-indigo-500"
            @click="router.replace({ path: '/review' })"
          >
            ← 返回列表
          </button>
          <h1 class="text-lg font-semibold tracking-tight">评审会话详情</h1>
        </div>
        <div class="flex items-center gap-3 text-[12px]">
          <span v-if="store.lark?.identity" class="text-gray-500">
            身份：{{ store.lark.identity.userName }}
          </span>
          <select
            v-model="store.role"
            class="px-2 py-1 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
          >
            <option value="host">主持人</option>
            <option value="frontend">前端</option>
            <option value="backend">后端</option>
            <option value="qa">测试</option>
          </select>
          <span :class="store.wsConnected ? 'text-emerald-600' : 'text-gray-400'">●</span>
        </div>
      </header>

      <GateBanner v-if="store.blocking.blocked" />

      <template v-else-if="store.session">
        <section class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-[14px] font-semibold">{{ store.session.requirementTitle }}</div>
              <div class="text-[11px] text-gray-400">
                v{{ store.specVersion }} · 状态 {{ store.session.status }} · #{{ store.session.requirementId }}
              </div>
            </div>
            <div class="flex gap-2">
              <a
                v-if="store.session.feishuRequirementUrl"
                :href="store.session.feishuRequirementUrl"
                target="_blank"
                class="text-[12px] text-indigo-500 hover:underline"
              >工作项 ↗</a>
              <a
                v-if="store.session.feishuSpecDocUrl"
                :href="store.session.feishuSpecDocUrl"
                target="_blank"
                class="text-[12px] text-indigo-500 hover:underline"
              >飞书文档 ↗</a>
            </div>
          </div>
          <StepProgress
            :steps="steps"
            :current-step="currentStep"
            @step-click="scrollToStep"
          />
        </section>

        <div id="step-pull">
          <RequirementSourceCard
            :source="requirementSource"
            :loading="fetchingDoc"
            :external-error="requirementError"
            @refresh="fetchRequirementSource"
            @manual-content="handleManualContent"
          />
        </div>

        <section class="grid grid-cols-3 gap-4">
          <div class="col-span-2 space-y-3">
            <div id="step-design">
              <StepDesignGen
                :content="store.specContent"
                :version="store.specVersion"
                :is-host="isHostComputed"
                :generating="generating"
                :can-generate="!!requirementSource"
                :active="currentStep === 2"
                @generate="generateFrontendDesign"
                @commit="commitSpec"
              />
            </div>

            <div id="step-evaluate">
              <StepStoryPoints
                :project-key="requirementSource?.projectKey ?? ''"
                :work-item-type="requirementSource?.workItemType ?? ''"
                :is-host="isHostComputed"
                :evaluating="evaluating"
                :active="currentStep >= 4"
                :assessments="store.assessments"
                @evaluate="confirmAndEvaluate"
              />
            </div>
          </div>

          <div class="space-y-3">
            <div class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
              <div class="text-[13px] font-semibold mb-2">在线参与者</div>
              <ul class="space-y-1">
                <li
                  v-for="p in store.participants"
                  :key="p.userId"
                  class="flex items-center justify-between text-[12px]"
                >
                  <span>{{ p.userName }}</span>
                  <span class="text-gray-400">{{ p.role }}</span>
                </li>
                <li v-if="!store.participants.length" class="text-[12px] text-gray-400">暂无</li>
              </ul>
            </div>

            <div id="step-clarify">
              <StepClarification
                :clarifications="store.clarifications"
                :active="currentStep === 3"
                @send="addClarification"
              />
            </div>
          </div>
        </section>

        <div v-if="errMsg" class="text-[12px] text-rose-600 whitespace-pre-wrap">{{ errMsg }}</div>
      </template>

      <template v-else>
        <div class="text-[12px] text-gray-500">正在加载会话 {{ props.sessionId }} …</div>
      </template>
    </div>
  </div>
</template>
