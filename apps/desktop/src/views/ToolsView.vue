<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { rpc } from '../composables/use-sidecar'

interface ToolInfo {
  id: string
  name: string
  description: string
  injectionRule: string
  usage: string
  scriptPath: string | null
}

const tools = ref<ToolInfo[]>([])
const loading = ref(true)
const expandedId = ref<string | null>(null)

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

async function loadTools() {
  loading.value = true
  try {
    const res = await rpc<ToolInfo[]>('workflow.listTools')
    tools.value = res ?? []
  } catch (err) {
    console.error('Failed to load tools:', err)
    tools.value = []
  } finally {
    loading.value = false
  }
}

onMounted(loadTools)
</script>

<template>
  <div class="p-8 max-w-2xl mx-auto">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">工具管理</h1>
        <p class="text-[12px] text-gray-400 mt-0.5">已注册的 Agent 工具，在工作流和编排中按条件自动注入</p>
      </div>
    </div>

    <div v-if="loading" class="text-center py-16 text-[13px] text-gray-400">
      加载中…
    </div>

    <div v-else-if="tools.length === 0" class="text-center py-16">
      <div class="i-carbon-tool-box w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
      <p class="text-[13px] text-gray-400">暂无已注册的工具</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="tool in tools"
        :key="tool.id"
        class="rounded-xl border bg-white dark:bg-[#1a1a1c] transition-all cursor-pointer"
        :class="expandedId === tool.id
          ? 'border-indigo-300 dark:border-indigo-500/30 shadow-sm shadow-indigo-500/5'
          : 'border-gray-200 dark:border-white/[0.06] hover:border-gray-300 dark:hover:border-white/10'"
        @click="toggleExpand(tool.id)"
      >
        <div class="p-4">
          <div class="flex items-center gap-2.5 mb-2">
            <div class="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-500/10">
              <div class="i-carbon-tool-box w-4 h-4 text-indigo-500 dark:text-indigo-400" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-[13px] font-medium text-gray-800 dark:text-gray-200">{{ tool.name }}</span>
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400">{{ tool.id }}</span>
              </div>
            </div>
            <div
              class="i-carbon-chevron-down w-4 h-4 text-gray-400 transition-transform duration-200"
              :class="{ 'rotate-180': expandedId === tool.id }"
            />
          </div>
          <p class="text-[12px] text-gray-500 dark:text-gray-400 leading-relaxed pl-[42px]">{{ tool.description }}</p>
        </div>

        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          leave-active-class="transition-all duration-150 ease-in"
          enter-from-class="opacity-0 max-h-0"
          enter-to-class="opacity-100 max-h-60"
          leave-from-class="opacity-100 max-h-60"
          leave-to-class="opacity-0 max-h-0"
        >
          <div v-if="expandedId === tool.id" class="overflow-hidden">
            <div class="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-white/5 space-y-3">
              <div class="flex items-start gap-2">
                <span class="shrink-0 text-[11px] font-medium text-gray-400 dark:text-gray-500 w-16 pt-0.5 text-right">注入条件</span>
                <span class="inline-flex items-center px-2 py-0.5 rounded-md text-[12px] bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200/40 dark:border-emerald-500/20">{{ tool.injectionRule }}</span>
              </div>
              <div v-if="tool.scriptPath" class="flex items-start gap-2">
                <span class="shrink-0 text-[11px] font-medium text-gray-400 dark:text-gray-500 w-16 pt-0.5 text-right">脚本路径</span>
                <code class="text-[11px] font-mono text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-white/5 px-2 py-1 rounded-md break-all leading-relaxed">{{ tool.scriptPath }}</code>
              </div>
              <div class="flex items-start gap-2">
                <span class="shrink-0 text-[11px] font-medium text-gray-400 dark:text-gray-500 w-16 pt-1 text-right">命令用法</span>
                <pre class="flex-1 text-[11px] font-mono text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-white/5 px-3 py-2 rounded-md leading-relaxed whitespace-pre-wrap">{{ tool.usage }}</pre>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>
