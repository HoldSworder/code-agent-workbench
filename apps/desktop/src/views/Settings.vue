<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { isTauri } from '@tauri-apps/api/core'
import { useReposStore } from '../stores/repos'
import { rpc } from '../composables/use-sidecar'
import AgentSelector from '../components/AgentSelector.vue'

const router = useRouter()

const reposStore = useReposStore()

onMounted(async () => {
  reposStore.fetchAll()
  await loadSettings()
})

const activeTab = ref<'agent' | 'proxy' | 'workflow' | 'repos'>('agent')

// --- Agent config ---
const agentProvider = ref('cursor-cli')
const agentApiKey = ref('')
const agentBaseUrl = ref('https://api.openai.com/v1')
const agentModel = ref('')
const agentBinaryPath = ref('')
const saving = ref(false)

const isApiMode = computed(() => agentProvider.value === 'custom-api')
const isCliMode = computed(() => ['cursor-cli', 'claude-code', 'codex'].includes(agentProvider.value))

// --- Proxy config ---
const proxyEnabled = ref(false)
const proxyUrl = ref('')
const savingProxy = ref(false)

async function loadSettings() {
  try {
    const all = await rpc<Record<string, string>>('settings.getAll')
    if (all['agent.provider']) agentProvider.value = all['agent.provider']
    if (all['agent.model']) agentModel.value = all['agent.model']
    if (all['agent.binaryPath']) agentBinaryPath.value = all['agent.binaryPath']
    if (all['agent.apiKey']) agentApiKey.value = all['agent.apiKey']
    if (all['agent.baseUrl']) agentBaseUrl.value = all['agent.baseUrl']
    proxyEnabled.value = all['proxy.enabled'] === 'true'
    if (all['proxy.url']) proxyUrl.value = all['proxy.url']
  }
  catch { /* sidecar may not be ready */ }
}

async function saveAgentConfig() {
  saving.value = true
  try {
    await rpc('settings.set', { key: 'agent.provider', value: agentProvider.value })
    if (agentModel.value)
      await rpc('settings.set', { key: 'agent.model', value: agentModel.value })
    if (agentBinaryPath.value)
      await rpc('settings.set', { key: 'agent.binaryPath', value: agentBinaryPath.value })
    if (isApiMode.value) {
      await rpc('settings.set', { key: 'agent.apiKey', value: agentApiKey.value })
      await rpc('settings.set', { key: 'agent.baseUrl', value: agentBaseUrl.value })
    }
  }
  finally {
    saving.value = false
  }
}

async function saveProxyConfig() {
  savingProxy.value = true
  try {
    await rpc('settings.set', { key: 'proxy.enabled', value: String(proxyEnabled.value) })
    await rpc('settings.set', { key: 'proxy.url', value: proxyUrl.value })
  }
  finally {
    savingProxy.value = false
  }
}

// --- Repos config ---
const showRepoForm = ref(false)
const repoFormMode = ref<'add' | 'edit'>('add')
const repoFormId = ref('')
const repoFormPath = ref('')
const repoFormName = ref('')
const repoFormAlias = ref('')
const repoFormBranch = ref('main')
const repoFormSaving = ref(false)

async function pickAndAddRepo() {
  let folderPath: string | null = null

  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    folderPath = await open({ directory: true, title: '选择仓库目录' }) as string | null
  }
  else {
    folderPath = prompt('输入仓库本地路径')
  }

  if (!folderPath)
    return

  repoFormMode.value = 'add'
  repoFormId.value = ''
  repoFormPath.value = folderPath
  repoFormName.value = folderPath.split('/').filter(Boolean).pop() || 'unknown'
  repoFormAlias.value = ''
  repoFormBranch.value = 'main'
  showRepoForm.value = true
}

function openEditRepo(repo: { id: string, name: string, alias: string | null, default_branch: string }) {
  repoFormMode.value = 'edit'
  repoFormId.value = repo.id
  repoFormPath.value = ''
  repoFormName.value = repo.name
  repoFormAlias.value = repo.alias ?? ''
  repoFormBranch.value = repo.default_branch
  showRepoForm.value = true
}

