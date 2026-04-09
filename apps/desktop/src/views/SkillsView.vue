<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import MarkdownIt from 'markdown-it'
import { rpc } from '../composables/use-sidecar'

// ── Types ──

type ManageableEnv = 'claude' | 'codex' | 'cursor'
type ActiveTab = 'local' | 'store'

interface EnvInstallation {
  installed: boolean
  path?: string
  isSymlink?: boolean
}

interface PluginMeta {
  name: string
  displayName?: string
  version?: string
  description?: string
  author?: string
}

interface SkillInfo {
  id: string
  name: string
  description: string
  type: 'skill' | 'command'
  dirName: string
  realDir: string
  skillMdPath: string
  plugin?: PluginMeta
  envs: Record<ManageableEnv, EnvInstallation>
}

interface RemoteSkillItem {
  slug: string
  displayName: string
  summary: string | null
  tags: string[]
  stats: { downloads: number, installs: number, versions: number, stars: number }
  highlighted: boolean
  createdAt: number
  updatedAt: number
  latestVersion: { version: string, createdAt: number, changelog: string } | null
  installed: boolean
  source?: string
}

interface RemoteSkillFile {
  path: string
  size: number
  storageKey: string
  sha256: string
  contentType: string
}

interface RemoteSkillDetail {
  skill: RemoteSkillItem
  latestVersion: {
    version: string
    createdAt: number
    changelog: string
    files: RemoteSkillFile[]
  } | null
  owner: { handle: string, displayName: string, image: string }
  installed: boolean
  readme?: string
}

interface SkillRegistry {
  id: string
  name: string
  apiBase: string
}

// ── Shared ──

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
const activeTab = ref<ActiveTab>('local')

// ── Local Skills ──

const skills = ref<SkillInfo[]>([])
const envLabels = ref<Record<string, string>>({})
const loading = ref(false)
const searchQuery = ref('')
const activeEnvFilter = ref<ManageableEnv | null>(null)
const activeTypeFilter = ref<'skill' | 'command' | null>(null)
const activePluginFilter = ref<string | null>(null)

const selectedSkill = ref<SkillInfo | null>(null)
const detailContent = ref('')
const detailLoading = ref(false)
const pendingOps = ref(new Set<string>())

const envList: { env: ManageableEnv, label: string, icon: string, activeClasses: string, dotColor: string }[] = [
  { env: 'claude', label: 'Claude Code', icon: 'i-carbon-chat-bot', activeClasses: 'bg-orange-500 text-white shadow-orange-500/30', dotColor: 'bg-orange-500' },
  { env: 'codex', label: 'Codex', icon: 'i-carbon-code', activeClasses: 'bg-emerald-500 text-white shadow-emerald-500/30', dotColor: 'bg-emerald-500' },
  { env: 'cursor', label: 'Cursor', icon: 'i-carbon-cursor-1', activeClasses: 'bg-blue-500 text-white shadow-blue-500/30', dotColor: 'bg-blue-500' },
]

async function loadSkills() {
  loading.value = true
  try {
    const res = await rpc<{ skills: SkillInfo[], envLabels: Record<string, string> }>('skill.scan')
    skills.value = res.skills
    envLabels.value = res.envLabels
  }
  catch (err) {
    console.error('Failed to scan skills:', err)
  }
  finally {
    loading.value = false
  }
}

onMounted(loadSkills)

const envCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const s of skills.value) {
    for (const e of envList) {
      if (s.envs[e.env]?.installed)
        counts[e.env] = (counts[e.env] || 0) + 1
    }
  }
  return counts
})

const typeCounts = computed(() => {
  const counts = { skill: 0, command: 0 }
  for (const s of skills.value) {
    if (s.type === 'command') counts.command++
    else counts.skill++
  }
  return counts
})

const pluginGroups = computed(() => {
  const map = new Map<string, { displayName: string, count: number }>()
  for (const s of skills.value) {
    if (!s.plugin) continue
    const key = s.plugin.name
    const existing = map.get(key)
    if (existing) {
      existing.count++
    }
    else {
      map.set(key, { displayName: s.plugin.displayName || s.plugin.name, count: 1 })
    }
  }
  return map
})

const totalPluginCount = computed(() => {
  let n = 0
  for (const g of pluginGroups.value.values()) n += g.count
  return n
})

const filteredSkills = computed(() => {
  let result = skills.value

  if (activeTypeFilter.value) {
    result = result.filter(s => s.type === activeTypeFilter.value)
  }

  if (activeEnvFilter.value) {
    result = result.filter(s => s.envs[activeEnvFilter.value!]?.installed)
  }

  if (activePluginFilter.value === '__all__') {
    result = result.filter(s => !!s.plugin)
  }
  else if (activePluginFilter.value) {
    result = result.filter(s => s.plugin?.name === activePluginFilter.value)
  }

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(s =>
      s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q)
      || s.dirName.toLowerCase().includes(q)
      || (s.plugin?.displayName?.toLowerCase().includes(q) ?? false),
    )
  }

  return result
})

async function toggleEnv(skill: SkillInfo, env: ManageableEnv) {
  if (skill.type === 'command') return
  const key = `${skill.id}:${env}`
  if (pendingOps.value.has(key)) return

  const wasInstalled = skill.envs[env].installed
  pendingOps.value.add(key)
  skill.envs[env] = { installed: !wasInstalled }

  try {
    if (wasInstalled) {
      await rpc('skill.disable', { dirName: skill.dirName, env })
    }
    else {
      await rpc('skill.enable', { dirName: skill.dirName, realDir: skill.realDir, env })
    }
  }
  catch (err) {
    skill.envs[env] = { installed: wasInstalled }
    console.error(`Failed to ${wasInstalled ? 'disable' : 'enable'} skill:`, err)
  }
  finally {
    pendingOps.value.delete(key)
  }
}

