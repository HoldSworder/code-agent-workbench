<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * 需求来源状态卡片。
 *
 * - 三色态：spec_doc / requirement_doc → 绿；description → 黄；title_only → 红。
 * - title_only 时附带 warnings（来自 sidecar feishu-requirement.ts，含工作项实际字段清单），
 *   并提供两个 CTA：手动粘贴需求文档、配置字段映射（v1 占位）。
 * - 父级负责拉取与重新拉取；本组件只渲染 + emit。
 */
type RequirementSourceType = 'spec_doc' | 'requirement_doc' | 'description' | 'title_only'

interface RequirementSource {
  workItemUrl: string
  workItemId: string
  projectKey: string
  workItemType: string
  title: string
  sourceType: RequirementSourceType
  sourceFieldLabel: string | null
  docUrl: string | null
  content: string
  warnings: string[]
}

const props = defineProps<{
  source: RequirementSource | null
  loading: boolean
  /** 父级在拉取过程中遇到的额外错误（与 source.warnings 区分开）。 */
  externalError?: string | null
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  /** 手动粘贴：父级负责把 content 写入 source 并通知后端。 */
  (e: 'manual-content', content: string): void
}>()

const expanded = ref(false)
const showManual = ref(false)
const manualDraft = ref('')

const tone = computed<'good' | 'warn' | 'bad' | 'neutral'>(() => {
  if (!props.source) return 'neutral'
  switch (props.source.sourceType) {
    case 'spec_doc':
    case 'requirement_doc': return 'good'
    case 'description': return 'warn'
    case 'title_only': return 'bad'
  }
})

const containerClass = computed(() => {
  const map = {
    good: 'border-emerald-200 bg-emerald-50/60 dark:bg-emerald-900/10 dark:border-emerald-800',
    warn: 'border-amber-200 bg-amber-50/60 dark:bg-amber-900/10 dark:border-amber-800',
    bad: 'border-rose-200 bg-rose-50/60 dark:bg-rose-900/10 dark:border-rose-800',
    neutral: 'border-gray-200 dark:border-white/10 bg-white dark:bg-white/5',
  }
  return map[tone.value]
})

const dotClass = computed(() => {
  const map = {
    good: 'bg-emerald-500',
    warn: 'bg-amber-500',
    bad: 'bg-rose-500',
    neutral: 'bg-gray-300',
  }
  return map[tone.value]
})

const badge = computed(() => {
  if (!props.source) return { text: '未拉取', cls: 'bg-gray-200 text-gray-700' }
  switch (props.source.sourceType) {
    case 'spec_doc': return { text: '需求 SPEC 文档', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' }
    case 'requirement_doc': return { text: '需求文档', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' }
    case 'description': return { text: '描述字段', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' }
    case 'title_only': return { text: '仅标题', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' }
  }
})

const preview = computed(() => {
  const c = props.source?.content ?? ''
  if (!c) return ''
  if (expanded.value) return c
  return c.length > 500 ? `${c.slice(0, 500)}…` : c
})

function submitManual(): void {
  const v = manualDraft.value.trim()
  if (!v) return
  emit('manual-content', v)
  manualDraft.value = ''
  showManual.value = false
}
</script>

<template>
  <section class="px-4 py-3 rounded-lg border space-y-2" :class="containerClass">
    <header class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <span class="size-2 rounded-full" :class="dotClass" />
        <span class="text-[13px] font-semibold">需求来源</span>
        <span class="px-1.5 py-0.5 text-[11px] rounded" :class="badge.cls">{{ badge.text }}</span>
        <span
          v-if="source?.sourceFieldLabel"
          class="text-[11px] text-gray-500 truncate"
          :title="source.sourceFieldLabel"
        >
          · 字段「{{ source.sourceFieldLabel }}」
        </span>
        <a
          v-if="source?.docUrl"
          :href="source.docUrl"
          target="_blank"
          class="text-[11px] text-indigo-500 hover:underline"
        >
          原文档 ↗
        </a>
      </div>
      <button
        class="text-[12px] text-indigo-500 hover:underline disabled:opacity-50"
        :disabled="loading"
        @click="emit('refresh')"
      >
        {{ loading ? '拉取中…' : '重新拉取' }}
      </button>
    </header>

    <div v-if="!source" class="text-[12px] text-gray-500">
      {{ loading ? '正在拉取需求来源…' : '尚未拉取需求来源' }}
    </div>

    <template v-else>
      <div v-if="source.content" class="text-[12px] whitespace-pre-wrap font-mono leading-relaxed text-gray-700 dark:text-gray-200 max-h-[280px] overflow-y-auto">
        {{ preview }}
      </div>
      <button
        v-if="source.content && source.content.length > 500"
        class="text-[11px] text-indigo-500 hover:underline"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开全文' }}
      </button>

      <div v-if="source.warnings.length" class="text-[11px] text-amber-700 dark:text-amber-300 space-y-1">
        <div
          v-for="(w, i) in source.warnings"
          :key="i"
          class="whitespace-pre-wrap"
        >
          · {{ w }}
        </div>
      </div>

      <div v-if="source.sourceType === 'title_only'" class="flex flex-wrap gap-2 pt-1">
        <button
          class="px-2.5 py-1 text-[12px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600"
          @click="showManual = !showManual"
        >
          {{ showManual ? '收起手动输入' : '手动粘贴需求文档' }}
        </button>
        <button
          class="px-2.5 py-1 text-[12px] rounded-md border border-gray-200 dark:border-white/15 text-gray-500"
          disabled
          title="即将上线：在「设置 → 评审需求字段映射」按 projectKey 配置自定义关键词"
        >
          配置字段映射（即将上线）
        </button>
      </div>

      <div v-if="showManual" class="space-y-2 pt-1">
        <textarea
          v-model="manualDraft"
          rows="6"
          class="w-full font-mono text-[12px] px-2 py-2 rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
          placeholder="把需求文档原文（Markdown 优先）粘贴到这里…"
        />
        <div class="flex gap-2 justify-end">
          <button
            class="px-3 py-1 text-[12px] rounded-md border border-gray-200 dark:border-white/10"
            @click="showManual = false"
          >
            取消
          </button>
          <button
            class="px-3 py-1 text-[12px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
            :disabled="!manualDraft.trim()"
            @click="submitManual"
          >
            使用此内容
          </button>
        </div>
      </div>
    </template>

    <div v-if="externalError" class="text-[12px] text-rose-600 whitespace-pre-wrap">
      {{ externalError }}
    </div>
  </section>
</template>