async function saveRepoForm() {
  repoFormSaving.value = true
  try {
    if (repoFormMode.value === 'add') {
      await reposStore.create({
        name: repoFormName.value,
        alias: repoFormAlias.value || undefined,
        local_path: repoFormPath.value,
        default_branch: repoFormBranch.value,
      })
    }
    else {
      await reposStore.update(repoFormId.value, {
        name: repoFormName.value,
        alias: repoFormAlias.value || null,
        default_branch: repoFormBranch.value,
      })
    }
    showRepoForm.value = false
  }
  finally {
    repoFormSaving.value = false
  }
}

async function removeRepo(id: string) {
  await reposStore.remove(id)
}

const tabs = [
  { id: 'agent' as const, label: 'Agent 配置', icon: 'i-carbon-bot' },
  { id: 'proxy' as const, label: '网络代理', icon: 'i-carbon-connection-signal' },
  { id: 'workflow' as const, label: '工作流配置', icon: 'i-carbon-flow' },
  { id: 'repos' as const, label: '仓库管理', icon: 'i-carbon-folder-details' },
]

const inputClass = 'w-full h-9 px-3 py-2 rounded-xl bg-[#fafafa] dark:bg-white/[0.04] text-[13px] border border-gray-200 dark:border-white/[0.08] placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 focus:bg-white dark:focus:bg-white/[0.06] outline-none transition-all duration-150'

