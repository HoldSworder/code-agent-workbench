<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useReviewStore, type SessionDto } from '../../stores/review'
import { useReposStore } from '../../stores/repos'
import { rpc } from '../../composables/use-sidecar'
import GateBanner from '../../components/review/GateBanner.vue'

interface ViewWorkItem {
  id: string
  title: string | null
  statusLabel: string | null
  ownerNames: string[]
  sourceUrl: string
}

const router = useRouter()
const store = useReviewStore()
const reposStore = useReposStore()

const viewUrl = ref(localStorage.getItem('review.viewUrl') ?? '')
const viewProjectKey = ref(localStorage.getItem('review.viewProjectKey') ?? '')
const viewWorkItemType = ref(localStorage.getItem('review.viewWorkItemType') ?? 'story')
const viewId = ref(localStorage.getItem('review.viewId') ?? '')
const viewItems = ref<ViewWorkItem[]>([])
const viewLoading = ref(false)
const viewError = ref<string | null>(null)
const viewPageNum = ref(1)
const viewHasMore = ref(false)
const viewDebug = ref<{ toolName?: string, rawSnippet?: string | null } | null>(null)

const selectedRepoIds = ref<string[]>(loadSelectedRepoIds())

const sessions = ref<SessionDto[]>([])
const sessionsLoading = ref(false)
const errMsg = ref<string | null>(null)

function loadSelectedRepoIds(): string[] {
  try {
    const raw = localStorage.getItem('review.selectedRepoIds')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  }
  catch { return [] }
}

function persistSelectedRepoIds(): void {
  localStorage.setItem('review.selectedRepoIds', JSON.stringify(selectedRepoIds.value))
}

function toggleRepo(id: string): void {
  const idx = selectedRepoIds.value.indexOf(id)
  if (idx >= 0) selectedRepoIds.value.splice(idx, 1)
  else selectedRepoIds.value.push(id)
  persistSelectedRepoIds()
}

function stripViewSuffix(seg: string): string {
  return seg.replace(/View$/i, '')
}

/**
 * 解析飞书项目视图链接，宽松匹配多种历史 / 现行格式。
 * 与原 ReviewView.vue 行为保持一致，避免破坏用户已配置的 localStorage。
 */
function parseViewUrl(raw: string): void {
  if (!raw) return
  try {
    const u = new URL(raw.trim())
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length >= 3 && /View$/i.test(segs[1])) {
      viewProjectKey.value = segs[0]
      viewWorkItemType.value = stripViewSuffix(segs[1])
      viewId.value = segs[2]
    }
    else {
      const viewIdx = segs.indexOf('view')
      if (viewIdx >= 1 && segs[viewIdx + 1]) {
        viewId.value = segs[viewIdx + 1]
        viewProjectKey.value = segs[0]
        if (viewIdx >= 2) viewWorkItemType.value = stripViewSuffix(segs[1])
      }
    }
    const typeFromQuery = u.searchParams.get('type')
    if (typeFromQuery) viewWorkItemType.value = stripViewSuffix(typeFromQuery)
  }
  catch { /* ignore */ }
}

async function fetchViewItems(reset = true): Promise<void> {
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
      hasMore: boolean
      total: number | null
      rawSnippet: string | null
    }>('feishuProject.listViewItems', {
      projectKey: viewProjectKey.value,
      workItemType: normalizedType,
      viewId: viewId.value,
      pageNum: viewPageNum.value,
    })
    if (!res) {
      viewError.value = 'Sidecar 未连接（res=undefined）。如果当前是浏览器开发模式，请改用 tauri dev 启动。'
      return
    }
    const items = Array.isArray(res.items) ? res.items : []
    viewItems.value = reset ? items : viewItems.value.concat(items)
    viewHasMore.value = !!res.hasMore
    if (items.length === 0 && res.rawSnippet) {
      viewDebug.value = {
        toolName: 'meegle view get',
        rawSnippet: res.rawSnippet,
      }
    }
  }
  catch (err) {
    viewError.value = err instanceof Error ? err.message : String(err)
    viewHasMore.value = false
  }
  finally {
    viewLoading.value = false
  }
}

