<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { rpc } from '../../composables/use-sidecar'

/**
 * Step 4 + 5：故事点评估 + 写回飞书。
 *
 * 自动配置流程（用户选 2c）：
 *   挂载 → review.getStoryPointFields(projectKey)
 *     ├ 已有 manual 配置  → 直接展示，不再探测；
 *     └ 无 / 仅 auto       → review.detectStoryPointFields(projectKey, workItemType)
 *         ├ 三角色全命中    → upsert(source=auto)，展示绿色匹配 chip；
 *         └ 部分命中或失败 → 展开「手动覆盖」面板让用户从 allFields 下拉里选。
 *
 * 评估按钮在三角色全部空配置时禁用（无法写回 → 只评估也意义不大）。
 */
type Role = 'frontend' | 'backend' | 'qa'
interface FieldRef { fieldKey: string, label: string }
interface StoryConfig {
  frontend: FieldRef | null
  backend: FieldRef | null
  qa: FieldRef | null
  writebackTool: string
  source: 'manual' | 'auto' | null
  updatedAt: string | null
}

interface AssessmentResult {
  role: Role
  points: number
  rationale: string
}

const props = defineProps<{
  projectKey: string
  workItemType: string
  isHost: boolean
  evaluating: boolean
  active: boolean
  assessments: AssessmentResult[]
}>()

const emit = defineEmits<{
  (e: 'evaluate', payload: {
    writebackTool: string
    fields: Array<{ fieldKey: string, role: Role }>
  }): void
}>()

const config = ref<StoryConfig>({ frontend: null, backend: null, qa: null, writebackTool: 'update_field', source: null, updatedAt: null })
const allFields = ref<FieldRef[]>([])
const detecting = ref(false)
const detectError = ref<string | null>(null)
const showManual = ref(false)
const manualDraft = ref<{ frontend: string, backend: string, qa: string, writebackTool: string }>({
  frontend: '',
  backend: '',
  qa: '',
  writebackTool: 'update_field',
})

const hasAnyConfig = computed(() =>
  !!(config.value.frontend || config.value.backend || config.value.qa),
)

async function loadConfig(): Promise<void> {
  if (!props.projectKey) return
  detectError.value = null
  try {
    const got = await rpc<StoryConfig>('review.getStoryPointFields', { projectKey: props.projectKey })
    config.value = got
    if (got.source === 'manual' && (got.frontend || got.backend || got.qa)) {
      // 用户已手动配置过，跳过自动探测
      return
    }
    await detect()
  }
  catch (err) {
    detectError.value = err instanceof Error ? err.message : String(err)
  }
}

async function detect(): Promise<void> {
  if (!props.projectKey || !props.workItemType) return
  detecting.value = true
  detectError.value = null
  try {
    const r = await rpc<{
      frontend: FieldRef | null
      backend: FieldRef | null
      qa: FieldRef | null
      writebackTool: string
      allFields: FieldRef[]
    }>('review.detectStoryPointFields', {
      projectKey: props.projectKey,
      workItemType: props.workItemType,
    })
    allFields.value = r.allFields ?? []
    const allHit = r.frontend && r.backend && r.qa
    if (allHit) {
      await rpc('review.upsertStoryPointFields', {
        projectKey: props.projectKey,
        frontend: r.frontend,
        backend: r.backend,
        qa: r.qa,
        writebackTool: r.writebackTool,
        source: 'auto',
      })
      config.value = {
        frontend: r.frontend,
        backend: r.backend,
        qa: r.qa,
        writebackTool: r.writebackTool,
        source: 'auto',
        updatedAt: new Date().toISOString(),
      }
    }
    else {
      // 部分命中或全空 → 用探测值预填手动面板，让用户补全或修正
      config.value = {
        frontend: r.frontend,
        backend: r.backend,
        qa: r.qa,
        writebackTool: r.writebackTool,
        source: null,
        updatedAt: null,
      }
      manualDraft.value = {
        frontend: r.frontend?.fieldKey ?? '',
        backend: r.backend?.fieldKey ?? '',
        qa: r.qa?.fieldKey ?? '',
        writebackTool: r.writebackTool || 'update_field',
      }
      showManual.value = true
    }
  }
  catch (err) {
    detectError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    detecting.value = false
  }
}

async function saveManual(): Promise<void> {
  if (!props.projectKey) return
  const lookup = (key: string): FieldRef | null => {
    const k = key.trim()
    if (!k) return null
    const found = allFields.value.find(f => f.fieldKey === k)
    return found ?? { fieldKey: k, label: k }
  }
  const payload = {
    projectKey: props.projectKey,
    frontend: lookup(manualDraft.value.frontend),
    backend: lookup(manualDraft.value.backend),
    qa: lookup(manualDraft.value.qa),
    writebackTool: manualDraft.value.writebackTool || 'update_field',
    source: 'manual' as const,
  }
  await rpc('review.upsertStoryPointFields', payload)
  config.value = {
    frontend: payload.frontend,
    backend: payload.backend,
    qa: payload.qa,
    writebackTool: payload.writebackTool,
    source: 'manual',
    updatedAt: new Date().toISOString(),
  }
  showManual.value = false
}

function triggerEvaluate(): void {
  const fields: Array<{ fieldKey: string, role: Role }> = []
  if (config.value.frontend) fields.push({ fieldKey: config.value.frontend.fieldKey, role: 'frontend' })
  if (config.value.backend) fields.push({ fieldKey: config.value.backend.fieldKey, role: 'backend' })
  if (config.value.qa) fields.push({ fieldKey: config.value.qa.fieldKey, role: 'qa' })
  emit('evaluate', { writebackTool: config.value.writebackTool, fields })
}

