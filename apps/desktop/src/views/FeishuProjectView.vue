<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { rpc } from '../composables/use-sidecar'
import { useRequirementsStore, type Requirement } from '../stores/requirements'

interface ViewWorkItem {
  id: string
  title: string | null
  statusLabel: string | null
  ownerNames: string[]
  sourceUrl: string
}

interface AuthState {
  installed: boolean
  authenticated: boolean
  host: string | null
  expiresInMinutes: number | null
  error: string | null
}

interface ListResp {
  items: ViewWorkItem[]
  pageNum: number
  hasMore: boolean
  total: number | null
  rawSnippet: string | null
}

const STORAGE_KEY_URL = 'feishuProject.viewUrl'
const STORAGE_KEY_PROJECT = 'feishuProject.projectKey'
const STORAGE_KEY_TYPE = 'feishuProject.workItemType'
const STORAGE_KEY_VIEW = 'feishuProject.viewId'

const MAX_PAGES = 20

// ── 节点流分组：按视图返回的真实「当前节点名」分组（meegle 节点流模式下，
// work_item_status.name 就是当前节点）。
//
// 列序策略：
// - 通用节点流模板按工作流推进方向硬编码，命中模板的节点严格按模板序排列；
// - 未在模板中的真实节点（项目自定义）按"首次出现顺序"追加到末尾；
// - 节点名为空 / null 的归到「未知节点」列，并置于最末。
//
// 颜色策略：按列在最终顺序中的位置取一份调色板，越靠左越偏灰色 / 待办，
// 越靠右越偏绿色 / 完成，无需为每个节点名单独维护颜色映射。

const NODE_ORDER_TEMPLATE: string[] = [
  '待确认需求',
  '需求池',
  '待需求评审',
  '待计划',
  'Sprint计划',
  '开发中',
  '联调',
  '待提测',
  '提测中',
  '待测试',
  '测试中',
  '待产品验收',
  '待验收',
  '待发布',
  '待上线',
  '灰度',
  '已上线',
  '已完成',
  '已关闭',
]

interface NodePalette {
  dot: string
  badgeClass: string
}

