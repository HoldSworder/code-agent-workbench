<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { sendChat, deleteSession, type ChatEvent } from '../composables/use-api'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{
  repoId: string
  repoName: string
}>()

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const messages = ref<Message[]>([])
const input = ref('')
const sending = ref(false)
const streamingText = ref('')
const sessionId = ref<string | null>(null)
const messagesContainer = ref<HTMLElement | null>(null)
let currentAbort: (() => void) | null = null

const suggestions = [
  { icon: 'i-carbon-tree-view-alt', text: '介绍一下项目架构' },
  { icon: 'i-carbon-flow', text: '核心数据流是怎样的？' },
  { icon: 'i-carbon-folder-details', text: '目录结构是什么样的？' },
  { icon: 'i-carbon-settings', text: '使用了哪些关键依赖？' },
]

watch(() => props.repoId, () => {
  if (sessionId.value) {
    deleteSession(sessionId.value).catch(() => {})
  }
  messages.value = []
  streamingText.value = ''
  sessionId.value = null
  sending.value = false
  currentAbort = null
})

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function handleSend(text?: string) {
  const msg = (text ?? input.value).trim()
  if (!msg || sending.value) return

  messages.value.push({ role: 'user', content: msg })
  input.value = ''
  sending.value = true
  streamingText.value = ''
  scrollToBottom()

  const { abort } = sendChat(
    { repoId: props.repoId, message: msg, sessionId: sessionId.value ?? undefined },
    (event: ChatEvent) => {
      switch (event.type) {
        case 'session':
          sessionId.value = event.sessionId ?? null
          break
        case 'chunk':
          streamingText.value += event.text ?? ''
          scrollToBottom()
          break
        case 'done':
          messages.value.push({ role: 'assistant', content: event.fullText ?? streamingText.value })
          streamingText.value = ''
          sending.value = false
          currentAbort = null
          scrollToBottom()
          break
        case 'error':
          if (streamingText.value) {
            messages.value.push({ role: 'assistant', content: streamingText.value })
          }
          messages.value.push({ role: 'assistant', content: `_Error: ${event.message}_` })
          streamingText.value = ''
          sending.value = false
          currentAbort = null
          scrollToBottom()
          break
      }
    },
  )
  currentAbort = abort
}

function handleStop() {
  currentAbort?.()
  if (streamingText.value) {
    messages.value.push({ role: 'assistant', content: streamingText.value })
  }
  streamingText.value = ''
  sending.value = false
  currentAbort = null
}