async function openDetail(skill: SkillInfo) {
  selectedSkill.value = skill
  detailContent.value = ''
  detailLoading.value = true
  try {
    const res = await rpc<{ content: string }>('skill.readContent', { skillPath: skill.skillMdPath })
    detailContent.value = res.content
  }
  catch {
    detailContent.value = ''
  }
  finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  selectedSkill.value = null
  detailContent.value = ''
}

const renderedContent = computed(() => {
  if (!detailContent.value) return ''
  let raw = detailContent.value
  const fmMatch = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n/)
  if (fmMatch) raw = raw.slice(fmMatch[0].length)
  return md.render(raw)
})

watch(selectedSkill, (v) => {
  if (!v) detailContent.value = ''
})

function installedEnvCount(skill: SkillInfo): number {
  return envList.filter(e => skill.envs[e.env]?.installed).length
}

// ── Store (通过 sidecar RPC 请求远程 API，避免 CORS 限制) ──

const REGISTRIES: SkillRegistry[] = [
  { id: 'onionhub', name: 'OnionHub', apiBase: 'https://onionhub-api.yc345.tv' },
  { id: 'skillssh', name: 'Skills.sh', apiBase: 'https://skills.sh' },
]

const activeRegistry = ref<SkillRegistry>(REGISTRIES[0])
const storeSkills = ref<RemoteSkillItem[]>([])
const storeLoading = ref(false)
const storeSearchQuery = ref('')
const storeError = ref('')

const storeSearchResults = ref<RemoteSkillItem[]>([])
const storeSearching = ref(false)
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const selectedStoreSkill = ref<RemoteSkillDetail | null>(null)
const storeDetailLoading = ref(false)
const installingSkills = ref(new Set<string>())

const isRemoteSearchable = computed(() => activeRegistry.value.id === 'skillssh')

async function loadStoreSkills() {
  storeLoading.value = true
  storeError.value = ''
  try {
    const res = await rpc<{ items: RemoteSkillItem[], nextCursor: string | null }>(
      'skillStore.list',
      { apiBase: activeRegistry.value.apiBase },
    )
    const localNames = new Set(skills.value.map(s => s.dirName))
    storeSkills.value = res.items.map(item => ({
      ...item,
      installed: localNames.has(item.slug),
    }))
  }
  catch (err: any) {
    storeError.value = err?.message ?? '加载失败'
    console.error('Failed to load store skills:', err)
  }
  finally {
    storeLoading.value = false
  }
}

async function searchStore(query: string) {
  if (!query.trim() || !isRemoteSearchable.value) {
    storeSearchResults.value = []
    return
  }
  storeSearching.value = true
  try {
    const res = await rpc<{ items: RemoteSkillItem[], nextCursor: string | null }>(
      'skillStore.search',
      { apiBase: activeRegistry.value.apiBase, query: query.trim() },
    )
    const localNames = new Set(skills.value.map(s => s.dirName))
    storeSearchResults.value = res.items.map(item => ({
      ...item,
      installed: localNames.has(item.slug),
    }))
  }
  catch (err) {
    console.error('Remote search failed:', err)
    storeSearchResults.value = []
  }
  finally {
    storeSearching.value = false
  }
}

watch(storeSearchQuery, (q) => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  if (!q.trim()) {
    storeSearchResults.value = []
    return
  }
  searchDebounceTimer = setTimeout(() => searchStore(q), 350)
})

const filteredStoreSkills = computed<(RemoteSkillItem & { _fromSearch?: boolean })[]>(() => {
  const q = storeSearchQuery.value.trim().toLowerCase()
  if (!q) return storeSkills.value

  const localHits = storeSkills.value.filter(s =>
    s.slug.toLowerCase().includes(q)
    || (s.displayName?.toLowerCase().includes(q))
    || (s.latestVersion?.changelog?.toLowerCase().includes(q)),
  )

  if (!isRemoteSearchable.value) return localHits

  const seen = new Set(localHits.map(s => `${s.source ?? ''}/${s.slug}`))
  const remoteOnly = storeSearchResults.value
    .filter(s => !seen.has(`${s.source ?? ''}/${s.slug}`))
    .map(s => ({ ...s, _fromSearch: true as const }))

  return [...localHits, ...remoteOnly]
})

async function openStoreDetail(skill: RemoteSkillItem) {
  storeDetailLoading.value = true
  selectedStoreSkill.value = null
  try {
    const res = await rpc<RemoteSkillDetail>(
      'skillStore.detail',
      { apiBase: activeRegistry.value.apiBase, slug: skill.slug, source: skill.source },
    )
    const localNames = new Set(skills.value.map(s => s.dirName))
    res.installed = localNames.has(skill.slug)
    selectedStoreSkill.value = res
  }
  catch (err) {
    console.error('Failed to load skill detail:', err)
  }
  finally {
    storeDetailLoading.value = false
  }
}

function closeStoreDetail() {
  selectedStoreSkill.value = null
}

const installError = ref('')

