<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useReviewStore, type SessionDto, type AssessmentResultDto } from '../stores/review'
import { useReposStore } from '../stores/repos'
import { useReviewWs, type ServerMessage } from '../composables/use-review-ws'
import { rpc } from '../composables/use-sidecar'
import GateBanner from '../components/review/GateBanner.vue'

const store = useReviewStore()
const reposStore = useReposStore()

const newReqId = ref('')
const newReqTitle = ref('')
const newReqUrl = ref('')

// 关联仓库多选：从仓库 store 拿全部已配置仓库，前端只持久化 id；提交时 map 成 local_path 数组。
const selectedRepoIds = ref<string[]>(loadSelectedRepoIds())

function loadSelectedRepoIds(): string[] {
  try {
    const raw = localStorage.getItem('review.selectedRepoIds')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

function toggleRepo(id: string): void {
  const idx = selectedRepoIds.value.indexOf(id)
  if (idx >= 0) selectedRepoIds.value.splice(idx, 1)
  else selectedRepoIds.value.push(id)
}

// ── 飞书视图驱动入口 ──
interface ViewWorkItem {
  id: string
  title: string | null
  statusLabel: string | null
  ownerNames: string[]
  sourceUrl: string
}
const viewUrl = ref(localStorage.getItem('review.viewUrl') ?? '')
const viewProjectKey = ref(localStorage.getItem('review.viewProjectKey') ?? '')
const viewWorkItemType = ref(localStorage.getItem('review.viewWorkItemType') ?? 'story')
const viewId = ref(localStorage.getItem('review.viewId') ?? '')
const viewItems = ref<ViewWorkItem[]>([])
const viewLoading = ref(false)
const viewError = ref<string | null>(null)
const viewPageNum = ref(1)
const viewPageSize = 50
const viewHasMore = ref(false)
const viewDebug = ref<{ toolName?: string, availableTools?: string[], rawSnippet?: string | null } | null>(null)
const formSectionRef = ref<HTMLElement | null>(null)

const projectKey = ref(localStorage.getItem('review.projectKey') ?? '')
const fieldKeyFE = ref(localStorage.getItem('review.fieldKey.frontend') ?? '')
const fieldKeyBE = ref(localStorage.getItem('review.fieldKey.backend') ?? '')
const fieldKeyQA = ref(localStorage.getItem('review.fieldKey.qa') ?? '')
const writebackTool = ref(localStorage.getItem('review.writebackTool') ?? 'update_field')
const requirementMarkdown = ref('')

const sessions = ref<SessionDto[]>([])
const sessionsLoading = ref(false)
const errMsg = ref<string | null>(null)
const newClarification = ref('')
const generating = ref(false)
const evaluating = ref(false)
const editing = ref(false)
const draftSpec = ref('')

let feishuDebounceTimer: ReturnType<typeof setTimeout> | null = null

const ws = useReviewWs({
  onMessage: handleWsMessage,
  onOpen: () => { store.wsConnected = true },
  onClose: () => { store.wsConnected = false },
})

function isHost(): boolean {
  return store.role === 'host'
    && !!store.session
    && !!store.lark?.identity
    && store.session.hostUserId === store.lark.identity.userId
}

function scheduleFeishuFlush(): void {
  if (!isHost()) return
  if (!store.session?.feishuSpecDocToken && !store.session?.feishuSpecDocUrl) return
  if (feishuDebounceTimer) clearTimeout(feishuDebounceTimer)
  feishuDebounceTimer = setTimeout(() => {
    void flushFeishu()
  }, 1500)
}

async function flushFeishu(): Promise<void> {
  if (!isHost()) return
  const tokenOrUrl = store.session?.feishuSpecDocToken ?? store.session?.feishuSpecDocUrl
  if (!tokenOrUrl) return
  try {
    await rpc('review.feishuDocOverwrite', { tokenOrUrl, content: store.specContent })
  }
  catch (err) {
    console.error('[review] feishuDocOverwrite failed:', err)
  }
}

function handleWsMessage(msg: ServerMessage): void {
  if (msg.type === 'session.snapshot') {
    const m = msg as unknown as Parameters<typeof store.applySnapshot>[0]
    store.applySnapshot(m)
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

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true
  errMsg.value = null
  try {
    const data = await rpc<{ sessions: SessionDto[] }>('review.listSessions', { baseUrl: store.baseUrl })
    sessions.value = data.sessions
  }
  catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    sessionsLoading.value = false
  }
}

async function reconnectWs(): Promise<void> {
  if (!store.lark?.identity) return
  ws.connect(store.lark.identity, store.role)
}

interface CreateDocResult { token: string, url: string }

async function ensureFeishuSpecDoc(title: string): Promise<CreateDocResult | null> {
  try {
    const res = await rpc<CreateDocResult>('review.feishuDocCreate', {
      title: `开发 Spec - ${title}`,
      content: `# 开发 Spec - ${title}\n\n（评审中…）`,
    })
    return res
  }
  catch (err) {
    errMsg.value = `创建飞书文档失败：${err instanceof Error ? err.message : String(err)}`
    return null
  }
}

async function createOrEnterSession(): Promise<void> {
  if (!newReqId.value || !newReqTitle.value) return
  errMsg.value = null

  // 提交前主动 ping 评审中心，避免在 fetch 阶段抛 WKWebView 的 TypeError("Type error")
  await store.refreshReviewServerHealth()
  if (!store.reviewServer.healthy) {
    errMsg.value = `评审中心服务未连通：${store.reviewServer.error ?? `请检查 ${store.baseUrl} 是否运行`}`
    return
  }

  const selectedRepos = reposStore.repos.filter(r => selectedRepoIds.value.includes(r.id))
  if (selectedRepos.length === 0) {
    errMsg.value = '请至少选择一个关联仓库'
    return
  }
  localStorage.setItem('review.selectedRepoIds', JSON.stringify(selectedRepoIds.value))

  const docInfo = await ensureFeishuSpecDoc(newReqTitle.value)
  if (!docInfo) return
  try {
    if (!store.lark?.identity) {
      errMsg.value = 'lark-cli 身份缺失，请先在顶部 GateBanner 点击"重新检测"'
      return
    }
    const identity = {
      userId: store.lark.identity.userId,
      userName: store.lark.identity.userName,
      role: store.role,
    }
    const data = await rpc<{ session: SessionDto, reused: boolean }>('review.createSession', {
      baseUrl: store.baseUrl,
      identity,
      input: {
        requirementId: newReqId.value,
        requirementTitle: newReqTitle.value,
        feishuRequirementUrl: newReqUrl.value || undefined,
        feishuSpecDocToken: docInfo.token,
        feishuSpecDocUrl: docInfo.url,
        initialSpecMarkdown: `# 开发 Spec - ${newReqTitle.value}\n\n（评审中…）`,
        relatedRepos: selectedRepos.map(r => r.local_path),
      },
    })
    await joinSession(data.session.id)
    await loadSessions()
  }
  catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err)
  }
}

