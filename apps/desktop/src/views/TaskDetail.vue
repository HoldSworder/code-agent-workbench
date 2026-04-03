<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const taskId = route.params.taskId as string
const repoId = route.params.repoId as string

const activeTab = ref<'files' | 'chat'>('files')

const mockTask = {
  id: taskId,
  requirementTitle: '用户登录流程重构',
  branchName: 'feat/login-refactor',
  currentPhase: 'review',
  phaseStatus: 'waiting_confirm',
  changeId: 'CHG-001',
}

// --- File tree mock ---
interface FileNode {
  name: string
  type: 'file' | 'dir'
  children?: FileNode[]
  content?: string
}

const fileTree: FileNode[] = [
  {
    name: 'openspec',
    type: 'dir',
    children: [
      { name: 'proposal.md', type: 'file', content: '# 用户登录流程重构\n\n## 目标\n重构现有登录逻辑，支持 OAuth2 和手机号验证码登录。\n\n## 范围\n- 前端登录页面重写\n- 新增 OAuth2 回调处理\n- 手机号验证码发送与校验\n\n## 技术方案\n使用 Vue3 Composition API + Pinia 管理登录态。' },
      {
        name: 'specs',
        type: 'dir',
        children: [
          { name: 'login-page.spec.md', type: 'file', content: '# 登录页面 Spec\n\n## 组件结构\n- LoginForm\n- OAuthButtons\n- PhoneVerification\n\n## 接口\n- POST /api/auth/login\n- POST /api/auth/send-code\n- GET /api/auth/oauth/callback' },
          { name: 'oauth-flow.spec.md', type: 'file', content: '# OAuth 流程 Spec\n\n## 支持的 Provider\n- GitHub\n- Google\n- 飞书\n\n## 流程\n1. 用户点击 OAuth 按钮\n2. 重定向到第三方授权页面\n3. 回调处理 token 交换' },
        ],
      },
      { name: 'plan.md', type: 'file', content: '# 实施计划\n\n## Phase 1: 基础登录页面\n- [ ] 创建 LoginForm 组件\n- [ ] 接入密码登录接口\n\n## Phase 2: OAuth 支持\n- [ ] 实现 OAuthButtons\n- [ ] 处理回调逻辑\n\n## Phase 3: 手机号登录\n- [ ] 验证码发送组件\n- [ ] 倒计时逻辑' },
    ],
  },
]

const selectedFile = ref<FileNode | null>(null)
const expandedDirs = ref<Set<string>>(new Set(['openspec', 'specs']))

function toggleDir(name: string) {
  if (expandedDirs.value.has(name))
    expandedDirs.value.delete(name)
  else
    expandedDirs.value.add(name)
}

function selectFile(node: FileNode) {
  if (node.type === 'file')
    selectedFile.value = node
}

// --- Chat mock ---
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

const mockMessages: ChatMessage[] = [
  { id: 'm1', role: 'assistant', content: '已完成登录页面的设计稿评审。主要修改包括：\n\n1. 新增 OAuth 按钮组件\n2. 调整表单布局为垂直居中\n3. 添加手机号输入框和验证码输入', createdAt: '2025-04-03T10:00:00Z' },
  { id: 'm2', role: 'user', content: '请将 OAuth 按钮放在表单下方，并添加分割线', createdAt: '2025-04-03T10:05:00Z' },
  { id: 'm3', role: 'assistant', content: '好的，已按要求调整布局：\n\n- OAuth 按钮移至表单下方\n- 添加了 "或使用以下方式登录" 分割线\n- 按钮间距调整为 12px\n\n当前阶段已完成，等待您确认后进入下一阶段。', createdAt: '2025-04-03T10:10:00Z' },
]

const chatInput = ref('')

function sendMessage() {
  if (!chatInput.value.trim())
    return
  chatInput.value = ''
}

// --- Confirm bar ---
function handleConfirm() {
  // placeholder
}