</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-2xl mx-auto px-8 py-8">
      <!-- Header -->
      <div class="mb-8">
        <h1 class="text-xl font-semibold tracking-tight">设置</h1>
        <p class="text-[13px] text-gray-400 dark:text-gray-500 mt-1">管理 Agent、代理、工作流及仓库配置</p>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 p-1 mb-8 bg-gray-100 dark:bg-white/[0.04] rounded-xl">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="flex items-center justify-center gap-1.5 flex-1 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-200"
          :class="activeTab === tab.id
            ? 'bg-white dark:bg-[#28282c] text-gray-900 dark:text-white shadow-sm shadow-black/[0.06] dark:shadow-black/20'
            : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'"
          @click="activeTab = tab.id"
        >
          <div :class="[tab.icon, 'w-3.5 h-3.5']" />
          {{ tab.label }}
        </button>
      </div>

      <!-- Agent config -->
      <Transition name="tab" mode="out-in">
        <div v-if="activeTab === 'agent'" key="agent" class="space-y-6">
          <!-- Provider + Model -->
          <section class="settings-card">
            <div class="settings-card-header">
              <div class="settings-card-icon bg-indigo-50 dark:bg-indigo-500/10">
                <div class="i-carbon-bot w-4 h-4 text-indigo-500" />
              </div>
              <div>
                <h3 class="settings-card-title">Agent Provider</h3>
                <p class="settings-card-desc">选择 AI 编码助手的后端引擎和模型</p>
              </div>
            </div>
            <div class="settings-card-body">
              <AgentSelector
                :provider="agentProvider"
                :model="agentModel"
                show-api-option
                @update:provider="agentProvider = $event"
                @update:model="agentModel = $event"
              />
            </div>
          </section>

          <!-- CLI Binary path -->
          <section v-if="isCliMode" class="settings-card">
            <div class="settings-card-header">
              <div class="settings-card-icon bg-emerald-50 dark:bg-emerald-500/10">
                <div class="i-carbon-terminal w-4 h-4 text-emerald-500" />
              </div>
              <div>
                <h3 class="settings-card-title">CLI 配置</h3>
                <p class="settings-card-desc">设置命令行工具路径</p>
              </div>
            </div>
            <div class="settings-card-body">
              <div>
                <label class="settings-label">Binary 路径</label>
                <div class="relative">
                  <div class="absolute left-3 top-1/2 -translate-y-1/2 i-carbon-terminal w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
                  <input
                    v-model="agentBinaryPath"
                    type="text"
                    :placeholder="agentProvider === 'claude-code' ? 'claude' : agentProvider === 'codex' ? 'codex' : 'agent'"
                    :class="[inputClass, 'pl-9']"
                  >
                </div>
                <p class="settings-hint">留空使用默认路径</p>
              </div>
            </div>
          </section>

          <!-- API settings -->
          <section v-if="isApiMode" class="settings-card">
            <div class="settings-card-header">
              <div class="settings-card-icon bg-violet-50 dark:bg-violet-500/10">
                <div class="i-carbon-api w-4 h-4 text-violet-500" />
              </div>
              <div>
                <h3 class="settings-card-title">API 配置</h3>
                <p class="settings-card-desc">自定义 API 端点和认证信息</p>
              </div>
            </div>
            <div class="settings-card-body space-y-5">
              <div>
                <label class="settings-label">API Key</label>
                <div class="relative">
                  <div class="absolute left-3 top-1/2 -translate-y-1/2 i-carbon-password w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
                  <input v-model="agentApiKey" type="password" placeholder="sk-..." :class="[inputClass, 'pl-9']">
                </div>
              </div>
              <div>
                <label class="settings-label">Base URL</label>
                <div class="relative">
                  <div class="absolute left-3 top-1/2 -translate-y-1/2 i-carbon-cloud w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
                  <input v-model="agentBaseUrl" type="text" placeholder="https://api.openai.com/v1" :class="[inputClass, 'pl-9']">
                </div>
              </div>
              <div>
                <label class="settings-label">模型</label>
                <div class="relative">
                  <div class="absolute left-3 top-1/2 -translate-y-1/2 i-carbon-machine-learning-model w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
                  <input v-model="agentModel" type="text" placeholder="gpt-4o" :class="[inputClass, 'pl-9']">
                </div>
              </div>
            </div>
          </section>

          <!-- Save -->
          <div class="flex justify-end">
            <button
              class="settings-save-btn"
              :disabled="saving"
              @click="saveAgentConfig"
            >
              <div v-if="saving" class="i-carbon-circle-dash w-3.5 h-3.5 animate-spin" />
              <div v-else class="i-carbon-checkmark w-3.5 h-3.5" />
              {{ saving ? '保存中...' : '保存配置' }}
            </button>
          </div>
        </div>

        <!-- Proxy config -->
        <div v-else-if="activeTab === 'proxy'" key="proxy" class="space-y-6">
          <section class="settings-card">
            <div class="settings-card-header">
              <div class="settings-card-icon bg-sky-50 dark:bg-sky-500/10">
                <div class="i-carbon-connection-signal w-4 h-4 text-sky-500" />
              </div>
              <div class="flex-1">
                <h3 class="settings-card-title">网络代理</h3>
                <p class="settings-card-desc">部分模型（如 Claude）可能需要通过代理访问</p>
              </div>
              <button
                class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none"
                :class="proxyEnabled ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-white/10'"
                @click="proxyEnabled = !proxyEnabled"
              >
                <span
                  class="pointer-events-none inline-block h-5 w-5 mt-0.5 rounded-full bg-white shadow-sm transform transition-transform duration-200 ease-in-out"
                  :class="proxyEnabled ? 'translate-x-5' : 'translate-x-0.5'"
                />
              </button>
            </div>
            <div
              class="settings-card-body transition-all duration-200"
              :class="proxyEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'"
            >
              <div>
                <label class="settings-label">代理地址</label>
                <div class="relative">
                  <div class="absolute left-3 top-1/2 -translate-y-1/2 i-carbon-network-4 w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
                  <input
                    v-model="proxyUrl"
                    type="text"
                    placeholder="http://127.0.0.1:7890"
                    :class="[inputClass, 'pl-9']"
                  >
                </div>
                <p class="settings-hint">
                  支持 HTTP / HTTPS / SOCKS5，如
                  <code class="settings-code">http://127.0.0.1:7890</code>
                  <code class="settings-code">socks5://127.0.0.1:1080</code>
                </p>
              </div>
            </div>
          </section>

          <div class="flex justify-end">
            <button
              class="settings-save-btn"
              :disabled="savingProxy"
              @click="saveProxyConfig"
            >
              <div v-if="savingProxy" class="i-carbon-circle-dash w-3.5 h-3.5 animate-spin" />
              <div v-else class="i-carbon-checkmark w-3.5 h-3.5" />
              {{ savingProxy ? '保存中...' : '保存配置' }}
            </button>
          </div>
        </div>

        <!-- Workflow config -->
        <div v-else-if="activeTab === 'workflow'" key="workflow" class="space-y-6">
          <section class="settings-card">
            <div class="settings-card-header">
              <div class="settings-card-icon bg-amber-50 dark:bg-amber-500/10">
                <div class="i-carbon-flow w-4 h-4 text-amber-500" />
              </div>
              <div class="flex-1">
                <h3 class="settings-card-title">工作流配置</h3>
                <p class="settings-card-desc">可视化编辑研发工作流的阶段、Phase 与规则</p>
              </div>
            </div>
            <div class="settings-card-body">
              <div class="flex flex-col items-center justify-center py-10">
                <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/20">
                  <div class="i-carbon-flow w-7 h-7 text-white" />
                </div>
                <p class="text-[13px] text-gray-600 dark:text-gray-300 mb-1 font-medium">可视化工作流编辑器</p>
                <p class="text-[12px] text-gray-400 dark:text-gray-500 mb-5">通过可视化界面配置 Stages、Phases、护栏和触发器</p>
                <button
                  class="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all active:scale-[0.97]"
                  @click="router.push('/workflow')"
                >
                  <div class="i-carbon-launch w-4 h-4" />
                  打开工作流编辑器
                </button>
              </div>
            </div>
          </section>
        </div>

        <!-- Repos management -->
        <div v-else-if="activeTab === 'repos'" key="repos" class="space-y-6">
          <section class="settings-card">
            <div class="settings-card-header">
              <div class="settings-card-icon bg-teal-50 dark:bg-teal-500/10">
                <div class="i-carbon-folder-details w-4 h-4 text-teal-500" />
              </div>
              <div class="flex-1">
                <h3 class="settings-card-title">仓库管理</h3>
                <p class="settings-card-desc">
                  已关联 {{ reposStore.repos.length }} 个代码仓库
                </p>
              </div>
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[12px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97]"
                @click="pickAndAddRepo"
              >
                <div class="i-carbon-add w-3.5 h-3.5" />
                添加仓库
              </button>
            </div>
            <div class="settings-card-body !pt-0">
              <div v-if="reposStore.repos.length > 0" class="divide-y divide-gray-100 dark:divide-white/[0.04]">
                <div
                  v-for="repo in reposStore.repos"
                  :key="repo.id"
                  class="flex items-center gap-3.5 py-3.5 group"
                >
                  <div class="w-9 h-9 rounded-xl bg-gray-100 dark:bg-white/[0.04] flex items-center justify-center shrink-0">
                    <div class="i-carbon-logo-github w-4.5 h-4.5 text-gray-400 dark:text-gray-500" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-[13px] font-medium text-gray-800 dark:text-gray-100">{{ repo.alias || repo.name }}</span>
                      <span v-if="repo.alias" class="text-[11px] text-gray-400 dark:text-gray-500">({{ repo.name }})</span>
                    </div>
                    <div class="text-[11px] text-gray-400 dark:text-gray-500 truncate font-mono mt-0.5">{{ repo.local_path }}</div>
                  </div>
                  <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/[0.04] px-2 py-0.5 rounded-md font-mono shrink-0">
                    {{ repo.default_branch }}
                  </span>
                  <button
                    class="p-1.5 rounded-lg text-gray-300 dark:text-gray-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 opacity-0 group-hover:opacity-100 transition-all duration-150"
                    @click="openEditRepo(repo)"
                  >
                    <div class="i-carbon-edit w-3.5 h-3.5" />
                  </button>
                  <button
                    class="p-1.5 rounded-lg text-gray-300 dark:text-gray-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all duration-150"
                    @click="removeRepo(repo.id)"
                  >
                    <div class="i-carbon-trash-can w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div v-else class="flex flex-col items-center justify-center py-14 text-gray-300 dark:text-gray-600">
                <div class="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-white/[0.03] flex items-center justify-center mb-3">
                  <div class="i-carbon-folder-add w-6 h-6 opacity-40" />
                </div>
                <p class="text-[13px] text-gray-400 dark:text-gray-500">暂无仓库</p>
                <p class="text-[12px] text-gray-300 dark:text-gray-600 mt-0.5">点击上方按钮选择目录添加</p>
              </div>
            </div>
          </section>

          <!-- Repo add/edit dialog -->
          <Teleport to="body">
            <Transition
              enter-active-class="transition-all duration-200 ease-out"
              leave-active-class="transition-all duration-150 ease-in"
              enter-from-class="opacity-0"
              leave-to-class="opacity-0"
            >
              <div
                v-if="showRepoForm"
                class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
                @click.self="showRepoForm = false"
              >
                <Transition
                  appear
                  enter-active-class="transition-all duration-200 ease-out"
                  enter-from-class="opacity-0 scale-95 translate-y-2"
                >
                  <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-md p-6">
                    <div class="flex items-center gap-3 mb-5">
                      <div class="w-10 h-10 rounded-full bg-teal-50 dark:bg-teal-500/10 flex items-center justify-center shrink-0">
                        <div class="i-carbon-folder-details w-5 h-5 text-teal-500" />
                      </div>
                      <div>
                        <h2 class="text-base font-semibold">{{ repoFormMode === 'add' ? '添加仓库' : '编辑仓库' }}</h2>
                        <p v-if="repoFormMode === 'add'" class="text-[13px] text-gray-400 mt-0.5 truncate max-w-[300px]">{{ repoFormPath }}</p>
                      </div>
                    </div>

                    <div class="space-y-4 mb-6">
                      <div>
                        <label class="block text-[12px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">仓库名称</label>
                        <input
                          v-model="repoFormName"
                          type="text"
                          placeholder="仓库名称"
                          :class="inputClass"
                        >
                      </div>
                      <div>
                        <label class="block text-[12px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                          别名
                          <span class="text-gray-300 dark:text-gray-600 font-normal ml-1">可选，设置后将优先显示</span>
                        </label>
                        <input
                          v-model="repoFormAlias"
                          type="text"
                          placeholder="例如：前端主仓库"
                          :class="inputClass"
                        >
                      </div>
                      <div>
                        <label class="block text-[12px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">默认分支</label>
                        <input
                          v-model="repoFormBranch"
                          type="text"
                          placeholder="main"
                          :class="inputClass"
                        >
                      </div>
                    </div>

                    <div class="flex justify-end gap-2">
                      <button
                        class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                        @click="showRepoForm = false"
                      >
                        取消
                      </button>
                      <button
                        class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                        :disabled="!repoFormName.trim() || repoFormSaving"
                        @click="saveRepoForm"
                      >
                        <div v-if="repoFormSaving" class="i-carbon-circle-dash w-4 h-4 animate-spin" />
                        <div v-else class="i-carbon-checkmark w-4 h-4" />
                        {{ repoFormSaving ? '保存中...' : '保存' }}
                      </button>
                    </div>
                  </div>
                </Transition>
              </div>
            </Transition>
          </Teleport>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.settings-card {
  background: white;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
:is(.dark) .settings-card {
  background: #28282c;
  border-color: rgba(255, 255, 255, 0.04);
  box-shadow: none;
}

.settings-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
:is(.dark) .settings-card-header {
  border-bottom-color: rgba(255, 255, 255, 0.04);
}

.settings-card-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.settings-card-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
  line-height: 1.3;
}
:is(.dark) .settings-card-title {
  color: #e5e7eb;
}

