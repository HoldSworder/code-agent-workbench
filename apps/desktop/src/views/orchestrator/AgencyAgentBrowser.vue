<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useOrchestratorStore } from '../../stores/orchestrator'
import type { AgentCatalogItem, AgentPromptDetail } from '../../stores/orchestrator'

const emit = defineEmits<{
  import: [roleId: string, description: string, promptTemplate: string]
  close: []
}>()

const store = useOrchestratorStore()

const selectedCategory = ref('')
const selectedAgent = ref<AgentCatalogItem | null>(null)
const agentDetail = ref<AgentPromptDetail | null>(null)
const detailLoading = ref(false)
const searchQuery = ref('')
const error = ref('')

const CATEGORY_LABELS: Record<string, string> = {
  'engineering': 'Engineering',
  'design': 'Design',
  'marketing': 'Marketing',
  'product': 'Product',
  'project-management': 'Project Management',
  'testing': 'Testing',
  'support': 'Support',
  'sales': 'Sales',
  'spatial-computing': 'Spatial Computing',
  'specialized': 'Specialized',
  'academic': 'Academic',
  'game-development': 'Game Development',
  'paid-media': 'Paid Media',
}

const CATEGORY_ICONS: Record<string, string> = {
  'engineering': 'i-carbon-code',
  'design': 'i-carbon-paint-brush',
  'marketing': 'i-carbon-megaphone',
  'product': 'i-carbon-cube',
  'project-management': 'i-carbon-task',
  'testing': 'i-carbon-chemistry',
  'support': 'i-carbon-help',
  'sales': 'i-carbon-chart-line',
  'spatial-computing': 'i-carbon-view',
  'specialized': 'i-carbon-star',
  'academic': 'i-carbon-education',
  'game-development': 'i-carbon-game-console',
  'paid-media': 'i-carbon-currency-dollar',
}