function handleFeedback() {
  // placeholder
}

function handleCancel() {
  router.push(`/repo/${repoId}`)
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Header -->
    <div class="flex items-center gap-3 px-6 py-4 border-b border-gray-200 dark:border-gray-800">
      <button
        class="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        @click="router.push(`/repo/${repoId}`)"
      >
        <div class="i-carbon-arrow-left w-5 h-5 text-gray-500" />
      </button>
      <div class="flex-1 min-w-0">
        <h1 class="text-lg font-semibold truncate">{{ mockTask.requirementTitle }}</h1>
        <div class="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
          <span>{{ mockTask.branchName }}</span>
          <span class="text-gray-300 dark:text-gray-600">·</span>
          <span>{{ mockTask.changeId }}</span>
          <span
            class="px-2 py-0.5 rounded-full font-medium"
            :class="mockTask.phaseStatus === 'waiting_confirm'
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
              : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300'"
          >
            {{ mockTask.currentPhase }} · {{ mockTask.phaseStatus === 'waiting_confirm' ? '待确认' : '运行中' }}
          </span>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 px-6 pt-3 border-b border-gray-200 dark:border-gray-800">
      <button
        class="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors"
        :class="activeTab === 'files'
          ? 'bg-white dark:bg-gray-900 border border-b-white dark:border-gray-800 dark:border-b-gray-900 text-indigo-600 dark:text-indigo-400'
          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
        @click="activeTab = 'files'"
      >
        <div class="flex items-center gap-1.5">
          <div class="i-carbon-document w-4 h-4" />
          文件
        </div>
      </button>
      <button
        class="px-4 py-2 text-sm font-medium rounded-t-lg transition-colors"
        :class="activeTab === 'chat'
          ? 'bg-white dark:bg-gray-900 border border-b-white dark:border-gray-800 dark:border-b-gray-900 text-indigo-600 dark:text-indigo-400'
          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
        @click="activeTab = 'chat'"
      >
        <div class="flex items-center gap-1.5">
          <div class="i-carbon-chat w-4 h-4" />
          对话
        </div>
      </button>
    </div>

    <!-- Content area -->
    <div class="flex-1 overflow-hidden">
      <!-- Files tab -->
      <div v-if="activeTab === 'files'" class="flex h-full">
        <!-- File tree -->
        <div class="w-56 border-r border-gray-200 dark:border-gray-800 overflow-y-auto py-2 bg-gray-50/50 dark:bg-gray-950/50">
          <template v-for="node in fileTree" :key="node.name">
            <div
              class="flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              :class="node.type === 'dir' ? 'font-medium text-gray-700 dark:text-gray-300' : 'text-gray-600 dark:text-gray-400'"
              @click="node.type === 'dir' ? toggleDir(node.name) : selectFile(node)"
            >
              <div
                v-if="node.type === 'dir'"
                :class="expandedDirs.has(node.name) ? 'i-carbon-chevron-down' : 'i-carbon-chevron-right'"
                class="w-3 h-3 text-gray-400"
              />
              <div :class="node.type === 'dir' ? 'i-carbon-folder w-4 h-4 text-indigo-500' : 'i-carbon-document w-4 h-4 text-gray-400'" />
              {{ node.name }}
            </div>
            <template v-if="node.type === 'dir' && expandedDirs.has(node.name) && node.children">
              <template v-for="child in node.children" :key="child.name">
                <div
                  class="flex items-center gap-1.5 pl-7 pr-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  :class="[
                    child.type === 'dir' ? 'font-medium text-gray-700 dark:text-gray-300' : 'text-gray-600 dark:text-gray-400',
                    selectedFile?.name === child.name ? 'bg-indigo-50 dark:bg-indigo-950 !text-indigo-600 dark:!text-indigo-400' : '',
                  ]"
                  @click="child.type === 'dir' ? toggleDir(child.name) : selectFile(child)"
                >
                  <div
                    v-if="child.type === 'dir'"
                    :class="expandedDirs.has(child.name) ? 'i-carbon-chevron-down' : 'i-carbon-chevron-right'"
                    class="w-3 h-3 text-gray-400"
                  />
                  <div :class="child.type === 'dir' ? 'i-carbon-folder w-4 h-4 text-indigo-500' : 'i-carbon-document w-4 h-4 text-gray-400'" />
                  {{ child.name }}
                </div>
                <template v-if="child.type === 'dir' && expandedDirs.has(child.name) && child.children">
                  <div
                    v-for="leaf in child.children"
                    :key="leaf.name"
                    class="flex items-center gap-1.5 pl-12 pr-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    :class="selectedFile?.name === leaf.name ? 'bg-indigo-50 dark:bg-indigo-950 !text-indigo-600 dark:!text-indigo-400' : 'text-gray-600 dark:text-gray-400'"
                    @click="selectFile(leaf)"
                  >
                    <div class="i-carbon-document w-4 h-4 text-gray-400" />
                    {{ leaf.name }}
                  </div>
                </template>
              </template>
            </template>
          </template>
        </div>

        <!-- File content -->
        <div class="flex-1 overflow-y-auto p-6">
          <div v-if="selectedFile" class="max-w-3xl">
            <div class="flex items-center gap-2 mb-4">
              <div class="i-carbon-document w-4 h-4 text-gray-400" />
              <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ selectedFile.name }}</span>
            </div>
            <div class="prose prose-sm dark:prose-invert max-w-none">
              <pre class="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800">{{ selectedFile.content }}</pre>
            </div>
          </div>
          <div v-else class="flex items-center justify-center h-full text-gray-400 text-sm">
            <div class="text-center">
              <div class="i-carbon-document-blank w-10 h-10 mx-auto mb-2 opacity-40" />
              <p>选择左侧文件查看内容</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Chat tab -->
      <div v-if="activeTab === 'chat'" class="flex flex-col h-full">
        <div class="flex-1 overflow-y-auto p-6 space-y-4">
          <div
            v-for="msg in mockMessages"
            :key="msg.id"
            class="flex"
            :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div
              class="max-w-md rounded-xl px-4 py-3 text-sm"
              :class="msg.role === 'user'
                ? 'bg-indigo-600 text-white rounded-br-sm'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-bl-sm'"
            >
              <pre class="whitespace-pre-wrap font-sans">{{ msg.content }}</pre>
              <div
                class="text-xs mt-1.5 text-right"
                :class="msg.role === 'user' ? 'text-indigo-200' : 'text-gray-400'"
              >
                {{ formatTime(msg.createdAt) }}
              </div>
            </div>
          </div>
        </div>

        <!-- Input -->
        <div class="border-t border-gray-200 dark:border-gray-800 p-4">
          <div class="flex gap-2">
            <input
              v-model="chatInput"
              type="text"
              placeholder="输入反馈或指令..."
              class="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              @keydown.enter="sendMessage"
            >
            <button
              class="px-4 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
              @click="sendMessage"
            >
              <div class="i-carbon-send w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Confirm bar (shown when waiting_confirm) -->
    <div
      v-if="mockTask.phaseStatus === 'waiting_confirm'"
      class="flex items-center gap-3 px-6 py-3 border-t border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950"
    >
      <div class="i-carbon-warning-alt w-5 h-5 text-amber-500" />
      <span class="text-sm text-amber-700 dark:text-amber-300 font-medium flex-1">
        当前阶段已完成，请确认是否继续推进到下一阶段
      </span>
      <button
        class="px-3 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors"
        @click="handleCancel"
      >
        取消任务
      </button>
      <button
        class="px-3 py-1.5 rounded-lg text-sm text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors"
        @click="handleFeedback"
      >
        反馈修改
      </button>
      <button
        class="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
        @click="handleConfirm"
      >
        确认通过
      </button>
    </div>
  </div>
</template>