async function installSkill(skill: RemoteSkillItem) {
  const slug = skill.slug
  if (installingSkills.value.has(slug)) return
  installingSkills.value.add(slug)
  installError.value = ''
  await nextTick()
  try {
    const res = await rpc<{ installed: boolean, fileCount: number }>('skillStore.install', {
      apiBase: activeRegistry.value.apiBase,
      slug,
      version: skill.latestVersion?.version,
      source: skill.source,
    })
    if (!res.installed) throw new Error('安装返回失败状态')
    await loadSkills()
    syncStoreInstalledState()
  }
  catch (err: any) {
    installError.value = `安装 ${slug} 失败: ${err?.message ?? '未知错误'}`
    console.error('[SkillStore] Install failed:', err)
  }
  finally {
    installingSkills.value.delete(slug)
  }
}

async function uninstallStoreSkill(slug: string) {
  if (installingSkills.value.has(slug)) return
  installingSkills.value.add(slug)
  installError.value = ''
  await nextTick()
  try {
    await rpc('skillStore.uninstall', { slug })
    await loadSkills()
    syncStoreInstalledState()
  }
  catch (err: any) {
    installError.value = `卸载 ${slug} 失败: ${err?.message ?? '未知错误'}`
    console.error('Failed to uninstall skill:', err)
  }
  finally {
    installingSkills.value.delete(slug)
  }
}

function syncStoreInstalledState() {
  const localNames = new Set(skills.value.map(s => s.dirName))
  for (const item of storeSkills.value) {
    item.installed = localNames.has(item.slug)
  }
  for (const item of storeSearchResults.value) {
    item.installed = localNames.has(item.slug)
  }
  if (selectedStoreSkill.value) {
    selectedStoreSkill.value.installed = localNames.has(selectedStoreSkill.value.skill.slug)
  }
}

const storeDetailRendered = computed(() => {
  const detail = selectedStoreSkill.value
  if (!detail) return ''
  if (detail.readme) return md.render(detail.readme)
  if (detail.latestVersion?.changelog) return md.render(detail.latestVersion.changelog)
  return ''
})

function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

watch(activeTab, async (tab) => {
  if (tab === 'local') {
    loadSkills()
    closeStoreDetail()
  }
  else if (tab === 'store') {
    closeDetail()
    await loadSkills()
    loadStoreSkills()
  }
})

watch(activeRegistry, () => {
  storeSkills.value = []
  storeSearchResults.value = []
  storeSearchQuery.value = ''
  selectedStoreSkill.value = null
  loadStoreSkills()
})
</script>

