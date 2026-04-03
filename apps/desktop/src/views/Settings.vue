<script setup lang="ts">
import { ref, computed } from 'vue'

const activeTab = ref<'agent' | 'workflow' | 'repos'>('agent')

// --- Agent config ---
const agentProvider = ref('cursor-cli')
const agentApiKey = ref('')
const agentBaseUrl = ref('https://api.openai.com/v1')
const agentModel = ref('gpt-4o')
const agentBinaryPath = ref('/usr/local/bin/cursor')

const isApiMode = computed(() => agentProvider.value === 'custom-api')
const isCliMode = computed(() => ['cursor-cli', 'claude-code', 'codex'].includes(agentProvider.value))

const providers = [
  { value: 'cursor-cli', label: 'Cursor CLI' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'custom-api', label: 'Custom API' },
]

function saveAgentConfig() {
  // placeholder
}

// --- Workflow config ---
const workflowYaml = ref(`phases:
  - id: design
    name: 设计
    prompt_template: design.md
    confirm: true

  - id: plan
    name: 计划
    prompt_template: plan.md
    confirm: true

  - id: t1-dev
    name: T1 开发
    prompt_template: t1-dev.md
    confirm: false

  - id: review
    name: 评审
    prompt_template: review.md
    confirm: true

  - id: verify
    name: 验证
    prompt_template: verify.md
    confirm: true

  - id: mr
    name: 合并请求
    prompt_template: mr.md
    confirm: true
`)

function saveWorkflow() {
  // placeholder
}

// --- Repos config ---
interface RepoEntry {
  id: string
  name: string
  localPath: string
  defaultBranch: string
}

const repos = ref<RepoEntry[]>([
  { id: '1', name: 'frontend-app', localPath: '/Users/dev/code/frontend', defaultBranch: 'main' },
  { id: '2', name: 'backend-api', localPath: '/Users/dev/code/backend', defaultBranch: 'main' },
  { id: '3', name: 'shared-lib', localPath: '/Users/dev/code/shared', defaultBranch: 'develop' },
])

const newRepo = ref({ name: '', localPath: '', defaultBranch: 'main' })
const showAddRepo = ref(false)

function addRepo() {
  if (!newRepo.value.name || !newRepo.value.localPath)
    return
  repos.value.push({
    id: String(Date.now()),
    name: newRepo.value.name,
    localPath: newRepo.value.localPath,
    defaultBranch: newRepo.value.defaultBranch,
  })
  newRepo.value = { name: '', localPath: '', defaultBranch: 'main' }
  showAddRepo.value = false
}

function removeRepo(id: string) {
  repos.value = repos.value.filter(r => r.id !== id)
}

const tabs = [
  { id: 'agent' as const, label: 'Agent 配置', icon: 'i-carbon-bot' },
  { id: 'workflow' as const, label: '工作流配置', icon: 'i-carbon-flow' },
  { id: 'repos' as const, label: '仓库管理', icon: 'i-carbon-folder-details' },
]
</script>

<template>
  <div class="p-6 max-w-3xl mx-auto">
    <h1 class="text-2xl font-bold tracking-tight mb-6">设置</h1>

    <!-- Tabs -->
    <div class="flex gap-1 mb-6 border-b border-gray-200 dark:border-gray-800">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors -mb-px"
        :class="activeTab === tab.id
          ? 'border-b-2 border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
        @click="activeTab = tab.id"
      >
        <div :class="[tab.icon, 'w-4 h-4']" />
        {{ tab.label }}
      </button>
    </div>

    <!-- Agent config -->
    <div v-if="activeTab === 'agent'" class="space-y-5">
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Agent Provider</label>
        <select
          v-model="agentProvider"
          class="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option v-for="p in providers" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
      </div>

      <template v-if="isCliMode">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Binary 路径</label>
          <input
            v-model="agentBinaryPath"
            type="text"
            placeholder="/usr/local/bin/cursor"
            class="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
        </div>
      </template>

      <template v-if="isApiMode">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">API Key</label>
          <input
            v-model="agentApiKey"
            type="password"
            placeholder="sk-..."
            class="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Base URL</label>
          <input
            v-model="agentBaseUrl"
            type="text"
            placeholder="https://api.openai.com/v1"
            class="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">模型</label>
          <input
            v-model="agentModel"
            type="text"
            placeholder="gpt-4o"
            class="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
        </div>
      </template>

      <button
        class="px-4 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        @click="saveAgentConfig"
      >
        保存配置
      </button>
    </div>

    <!-- Workflow config -->
    <div v-if="activeTab === 'workflow'" class="space-y-4">
      <p class="text-sm text-gray-500">编辑工作流配置 (workflow.yaml)</p>
      <textarea
        v-model="workflowYaml"
        rows="20"
        class="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
      />
      <button
        class="px-4 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        @click="saveWorkflow"
      >
        保存工作流
      </button>
    </div>

    <!-- Repos management -->
    <div v-if="activeTab === 'repos'" class="space-y-4">
      <div class="flex items-center justify-between mb-2">
        <p class="text-sm text-gray-500">管理已关联的代码仓库</p>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
          @click="showAddRepo = !showAddRepo"
        >
          <div class="i-carbon-add w-4 h-4" />
          添加仓库
        </button>
      </div>

      <!-- Add repo form -->
      <Transition
        enter-active-class="transition-all duration-200"
        leave-active-class="transition-all duration-150"
        enter-from-class="opacity-0 -translate-y-2"
        leave-to-class="opacity-0 -translate-y-2"
      >
        <div v-if="showAddRepo" class="bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">仓库名</label>
              <input
                v-model="newRepo.name"
                type="text"
                placeholder="my-repo"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">本地路径</label>
              <input
                v-model="newRepo.localPath"
                type="text"
                placeholder="/path/to/repo"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">默认分支</label>
              <input
                v-model="newRepo.defaultBranch"
                type="text"
                placeholder="main"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button
              class="px-3 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              @click="showAddRepo = false"
            >
              取消
            </button>
            <button
              class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
              @click="addRepo"
            >
              添加
            </button>
          </div>
        </div>
      </Transition>

      <!-- Repo list -->
      <div class="space-y-2">
        <div
          v-for="repo in repos"
          :key="repo.id"
          class="flex items-center gap-4 px-4 py-3 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 group"
        >
          <div class="i-carbon-folder-details w-5 h-5 text-indigo-500 shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ repo.name }}</div>
            <div class="text-xs text-gray-400 truncate">{{ repo.localPath }}</div>
          </div>
          <span class="text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">{{ repo.defaultBranch }}</span>
          <button
            class="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 opacity-0 group-hover:opacity-100 transition-all"
            @click="removeRepo(repo.id)"
          >
            <div class="i-carbon-trash-can w-4 h-4" />
          </button>
        </div>
      </div>

      <div v-if="repos.length === 0" class="text-center py-8 text-gray-400 text-sm">
        <div class="i-carbon-folder-add w-10 h-10 mx-auto mb-2 opacity-40" />
        <p>暂无仓库，点击上方按钮添加</p>
      </div>
    </div>
  </div>
</template>