onMounted(async () => {
  if (!store.agencyCatalog) {
    try {
      await store.fetchAgencyCatalog()
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }
  if (store.agencyCatalog) {
    const cats = Object.keys(store.agencyCatalog.categories)
    if (cats.length > 0)
      selectedCategory.value = cats[0]
  }
})

const sortedCategories = computed(() => {
  if (!store.agencyCatalog) return []
  return Object.keys(store.agencyCatalog.categories).sort((a, b) => {
    const la = CATEGORY_LABELS[a] ?? a
    const lb = CATEGORY_LABELS[b] ?? b
    return la.localeCompare(lb)
  })
})

const filteredAgents = computed(() => {
  if (!store.agencyCatalog || !selectedCategory.value) return []
  const items = store.agencyCatalog.categories[selectedCategory.value] ?? []
  if (!searchQuery.value.trim()) return items
  const q = searchQuery.value.toLowerCase()
  return items.filter(i => i.filename.toLowerCase().includes(q) || i.path.toLowerCase().includes(q))
})

function formatAgentName(filename: string): string {
  return filename
    .replace(/\.md$/, '')
    .replace(/^[^-]+-/, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function deriveRoleId(filename: string): string {
  return filename
    .replace(/\.md$/, '')
    .replace(/^[^-]+-/, '')
    .replace(/-/g, '_')
}

watch(selectedCategory, () => {
  selectedAgent.value = null
  agentDetail.value = null
})

async function selectAgent(item: AgentCatalogItem) {
  selectedAgent.value = item
  agentDetail.value = null
  detailLoading.value = true
  try {
    agentDetail.value = await store.fetchAgentPrompt(item.path)
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    detailLoading.value = false
  }
}

function handleImport() {
  if (!selectedAgent.value || !agentDetail.value) return
  const roleId = deriveRoleId(selectedAgent.value.filename)
  emit('import', roleId, agentDetail.value.description, agentDetail.value.prompt)
}
</script>

<template>
  <div class="ab-overlay" @click.self="emit('close')">
    <div class="ab-panel">
      <!-- Header -->
      <div class="ab-header">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center">
            <div class="i-carbon-catalog w-4.5 h-4.5 text-indigo-500" />
          </div>
          <div>
            <h2 class="text-[14px] font-semibold text-gray-800 dark:text-gray-200">Agency Agents</h2>
            <p class="text-[12px] text-gray-400 dark:text-gray-500">浏览社区 Agent 角色，一键导入到团队配置</p>
          </div>
        </div>
        <button
          class="p-2 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.04] transition-all"
          @click="emit('close')"
        >
          <div class="i-carbon-close w-4 h-4" />
        </button>
      </div>

      <!-- Error -->
      <div v-if="error" class="mx-5 mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-500/10 text-[12px] text-red-600 dark:text-red-400">
        {{ error }}
      </div>

      <!-- Loading catalog -->
      <div v-if="store.catalogLoading" class="flex-1 flex items-center justify-center">
        <div class="text-[13px] text-gray-400 dark:text-gray-500">加载 Agent 目录…</div>
      </div>

      <!-- Content -->
      <div v-else-if="store.agencyCatalog" class="ab-content">
        <!-- Left: Categories -->
        <div class="ab-sidebar">
          <button
            v-for="cat in sortedCategories"
            :key="cat"
            class="ab-cat-item"
            :class="{ 'ab-cat-active': selectedCategory === cat }"
            @click="selectedCategory = cat"
          >
            <div :class="[CATEGORY_ICONS[cat] ?? 'i-carbon-folder', 'w-3.5 h-3.5']" />
            <span class="truncate">{{ CATEGORY_LABELS[cat] ?? cat }}</span>
            <span class="ml-auto text-[10px] opacity-50">{{ store.agencyCatalog!.categories[cat]?.length ?? 0 }}</span>
          </button>
        </div>

        <!-- Right: Agent list + Detail -->
        <div class="ab-main">
          <!-- Search -->
          <div class="ab-search-wrap">
            <div class="i-carbon-search w-3.5 h-3.5 text-gray-300 dark:text-gray-600 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              v-model="searchQuery"
              type="text"
              class="ab-search"
              placeholder="搜索 Agent…"
            >
          </div>

          <!-- Agent list -->
          <div v-if="!selectedAgent" class="ab-list">
            <button
              v-for="item in filteredAgents"
              :key="item.path"
              class="ab-agent-item"
              @click="selectAgent(item)"
            >
              <span class="text-[13px] font-medium text-gray-700 dark:text-gray-300">{{ formatAgentName(item.filename) }}</span>
              <div class="i-carbon-chevron-right w-3 h-3 text-gray-300 dark:text-gray-600 shrink-0" />
            </button>
            <div v-if="filteredAgents.length === 0" class="text-center py-8 text-[13px] text-gray-400 dark:text-gray-500">
              无匹配结果
            </div>
          </div>

          <!-- Agent detail -->
          <div v-else class="ab-detail">
            <button class="ab-back-btn" @click="selectedAgent = null; agentDetail = null">
              <div class="i-carbon-arrow-left w-3.5 h-3.5" />
              返回列表
            </button>

            <div v-if="detailLoading" class="flex-1 flex items-center justify-center">
              <span class="text-[13px] text-gray-400 dark:text-gray-500">加载 Prompt…</span>
            </div>

            <template v-else-if="agentDetail">
              <div class="ab-detail-header">
                <span v-if="agentDetail.emoji" class="text-xl">{{ agentDetail.emoji }}</span>
                <div>
                  <h3 class="text-[14px] font-semibold text-gray-800 dark:text-gray-200">{{ agentDetail.name || formatAgentName(selectedAgent!.filename) }}</h3>
                  <p class="text-[12px] text-gray-400 dark:text-gray-500 mt-0.5">{{ agentDetail.description }}</p>
                </div>
              </div>

              <div class="ab-prompt-preview">
                <label class="block text-[11px] font-medium text-gray-400 dark:text-gray-500 mb-2 uppercase tracking-wider">Prompt Preview</label>
                <pre class="ab-prompt-text">{{ agentDetail.prompt.slice(0, 2000) }}{{ agentDetail.prompt.length > 2000 ? '\n\n…(truncated)' : '' }}</pre>
              </div>

              <div class="ab-detail-footer">
                <div class="text-[12px] text-gray-400 dark:text-gray-500">
                  Role ID: <code class="ab-code">{{ deriveRoleId(selectedAgent!.filename) }}</code>
                </div>
                <button class="ab-import-btn" @click="handleImport">
                  <div class="i-carbon-download w-3.5 h-3.5" />
                  导入为角色
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ab-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
}

.ab-panel {
  width: 860px;
  max-width: 92vw;
  height: 600px;
  max-height: 80vh;
  background: white;
  border-radius: 20px;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
:is(.dark) .ab-panel {
  background: #1e1e22;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.5);
}

.ab-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  flex-shrink: 0;
}
:is(.dark) .ab-header {
  border-bottom-color: rgba(255, 255, 255, 0.04);
}

.ab-content {
  display: flex;
  flex: 1;
  min-height: 0;
}

.ab-sidebar {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid rgba(0, 0, 0, 0.06);
  padding: 12px 8px;
  overflow-y: auto;
}
:is(.dark) .ab-sidebar {
  border-right-color: rgba(255, 255, 255, 0.04);
}

.ab-cat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  color: #6b7280;
  text-align: left;
  transition: all 0.12s;
}
.ab-cat-item:hover {
  background: rgba(0, 0, 0, 0.03);
  color: #374151;
}
:is(.dark) .ab-cat-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: #d1d5db;
}
.ab-cat-active {
  background: rgba(99, 102, 241, 0.08) !important;
  color: #4f46e5 !important;
}
:is(.dark) .ab-cat-active {
  background: rgba(99, 102, 241, 0.12) !important;
  color: #818cf8 !important;
}