<template>
  <div class="flex h-full">
    <!-- Main content area -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-8" :class="(selectedSkill || selectedStoreSkill) ? 'max-w-none' : 'max-w-5xl mx-auto'">
        <!-- Header with tabs -->
        <div class="flex items-center justify-between mb-6">
          <div>
            <h1 class="text-xl font-semibold tracking-tight">Skill 管理</h1>
            <p class="text-[13px] text-gray-400 mt-1">
              管理本机 Agent Skills，或从 Skill 商店下载安装新的 Skill
            </p>
          </div>
          <button
            v-if="activeTab === 'local'"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-gray-200 dark:border-white/10 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-colors disabled:opacity-40"
            :disabled="loading"
            @click="loadSkills"
          >
            <div class="w-4 h-4" :class="loading ? 'i-carbon-renew animate-spin' : 'i-carbon-renew'" />
            {{ loading ? '扫描中…' : '重新扫描' }}
          </button>
          <button
            v-else
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-gray-200 dark:border-white/10 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-colors disabled:opacity-40"
            :disabled="storeLoading"
            @click="loadStoreSkills"
          >
            <div class="w-4 h-4" :class="storeLoading ? 'i-carbon-renew animate-spin' : 'i-carbon-renew'" />
            {{ storeLoading ? '加载中…' : '刷新' }}
          </button>
        </div>

        <!-- Tab switcher -->
        <div class="flex items-center gap-1 mb-5 p-0.5 bg-gray-100 dark:bg-white/5 rounded-lg w-fit">
          <button
            class="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-medium transition-all duration-150"
            :class="activeTab === 'local'
              ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
            @click="activeTab = 'local'"
          >
            <div class="i-carbon-skill-level-advanced w-3.5 h-3.5" />
            本地 Skills
          </button>
          <button
            class="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-medium transition-all duration-150"
            :class="activeTab === 'store'
              ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
            @click="activeTab = 'store'"
          >
            <div class="i-carbon-store w-3.5 h-3.5" />
            Skill 商店
          </button>
        </div>

        <!-- ========== LOCAL TAB ========== -->
        <template v-if="activeTab === 'local'">
          <!-- Filter bar -->
          <div class="flex items-center gap-3 mb-5">
            <div class="flex gap-1.5 flex-wrap flex-1">
              <button
                class="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-150"
                :class="activeEnvFilter === null && activeTypeFilter === null && activePluginFilter === null
                  ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-sm'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
                @click="activeEnvFilter = null; activeTypeFilter = null; activePluginFilter = null"
              >
                全部
                <span class="text-[11px] opacity-70">{{ skills.length }}</span>
              </button>

              <div class="w-px h-5 bg-gray-200 dark:bg-white/10 self-center mx-0.5" />

              <!-- Type filter -->
              <button
                class="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-150"
                :class="activeTypeFilter === 'skill'
                  ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-sm'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
                @click="activeTypeFilter = activeTypeFilter === 'skill' ? null : 'skill'"
              >
                <div class="i-carbon-skill-level w-3 h-3" />
                Skill
                <span class="text-[11px] opacity-70">{{ typeCounts.skill }}</span>
              </button>
              <button
                class="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-150"
                :class="activeTypeFilter === 'command'
                  ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-sm'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
                @click="activeTypeFilter = activeTypeFilter === 'command' ? null : 'command'"
              >
                <div class="i-carbon-terminal w-3 h-3" />
                Command
                <span class="text-[11px] opacity-70">{{ typeCounts.command }}</span>
              </button>

              <div class="w-px h-5 bg-gray-200 dark:bg-white/10 self-center mx-0.5" />

              <!-- Env filter -->
              <button
                v-for="e in envList"
                :key="e.env"
                class="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-150"
                :class="activeEnvFilter === e.env
                  ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-sm'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
                @click="activeEnvFilter = activeEnvFilter === e.env ? null : e.env"
              >
                <div class="w-1.5 h-1.5 rounded-full" :class="e.dotColor" />
                {{ e.label }}
                <span class="text-[11px] opacity-70">{{ envCounts[e.env] || 0 }}</span>
              </button>

              <template v-if="pluginGroups.size > 0">
                <div class="w-px h-5 bg-gray-200 dark:bg-white/10 self-center mx-0.5" />

                <!-- Plugin filter -->
                <button
                  class="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-150"
                  :class="activePluginFilter === '__all__'
                    ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30'
                    : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
                  @click="activePluginFilter = activePluginFilter === '__all__' ? null : '__all__'"
                >
                  <div class="i-carbon-plug w-3 h-3" />
                  Plugin
                  <span class="text-[11px] opacity-70">{{ totalPluginCount }}</span>
                </button>
                <button
                  v-for="[key, group] in pluginGroups"
                  :key="key"
                  class="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-150"
                  :class="activePluginFilter === key
                    ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30'
                    : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
                  @click="activePluginFilter = activePluginFilter === key ? null : key"
                >
                  {{ group.displayName }}
                  <span class="text-[11px] opacity-70">{{ group.count }}</span>
                </button>
              </template>
            </div>

            <div class="relative">
              <div class="i-carbon-search absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 dark:text-gray-500" />
              <input
                v-model="searchQuery"
                type="text"
                placeholder="搜索 skill…"
                class="w-52 pl-8 pr-3 py-1.5 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
              >
            </div>
          </div>

          <!-- Loading -->
          <div v-if="loading && skills.length === 0" class="flex items-center justify-center py-20">
            <div class="flex items-center gap-3 text-gray-400 text-sm">
              <div class="w-4 h-4 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
              正在扫描本机 Skill…
            </div>
          </div>

          <!-- Empty -->
          <div v-else-if="!loading && filteredSkills.length === 0" class="text-center py-20 text-gray-400">
            <div class="i-carbon-search w-10 h-10 mx-auto mb-3 opacity-30" />
            <p class="text-[13px]">
              {{ searchQuery || activeEnvFilter || activeTypeFilter || activePluginFilter ? '未找到匹配的 Skill' : '未发现已安装的 Skill' }}
            </p>
          </div>

          <!-- Skill list -->
          <div v-else class="space-y-1.5">
            <div
              v-for="skill in filteredSkills"
              :key="skill.id"
              class="group bg-white dark:bg-[#28282c] rounded-xl shadow-sm shadow-black/[0.04] dark:shadow-none transition-all duration-150 overflow-hidden"
              :class="selectedSkill?.id === skill.id ? 'ring-2 ring-indigo-500/40' : ''"
            >
              <div class="flex items-center gap-3 px-4 py-2.5">
                <div
                  class="flex-1 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
                  @click="openDetail(skill)"
                >
                  <div class="flex items-center gap-2">
                    <span class="text-[13px] font-medium text-gray-800 dark:text-gray-100">
                      {{ skill.name }}
                    </span>
                    <span
                      v-if="skill.type === 'command'"
                      class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-500/10 text-indigo-500 font-medium"
                    >command</span>
                    <span
                      v-if="skill.plugin"
                      class="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-500/10 text-violet-500"
                    >{{ skill.plugin.displayName || skill.plugin.name }}</span>
                  </div>
                  <p class="text-[12px] text-gray-400 mt-0.5 line-clamp-1">
                    {{ skill.description || '无描述' }}
                  </p>
                </div>

                <div class="flex items-center gap-1.5 shrink-0">
                  <button
                    v-for="e in envList"
                    :key="e.env"
                    class="relative w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200"
                    :class="[
                      skill.envs[e.env]?.installed
                        ? `${e.activeClasses} shadow-sm`
                        : 'bg-gray-100 dark:bg-white/5 text-gray-300 dark:text-gray-600 hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-400',
                      skill.type === 'command' ? 'opacity-20 pointer-events-none' : 'cursor-pointer',
                    ]"
                    :title="skill.envs[e.env]?.installed ? `从 ${e.label} 移除` : `启用到 ${e.label}`"
                    :disabled="skill.type === 'command' || pendingOps.has(`${skill.id}:${e.env}`)"
                    @click.stop="toggleEnv(skill, e.env)"
                  >
                    <div
                      v-if="pendingOps.has(`${skill.id}:${e.env}`)"
                      class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                    />
                    <div v-else class="w-3.5 h-3.5" :class="e.icon" />
                  </button>
                </div>

                <button
                  class="w-6 h-6 rounded-md flex items-center justify-center text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="openDetail(skill)"
                >
                  <div class="i-carbon-chevron-right w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </template>

        <!-- ========== STORE TAB ========== -->
        <template v-if="activeTab === 'store'">
          <!-- Registry selector + search -->
          <div class="flex items-center gap-3 mb-5">
            <div v-if="REGISTRIES.length > 1" class="flex gap-1.5">
              <button
                v-for="reg in REGISTRIES"
                :key="reg.id"
                class="px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-150"
                :class="activeRegistry.id === reg.id
                  ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-sm'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
                @click="activeRegistry = reg"
              >
                {{ reg.name }}
              </button>
            </div>
            <div v-else class="flex items-center gap-2 text-[13px] text-gray-500">
              <div class="i-carbon-store w-4 h-4 text-indigo-500" />
              <span class="font-medium text-gray-700 dark:text-gray-200">{{ activeRegistry.name }}</span>
            </div>

            <div class="flex-1" />

            <div class="relative">
              <div class="i-carbon-search absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 dark:text-gray-500" />
              <input
                v-model="storeSearchQuery"
                type="text"
                :placeholder="isRemoteSearchable ? '搜索全部 skill（支持远程）…' : '搜索商店 skill…'"
                class="w-64 pl-8 pr-3 py-1.5 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
              >
            </div>
          </div>

          <!-- Search status bar -->
          <div
            v-if="storeSearchQuery.trim() && isRemoteSearchable"
            class="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-indigo-50/60 dark:bg-indigo-500/5 border border-indigo-100 dark:border-indigo-500/10"
          >
            <div
              v-if="storeSearching"
              class="w-3.5 h-3.5 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin shrink-0"
            />
            <div v-else class="i-carbon-cloud w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span class="text-[12px] text-indigo-600 dark:text-indigo-400">
              <template v-if="storeSearching">正在从 {{ activeRegistry.name }} 远程搜索…</template>
              <template v-else>
                已展示热门列表本地匹配 + {{ activeRegistry.name }} 远程搜索结果，共 {{ filteredStoreSkills.length }} 条
              </template>
            </span>
          </div>

          <!-- Store loading -->
          <div v-if="storeLoading && storeSkills.length === 0" class="flex items-center justify-center py-20">
            <div class="flex items-center gap-3 text-gray-400 text-sm">
              <div class="w-4 h-4 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
              正在加载 Skill 商店…
            </div>
          </div>

          <!-- Install/uninstall error banner -->
          <div
            v-if="installError"
            class="flex items-center gap-2 mb-4 px-4 py-2.5 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20"
          >
            <div class="i-carbon-warning-filled w-4 h-4 text-red-500 shrink-0" />
            <span class="text-[13px] text-red-600 dark:text-red-400 flex-1">{{ installError }}</span>
            <button class="text-[12px] text-red-500 hover:text-red-700 font-medium shrink-0" @click="installError = ''">关闭</button>
          </div>

          <!-- Store error -->
          <div v-else-if="storeError" class="text-center py-20">
            <div class="i-carbon-warning-alt w-10 h-10 mx-auto mb-3 text-amber-400 opacity-60" />
            <p class="text-[13px] text-gray-400 mb-2">{{ storeError }}</p>
            <button
              class="text-[13px] text-indigo-500 hover:text-indigo-600 font-medium"
              @click="loadStoreSkills"
            >
              重试
            </button>
          </div>

          <!-- Store empty -->
          <div v-else-if="!storeLoading && !storeSearching && filteredStoreSkills.length === 0" class="text-center py-20 text-gray-400">
            <div class="i-carbon-search w-10 h-10 mx-auto mb-3 opacity-30" />
            <p class="text-[13px]">
              {{ storeSearchQuery ? '未找到匹配的 Skill' : '商店暂无可用 Skill' }}
            </p>
          </div>

          <!-- Store skill grid -->
          <template v-else>
            <!-- Hot list badge (no search) -->
            <div v-if="!storeSearchQuery.trim() && storeSkills.length > 0" class="flex items-center gap-2 mb-3 text-[12px] text-gray-400">
              <div class="i-carbon-fire w-3.5 h-3.5 text-orange-400" />
              <span>热门推荐 · {{ storeSkills.length }} 个 Skill</span>
              <span v-if="isRemoteSearchable" class="text-gray-300 dark:text-gray-600">（输入关键词可搜索全部）</span>
            </div>

          <div class="grid gap-3" :class="selectedStoreSkill ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'">
            <div
              v-for="skill in filteredStoreSkills"
              :key="skill.slug"
              class="group bg-white dark:bg-[#28282c] rounded-xl shadow-sm shadow-black/[0.04] dark:shadow-none transition-all duration-150 overflow-hidden cursor-pointer hover:shadow-md dark:hover:ring-1 dark:hover:ring-white/10"
              :class="selectedStoreSkill?.skill.slug === skill.slug ? 'ring-2 ring-indigo-500/40' : ''"
              @click="openStoreDetail(skill)"
            >
              <div class="p-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-[14px] font-semibold text-gray-800 dark:text-gray-100 truncate">
                        {{ skill.displayName || skill.slug }}
                      </span>
                      <span
                        v-if="skill.highlighted"
                        class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium"
                      >精选</span>
                      <span
                        v-if="skill.installed"
                        class="text-[10px] px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 font-medium"
                      >已安装</span>
                      <span
                        v-if="skill._fromSearch"
                        class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-500/10 text-indigo-500 dark:text-indigo-400 font-medium flex items-center gap-0.5"
                      >
                        <div class="i-carbon-cloud w-2.5 h-2.5" />
                        搜索结果
                      </span>
                    </div>
                    <p class="text-[12px] text-gray-400 mt-1 line-clamp-2">
                      {{ skill.latestVersion?.changelog || skill.summary || '无描述' }}
                    </p>
                  </div>
                  <!-- installing → installed → default -->
                  <button
                    v-if="installingSkills.has(skill.slug)"
                    class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-500/80 text-white cursor-not-allowed shadow-sm"
                    disabled
                    @click.stop
                  >
                    <div class="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    安装中…
                  </button>
                  <button
                    v-else-if="skill.installed"
                    class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 transition-colors"
                    @click.stop="uninstallStoreSkill(skill.slug)"
                  >
                    <div class="i-carbon-checkmark w-3.5 h-3.5" />
                    已安装
                  </button>
                  <button
                    v-else
                    class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm"
                    @click.stop="installSkill(skill)"
                  >
                    <div class="i-carbon-download w-3.5 h-3.5" />
                    安装
                  </button>
                </div>

                <div class="flex items-center gap-4 mt-3 text-[11px] text-gray-400">
                  <span v-if="skill.latestVersion?.version" class="flex items-center gap-1">
                    <div class="i-carbon-version w-3 h-3" />
                    v{{ skill.latestVersion.version }}
                  </span>
                  <span v-if="skill.stats.installs" class="flex items-center gap-1">
                    <div class="i-carbon-download w-3 h-3" />
                    {{ skill.stats.installs.toLocaleString() }}
                  </span>
                  <span v-if="skill.stats.stars" class="flex items-center gap-1">
                    <div class="i-carbon-star w-3 h-3" />
                    {{ skill.stats.stars }}
                  </span>
                  <span v-if="skill.source" class="flex items-center gap-1 font-mono">
                    <div class="i-carbon-logo-github w-3 h-3" />
                    {{ skill.source }}
                  </span>
                  <span v-if="skill.updatedAt">{{ formatDate(skill.updatedAt) }}</span>
                </div>
              </div>
            </div>
          </div>
          </template>
        </template>
      </div>
    </div>

    <!-- ========== LOCAL DETAIL PANEL ========== -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      leave-active-class="transition-all duration-200 ease-in"
      enter-from-class="translate-x-full opacity-0"
      enter-to-class="translate-x-0 opacity-100"
      leave-from-class="translate-x-0 opacity-100"
      leave-to-class="translate-x-full opacity-0"
    >
      <div
        v-if="selectedSkill && activeTab === 'local'"
        class="w-[520px] shrink-0 border-l border-gray-200 dark:border-white/5 bg-white dark:bg-[#1e1e22] h-full overflow-y-auto"
      >
        <div class="sticky top-0 z-10 bg-white/80 dark:bg-[#1e1e22]/80 backdrop-blur-xl border-b border-gray-100 dark:border-white/5 px-5 py-4">
          <div class="flex items-start justify-between">
            <div class="flex-1 min-w-0">
              <h2 class="text-[15px] font-semibold text-gray-900 dark:text-gray-100 truncate">
                {{ selectedSkill.name }}
              </h2>
              <div class="flex items-center gap-2 mt-1">
                <span
                  v-if="selectedSkill.type === 'command'"
                  class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-500/10 text-indigo-500 font-medium"
                >command</span>
                <span class="text-[11px] text-gray-400">
                  {{ installedEnvCount(selectedSkill) }} 个环境已启用
                </span>
              </div>
            </div>
            <button
              class="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors ml-2 shrink-0"
              @click="closeDetail"
            >
              <div class="i-carbon-close w-4 h-4" />
            </button>
          </div>
          <p v-if="selectedSkill.description" class="text-[12px] text-gray-400 mt-2 line-clamp-3">
            {{ selectedSkill.description }}
          </p>
        </div>

        <div class="px-5 py-4 space-y-4">
          <div class="space-y-2">
            <h3 class="text-[12px] font-semibold text-gray-400 uppercase tracking-wider">环境安装状态</h3>
            <div
              v-for="e in envList"
              :key="e.env"
              class="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5"
            >
              <div class="flex items-center gap-2.5">
                <div
                  class="w-6 h-6 rounded-full flex items-center justify-center"
                  :class="selectedSkill.envs[e.env]?.installed
                    ? e.activeClasses
                    : 'bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-gray-500'"
                >
                  <div class="w-3 h-3" :class="e.icon" />
                </div>
                <span class="text-[13px] font-medium text-gray-700 dark:text-gray-200">{{ e.label }}</span>
              </div>
              <button
                v-if="selectedSkill.type !== 'command'"
                class="px-3 py-1 rounded-md text-[12px] font-medium transition-all duration-150"
                :class="selectedSkill.envs[e.env]?.installed
                  ? 'bg-red-50 dark:bg-red-500/10 text-red-500 hover:bg-red-100 dark:hover:bg-red-500/20'
                  : 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-500/20'"
                :disabled="pendingOps.has(`${selectedSkill.id}:${e.env}`)"
                @click="toggleEnv(selectedSkill, e.env)"
              >
                <template v-if="pendingOps.has(`${selectedSkill.id}:${e.env}`)">
                  处理中…
                </template>
                <template v-else>
                  {{ selectedSkill.envs[e.env]?.installed ? '移除' : '启用' }}
                </template>
              </button>
              <span v-else class="text-[11px] text-gray-300">—</span>
            </div>
          </div>

          <div
            v-if="selectedSkill.plugin"
            class="rounded-lg bg-violet-50/50 dark:bg-violet-500/5 border border-violet-100 dark:border-violet-500/10 px-3.5 py-2.5"
          >
            <div class="flex items-center gap-2 mb-1.5">
              <div class="i-carbon-package w-3.5 h-3.5 text-violet-500" />
              <span class="text-[12px] font-medium text-violet-700 dark:text-violet-300">Marketplace Plugin</span>
            </div>
            <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
              <span class="text-violet-400">名称</span>
              <span class="text-violet-600 dark:text-violet-300 font-medium">{{ selectedSkill.plugin.displayName || selectedSkill.plugin.name }}</span>
              <template v-if="selectedSkill.plugin.version">
                <span class="text-violet-400">版本</span>
                <span class="text-violet-600 dark:text-violet-300 font-mono">{{ selectedSkill.plugin.version }}</span>
              </template>
              <template v-if="selectedSkill.plugin.author">
                <span class="text-violet-400">作者</span>
                <span class="text-violet-600 dark:text-violet-300">{{ selectedSkill.plugin.author }}</span>
              </template>
            </div>
          </div>

          <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
            <span class="text-gray-400">类型</span>
            <span class="text-gray-600 dark:text-gray-300">{{ selectedSkill.type === 'command' ? 'Command' : 'Skill' }}</span>
            <span class="text-gray-400">目录名</span>
            <span class="font-mono text-gray-600 dark:text-gray-300">{{ selectedSkill.dirName }}</span>
            <span class="text-gray-400">实际路径</span>
            <span class="font-mono text-gray-500 dark:text-gray-400 break-all text-[11px]">{{ selectedSkill.realDir }}</span>
          </div>

          <div class="border-t border-gray-100 dark:border-white/5 pt-4">
            <h3 class="text-[12px] font-semibold text-gray-400 uppercase tracking-wider mb-3">内容</h3>
            <div v-if="detailLoading" class="flex items-center justify-center py-8">
              <div class="flex items-center gap-2 text-gray-400 text-[13px]">
                <div class="w-3.5 h-3.5 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
                加载中…
              </div>
            </div>
            <div v-else-if="!renderedContent" class="text-center py-8 text-gray-400 text-[13px]">
              无法读取内容
            </div>
            <div
              v-else
              class="prose prose-sm dark:prose-invert max-w-none
                prose-headings:text-gray-800 dark:prose-headings:text-gray-200
                prose-headings:font-semibold prose-headings:tracking-tight
                prose-h1:text-[16px] prose-h1:mt-0 prose-h1:mb-3
                prose-h2:text-[14px] prose-h2:mt-5 prose-h2:mb-2
                prose-h3:text-[13px] prose-h3:mt-4 prose-h3:mb-1.5
                prose-p:text-[13px] prose-p:leading-relaxed prose-p:text-gray-600 dark:prose-p:text-gray-400
                prose-li:text-[13px] prose-li:text-gray-600 dark:prose-li:text-gray-400
                prose-code:text-[12px] prose-code:px-1 prose-code:py-0.5 prose-code:bg-gray-100 dark:prose-code:bg-white/5 prose-code:rounded prose-code:font-mono
                prose-pre:bg-gray-50 dark:prose-pre:bg-white/5 prose-pre:rounded-lg prose-pre:text-[12px]
                prose-a:text-indigo-600 dark:prose-a:text-indigo-400
                prose-strong:text-gray-700 dark:prose-strong:text-gray-300
                prose-table:text-[12px]
                prose-th:text-gray-500 prose-th:font-medium"
              v-html="renderedContent"
            />
          </div>
        </div>
      </div>
    </Transition>

    <!-- ========== STORE DETAIL PANEL ========== -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      leave-active-class="transition-all duration-200 ease-in"
      enter-from-class="translate-x-full opacity-0"
      enter-to-class="translate-x-0 opacity-100"
      leave-from-class="translate-x-0 opacity-100"
      leave-to-class="translate-x-full opacity-0"
    >
      <div
        v-if="(selectedStoreSkill || storeDetailLoading) && activeTab === 'store'"
        class="w-[520px] shrink-0 border-l border-gray-200 dark:border-white/5 bg-white dark:bg-[#1e1e22] h-full overflow-y-auto"
      >
        <!-- Loading state -->
        <div v-if="storeDetailLoading && !selectedStoreSkill" class="flex items-center justify-center h-full">
          <div class="flex items-center gap-2 text-gray-400 text-[13px]">
            <div class="w-3.5 h-3.5 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
            加载中…
          </div>
        </div>

        <template v-else-if="selectedStoreSkill">
          <!-- Header -->
          <div class="sticky top-0 z-10 bg-white/80 dark:bg-[#1e1e22]/80 backdrop-blur-xl border-b border-gray-100 dark:border-white/5 px-5 py-4">
            <div class="flex items-start justify-between">
              <div class="flex-1 min-w-0">
                <h2 class="text-[15px] font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {{ selectedStoreSkill.skill.displayName || selectedStoreSkill.skill.slug }}
                </h2>
                <div class="flex items-center gap-2 mt-1">
                  <span class="text-[11px] text-gray-400 font-mono">{{ selectedStoreSkill.skill.slug }}</span>
                  <span
                    v-if="selectedStoreSkill.installed"
                    class="text-[10px] px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 font-medium"
                  >已安装</span>
                </div>
              </div>
              <button
                class="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors ml-2 shrink-0"
                @click="closeStoreDetail"
              >
                <div class="i-carbon-close w-4 h-4" />
              </button>
            </div>

            <!-- Action buttons: installing → installed → default -->
            <div class="flex items-center gap-2 mt-3">
              <button
                v-if="installingSkills.has(selectedStoreSkill.skill.slug)"
                class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-indigo-500/80 text-white cursor-not-allowed shadow-sm"
                disabled
              >
                <div class="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                安装中…
              </button>
              <button
                v-else-if="selectedStoreSkill.installed"
                class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-red-50 dark:bg-red-500/10 text-red-500 hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors"
                @click="uninstallStoreSkill(selectedStoreSkill.skill.slug)"
              >
                <div class="i-carbon-trash-can w-4 h-4" />
                卸载
              </button>
              <button
                v-else
                class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm"
                @click="installSkill(selectedStoreSkill.skill)"
              >
                <div class="i-carbon-download w-4 h-4" />
                安装到本机
              </button>
            </div>
          </div>

          <div class="px-5 py-4 space-y-4">
            <!-- Owner info -->
            <div
              v-if="selectedStoreSkill.owner"
              class="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5"
            >
              <img
                v-if="selectedStoreSkill.owner.image"
                :src="selectedStoreSkill.owner.image"
                class="w-8 h-8 rounded-full bg-gray-200 dark:bg-white/10"
                :alt="selectedStoreSkill.owner.displayName"
              >
              <div v-else class="w-8 h-8 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center">
                <div class="i-carbon-user w-4 h-4 text-gray-400" />
              </div>
              <div>
                <div class="text-[13px] font-medium text-gray-700 dark:text-gray-200">{{ selectedStoreSkill.owner.displayName }}</div>
                <div class="text-[11px] text-gray-400 font-mono">{{ selectedStoreSkill.owner.handle }}</div>
              </div>
            </div>

            <!-- Stats -->
            <div class="grid grid-cols-4 gap-2">
              <div class="text-center px-2 py-2 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                <div class="text-[16px] font-semibold text-gray-800 dark:text-gray-100">{{ selectedStoreSkill.skill.stats.downloads }}</div>
                <div class="text-[10px] text-gray-400 mt-0.5">下载</div>
              </div>
              <div class="text-center px-2 py-2 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                <div class="text-[16px] font-semibold text-gray-800 dark:text-gray-100">{{ selectedStoreSkill.skill.stats.installs }}</div>
                <div class="text-[10px] text-gray-400 mt-0.5">安装</div>
              </div>
              <div class="text-center px-2 py-2 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                <div class="text-[16px] font-semibold text-gray-800 dark:text-gray-100">{{ selectedStoreSkill.skill.stats.stars }}</div>
                <div class="text-[10px] text-gray-400 mt-0.5">Star</div>
              </div>
              <div class="text-center px-2 py-2 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5">
                <div class="text-[16px] font-semibold text-gray-800 dark:text-gray-100">{{ selectedStoreSkill.skill.stats.versions }}</div>
                <div class="text-[10px] text-gray-400 mt-0.5">版本</div>
              </div>
            </div>

            <!-- Meta -->
            <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
              <span class="text-gray-400">Slug</span>
              <span class="font-mono text-gray-600 dark:text-gray-300">{{ selectedStoreSkill.skill.slug }}</span>
              <template v-if="selectedStoreSkill.latestVersion?.version">
                <span class="text-gray-400">最新版本</span>
                <span class="text-gray-600 dark:text-gray-300">v{{ selectedStoreSkill.latestVersion.version }}</span>
              </template>
              <template v-if="selectedStoreSkill.skill.source">
                <span class="text-gray-400">来源</span>
                <a
                  :href="`https://github.com/${selectedStoreSkill.skill.source}`"
                  target="_blank"
                  class="font-mono text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
                >{{ selectedStoreSkill.skill.source }}</a>
              </template>
              <template v-if="selectedStoreSkill.skill.updatedAt">
                <span class="text-gray-400">更新时间</span>
                <span class="text-gray-600 dark:text-gray-300">{{ formatDate(selectedStoreSkill.skill.updatedAt) }}</span>
              </template>
              <template v-if="selectedStoreSkill.skill.createdAt">
                <span class="text-gray-400">创建时间</span>
                <span class="text-gray-600 dark:text-gray-300">{{ formatDate(selectedStoreSkill.skill.createdAt) }}</span>
              </template>
            </div>

            <!-- Files -->
            <div v-if="selectedStoreSkill.latestVersion?.files?.length" class="border-t border-gray-100 dark:border-white/5 pt-4">
              <h3 class="text-[12px] font-semibold text-gray-400 uppercase tracking-wider mb-2">文件列表</h3>
              <div class="space-y-1">
                <div
                  v-for="file in selectedStoreSkill.latestVersion.files"
                  :key="file.path"
                  class="flex items-center justify-between px-3 py-1.5 rounded-md bg-gray-50 dark:bg-white/[0.02] text-[12px]"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <div class="i-carbon-document w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span class="font-mono text-gray-600 dark:text-gray-300 truncate">{{ file.path }}</span>
                  </div>
                  <span class="text-gray-400 shrink-0 ml-2">{{ formatFileSize(file.size) }}</span>
                </div>
              </div>
            </div>

            <!-- Readme / Changelog -->
            <div v-if="storeDetailRendered" class="border-t border-gray-100 dark:border-white/5 pt-4">
              <h3 class="text-[12px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
                {{ selectedStoreSkill.readme ? '说明文档' : '更新日志' }}
              </h3>
              <div
                class="prose prose-sm dark:prose-invert max-w-none
                  prose-p:text-[13px] prose-p:leading-relaxed prose-p:text-gray-600 dark:prose-p:text-gray-400
                  prose-a:text-indigo-600 dark:prose-a:text-indigo-400"
                v-html="storeDetailRendered"
              />
            </div>
          </div>
        </template>
      </div>
    </Transition>
  </div>
</template>