async function joinSession(sessionId: string): Promise<void> {
  if (!store.lark?.identity) return
  await reconnectWs()
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (store.wsConnected) { clearInterval(timer); resolve() }
    }, 50)
    setTimeout(() => { clearInterval(timer); resolve() }, 3000)
  })
  ws.send({ type: 'join', sessionId })
}

async function generateDevSpec(): Promise<void> {
  if (!store.session) return
  if (!isHost()) {
    errMsg.value = '仅会话主持人（host）可以生成开发 Spec'
    return
  }
  generating.value = true
  errMsg.value = null
  try {
    const repos = store.session.relatedRepos.map(p => ({ path: p }))
    const res = await rpc<{ content: string, error?: string }>('review.generateDevSpec', {
      sessionId: store.session.id,
      requirementTitle: store.session.requirementTitle,
      requirementMarkdown: requirementMarkdown.value || `（产品 spec 由参与者口头同步）\n\n标题：${store.session.requirementTitle}`,
      relatedRepos: repos,
      existingSpec: store.specContent,
      reviewServerBaseUrl: store.baseUrl,
      identity: store.lark?.identity
        ? { userId: store.lark.identity.userId, userName: store.lark.identity.userName, role: store.role }
        : undefined,
    })
    if (res.error) errMsg.value = res.error
  }
  catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    generating.value = false
  }
}