async function loadMoreViewItems(): Promise<void> {
  if (viewLoading.value || !viewHasMore.value) return
  viewPageNum.value += 1
  await fetchViewItems(false)
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

/** 路由跳转：点击工作项时通过 bridge 创建/复用 session 后跳详情。 */
async function pickViewItem(item: ViewWorkItem): Promise<void> {
  errMsg.value = null
  await store.refreshReviewServerHealth()
  if (!store.reviewServer.healthy) {
    errMsg.value = `评审中心服务未连通：${store.reviewServer.error ?? `请检查 ${store.baseUrl} 是否运行`}`
    return
  }
  if (selectedRepoIds.value.length === 0) {
    errMsg.value = '请先在下方勾选至少一个关联仓库再点击工作项'
    return
  }
  persistSelectedRepoIds()
  const repoPaths = reposStore.repos
    .filter(r => selectedRepoIds.value.includes(r.id))
    .map(r => r.local_path)
    .join('|')
  await router.push({
    path: '/review/workitem/new',
    query: {
      workItemId: item.id,
      title: item.title ?? '',
      url: item.sourceUrl,
      repos: repoPaths,
    },
  })
}

function openSession(sessionId: string): void {
  void router.push({ path: `/review/session/${sessionId}` })
}

onMounted(async () => {
  await store.refreshAll()
  if (!store.blocking.blocked) {
    if (reposStore.repos.length === 0) await reposStore.fetchAll()
    await loadSessions()
  }
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
              点击列表中的某一行，会创建/复用评审会话，然后进入详情页。
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
            <span v-if="/meegle|未登录|未安装/i.test(viewError)">
              · 请在终端执行 <code class="px-1 bg-gray-100 dark:bg-white/10 rounded">meegle auth login --host project.feishu.cn</code>
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
              <span class="text-[11px] text-indigo-500 shrink-0">进入评审 →</span>
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
              meegle CLI 调用成功但解析不出条目（点击查看诊断信息）
            </summary>
            <div class="mt-2 space-y-1">
              <div>实际调用：<code>{{ viewDebug.toolName ?? 'meegle view get' }}</code></div>
              <div v-if="viewDebug.rawSnippet">
                原始响应（前 800 字符）：
                <pre class="mt-1 p-2 rounded bg-white/60 dark:bg-black/30 whitespace-pre-wrap break-all font-mono text-[11px]">{{ viewDebug.rawSnippet }}</pre>
              </div>
              <div v-else class="text-rose-500">
                meegle 返回为空。请确认 view_id 是否正确，或在飞书项目内打开该视图能看到工作项。
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

        <section class="px-4 py-4 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 space-y-1.5">
          <div class="flex items-center justify-between">
            <div class="text-[13px] font-semibold text-gray-700 dark:text-gray-200">关联仓库（多选，从「仓库」页配置）</div>
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
          <ul v-else class="grid grid-cols-2 gap-1 max-h-[200px] overflow-y-auto pr-1">
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
        </section>

        <section class="px-4 py-4 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
          <div class="flex items-center justify-between mb-2">
            <div class="text-[13px] font-semibold text-gray-700 dark:text-gray-200">已有评审会话</div>
            <button class="text-[12px] text-indigo-500 hover:underline" @click="loadSessions">刷新</button>
          </div>
          <div v-if="sessionsLoading" class="text-[12px] text-gray-500">加载中…</div>
          <div v-else-if="sessions.length === 0" class="text-[12px] text-gray-500">暂无会话</div>
          <ul v-else class="space-y-1.5">
            <li
              v-for="s in sessions"
              :key="s.id"
              class="flex items-center justify-between p-2 rounded-md border border-gray-100 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
              @click="openSession(s.id)"
            >
              <div class="flex items-center gap-2">
                <span class="text-[12px] text-gray-500">[{{ s.status }}]</span>
                <span class="text-[13px]">{{ s.requirementTitle }}</span>
              </div>
              <span class="text-[11px] text-gray-400">{{ s.hostUserName }} · {{ s.createdAt.slice(0, 16) }}</span>
            </li>
          </ul>
        </section>

        <div v-if="errMsg" class="text-[12px] text-rose-600 whitespace-pre-wrap">{{ errMsg }}</div>
      </template>
    </div>
  </div>
</template>