function handleNewChat() {
  if (sessionId.value) {
    deleteSession(sessionId.value).catch(() => {})
  }
  messages.value = []
  streamingText.value = ''
  sessionId.value = null
  sending.value = false
  currentAbort = null
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between px-5 h-13 bg-white/40 dark:bg-[#1a1a1e]/40 backdrop-blur-md shrink-0 border-b border-gray-200/20 dark:border-white/3">
      <div class="flex items-center gap-2.5">
        <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-100/60 dark:bg-white/4">
          <div class="i-carbon-folder-details w-3.5 h-3.5 text-indigo-500" />
          <span class="text-[13px] font-medium text-gray-700 dark:text-gray-200">{{ repoName }}</span>
        </div>
        <span class="hidden sm:inline text-[11px] text-gray-400 dark:text-gray-500">只读咨询</span>
      </div>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium text-gray-400 dark:text-gray-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-500/6 transition-colors duration-150"
        @click="handleNewChat"
      >
        <div class="i-carbon-renew w-3.5 h-3.5" />
        新对话
      </button>
    </div>

    <!-- Messages -->
    <div ref="messagesContainer" class="flex-1 overflow-y-auto scroll-thin min-h-0">
      <!-- Empty state -->
      <div v-if="messages.length === 0 && !streamingText" class="flex flex-col items-center justify-center h-full text-center px-6 pb-16">
        <div class="relative mb-5">
          <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-100 via-violet-50 to-purple-100 dark:from-indigo-500/12 dark:via-violet-500/8 dark:to-purple-500/12 flex items-center justify-center">
            <div class="i-carbon-chat w-7 h-7 text-indigo-400" />
          </div>
        </div>
        <h3 class="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">有什么想了解的？</h3>
        <p class="text-[13px] text-gray-400 dark:text-gray-500 max-w-sm mb-6">
          关于 <strong class="text-gray-600 dark:text-gray-300 font-semibold">{{ repoName }}</strong> 的架构、代码逻辑、配置等问题
        </p>

        <!-- Suggestions -->
        <div class="grid grid-cols-2 gap-2 max-w-md w-full">
          <button
            v-for="(s, i) in suggestions"
            :key="i"
            class="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-white/60 dark:bg-white/3 text-left text-[12px] text-gray-500 dark:text-gray-400 hover:bg-indigo-50/60 dark:hover:bg-indigo-500/6 hover:text-indigo-600 dark:hover:text-indigo-300 transition-all duration-150 group"
            @click="handleSend(s.text)"
          >
            <div :class="s.icon" class="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-gray-500 group-hover:text-indigo-500 transition-colors" />
            <span>{{ s.text }}</span>
          </button>
        </div>
      </div>

      <!-- Messages list -->
      <div v-else class="w-full max-w-[min(90%,960px)] mx-auto px-4 py-5 space-y-4">
        <MessageBubble
          v-for="(msg, i) in messages"
          :key="i"
          :role="msg.role"
          :content="msg.content"
        />

        <!-- Streaming message -->
        <MessageBubble
          v-if="streamingText"
          role="assistant"
          :content="streamingText"
          streaming
        />

        <!-- Typing indicator -->
        <div v-if="sending && !streamingText" class="flex items-start gap-2.5">
          <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-sm shadow-indigo-500/15">
            <div class="i-carbon-bot w-4 h-4 text-white" />
          </div>
          <div class="px-3.5 py-2.5 rounded-xl rounded-tl-sm bg-white/80 dark:bg-[#232327]/80">
            <div class="flex gap-1 items-center h-4">
              <span class="w-1.5 h-1.5 bg-indigo-400/50 rounded-full animate-bounce" style="animation-delay: 0ms; animation-duration: 1.2s" />
              <span class="w-1.5 h-1.5 bg-indigo-400/50 rounded-full animate-bounce" style="animation-delay: 200ms; animation-duration: 1.2s" />
              <span class="w-1.5 h-1.5 bg-indigo-400/50 rounded-full animate-bounce" style="animation-delay: 400ms; animation-duration: 1.2s" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Input area -->
    <div class="shrink-0 px-4 pb-4 pt-2">
      <div class="w-full max-w-[min(90%,960px)] mx-auto">
        <div class="flex items-end gap-2.5 p-1.5 rounded-xl bg-white/70 dark:bg-[#232327]/70 backdrop-blur-sm shadow-lg shadow-black/3 dark:shadow-black/15 focus-within:shadow-indigo-500/5 transition-shadow duration-200">
          <textarea
            v-model="input"
            :disabled="sending"
            class="flex-1 min-h-[36px] max-h-[120px] px-3 py-2 bg-transparent text-[14px] placeholder-gray-300 dark:placeholder-gray-600 outline-none resize-none leading-relaxed"
            placeholder="输入你的问题…"
            rows="1"
            @keydown="handleKeydown"
          />
          <button
            v-if="!sending"
            :disabled="!input.trim()"
            class="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-150 active:scale-90"
            :class="input.trim()
              ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-sm shadow-indigo-500/20'
              : 'bg-gray-100 dark:bg-white/5 text-gray-300 dark:text-gray-600 cursor-not-allowed'"
            @click="handleSend()"
          >
            <div class="i-carbon-send-alt w-4 h-4" />
          </button>
          <button
            v-else
            class="shrink-0 w-9 h-9 rounded-lg bg-red-500 text-white flex items-center justify-center shadow-sm shadow-red-500/15 hover:bg-red-400 transition-all duration-150 active:scale-90"
            @click="handleStop"
          >
            <div class="i-carbon-stop-filled w-4 h-4" />
          </button>
        </div>
        <p class="text-center text-[10px] text-gray-300 dark:text-gray-600 mt-2">只读模式 — 不会修改任何代码文件</p>
      </div>
    </div>
  </div>
</template>