.ab-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ab-search-wrap {
  position: relative;
  padding: 12px 16px;
  flex-shrink: 0;
}
.ab-search {
  width: 100%;
  height: 34px;
  padding: 0 12px 0 32px;
  border-radius: 10px;
  background: #f5f5f5;
  border: 1px solid transparent;
  font-size: 13px;
  color: #1f2937;
  outline: none;
  transition: all 0.15s;
}
.ab-search:focus {
  border-color: #6366f1;
  background: white;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.08);
}
:is(.dark) .ab-search {
  background: rgba(255, 255, 255, 0.04);
  color: #e5e7eb;
}
:is(.dark) .ab-search:focus {
  background: rgba(255, 255, 255, 0.06);
}

.ab-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 16px 16px;
}

.ab-agent-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  text-align: left;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.04);
  margin-bottom: 6px;
  transition: all 0.12s;
}
.ab-agent-item:hover {
  border-color: rgba(99, 102, 241, 0.3);
  background: rgba(99, 102, 241, 0.02);
}
:is(.dark) .ab-agent-item {
  border-color: rgba(255, 255, 255, 0.04);
}
:is(.dark) .ab-agent-item:hover {
  border-color: rgba(99, 102, 241, 0.2);
  background: rgba(99, 102, 241, 0.04);
}

.ab-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0 16px 16px;
  overflow-y: auto;
}

.ab-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
  font-weight: 500;
  color: #6b7280;
  transition: color 0.12s;
  flex-shrink: 0;
  margin-bottom: 8px;
}
.ab-back-btn:hover {
  color: #4f46e5;
}

.ab-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  flex-shrink: 0;
}

.ab-prompt-preview {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.ab-prompt-text {
  flex: 1;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.7;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  color: #4b5563;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 12px;
  border-radius: 10px;
  background: #fafafa;
  border: 1px solid rgba(0, 0, 0, 0.04);
}
:is(.dark) .ab-prompt-text {
  background: rgba(255, 255, 255, 0.02);
  border-color: rgba(255, 255, 255, 0.04);
  color: #9ca3af;
}

.ab-detail-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  flex-shrink: 0;
}

.ab-code {
  font-size: 11px;
  padding: 2px 6px;
  background: #f3f4f6;
  border-radius: 5px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
:is(.dark) .ab-code {
  background: rgba(255, 255, 255, 0.05);
}

.ab-import-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  border-radius: 10px;
  background: #4f46e5;
  color: white;
  font-size: 13px;
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(79, 70, 229, 0.3);
  transition: all 0.15s;
}
.ab-import-btn:hover {
  background: #6366f1;
  box-shadow: 0 2px 8px rgba(79, 70, 229, 0.35);
}
.ab-import-btn:active {
  transform: scale(0.97);
}
</style>
