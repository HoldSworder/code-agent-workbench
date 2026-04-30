<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * Step2：生成 / 查看 / 编辑前端 design.md。
 *
 * - 父级负责 RPC 与 WS 派发；本组件只触发 emit + 维护本地 editing 草稿。
 * - 生成按钮在「未拉到需求来源」或非 host 时禁用，从 props 传入决策依据避免组件再去看 store。
 */

const props = defineProps<{
  content: string
  version: number
  isHost: boolean
  generating: boolean
  /** 是否允许触发"生成 design"，例如未拉到需求时 false。 */
  canGenerate: boolean
  active: boolean
}>()

const emit = defineEmits<{
  (e: 'generate'): void
  (e: 'commit', draft: string): void
}>()

const editing = ref(false)
const draft = ref('')

watch(() => props.content, (v) => {
  if (!editing.value) draft.value = v
}, { immediate: true })

function start(): void {
  draft.value = props.content
  editing.value = true
}

function cancel(): void {
  editing.value = false
  draft.value = props.content
}

function commit(): void {
  emit('commit', draft.value)
  editing.value = false
}
</script>

<template>
  <section
    class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border space-y-2 transition"
    :class="active ? 'border-indigo-300 dark:border-indigo-700 ring-2 ring-indigo-100 dark:ring-indigo-900/30' : 'border-gray-200 dark:border-white/10'"
  >
    <header class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="text-[13px] font-semibold">Step 2 · 前端开发设计 design.md</span>
        <span class="text-[11px] text-gray-400">v{{ version }}</span>
      </div>
      <div class="flex items-center gap-3">
        <button
          v-if="!editing"
          class="text-[12px] text-gray-600 hover:text-indigo-500"
          @click="start"
        >
          编辑
        </button>
        <button
          class="px-3 py-1.5 text-[12px] rounded-md bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
          :disabled="!isHost || generating || !canGenerate"
          :title="!isHost ? '仅会话主持人可以生成' : !canGenerate ? '请先拉取需求来源' : ''"
          @click="emit('generate')"
        >
          {{ generating ? '生成中…' : (content && !/\(评审中…\)/.test(content) ? '重新生成' : '生成 design') }}
        </button>
      </div>
    </header>

    <textarea
      v-if="editing"
      v-model="draft"
      rows="20"
      class="w-full font-mono text-[12px] px-2 py-2 rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
    />
    <div
      v-else
      class="prose prose-sm max-w-none whitespace-pre-wrap text-[13px] leading-relaxed font-mono text-gray-700 dark:text-gray-200 max-h-[420px] overflow-y-auto"
    >
      {{ content || '(design.md 尚未生成)' }}
    </div>

    <div v-if="editing" class="flex gap-2 justify-end">
      <button
        class="px-3 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10"
        @click="cancel"
      >
        取消
      </button>
      <button
        class="px-3 py-1.5 text-[12px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600"
        @click="commit"
      >
        提交修改
      </button>
    </div>
  </section>
</template>
