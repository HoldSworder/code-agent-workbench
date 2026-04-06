<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { useReposStore } from '../stores/repos'
import { rpc } from '../composables/use-sidecar'

const reposStore = useReposStore()

onMounted(async () => {
  reposStore.fetchAll()
  await loadSettings()
})

const activeTab = ref<'agent' | 'workflow' | 'repos'>('agent')

// --- Agent config ---
const agentProvider = ref('cursor-cli')
const agentApiKey = ref('')
const agentBaseUrl = ref('https://api.openai.com/v1')
const agentModel = ref('')
const agentBinaryPath = ref('')
interface ModelOption { id: string, label: string }
const availableModels = ref<ModelOption[]>([])
const loadingModels = ref(false)
const saving = ref(false)
const customModelInput = ref(false)

const isApiMode = computed(() => agentProvider.value === 'custom-api')
const isCliMode = computed(() => ['cursor-cli', 'claude-code', 'codex'].includes(agentProvider.value))

const providers = [
  { value: 'cursor-cli', label: 'Cursor CLI' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'custom-api', label: 'Custom API' },
]

async function loadSettings() {
  try {
    const all = await rpc<Record<string, string>>('settings.getAll')
    if (all['agent.provider']) agentProvider.value = all['agent.provider']
    if (all['agent.model']) agentModel.value = all['agent.model']
    if (all['agent.binaryPath']) agentBinaryPath.value = all['agent.binaryPath']
    if (all['agent.apiKey']) agentApiKey.value = all['agent.apiKey']
    if (all['agent.baseUrl']) agentBaseUrl.value = all['agent.baseUrl']
    // non-blocking: fetch models in background (can take 20+ seconds)
    fetchModels()
  }
  catch { /* sidecar may not be ready */ }
}

async function fetchModels() {
  loadingModels.value = true
  try {
    const res = await rpc<{ models: ModelOption[] }>('agent.listModels')
    availableModels.value = res.models ?? []
    if (agentModel.value && availableModels.value.length > 0) {
      const exists = availableModels.value.some(m => m.id === agentModel.value)
      if (!exists) customModelInput.value = true
    }
  }
  catch {
    availableModels.value = []
  }
  finally {
    loadingModels.value = false
  }
}

watch(agentProvider, () => {
  agentModel.value = ''
  availableModels.value = []
  customModelInput.value = false
  fetchModels()
})

watch(agentModel, (v) => {
  if (v === '__custom__') {
    customModelInput.value = true
    agentModel.value = ''
  }
})

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