function startEdit(): void {
  draftSpec.value = store.specContent
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
  draftSpec.value = ''
}

function commitSpec(): void {
  if (!store.session) return
  ws.send({
    type: 'spec.patch',
    sessionId: store.session.id,
    baseVersion: store.specVersion,
    content: draftSpec.value,
  })
  editing.value = false
}

function addClarification(): void {
  if (!store.session || !newClarification.value.trim()) return
  ws.send({
    type: 'clarify.add',
    sessionId: store.session.id,
    content: newClarification.value.trim(),
  })
  newClarification.value = ''
}

async function confirmAndEvaluate(): Promise<void> {
  if (!store.session) return
  if (!isHost()) {
    errMsg.value = '仅会话主持人可触发评估并写回飞书项目'
    return
  }
  evaluating.value = true
  errMsg.value = null
  localStorage.setItem('review.projectKey', projectKey.value)
  if (fieldKeyFE.value) localStorage.setItem('review.fieldKey.frontend', fieldKeyFE.value)
  if (fieldKeyBE.value) localStorage.setItem('review.fieldKey.backend', fieldKeyBE.value)
  if (fieldKeyQA.value) localStorage.setItem('review.fieldKey.qa', fieldKeyQA.value)
  if (writebackTool.value) localStorage.setItem('review.writebackTool', writebackTool.value)
  try {
    const fields = [
      fieldKeyFE.value ? { fieldKey: fieldKeyFE.value, role: 'frontend' as const } : null,
      fieldKeyBE.value ? { fieldKey: fieldKeyBE.value, role: 'backend' as const } : null,
      fieldKeyQA.value ? { fieldKey: fieldKeyQA.value, role: 'qa' as const } : null,
    ].filter((f): f is { fieldKey: string, role: 'frontend' | 'backend' | 'qa' } => f !== null)

    const writebackPlan = fields.length > 0 && writebackTool.value
      ? { tool: writebackTool.value, requirementId: store.session.requirementId, fields }
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
    if (res.warnings?.length) errMsg.value = `部分步骤有告警：\n${res.warnings.join('\n')}`
  }
  catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    evaluating.value = false
  }
}

/** 把形如 storyView / IssueView 的路径段还原为 workItemType key（story / Issue）。 */
function stripViewSuffix(seg: string): string {
  return seg.replace(/View$/i, '')
}

/**
 * 解析飞书项目视图链接，尽量宽松，已知格式：
 *  主格式（飞书现行）: https://project.feishu.cn/<projectKey>/<workItemTypeKey>View/<viewId>?...
 *  兼容格式 1:        https://project.feishu.cn/<projectKey>/<workItemTypeKey>/view/<viewId>
 *  兼容格式 2:        https://project.feishu.cn/<projectKey>/view/<viewId>?type=<workItemTypeKey>
 * 解析不出的字段保持原值，由用户手填修正。
 */
function parseViewUrl(raw: string): void {
  if (!raw) return
  try {
    const u = new URL(raw.trim())
    const segs = u.pathname.split('/').filter(Boolean)

    // 主格式：第二段以 View 结尾
    if (segs.length >= 3 && /View$/i.test(segs[1])) {
      viewProjectKey.value = segs[0]
      viewWorkItemType.value = stripViewSuffix(segs[1])
      viewId.value = segs[2]
    } else {
      // 兼容格式 1 / 2：路径中包含独立的 'view' 段
      const viewIdx = segs.indexOf('view')
      if (viewIdx >= 1 && segs[viewIdx + 1]) {
        viewId.value = segs[viewIdx + 1]
        viewProjectKey.value = segs[0]
        if (viewIdx >= 2) viewWorkItemType.value = stripViewSuffix(segs[1])
      }
    }

    // query 兜底覆盖
    const typeFromQuery = u.searchParams.get('type')
    if (typeFromQuery) viewWorkItemType.value = stripViewSuffix(typeFromQuery)
  } catch {
    // ignore: 用户可继续手填
  }
}