watch(() => props.projectKey, (v) => { if (v) void loadConfig() }, { immediate: true })

function chipClass(hit: FieldRef | null): string {
  return hit
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
    : 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400'
}

const sourceLabel = computed(() => {
  if (config.value.source === 'manual') return '手动配置'
  if (config.value.source === 'auto') return 'MCP 自动探测'
  return '尚未配置'
})
</script>

<template>
  <section
    class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border space-y-3 transition"
    :class="active ? 'border-indigo-300 dark:border-indigo-700 ring-2 ring-indigo-100 dark:ring-indigo-900/30' : 'border-gray-200 dark:border-white/10'"
  >
    <header class="flex items-center justify-between gap-2">
      <span class="text-[13px] font-semibold">Step 4 · 评估故事点 & 写回飞书</span>
      <span class="text-[11px] text-gray-400">来源：{{ sourceLabel }}</span>
    </header>

    <div class="flex flex-wrap gap-2 text-[11px]">
      <span class="px-2 py-1 rounded" :class="chipClass(config.frontend)">
        前端 · {{ config.frontend ? `${config.frontend.label} (${config.frontend.fieldKey})` : '未匹配' }}
      </span>
      <span class="px-2 py-1 rounded" :class="chipClass(config.backend)">
        后端 · {{ config.backend ? `${config.backend.label} (${config.backend.fieldKey})` : '未匹配' }}
      </span>
      <span class="px-2 py-1 rounded" :class="chipClass(config.qa)">
        测试 · {{ config.qa ? `${config.qa.label} (${config.qa.fieldKey})` : '未匹配' }}
      </span>
    </div>

    <div class="flex flex-wrap gap-2 items-center text-[12px]">
      <button
        class="px-2 py-1 rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
        :disabled="detecting || !projectKey"
        @click="detect"
      >
        {{ detecting ? '探测中…' : '重新自动探测' }}
      </button>
      <button
        class="px-2 py-1 rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
        @click="showManual = !showManual"
      >
        {{ showManual ? '收起手动覆盖' : '手动覆盖' }}
      </button>
      <button
        class="ml-auto px-3 py-1.5 rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
        :disabled="!isHost || evaluating || !hasAnyConfig"
        :title="!isHost ? '仅会话主持人可评估并写回' : !hasAnyConfig ? '至少配置一个角色字段' : ''"
        @click="triggerEvaluate"
      >
        {{ evaluating ? '评估中…' : '确认 design & 评估故事点' }}
      </button>
    </div>

    <div v-if="detectError" class="text-[11px] text-rose-600 whitespace-pre-wrap">
      探测失败：{{ detectError }}
    </div>

    <div v-if="showManual" class="space-y-2 pt-1 border-t border-dashed border-gray-200 dark:border-white/10 mt-1">
      <div class="text-[11px] text-gray-500">
        从飞书项目「字段配置」拉到 {{ allFields.length }} 个字段。手动指定 field_key（按工作项类型 {{ workItemType }}）：
      </div>
      <div class="grid grid-cols-2 gap-2">
        <select
          v-model="manualDraft.frontend"
          class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
        >
          <option value="">前端故事点 field_key（不写回）</option>
          <option v-for="f in allFields" :key="`fe-${f.fieldKey}`" :value="f.fieldKey">
            {{ f.label }} ({{ f.fieldKey }})
          </option>
        </select>
        <select
          v-model="manualDraft.backend"
          class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
        >
          <option value="">后端故事点 field_key（不写回）</option>
          <option v-for="f in allFields" :key="`be-${f.fieldKey}`" :value="f.fieldKey">
            {{ f.label }} ({{ f.fieldKey }})
          </option>
        </select>
        <select
          v-model="manualDraft.qa"
          class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
        >
          <option value="">测试故事点 field_key（不写回）</option>
          <option v-for="f in allFields" :key="`qa-${f.fieldKey}`" :value="f.fieldKey">
            {{ f.label }} ({{ f.fieldKey }})
          </option>
        </select>
        <input
          v-model="manualDraft.writebackTool"
          class="px-2 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
          placeholder="MCP 写回 tool 名（默认 update_field）"
        >
      </div>
      <div class="flex gap-2 justify-end">
        <button
          class="px-3 py-1.5 text-[12px] rounded-md border border-gray-200 dark:border-white/10"
          @click="showManual = false"
        >
          取消
        </button>
        <button
          class="px-3 py-1.5 text-[12px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600"
          @click="saveManual"
        >
          保存配置
        </button>
      </div>
    </div>

    <div v-if="assessments.length" class="grid grid-cols-3 gap-2 pt-1">
      <div
        v-for="a in assessments"
        :key="a.role"
        class="px-3 py-2 rounded-md bg-gray-50 dark:bg-white/5"
      >
        <div class="text-[11px] text-gray-500">
          {{ a.role === 'frontend' ? '前端' : a.role === 'backend' ? '后端' : '测试' }}
        </div>
        <div class="text-base font-semibold">{{ a.points }} 点</div>
        <div class="text-[11px] text-gray-500 line-clamp-2" :title="a.rationale">{{ a.rationale }}</div>
      </div>
    </div>
  </section>
</template>