.settings-card-desc {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 1px;
}
:is(.dark) .settings-card-desc {
  color: #6b7280;
}

.settings-card-body {
  padding: 16px 20px;
}

.settings-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #6b7280;
  margin-bottom: 6px;
}
:is(.dark) .settings-label {
  color: #9ca3af;
}

.settings-hint {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 4px;
  line-height: 1.5;
}
:is(.dark) .settings-hint {
  color: #6b7280;
}

.settings-code {
  font-size: 11px;
  padding: 1px 5px;
  background: #f3f4f6;
  border-radius: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
:is(.dark) .settings-code {
  background: rgba(255, 255, 255, 0.05);
}

.settings-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  color: #9ca3af;
  transition: all 0.15s;
  flex-shrink: 0;
}
.settings-icon-btn:hover {
  color: #6366f1;
  border-color: #c7d2fe;
  background: #eef2ff;
}
:is(.dark) .settings-icon-btn {
  border-color: rgba(255, 255, 255, 0.08);
}
:is(.dark) .settings-icon-btn:hover {
  color: #818cf8;
  border-color: rgba(99, 102, 241, 0.3);
  background: rgba(99, 102, 241, 0.06);
}

.settings-save-btn {
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
.settings-save-btn:hover {
  background: #6366f1;
  box-shadow: 0 2px 8px rgba(79, 70, 229, 0.35);
}
.settings-save-btn:active {
  transform: scale(0.97);
}
.settings-save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tab-enter-active,
.tab-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.tab-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.tab-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

</style>