async function fetchViewItems(reset = true): Promise<void> {
  // 用户可能手填带 View 后缀（storyView/issueView），统一规整再发 RPC
  const normalizedType = stripViewSuffix(viewWorkItemType.value.trim())
  if (normalizedType !== viewWorkItemType.value) viewWorkItemType.value = normalizedType

  if (!viewProjectKey.value || !normalizedType || !viewId.value) {
    viewError.value = '请先填写或粘贴视图链接，确保 projectKey / workItemType / viewId 三项齐全'
    return
  }
  viewLoading.value = true
  viewError.value = null
  viewDebug.value = null
  if (reset) { viewPageNum.value = 1; viewItems.value = [] }
  localStorage.setItem('review.viewUrl', viewUrl.value)
  localStorage.setItem('review.viewProjectKey', viewProjectKey.value)
  localStorage.setItem('review.viewWorkItemType', normalizedType)
  localStorage.setItem('review.viewId', viewId.value)
  try {
    const res = await rpc<{
      items: ViewWorkItem[]
      pageNum: number
      pageSize: number
      toolName?: string
      debug?: { availableTools?: string[], rawSnippet?: string | null }
    }>('review.listViewWorkItems', {
      projectKey: viewProjectKey.value,
      workItemType: normalizedType,
      viewId: viewId.value,
      pageNum: viewPageNum.value,
      pageSize: viewPageSize,
    })
    if (!res) {
      viewError.value = 'Sidecar 未连接（res=undefined）。如果当前是浏览器开发模式，请改用 tauri dev 启动。'
      return
    }
    const items = Array.isArray(res.items) ? res.items : []
    viewItems.value = reset ? items : viewItems.value.concat(items)
    viewHasMore.value = items.length >= viewPageSize
    if (items.length === 0 && (res.toolName || res.debug)) {
      viewDebug.value = {
        toolName: res.toolName,
        availableTools: res.debug?.availableTools,
        rawSnippet: res.debug?.rawSnippet ?? null,
      }
    }
  } catch (err) {
    viewError.value = err instanceof Error ? err.message : String(err)
    viewHasMore.value = false
  } finally {
    viewLoading.value = false
  }
}

async function loadMoreViewItems(): Promise<void> {
  if (viewLoading.value || !viewHasMore.value) return
  viewPageNum.value += 1
  await fetchViewItems(false)
}

