<script setup lang="ts">
import MarkdownIt from 'markdown-it'

export interface ToolCall {
  tool_use_id: string
  name: string
  input: Record<string, any>
  result: string | null
  resultTimestamp: string | null
  is_error: boolean
}

export interface AssistantBlock {
  kind: 'text' | 'thinking' | 'tool_use'
  text: string
  tool_call: ToolCall | null
  timestamp: string | null
}

const props = defineProps<{
  blocks: AssistantBlock[]
  blockKeyPrefix: string
}>()

const emit = defineEmits<{
  (e: 'toggle', blockId: string): void
}>()

defineExpose({})

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const expandedBlocks = defineModel<Set<string>>('expandedBlocks', { required: true })

function toggle(id: string) {
  const s = new Set(expandedBlocks.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedBlocks.value = s
}

function truncateText(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}...`
}

function formatToolInput(input: Record<string, any>): string {
  try { return JSON.stringify(input, null, 2) }
  catch { return String(input) }
}

function toolSummary(tc: ToolCall): string {
  const inp = tc.input
  if (inp.description) return truncateText(inp.description, 60)
  if (inp.command) return truncateText(inp.command, 60)
  if (inp.path) return inp.path.split('/').pop() ?? inp.path
  if (inp.query) return truncateText(inp.query, 60)
  if (inp.pattern) return truncateText(inp.pattern, 60)
  if (inp.glob_pattern) return truncateText(inp.glob_pattern, 60)
  if (inp.search_term) return truncateText(inp.search_term, 60)
  return ''
}

function blockId(kind: string, bIdx: number) {
  return `${props.blockKeyPrefix}-${kind}-${bIdx}`
}
</script>

<template>
  <template v-for="(block, bIdx) in blocks" :key="bIdx">
    <!-- Text block -->
    <div v-if="block.kind === 'text'" class="rounded-xl px-4 py-3 bg-white dark:bg-[#28282c] border border-gray-100 dark:border-white/[0.04] shadow-sm shadow-black/[0.02] dark:shadow-none">
      <div class="prose-chat text-[13px] leading-relaxed text-gray-700 dark:text-gray-200" v-html="md.render(block.text)" />
    </div>

    <!-- Thinking block -->
    <div v-else-if="block.kind === 'thinking'" class="rounded-lg overflow-hidden border border-purple-200/50 dark:border-purple-500/10">
      <button
        class="w-full flex items-center gap-2 px-3 py-2 text-left bg-purple-50/50 dark:bg-purple-500/[0.03] hover:bg-purple-50 dark:hover:bg-purple-500/5 transition-colors"
        @click="toggle(blockId('think', bIdx))"
      >
        <div
          class="i-carbon-chevron-right w-3 h-3 text-gray-400 transition-transform duration-150"
          :class="expandedBlocks.has(blockId('think', bIdx)) && 'rotate-90'"
        />
        <div class="i-carbon-idea w-3.5 h-3.5 text-purple-500" />
        <span class="text-[12px] font-medium text-purple-600 dark:text-purple-400">Thinking</span>
        <span class="text-[11px] text-gray-400 dark:text-gray-500 truncate flex-1">
          {{ truncateText(block.text, 80) }}
        </span>
      </button>
      <div v-if="expandedBlocks.has(blockId('think', bIdx))" class="px-4 py-3 bg-purple-50/30 dark:bg-purple-500/[0.02]">
        <div class="prose-chat text-[12px] leading-relaxed text-gray-600 dark:text-gray-400" v-html="md.render(block.text)" />
      </div>
    </div>

    <!-- Tool use block -->
    <div
      v-else-if="block.kind === 'tool_use' && block.tool_call"
      class="rounded-lg overflow-hidden border"
      :class="block.tool_call.is_error
        ? 'border-red-200 dark:border-red-500/15'
        : 'border-gray-200 dark:border-white/[0.06]'"
    >
      <button
        class="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
        :class="block.tool_call.is_error
          ? 'bg-red-50/50 dark:bg-red-500/[0.03] hover:bg-red-50 dark:hover:bg-red-500/5'
          : 'bg-gray-50 dark:bg-[#1a1a1e] hover:bg-gray-100 dark:hover:bg-white/5'"
        @click="toggle(blockId('tool', bIdx))"
      >
        <div
          class="i-carbon-chevron-right w-3 h-3 text-gray-400 transition-transform duration-150"
          :class="expandedBlocks.has(blockId('tool', bIdx)) && 'rotate-90'"
        />
        <div class="w-3.5 h-3.5" :class="block.tool_call.is_error ? 'i-carbon-warning-alt text-red-500' : 'i-carbon-terminal text-blue-500'" />
        <span
          class="text-[12px] font-medium"
          :class="block.tool_call.is_error ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'"
        >{{ block.tool_call.name }}</span>
        <span class="text-[11px] text-gray-400 dark:text-gray-500 truncate flex-1 font-mono">
          {{ toolSummary(block.tool_call) }}
        </span>
        <span v-if="block.tool_call.result !== null" class="shrink-0">
          <div v-if="block.tool_call.is_error" class="i-carbon-close-filled w-3 h-3 text-red-400" />
          <div v-else class="i-carbon-checkmark-filled w-3 h-3 text-emerald-400" />
        </span>
      </button>
      <div v-if="expandedBlocks.has(blockId('tool', bIdx))" class="border-t border-gray-100 dark:border-white/[0.04]">
        <div class="px-3 py-2 bg-[#fafafa] dark:bg-[#161618]">
          <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Input</div>
          <pre class="text-[11px] font-mono text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">{{ formatToolInput(block.tool_call.input) }}</pre>
        </div>
        <div v-if="block.tool_call.result !== null" class="px-3 py-2 border-t border-gray-100 dark:border-white/[0.04]" :class="block.tool_call.is_error ? 'bg-red-50/30 dark:bg-red-500/[0.02]' : 'bg-emerald-50/30 dark:bg-emerald-500/[0.02]'">
          <div class="text-[10px] font-bold uppercase tracking-wider mb-1" :class="block.tool_call.is_error ? 'text-red-400' : 'text-emerald-500'">
            {{ block.tool_call.is_error ? 'Error' : 'Result' }}
          </div>
          <pre class="text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto" :class="block.tool_call.is_error ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'">{{ block.tool_call.result }}</pre>
        </div>
      </div>
    </div>
  </template>
</template>