// --- Workflow config ---
const workflowYaml = ref(`name: fe-dev-workflow
description: 前端 Spec-Driven 研发工作流

dependencies:
  openspec:
    type: cli
    check: "which openspec"
    install_hint: "npm install -g openspec"
    commands:
      - openspec new change
      - openspec continue
      - openspec validate
      - openspec archive
  superpowers:
    type: skill-pack
    skills:
      brainstorming: superpowers:brainstorming
      test-driven-development: superpowers:test-driven-development
      verification-before-completion: superpowers:verification-before-completion
  fe-specflow:
    type: skill-pack
    skills:
      design-to-opsx: fe-specflow:design-to-opsx
      pull-spec: fe-specflow:pull-spec
      e2e-verify: fe-specflow:e2e-verify

state_inference:
  rules:
    - condition: no_change_dir
      phase: design
    - condition: has_proposal_and_specs_no_tasks
      phase: plan
    - condition: tasks_has_unchecked
      phase: t1-dev
    - condition: tasks_all_checked
      phase: waiting_event
    - condition: e2e_report_pass
      phase: archive

phases:
  - id: design
    name: 设计探索
    requires_confirm: true
    provider: api
    skill: skills/design.md
    invoke_skills:
      - superpowers:brainstorming
      - fe-specflow:design-to-opsx
    invoke_commands:
      - openspec new change "{{change_id}}"

  - id: plan
    name: 任务规划
    requires_confirm: true
    provider: api
    skill: skills/plan.md
    invoke_commands:
      - openspec continue "{{change_id}}"
      - openspec validate "{{change_id}}"

  - id: t1-dev
    name: T1 前端开发
    requires_confirm: false
    provider: external-cli
    skill: skills/t1-dev.md
    invoke_skills:
      - superpowers:test-driven-development
      - superpowers:verification-before-completion
    completion_check: tasks-all-checked

  - id: review
    name: 代码审查
    requires_confirm: true
    provider: api
    skill: skills/review.md

  - id: verify
    name: 验证
    requires_confirm: false
    provider: script
    script: scripts/verify.sh

  - id: mr
    name: 创建 MR
    requires_confirm: true
    provider: script
    script: scripts/gitlab-mr.sh
    args: ["--target", "develop", "--auto-merge"]

events:
  - id: backend-spec-arrived
    name: 后端 Spec 到达
    after_phase: t1-dev
    provider: external-cli
    skill: skills/integration.md
    invoke_skills:
      - fe-specflow:pull-spec
    triggers: ["后端spec到了", "API文档到了"]

  - id: test-spec-arrived
    name: 测试 Spec 到达
    after_phase: t1-dev
    provider: api
    skill: skills/test-spec.md
    invoke_skills:
      - fe-specflow:pull-spec
    triggers: ["测试spec到了", "QA文档到了"]

  - id: e2e-verify
    name: E2E 验证
    after_phase: t1-dev
    provider: external-cli
    skill: skills/e2e.md
    invoke_skills:
      - fe-specflow:e2e-verify
      - superpowers:verification-before-completion
    triggers: ["跑e2e", "浏览器验证"]

  - id: archive
    name: 归档
    after_phase: e2e-verify
    provider: script
    script: scripts/archive.sh
    invoke_commands:
      - openspec archive "{{change_id}}" --yes
    precondition: e2e_report_pass
    triggers: ["归档", "archive"]

trigger_mapping:
  - patterns: ["新需求", "新功能", "开始开发"]
    target: design
  - patterns: ["继续开发", "接着做"]
    target: infer_from_state
  - patterns: ["后端spec", "API文档"]
    target: backend-spec-arrived
  - patterns: ["测试spec", "QA文档"]
    target: test-spec-arrived
  - patterns: ["跑e2e", "浏览器验证"]
    target: e2e-verify
  - patterns: ["归档", "archive"]
    target: archive
`)

function saveWorkflow() {
  // placeholder
}

// --- Repos config ---
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

  const name = folderPath.split('/').filter(Boolean).pop() || 'unknown'
  await reposStore.create({ name, local_path: folderPath, default_branch: 'main' })
}

async function removeRepo(id: string) {
  await reposStore.remove(id)
}

const tabs = [
  { id: 'agent' as const, label: 'Agent 配置', icon: 'i-carbon-bot' },
  { id: 'workflow' as const, label: '工作流配置', icon: 'i-carbon-flow' },
  { id: 'repos' as const, label: '仓库管理', icon: 'i-carbon-folder-details' },
]

const inputClass = 'w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors'
</script>

