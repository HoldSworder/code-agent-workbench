<script setup lang="ts">
import { ref } from 'vue'

/**
 * Step3：澄清记录列表 + 输入。
 *
 * - 父级负责通过 WS 推送澄清；本组件只展示 + emit('send', content)。
 * - 后续可扩展 @ 提及 / 已读红点（第二轮）。
 */
interface Clarification {
  id: string
  userId: string
  userName: string
  content: string
  createdAt: string
}

defineProps<{
  clarifications: Clarification[]
  active: boolean
}>()

const emit = defineEmits<{
  (e: 'send', content: string): void
}>()

const draft = ref('')

function send(): void {
  const v = draft.value.trim()
  if (!v) return
  emit('send', v)
  draft.value = ''
}
</script>

<template>
  <section
    class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border space-y-2 transition"
    :class="active ? 'border-indigo-300 dark:border-indigo-700 ring-2 ring-indigo-100 dark:ring-indigo-900/30' : 'border-gray-200 dark:border-white/10'"
  >
    <header class="flex items-center justify-between">
      <span class="text-[13px] font-semibold">
        Step 3 · 澄清评审
        <span class="text-[11px] text-gray-400 font-normal ml-1">{{ clarifications.length }} 条</span>
      </span>
    </header>

    <ul class="space-y-2 max-h-[280px] overflow-y-auto pr-1">
      <li
        v-for="c in clarifications"
        :key="c.id"
        class="border-l-2 border-indigo-200 dark:border-indigo-700 pl-2"
      >
        <div class="text-[11px] text-gray-500">
          {{ c.userName }} · {{ c.createdAt.slice(11, 16) }}
        </div>
        <div class="text-[12px] whitespace-pre-wrap">{{ c.content }}</div>
      </li>
      <li v-if="!clarifications.length" class="text-[12px] text-gray-400">
        暂无澄清。可在评审过程中提问，所有参与者都会同步看到。
      </li>
    </ul>

    <div class="flex gap-1 pt-1">
      <input
        v-model="draft"
        class="flex-1 px-2 py-1 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
        placeholder="提一个澄清问题…"
        @keyup.enter="send"
      >
      <button
        class="px-3 py-1 text-[12px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
        :disabled="!draft.trim()"
        @click="send"
      >
        发送
      </button>
    </div>
  </section>
</template>
