<script setup lang="ts">
/**
 * 评审会话详情页顶部 5 步状态条。
 *
 * - 不维护内部状态；currentStep / steps 状态由父级 computed 推导。
 * - 每个 step 三态：done / current / pending；warning 用 amber 单独提示（如 title_only）。
 * - 不发出 emit；点击仅滚动到对应锚点（父级监听 step-click）。
 */
export type StepStatus = 'done' | 'current' | 'pending' | 'warning'

export interface StepDef {
  id: string
  index: number
  title: string
  status: StepStatus
  /** 可选副标题 / 状态描述，比如 "命中 spec_doc" / "title_only" */
  detail?: string | null
}

defineProps<{
  steps: StepDef[]
  /** 当前激活的 step index（1-based） */
  currentStep: number
}>()

const emit = defineEmits<{
  (e: 'step-click', step: StepDef): void
}>()

function dotClasses(s: StepStatus): string {
  switch (s) {
    case 'done': return 'bg-emerald-500 text-white border-emerald-500'
    case 'current': return 'bg-indigo-500 text-white border-indigo-500 ring-4 ring-indigo-100 dark:ring-indigo-900/40'
    case 'warning': return 'bg-amber-500 text-white border-amber-500'
    default: return 'bg-white dark:bg-white/10 text-gray-400 border-gray-200 dark:border-white/15'
  }
}

function labelClasses(s: StepStatus): string {
  switch (s) {
    case 'done': return 'text-gray-700 dark:text-gray-200'
    case 'current': return 'text-indigo-600 dark:text-indigo-300 font-semibold'
    case 'warning': return 'text-amber-600 dark:text-amber-300 font-semibold'
    default: return 'text-gray-400'
  }
}

function lineClasses(prev: StepStatus): string {
  return prev === 'done' || prev === 'current' || prev === 'warning'
    ? 'bg-indigo-200 dark:bg-indigo-700/60'
    : 'bg-gray-200 dark:bg-white/10'
}
</script>

<template>
  <ol class="flex items-start gap-1 select-none">
    <li
      v-for="(s, i) in steps"
      :key="s.id"
      class="flex-1 flex flex-col items-center min-w-0"
    >
      <div class="flex items-center w-full">
        <div
          v-if="i > 0"
          class="h-[2px] flex-1"
          :class="lineClasses(steps[i - 1].status)"
        />
        <button
          class="size-7 shrink-0 rounded-full border flex items-center justify-center text-[12px] font-semibold transition"
          :class="dotClasses(s.status)"
          :title="s.title"
          @click="emit('step-click', s)"
        >
          <span v-if="s.status === 'done'">✓</span>
          <span v-else-if="s.status === 'warning'">!</span>
          <span v-else>{{ s.index }}</span>
        </button>
        <div
          v-if="i < steps.length - 1"
          class="h-[2px] flex-1"
          :class="lineClasses(s.status)"
        />
      </div>
      <button
        class="mt-1 px-1 text-[12px] leading-tight truncate max-w-full"
        :class="labelClasses(s.status)"
        :title="s.detail ?? s.title"
        @click="emit('step-click', s)"
      >
        {{ s.title }}
      </button>
      <div
        v-if="s.detail"
        class="text-[10px] text-gray-400 truncate max-w-full px-1"
        :title="s.detail"
      >
        {{ s.detail }}
      </div>
    </li>
  </ol>
</template>