<template>
  <div class="p-8 max-w-3xl mx-auto">
    <h1 class="text-xl font-semibold tracking-tight mb-6">设置</h1>

    <!-- Tabs -->
    <div class="flex gap-1 mb-6 border-b border-gray-200 dark:border-white/5">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium transition-colors -mb-px"
        :class="activeTab === tab.id
          ? 'border-b-2 border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
          : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
        @click="activeTab = tab.id"
      >
        <div :class="[tab.icon, 'w-4 h-4']" />
        {{ tab.label }}
      </button>
    </div>

    <!-- Agent config -->
    <div v-if="activeTab === 'agent'" class="space-y-5">
      <div>
        <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">Agent Provider</label>
        <select v-model="agentProvider" :class="[inputClass, 'appearance-auto']">
          <option v-for="p in providers" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
      </div>

      <template v-if="isCliMode">
        <div>
          <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">Binary 路径 (可选)</label>
          <input v-model="agentBinaryPath" type="text" :placeholder="agentProvider === 'claude-code' ? 'claude' : agentProvider === 'codex' ? 'codex' : 'cursor'" :class="inputClass">
          <p class="text-[11px] text-gray-400 mt-1">留空使用默认路径</p>
        </div>
        <div>
          <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">模型</label>
          <div class="flex gap-2 items-center">
            <div class="flex-1 relative">
              <select
                v-if="availableModels.length > 0 && !customModelInput"
                v-model="agentModel"
                :class="[inputClass, 'appearance-auto']"
              >
                <option value="">使用默认模型</option>
                <option v-for="m in availableModels" :key="m.id" :value="m.id">
                  {{ m.id }}{{ m.label ? ` — ${m.label}` : '' }}
                </option>
                <option value="__custom__">自定义输入...</option>
              </select>
              <input
                v-else
                v-model="agentModel"
                type="text"
                placeholder="输入模型名称"
                :class="inputClass"
              >
            </div>
            <button
              v-if="customModelInput && availableModels.length > 0"
              class="px-3 py-2 rounded-lg text-[12px] font-medium border border-gray-200 dark:border-white/10 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-colors"
              @click="customModelInput = false; agentModel = ''"
            >
              <div class="i-carbon-list w-4 h-4" />
            </button>
            <button
              class="px-3 py-2 rounded-lg text-[12px] font-medium border border-gray-200 dark:border-white/10 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-colors disabled:opacity-40"
              :disabled="loadingModels"
              title="刷新模型列表"
              @click="fetchModels"
            >
              <div v-if="loadingModels" class="i-carbon-renew w-4 h-4 animate-spin" />
              <div v-else class="i-carbon-renew w-4 h-4" />
            </button>
          </div>
          <p v-if="customModelInput" class="text-[11px] text-gray-400 mt-1">
            手动输入模型名称，点击列表图标切回选择
          </p>
        </div>
      </template>

      <template v-if="isApiMode">
        <div>
          <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">API Key</label>
          <input v-model="agentApiKey" type="password" placeholder="sk-..." :class="inputClass">
        </div>
        <div>
          <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">Base URL</label>
          <input v-model="agentBaseUrl" type="text" placeholder="https://api.openai.com/v1" :class="inputClass">
        </div>
        <div>
          <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">模型</label>
          <input v-model="agentModel" type="text" placeholder="gpt-4o" :class="inputClass">
        </div>
      </template>

      <button
        class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
        :disabled="saving"
        @click="saveAgentConfig"
      >
        {{ saving ? '保存中...' : '保存配置' }}
      </button>
    </div>

    <!-- Workflow config -->
    <div v-if="activeTab === 'workflow'" class="space-y-4">
      <p class="text-[13px] text-gray-400">编辑工作流配置 (workflow.yaml)</p>
      <textarea
        v-model="workflowYaml"
        rows="20"
        class="w-full px-4 py-3 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] font-mono border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors resize-y"
      />
      <button
        class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97]"
        @click="saveWorkflow"
      >
        保存工作流
      </button>
    </div>

    <!-- Repos management -->
    <div v-if="activeTab === 'repos'" class="space-y-4">
      <div class="flex items-center justify-between mb-4">
        <p class="text-[13px] text-gray-400">管理已关联的代码仓库</p>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97]"
          @click="pickAndAddRepo"
        >
          <div class="i-carbon-folder-add w-4 h-4" />
          选择仓库目录
        </button>
      </div>

      <div class="space-y-2">
        <div
          v-for="repo in reposStore.repos"
          :key="repo.id"
          class="flex items-center gap-4 px-4 py-3 bg-white dark:bg-[#28282c] rounded-xl shadow-sm shadow-black/[0.04] dark:shadow-none group transition-all duration-150"
        >
          <div class="i-carbon-folder-details w-5 h-5 text-indigo-500/70 shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="text-[13px] font-medium text-gray-800 dark:text-gray-100">{{ repo.name }}</div>
            <div class="text-[12px] text-gray-400 truncate">{{ repo.local_path }}</div>
          </div>
          <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-2 py-0.5 rounded-md font-mono">{{ repo.default_branch }}</span>
          <button
            class="p-1.5 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all duration-150"
            @click="removeRepo(repo.id)"
          >
            <div class="i-carbon-trash-can w-4 h-4" />
          </button>
        </div>
      </div>

      <div v-if="reposStore.repos.length === 0" class="text-center py-12 text-gray-400">
        <div class="i-carbon-folder-add w-10 h-10 mx-auto mb-2 opacity-30" />
        <p class="text-[13px]">暂无仓库，点击上方按钮选择目录添加</p>
      </div>
    </div>
  </div>
</template>