// 索引越靠后（越接近完成）越绿；用于按 (position / totalCols) 在调色板里取色。
const NODE_PALETTE: NodePalette[] = [
  { dot: 'bg-gray-400', badgeClass: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
  { dot: 'bg-slate-500', badgeClass: 'bg-slate-50 text-slate-600 dark:bg-slate-500/10 dark:text-slate-400' },
  { dot: 'bg-blue-500', badgeClass: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' },
  { dot: 'bg-indigo-500', badgeClass: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400' },
  { dot: 'bg-violet-500', badgeClass: 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400' },
  { dot: 'bg-fuchsia-500', badgeClass: 'bg-fuchsia-50 text-fuchsia-600 dark:bg-fuchsia-500/10 dark:text-fuchsia-400' },
  { dot: 'bg-amber-500', badgeClass: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400' },
  { dot: 'bg-orange-500', badgeClass: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400' },
  { dot: 'bg-teal-500', badgeClass: 'bg-teal-50 text-teal-600 dark:bg-teal-500/10 dark:text-teal-400' },
  { dot: 'bg-emerald-500', badgeClass: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400' },
]

const UNKNOWN_NODE_KEY = '__unknown__'

function pickPalette(positionRatio: number): NodePalette {
  const idx = Math.min(NODE_PALETTE.length - 1, Math.max(0, Math.floor(positionRatio * NODE_PALETTE.length)))
  return NODE_PALETTE[idx]
}

// ── 状态 ──
const auth = ref<AuthState | null>(null)
const authChecking = ref(false)

const viewUrl = ref(localStorage.getItem(STORAGE_KEY_URL) ?? '')
const projectKey = ref(localStorage.getItem(STORAGE_KEY_PROJECT) ?? '')
const workItemType = ref(localStorage.getItem(STORAGE_KEY_TYPE) ?? 'story')
const viewId = ref(localStorage.getItem(STORAGE_KEY_VIEW) ?? '')

const items = ref<ViewWorkItem[]>([])
const loading = ref(false)
const loadingProgress = ref<{ loaded: number, total: number | null } | null>(null)
const errMsg = ref<string | null>(null)
const total = ref<number | null>(null)
const rawSnippet = ref<string | null>(null)

const showConfigModal = ref(false)
const configDraft = ref({ url: '', projectKey: '', workItemType: '', viewId: '' })

const searchQuery = ref('')

const filteredItems = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter(it => (it.title ?? '').toLowerCase().includes(q))
})

const authReady = computed(() => auth.value?.installed === true && auth.value?.authenticated === true)

const configReady = computed(() => !!projectKey.value && !!workItemType.value && !!viewId.value)

const groupedItems = computed(() => {
  // 1) 桶：node 名 → items
  const buckets = new Map<string, ViewWorkItem[]>()
  // 2) 记录非模板节点的"首次出现顺序"
  const customOrder: string[] = []

  for (const it of filteredItems.value) {
    const node = it.statusLabel?.trim()
    const key = node || UNKNOWN_NODE_KEY
    if (!buckets.has(key)) {
      buckets.set(key, [])
      if (node && !NODE_ORDER_TEMPLATE.includes(node)) customOrder.push(node)
    }
    buckets.get(key)!.push(it)
  }

  // 3) 排序：模板序内已命中的节点 → 自定义节点（首次出现序）→ 未知节点列
  const orderedKeys: string[] = []
  for (const tplNode of NODE_ORDER_TEMPLATE) {
    if (buckets.has(tplNode)) orderedKeys.push(tplNode)
  }
  for (const customNode of customOrder) orderedKeys.push(customNode)
  if (buckets.has(UNKNOWN_NODE_KEY)) orderedKeys.push(UNKNOWN_NODE_KEY)

  // 4) 给每列分配调色板（按位置比例），列 key 就是节点名本身
  const total = orderedKeys.length
  return orderedKeys.map((key, idx) => {
    const ratio = total <= 1 ? 0 : idx / (total - 1)
    const palette = pickPalette(ratio)
    return {
      key,
      label: key === UNKNOWN_NODE_KEY ? '未知节点' : key,
      dot: palette.dot,
      badgeClass: palette.badgeClass,
      items: buckets.get(key) ?? [],
    }
  })
})

// ── 视图链接解析 ──
function stripViewSuffix(seg: string): string {
  return seg.replace(/View$/i, '')
}

function parseViewUrlInto(raw: string, target: { url: string, projectKey: string, workItemType: string, viewId: string }): void {
  if (!raw) return
  target.url = raw
  try {
    const u = new URL(raw.trim())
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length >= 3 && /View$/i.test(segs[1])) {
      target.projectKey = segs[0]
      target.workItemType = stripViewSuffix(segs[1])
      target.viewId = segs[2]
    }
    else {
      const viewIdx = segs.indexOf('view')
      if (viewIdx >= 1 && segs[viewIdx + 1]) {
        target.viewId = segs[viewIdx + 1]
        target.projectKey = segs[0]
        if (viewIdx >= 2) target.workItemType = stripViewSuffix(segs[1])
      }
    }
    const typeFromQuery = u.searchParams.get('type')
    if (typeFromQuery) target.workItemType = stripViewSuffix(typeFromQuery)
  }
  catch { /* ignore */ }
}

// ── auth ──
async function refreshAuth(): Promise<void> {
  authChecking.value = true
  try {
    auth.value = await rpc<AuthState>('feishuProject.checkAuth')
  }
  catch (err) {
    auth.value = {
      installed: false,
      authenticated: false,
      host: null,
      expiresInMinutes: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  finally {
    authChecking.value = false
  }
}

// ── 全量加载（自动翻页） ──
async function fetchAll(): Promise<void> {
  if (!authReady.value) {
    errMsg.value = '请先完成 meegle-cli 安装与登录'
    return
  }
  const normalizedType = stripViewSuffix(workItemType.value.trim())
  if (normalizedType !== workItemType.value) workItemType.value = normalizedType
  if (!projectKey.value || !normalizedType || !viewId.value) {
    errMsg.value = '请先点击右上「视图配置」填写视图信息'
    return
  }
  loading.value = true
  errMsg.value = null
  rawSnippet.value = null
  loadingProgress.value = { loaded: 0, total: null }
  const collected: ViewWorkItem[] = []
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await rpc<ListResp>('feishuProject.listViewItems', {
        projectKey: projectKey.value,
        workItemType: normalizedType,
        viewId: viewId.value,
        pageNum: page,
      })
      if (!res) {
        errMsg.value = 'Sidecar 未连接（res=undefined）。如果当前是浏览器开发模式，请改用 tauri dev 启动。'
        return
      }
      collected.push(...(res.items ?? []))
      loadingProgress.value = { loaded: collected.length, total: res.total }
      total.value = res.total
      // 实时显示已加载的页，提升交互感
      items.value = collected.slice()
      if (page === 1 && collected.length === 0) {
        rawSnippet.value = res.rawSnippet
      }
      if (!res.hasMore || (res.items ?? []).length === 0) break
    }
    items.value = collected
  }
  catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
    loadingProgress.value = null
  }
}

function openItem(item: ViewWorkItem): void {
  if (item.sourceUrl) window.open(item.sourceUrl, '_blank')
}

// ── 推进到需求看板 ──
const reqStore = useRequirementsStore()
const router = useRouter()

const promotedSourceUrls = computed(() => {
  const set = new Set<string>()
  for (const r of reqStore.requirements) {
    if (r.source === 'feishu' && r.source_url) set.add(r.source_url)
  }
  return set
})

function findPromoted(item: ViewWorkItem): Requirement | null {
  return reqStore.requirements.find(
    r => r.source === 'feishu' && r.source_url === item.sourceUrl,
  ) ?? null
}

const showPromoteModal = ref(false)
const promoteTarget = ref<ViewWorkItem | null>(null)
const promoting = ref(false)
const promoteError = ref<string | null>(null)

const promoteTargetExisting = computed<Requirement | null>(() => {
  if (!promoteTarget.value) return null
  return findPromoted(promoteTarget.value)
})

function openPromoteModal(item: ViewWorkItem): void {
  promoteTarget.value = item
  promoteError.value = null
  showPromoteModal.value = true
}

function closePromoteModal(): void {
  if (promoting.value) return
  showPromoteModal.value = false
}

async function promote(): Promise<void> {
  if (!promoteTarget.value) return
  const item = promoteTarget.value
  promoting.value = true
  promoteError.value = null
  try {
    const existing = findPromoted(item)
    if (existing) {
      showPromoteModal.value = false
      await router.push('/')
      return
    }
    const req = await reqStore.create({
      description: `飞书项目 ${projectKey.value} #${item.id} (${workItemType.value})`,
      source: 'feishu',
      source_url: item.sourceUrl,
      mode: 'workflow',
    })
    await rpc('requirement.startFetch', { requirementId: req.id })
    showPromoteModal.value = false
    await router.push('/')
  }
  catch (err) {
    promoteError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    promoting.value = false
  }
}

async function jumpToBoard(): Promise<void> {
  showPromoteModal.value = false
  await router.push('/')
}

function formatPromotedAt(iso: string): string {
  try {
    const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`)
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }
  catch { return iso }
}

// ── 视图配置弹窗 ──
function openConfigModal(): void {
  configDraft.value = {
    url: viewUrl.value,
    projectKey: projectKey.value,
    workItemType: workItemType.value,
    viewId: viewId.value,
  }
  showConfigModal.value = true
}

function parseConfigUrl(): void {
  parseViewUrlInto(configDraft.value.url, configDraft.value)
}

async function applyConfig(): Promise<void> {
  const d = configDraft.value
  const normalizedType = stripViewSuffix(d.workItemType.trim())
  if (!d.projectKey.trim() || !normalizedType || !d.viewId.trim()) {
    return
  }
  viewUrl.value = d.url
  projectKey.value = d.projectKey.trim()
  workItemType.value = normalizedType
  viewId.value = d.viewId.trim()
  localStorage.setItem(STORAGE_KEY_URL, viewUrl.value)
  localStorage.setItem(STORAGE_KEY_PROJECT, projectKey.value)
  localStorage.setItem(STORAGE_KEY_TYPE, workItemType.value)
  localStorage.setItem(STORAGE_KEY_VIEW, viewId.value)
  showConfigModal.value = false
  await fetchAll()
}

onMounted(async () => {
  void reqStore.fetchAll().catch(() => { /* 看板拿不到不阻塞主流程 */ })
  await refreshAuth()
  if (authReady.value && configReady.value) {
    void fetchAll()
  }
})
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 顶栏 -->
    <div class="shrink-0 px-6 pt-6 pb-4 flex items-center justify-between gap-4">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold tracking-tight">飞书项目</h1>
        <p class="text-[13px] text-gray-400 mt-1 truncate">
          <template v-if="configReady">
            当前视图: <code class="px-1 rounded bg-gray-100 dark:bg-white/5 font-mono text-[12px]">{{ projectKey }}/{{ workItemType }}/{{ viewId }}</code>
            <span v-if="total != null" class="ml-2 tabular-nums">· 共 {{ total }} 条</span>
            <span v-if="searchQuery.trim()" class="ml-1 tabular-nums text-indigo-500 dark:text-indigo-400">· 匹配 {{ filteredItems.length }} 条</span>
          </template>
          <template v-else>
            通过 meegle-cli 拉取飞书项目视图工作项，按状态自动分组展示
          </template>
        </p>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <!-- auth chip -->
        <div
          v-if="auth && !auth.installed"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400 cursor-pointer hover:bg-rose-100 dark:hover:bg-rose-500/15"
          :title="auth.error ?? ''"
          @click="refreshAuth"
        >
          <div class="i-carbon-warning-alt w-3 h-3" />
          meegle-cli 未安装
        </div>
        <div
          v-else-if="auth && !auth.authenticated"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-500/15"
          :title="`请在终端运行: meegle auth login --host project.feishu.cn`"
          @click="refreshAuth"
        >
          <div class="i-carbon-warning w-3 h-3" />
          未登录
        </div>
        <div
          v-else-if="auth?.authenticated"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
          :title="`${auth.host} · token 还剩 ${auth.expiresInMinutes ?? '?'} 分钟`"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          meegle 已登录
        </div>

        <div class="relative">
          <div class="i-carbon-search w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            v-model="searchQuery"
            type="search"
            placeholder="搜索标题"
            class="pl-8 pr-7 py-2 w-48 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#28282c] text-[13px] placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
          >
          <button
            v-if="searchQuery"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-white/10"
            title="清空"
            @click="searchQuery = ''"
          >
            <div class="i-carbon-close w-3 h-3" />
          </button>
        </div>

        <button
          class="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 text-[13px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 transition-all duration-150 active:scale-[0.97]"
          @click="openConfigModal"
        >
          <div class="i-carbon-settings w-4 h-4 opacity-60" />
          视图配置
        </button>
        <button
          :disabled="loading || !authReady || !configReady"
          class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
          @click="fetchAll"
        >
          <div :class="loading ? 'i-carbon-circle-dash w-4 h-4 animate-spin' : 'i-carbon-renew w-4 h-4'" />
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 加载进度 / 错误 -->
    <div v-if="loadingProgress" class="shrink-0 px-6 pb-2 text-[11px] text-gray-400 tabular-nums">
      已加载 {{ loadingProgress.loaded }}<span v-if="loadingProgress.total != null"> / {{ loadingProgress.total }}</span> 条…
    </div>
    <div
      v-if="errMsg"
      class="shrink-0 mx-6 mb-3 px-3 py-2 rounded-lg border border-rose-200 dark:border-rose-700/50 bg-rose-50/40 dark:bg-rose-900/10 text-[12px] text-rose-700 dark:text-rose-300 whitespace-pre-wrap"
    >
      {{ errMsg }}
    </div>

    <!-- 看板 -->
    <div v-if="configReady && items.length > 0" class="flex-1 overflow-x-auto overflow-y-hidden px-6 pb-6">
      <div class="flex gap-4 h-full min-w-min">
        <div
          v-for="col in groupedItems"
          :key="col.key"
          class="w-[272px] shrink-0 flex flex-col h-full rounded-xl bg-gray-100/60 dark:bg-white/[0.02]"
        >
          <!-- 列头 -->
          <div class="shrink-0 flex items-center gap-2 px-3.5 py-3">
            <span class="w-2 h-2 rounded-full shrink-0" :class="col.dot" />
            <span class="text-[13px] font-semibold text-gray-600 dark:text-gray-300">{{ col.label }}</span>
            <span class="ml-auto px-1.5 py-0.5 rounded-md text-[11px] font-medium tabular-nums" :class="col.badgeClass">
              {{ col.items.length }}
            </span>
          </div>

          <!-- 卡片列表 -->
          <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-2.5">
            <div
              v-for="item in col.items"
              :key="item.id"
              class="bg-white dark:bg-[#28282c] rounded-lg p-3.5 shadow-sm shadow-black/[0.04] dark:shadow-none transition-all duration-200 hover:shadow-md hover:shadow-black/[0.08] cursor-pointer group relative"
              @click="openPromoteModal(item)"
            >
              <!-- 顶行: ID + 状态原始名 -->
              <div class="flex items-center gap-1.5 mb-1.5">
                <span class="text-[10px] font-mono text-gray-400 dark:text-gray-500">#{{ item.id }}</span>
                <span
                  v-if="promotedSourceUrls.has(item.sourceUrl)"
                  class="ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 inline-flex items-center gap-0.5 bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"
                  title="已推进到需求看板"
                >
                  <div class="i-carbon-checkmark-filled w-2.5 h-2.5" />
                  已推进
                </span>
                <span
                  v-if="item.statusLabel"
                  class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                  :class="[col.badgeClass, promotedSourceUrls.has(item.sourceUrl) ? '' : 'ml-auto']"
                >
                  {{ item.statusLabel }}
                </span>
              </div>

              <!-- 标题 -->
              <h4 class="text-[13px] font-semibold leading-snug line-clamp-2 text-gray-900 dark:text-gray-100">
                {{ item.title || '（无标题）' }}
              </h4>

              <!-- 底行: 负责人 + 飞书跳转（独立按钮，不冒泡） -->
              <div class="flex items-center gap-1.5 mt-2.5">
                <div v-if="item.ownerNames.length > 0" class="flex items-center gap-1 min-w-0 flex-1">
                  <div class="i-carbon-user w-3 h-3 text-gray-400 shrink-0" />
                  <span class="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                    {{ item.ownerNames.slice(0, 3).join('、') }}<span v-if="item.ownerNames.length > 3" class="text-gray-400"> +{{ item.ownerNames.length - 3 }}</span>
                  </span>
                </div>
                <div v-else class="flex-1 text-[11px] text-gray-300 dark:text-gray-600">未分配</div>
                <a
                  :href="item.sourceUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="shrink-0 p-1 -m-1 rounded text-gray-300 dark:text-gray-600 hover:text-indigo-500 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                  title="在飞书项目中打开"
                  @click.stop
                >
                  <div class="i-carbon-launch w-3 h-3" />
                </a>
              </div>
            </div>

            <!-- 空列占位（理论上分组结果不会有空列，保留以防 future filter） -->
            <div v-if="col.items.length === 0" class="flex flex-col items-center justify-center py-10 text-gray-300 dark:text-gray-600">
              <div class="i-carbon-circle-dash w-6 h-6 mb-2 opacity-30" />
              <span class="text-[11px]">暂无</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <div v-else-if="!loading && configReady && authReady" class="flex-1 flex flex-col items-center justify-center text-gray-300 dark:text-gray-600">
      <div class="i-carbon-task-view w-12 h-12 mb-3 opacity-30" />
      <p class="text-[13px] mb-3">暂无数据</p>
      <button
        class="px-3 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 text-gray-500 hover:bg-gray-50 dark:hover:bg-white/5"
        @click="fetchAll"
      >
        点击刷新
      </button>
      <div v-if="rawSnippet" class="mt-6 max-w-2xl px-4 py-3 rounded-lg border border-amber-200 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-900/10 text-[11px] text-amber-700 dark:text-amber-300">
        <div class="mb-1 font-medium">CLI 返回 data 前 800 字节：</div>
        <pre class="whitespace-pre-wrap break-all">{{ rawSnippet }}</pre>
      </div>
    </div>

    <div v-else-if="!configReady" class="flex-1 flex flex-col items-center justify-center text-gray-400">
      <div class="i-carbon-settings w-12 h-12 mb-3 opacity-30" />
      <p class="text-[13px] mb-3">尚未配置视图</p>
      <button
        class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97]"
        @click="openConfigModal"
      >
        <div class="i-carbon-settings w-4 h-4" />
        打开视图配置
      </button>
    </div>

    <!-- 视图配置弹窗 -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-if="showConfigModal"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          @click.self="showConfigModal = false"
        >
          <Transition
            appear
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 scale-95 translate-y-2"
          >
            <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-md p-6">
              <div class="flex items-center gap-3 mb-5">
                <div class="w-9 h-9 rounded-full bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center shrink-0">
                  <div class="i-carbon-settings w-4 h-4 text-indigo-500" />
                </div>
                <div>
                  <h2 class="text-base font-semibold">视图配置</h2>
                  <p class="text-[12px] text-gray-400 mt-0.5">粘贴飞书项目视图链接，或手动填写三项</p>
                </div>
              </div>

              <div class="space-y-4">
                <div>
                  <label class="block text-[12px] font-medium text-gray-400 dark:text-gray-500 mb-1.5">视图链接</label>
                  <div class="flex gap-2">
                    <input
                      v-model="configDraft.url"
                      type="text"
                      placeholder="https://project.feishu.cn/{projectKey}/storyView/{viewId}"
                      class="flex-1 px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors font-mono"
                      @blur="parseConfigUrl"
                      @paste="(e) => { const v = e.clipboardData?.getData('text') ?? ''; configDraft.url = v; parseConfigUrl() }"
                    >
                    <button
                      class="px-3 py-2 rounded-lg text-[12px] font-medium text-gray-500 border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
                      @click="parseConfigUrl"
                    >
                      解析
                    </button>
                  </div>
                </div>

                <div class="grid grid-cols-3 gap-2">
                  <div>
                    <label class="block text-[11px] font-medium text-gray-400 mb-1">projectKey</label>
                    <input
                      v-model="configDraft.projectKey"
                      type="text"
                      class="w-full px-2.5 py-1.5 rounded-md bg-gray-50 dark:bg-white/5 text-[12px] border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 font-mono"
                    >
                  </div>
                  <div>
                    <label class="block text-[11px] font-medium text-gray-400 mb-1">workItemType</label>
                    <input
                      v-model="configDraft.workItemType"
                      type="text"
                      placeholder="story / issue"
                      class="w-full px-2.5 py-1.5 rounded-md bg-gray-50 dark:bg-white/5 text-[12px] border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 font-mono"
                    >
                  </div>
                  <div>
                    <label class="block text-[11px] font-medium text-gray-400 mb-1">viewId</label>
                    <input
                      v-model="configDraft.viewId"
                      type="text"
                      class="w-full px-2.5 py-1.5 rounded-md bg-gray-50 dark:bg-white/5 text-[12px] border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 font-mono"
                    >
                  </div>
                </div>

                <div
                  v-if="!auth?.authenticated"
                  class="px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/5 border border-amber-200/60 dark:border-amber-500/15 text-[11px] text-amber-700 dark:text-amber-400"
                >
                  <span v-if="!auth?.installed">meegle-cli 未安装，请运行 <code class="px-1 rounded bg-amber-100 dark:bg-amber-900/30">npm i -g meegle-cli</code></span>
                  <span v-else>尚未登录，请在终端运行 <code class="px-1 rounded bg-amber-100 dark:bg-amber-900/30">meegle auth login --host project.feishu.cn</code></span>
                </div>
              </div>

              <div class="flex justify-end gap-2 mt-6">
                <button
                  class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="showConfigModal = false"
                >
                  取消
                </button>
                <button
                  class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="!configDraft.projectKey.trim() || !configDraft.workItemType.trim() || !configDraft.viewId.trim()"
                  @click="applyConfig"
                >
                  应用并拉取
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>

    <!-- 推进到需求看板弹窗 -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-if="showPromoteModal && promoteTarget"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          @click.self="closePromoteModal"
        >
          <Transition
            appear
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 scale-95 translate-y-2"
          >
            <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-lg p-6">
              <!-- header -->
              <div class="flex items-start gap-3 mb-5">
                <div class="w-9 h-9 rounded-full bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center shrink-0">
                  <div class="i-carbon-rocket w-4 h-4 text-indigo-500" />
                </div>
                <div class="flex-1 min-w-0">
                  <h2 class="text-base font-semibold">推进到需求看板</h2>
                  <p class="text-[12px] text-gray-400 mt-0.5">将此飞书项目卡片纳入本地需求看板进行编排</p>
                </div>
                <a
                  :href="promoteTarget.sourceUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                  title="在飞书项目中打开"
                >
                  <div class="i-carbon-launch w-4 h-4" />
                </a>
              </div>

              <!-- 卡片信息 -->
              <div class="space-y-3">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-mono text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-white/5">
                    #{{ promoteTarget.id }}
                  </span>
                  <span
                    v-if="promoteTarget.statusLabel"
                    class="px-2 py-0.5 rounded text-[11px] font-medium bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-300"
                  >
                    {{ promoteTarget.statusLabel }}
                  </span>
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-mono text-gray-400 bg-gray-50 dark:bg-white/5">
                    {{ workItemType }}
                  </span>
                </div>

                <h3 class="text-[15px] font-semibold leading-snug text-gray-900 dark:text-gray-100">
                  {{ promoteTarget.title || '（无标题）' }}
                </h3>

                <div v-if="promoteTarget.ownerNames.length > 0" class="flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-gray-400">
                  <div class="i-carbon-user w-3.5 h-3.5 text-gray-400" />
                  <span>{{ promoteTarget.ownerNames.join('、') }}</span>
                </div>

                <!-- 已推进状态条 -->
                <div
                  v-if="promoteTargetExisting"
                  class="px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-200/60 dark:border-emerald-500/15 text-[12px] text-emerald-700 dark:text-emerald-400 flex items-center gap-2"
                >
                  <div class="i-carbon-checkmark-filled w-3.5 h-3.5 shrink-0" />
                  <span>已在需求看板中（创建于 {{ formatPromotedAt(promoteTargetExisting.created_at) }}）</span>
                </div>

                <div
                  v-if="promoteError"
                  class="px-3 py-2 rounded-lg bg-rose-50 dark:bg-rose-500/5 border border-rose-200/60 dark:border-rose-500/15 text-[12px] text-rose-700 dark:text-rose-400"
                >
                  {{ promoteError }}
                </div>
              </div>

              <!-- footer -->
              <div class="flex justify-end gap-2 mt-6">
                <button
                  class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                  :disabled="promoting"
                  @click="closePromoteModal"
                >
                  关闭
                </button>
                <button
                  v-if="promoteTargetExisting"
                  class="px-4 py-2 rounded-lg bg-emerald-600 text-white text-[13px] font-medium hover:bg-emerald-500 shadow-sm shadow-emerald-600/20 transition-all duration-150 active:scale-[0.97] inline-flex items-center gap-1.5"
                  @click="jumpToBoard"
                >
                  <div class="i-carbon-view w-3.5 h-3.5" />
                  在需求看板中查看
                </button>
                <button
                  v-else
                  class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  :disabled="promoting"
                  @click="promote"
                >
                  <div v-if="promoting" class="i-carbon-circle-dash w-3.5 h-3.5 animate-spin" />
                  <div v-else class="i-carbon-rocket w-3.5 h-3.5" />
                  {{ promoting ? '推进中…' : '推进到需求看板' }}
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