function pickViewItem(item: ViewWorkItem): void {
  newReqId.value = item.id
  newReqTitle.value = item.title ?? ''
  newReqUrl.value = item.sourceUrl
  formSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

onMounted(async () => {
  await store.refreshAll()
  if (!store.blocking.blocked) {
    if (reposStore.repos.length === 0) await reposStore.fetchAll()
    await loadSessions()
    await reconnectWs()
  }
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
        <h1 class="text-lg font-semibold tracking-tight">迭代评审</h1>
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

      <template v-else>
        <section class="px-4 py-4 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 space-y-2">
          <div class="flex items-center justify-between mb-1">
            <div class="text-[13px] font-semibold text-gray-700 dark:text-gray-200">按飞书视图拉取需求</div>
            <button
              v-if="viewItems.length > 0"
              class="text-[11px] text-gray-500 hover:underline"
              @click="viewItems = []"
            >
              清空列表
            </button>
          </div>
          <div class="grid grid-cols-[1fr_auto] gap-2">
            <input
              v-model="viewUrl"
              class="px-2 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
              placeholder="粘贴飞书视图链接，例：https://project.feishu.cn/wuhan/storyView/yZHfUfyHR"
              @blur="parseViewUrl(viewUrl)"
            >
            <button
              class="px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
              :disabled="!viewUrl"
              @click="parseViewUrl(viewUrl)"
            >
              解析
            </button>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <input v-model="viewProjectKey" class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="projectKey">
            <input v-model="viewWorkItemType" class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="workItemType（如 story）">
            <input v-model="viewId" class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="viewId">
          </div>
          <div class="flex items-center justify-between">
            <div class="text-[11px] text-gray-500">
              点击列表中的某一行，将自动填入下方「开启评审」表单。
            </div>
            <button
              class="px-3 py-1.5 text-[13px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
              :disabled="viewLoading || !viewProjectKey || !viewWorkItemType || !viewId"
              @click="fetchViewItems(true)"
            >
              {{ viewLoading ? '拉取中…' : '拉取视图需求' }}
            </button>
          </div>

          <div v-if="viewError" class="text-[12px] text-rose-600 whitespace-pre-wrap">
            {{ viewError }}
            <span v-if="/未配置.*MCP|feishu-project|未启用/i.test(viewError)">
              · <router-link to="/mcp" class="text-indigo-500 hover:underline">前往 MCP 配置</router-link>
            </span>
          </div>

          <ul v-if="viewItems.length > 0" class="space-y-1.5 max-h-[320px] overflow-y-auto pr-1 mt-1">
            <li
              v-for="item in viewItems"
              :key="item.id"
              class="flex items-center justify-between gap-3 p-2 rounded-md border border-gray-100 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
              @click="pickViewItem(item)"
            >
              <div class="min-w-0 flex-1">
                <div class="text-[13px] truncate">{{ item.title || `(无标题 #${item.id})` }}</div>
                <div class="text-[11px] text-gray-500 truncate">
                  #{{ item.id }}
                  <span v-if="item.statusLabel"> · {{ item.statusLabel }}</span>
                  <span v-if="item.ownerNames.length"> · {{ item.ownerNames.join('、') }}</span>
                </div>
              </div>
              <span class="text-[11px] text-indigo-500 shrink-0">填入表单 →</span>
            </li>
          </ul>
          <div v-else-if="!viewLoading && !viewError" class="text-[12px] text-gray-400 mt-1">
            暂无数据，填入视图三要素后点击「拉取视图需求」。
          </div>

          <details
            v-if="viewDebug && viewItems.length === 0 && !viewError"
            class="mt-1 text-[11px] text-gray-500 border border-amber-200 dark:border-amber-700/40 rounded-md p-2 bg-amber-50/40 dark:bg-amber-900/10"
          >
            <summary class="cursor-pointer text-amber-700 dark:text-amber-300">
              MCP 调用成功但解析不出条目（点击查看诊断信息）
            </summary>
            <div class="mt-2 space-y-1">
              <div>实际调用工具：<code>{{ viewDebug.toolName ?? '(unknown)' }}</code></div>
              <div v-if="viewDebug.availableTools?.length">
                可用工具：<code class="break-all">{{ viewDebug.availableTools.join(', ') }}</code>
              </div>
              <div v-if="viewDebug.rawSnippet">
                原始响应（前 800 字符）：
                <pre class="mt-1 p-2 rounded bg-white/60 dark:bg-black/30 whitespace-pre-wrap break-all font-mono text-[11px]">{{ viewDebug.rawSnippet }}</pre>
              </div>
              <div v-else class="text-rose-500">
                工具返回的 content 为空或无 text。请确认 view_id 是否正确，或在飞书项目内打开该视图能看到工作项。
              </div>
            </div>
          </details>

          <div v-if="viewHasMore" class="flex justify-center">
            <button
              class="text-[12px] text-indigo-500 hover:underline disabled:opacity-50"
              :disabled="viewLoading"
              @click="loadMoreViewItems"
            >
              加载下一页
            </button>
          </div>
        </section>

        <section
          ref="formSectionRef"
          class="px-4 py-4 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 space-y-2"
        >
          <div class="text-[13px] font-semibold text-gray-700 dark:text-gray-200 mb-2">开启评审</div>
          <div class="grid grid-cols-2 gap-2">
            <input v-model="newReqId" class="px-2 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="飞书工作项 ID（必填）">
            <input v-model="newReqTitle" class="px-2 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="需求标题（必填）">
          </div>
          <input v-model="newReqUrl" class="w-full px-2 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="需求飞书链接（可选）">

          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <div class="text-[12px] text-gray-500">关联仓库（多选，从「仓库」页配置）</div>
              <button
                class="text-[11px] text-indigo-500 hover:underline disabled:opacity-50"
                :disabled="reposStore.loading"
                @click="reposStore.fetchAll()"
              >
                {{ reposStore.loading ? '加载中…' : '刷新' }}
              </button>
            </div>
            <div v-if="reposStore.loading && reposStore.repos.length === 0" class="text-[12px] text-gray-400">加载中…</div>
            <div v-else-if="reposStore.repos.length === 0" class="text-[12px] text-rose-500">
              尚未配置仓库，请先到 <router-link to="/repos" class="text-indigo-500 hover:underline">仓库</router-link> 页添加。
            </div>
            <ul v-else class="grid grid-cols-2 gap-1 max-h-[160px] overflow-y-auto pr-1">
              <li
                v-for="r in reposStore.repos"
                :key="r.id"
                class="flex items-start gap-2 px-2 py-1 rounded-md border border-gray-100 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
              >
                <input
                  :id="`repo-${r.id}`"
                  type="checkbox"
                  class="mt-0.5"
                  :checked="selectedRepoIds.includes(r.id)"
                  @change="toggleRepo(r.id)"
                >
                <label :for="`repo-${r.id}`" class="min-w-0 flex-1 cursor-pointer">
                  <div class="text-[13px] truncate">{{ r.alias || r.name }}</div>
                  <div class="text-[11px] text-gray-500 truncate" :title="r.local_path">{{ r.local_path }}</div>
                </label>
              </li>
            </ul>
          </div>

          <div class="flex justify-end">
            <button
              class="px-3 py-1.5 text-[13px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
              :disabled="!newReqId || !newReqTitle || selectedRepoIds.length === 0 || store.blocking.blocked"
              @click="createOrEnterSession"
            >
              创建 / 进入评审会话
            </button>
          </div>
        </section>

        <section v-if="!store.session" class="px-4 py-4 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
          <div class="flex items-center justify-between mb-2">
            <div class="text-[13px] font-semibold text-gray-700 dark:text-gray-200">已有会话</div>
            <button class="text-[12px] text-indigo-500 hover:underline" @click="loadSessions">刷新</button>
          </div>
          <div v-if="sessionsLoading" class="text-[12px] text-gray-500">加载中…</div>
          <div v-else-if="sessions.length === 0" class="text-[12px] text-gray-500">暂无会话</div>
          <ul v-else class="space-y-1.5">
            <li
              v-for="s in sessions"
              :key="s.id"
              class="flex items-center justify-between p-2 rounded-md border border-gray-100 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
              @click="joinSession(s.id)"
            >
              <div class="flex items-center gap-2">
                <span class="text-[12px] text-gray-500">[{{ s.status }}]</span>
                <span class="text-[13px]">{{ s.requirementTitle }}</span>
              </div>
              <span class="text-[11px] text-gray-400">{{ s.hostUserName }} · {{ s.createdAt.slice(0, 16) }}</span>
            </li>
          </ul>
        </section>

        <section v-if="store.session" class="grid grid-cols-3 gap-4">
          <div class="col-span-2 space-y-3">
            <div class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
              <div class="flex items-center justify-between mb-2">
                <div>
                  <div class="text-[13px] font-semibold">{{ store.session.requirementTitle }}</div>
                  <div class="text-[11px] text-gray-400">v{{ store.specVersion }} · 状态 {{ store.session.status }}</div>
                </div>
                <div class="flex gap-2">
                  <a
                    v-if="store.session.feishuSpecDocUrl"
                    :href="store.session.feishuSpecDocUrl"
                    target="_blank"
                    class="text-[12px] text-indigo-500 hover:underline"
                  >飞书文档 ↗</a>
                  <button v-if="!editing" class="text-[12px] text-gray-600 hover:text-indigo-500" @click="startEdit">编辑</button>
                </div>
              </div>

              <textarea
                v-if="editing"
                v-model="draftSpec"
                rows="20"
                class="w-full font-mono text-[12px] px-2 py-2 rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
              />
              <div v-else class="prose prose-sm max-w-none whitespace-pre-wrap text-[13px] leading-relaxed font-mono text-gray-700 dark:text-gray-200">
                {{ store.specContent || '(Spec 尚未生成)' }}
              </div>

              <div v-if="editing" class="flex gap-2 mt-2 justify-end">
                <button class="px-3 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10" @click="cancelEdit">取消</button>
                <button class="px-3 py-1.5 text-[12px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600" @click="commitSpec">提交修改</button>
              </div>
            </div>

            <div class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 space-y-2">
              <div class="text-[13px] font-semibold mb-1">主持人操作</div>
              <textarea
                v-model="requirementMarkdown"
                rows="3"
                class="w-full px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent font-mono"
                placeholder="（可选）粘贴需求 markdown 作为生成 Spec 的输入"
              />
              <div class="flex gap-2 flex-wrap">
                <button
                  class="px-3 py-1.5 text-[12px] rounded-md bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
                  :disabled="generating"
                  @click="generateDevSpec"
                >
                  {{ generating ? '生成中…' : '基于代码生成开发 Spec' }}
                </button>
              </div>

              <div class="grid grid-cols-2 gap-2 mt-2">
                <input v-model="projectKey" class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="飞书项目 projectKey">
                <input v-model="writebackTool" class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="MCP 回写 tool 名（默认 update_field）">
                <input v-model="fieldKeyFE" class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="前端故事点 field_key">
                <input v-model="fieldKeyBE" class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="后端故事点 field_key">
                <input v-model="fieldKeyQA" class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent" placeholder="测试故事点 field_key">
              </div>
              <div class="flex gap-2 justify-end">
                <button
                  class="px-3 py-1.5 text-[12px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
                  :disabled="evaluating"
                  @click="confirmAndEvaluate"
                >
                  {{ evaluating ? '评估中…' : '确认 Spec & 评估故事点' }}
                </button>
              </div>

              <div v-if="store.assessments.length" class="mt-2 grid grid-cols-3 gap-2">
                <div v-for="a in store.assessments" :key="a.role" class="px-3 py-2 rounded-md bg-gray-50 dark:bg-white/5">
                  <div class="text-[11px] text-gray-500">
                    {{ a.role === 'frontend' ? '前端' : a.role === 'backend' ? '后端' : '测试' }}
                  </div>
                  <div class="text-base font-semibold">{{ a.points }} 点</div>
                  <div class="text-[11px] text-gray-500 line-clamp-2" :title="a.rationale">{{ a.rationale }}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="space-y-3">
            <div class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
              <div class="text-[13px] font-semibold mb-2">在线参与者</div>
              <ul class="space-y-1">
                <li v-for="p in store.participants" :key="p.userId" class="flex items-center justify-between text-[12px]">
                  <span>{{ p.userName }}</span>
                  <span class="text-gray-400">{{ p.role }}</span>
                </li>
                <li v-if="!store.participants.length" class="text-[12px] text-gray-400">暂无</li>
              </ul>
            </div>

            <div class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
              <div class="text-[13px] font-semibold mb-2">澄清记录</div>
              <ul class="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                <li v-for="c in store.clarifications" :key="c.id" class="border-l-2 border-indigo-200 dark:border-indigo-700 pl-2">
                  <div class="text-[11px] text-gray-500">{{ c.userName }} · {{ c.createdAt.slice(11, 16) }}</div>
                  <div class="text-[12px] whitespace-pre-wrap">{{ c.content }}</div>
                </li>
                <li v-if="!store.clarifications.length" class="text-[12px] text-gray-400">暂无澄清</li>
              </ul>
              <div class="mt-2 flex gap-1">
                <input
                  v-model="newClarification"
                  class="flex-1 px-2 py-1 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
                  placeholder="提一个澄清问题…"
                  @keyup.enter="addClarification"
                >
                <button
                  class="px-2 py-1 text-[12px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600"
                  @click="addClarification"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        </section>

        <div v-if="errMsg" class="text-[12px] text-rose-600 whitespace-pre-wrap">{{ errMsg }}</div>
      </template>
    </div>
  </div>
</template>
