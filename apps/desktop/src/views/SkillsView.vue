<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { rpc } from '../composables/use-sidecar'

type ManageableEnv = 'claude' | 'codex' | 'cursor'

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

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

const skills = ref<SkillInfo[]>([])
const envLabels = ref<Record<string, string>>({})
const loading = ref(false)
const searchQuery = ref('')
const activeEnvFilter = ref<ManageableEnv | null>(null)

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

const filteredSkills = computed(() => {
  let result = skills.value

  if (activeEnvFilter.value) {
    result = result.filter(s => s.envs[activeEnvFilter.value!]?.installed)
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
</script>

<template>
  <div class="flex h-full">
    <!-- Main list -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-8" :class="selectedSkill ? 'max-w-none' : 'max-w-5xl mx-auto'">
        <div class="flex items-center justify-between mb-6">
          <div>
            <h1 class="text-xl font-semibold tracking-tight">Skill 管理</h1>
            <p class="text-[13px] text-gray-400 mt-1">
              管理本机 Agent Skills 在各环境的安装状态，通过软链接启用到不同工具
            </p>
          </div>
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-gray-200 dark:border-white/10 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-colors disabled:opacity-40"
            :disabled="loading"
            @click="loadSkills"
          >
            <div class="w-4 h-4" :class="loading ? 'i-carbon-renew animate-spin' : 'i-carbon-renew'" />
            {{ loading ? '扫描中…' : '重新扫描' }}
          </button>
        </div>

        <!-- Filter bar -->
        <div class="flex items-center gap-3 mb-5">
          <div class="flex gap-1.5 flex-wrap flex-1">
            <button
              class="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-150"
              :class="activeEnvFilter === null
                ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-sm'
                : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
              @click="activeEnvFilter = null"
            >
              全部
              <span class="text-[11px] opacity-70">{{ skills.length }}</span>
            </button>
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
            {{ searchQuery || activeEnvFilter ? '未找到匹配的 Skill' : '未发现已安装的 Skill' }}
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
              <!-- Click area: name + description -->
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

              <!-- Env toggle buttons -->
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

              <!-- Detail arrow -->
              <button
                class="w-6 h-6 rounded-md flex items-center justify-center text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                @click="openDetail(skill)"
              >
                <div class="i-carbon-chevron-right w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Detail panel -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      leave-active-class="transition-all duration-200 ease-in"
      enter-from-class="translate-x-full opacity-0"
      enter-to-class="translate-x-0 opacity-100"
      leave-from-class="translate-x-0 opacity-100"
      leave-to-class="translate-x-full opacity-0"
    >
      <div
        v-if="selectedSkill"
        class="w-[520px] shrink-0 border-l border-gray-200 dark:border-white/5 bg-white dark:bg-[#1e1e22] h-full overflow-y-auto"
      >
        <!-- Header -->
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
          <!-- Env toggles (detailed) -->
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

          <!-- Plugin info -->
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

          <!-- Metadata -->
          <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
            <span class="text-gray-400">类型</span>
            <span class="text-gray-600 dark:text-gray-300">{{ selectedSkill.type === 'command' ? 'Command' : 'Skill' }}</span>

            <span class="text-gray-400">目录名</span>
            <span class="font-mono text-gray-600 dark:text-gray-300">{{ selectedSkill.dirName }}</span>

            <span class="text-gray-400">实际路径</span>
            <span class="font-mono text-gray-500 dark:text-gray-400 break-all text-[11px]">{{ selectedSkill.realDir }}</span>
          </div>

          <!-- Content -->
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
  </div>
</template>
