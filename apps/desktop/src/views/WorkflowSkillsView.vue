<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import { rpc } from '../composables/use-sidecar'

interface SkillInput {
  key: string
  label?: string
  required?: boolean
  default?: string
}

interface SkillMeta {
  id: string
  name: string
  description: string
  inputs?: SkillInput[]
  mcp_dependencies?: string[]
  tags?: string[]
  dir?: string
}

interface ListResponse {
  root: string
  skills: SkillMeta[]
}

interface DetailResponse {
  found: boolean
  meta: SkillMeta | null
  content: string
  dir?: string
}

type FormMode = 'create' | 'edit'

interface FormState {
  id: string
  name: string
  description: string
  content: string
  inputs: SkillInput[]
  mcp_dependencies: string
  tags: string
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const skills = ref<SkillMeta[]>([])
const root = ref('')
const loading = ref(true)
const search = ref('')
const selectedId = ref<string | null>(null)
const detailContent = ref('')
const detailMeta = ref<SkillMeta | null>(null)

const drawerOpen = ref(false)
const drawerMode = ref<FormMode>('create')
const saving = ref(false)
const form = reactive<FormState>({
  id: '',
  name: '',
  description: '',
  content: '',
  inputs: [],
  mcp_dependencies: '',
  tags: '',
})
const formError = ref('')

const filteredSkills = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return skills.value
  return skills.value.filter(s =>
    s.id.toLowerCase().includes(q)
    || s.name.toLowerCase().includes(q)
    || s.description.toLowerCase().includes(q),
  )
})

const renderedContent = computed(() => md.render(detailContent.value || ''))

async function loadList() {
  loading.value = true
  try {
    const res = await rpc<ListResponse>('workflowSkill.list')
    skills.value = res.skills ?? []
    root.value = res.root
    if (selectedId.value && !skills.value.find(s => s.id === selectedId.value))
      selectedId.value = null
    if (!selectedId.value && skills.value.length > 0)
      selectSkill(skills.value[0].id)
  }
  catch (err) {
    console.error('[workflowSkill.list] failed:', err)
    skills.value = []
  }
  finally {
    loading.value = false
  }
}

async function selectSkill(id: string) {
  selectedId.value = id
  detailContent.value = ''
  detailMeta.value = null
  try {
    const res = await rpc<DetailResponse>('workflowSkill.get', { id })
    if (res.found) {
      detailMeta.value = res.meta
      detailContent.value = res.content
    }
  }
  catch (err) {
    console.error('[workflowSkill.get] failed:', err)
  }
}

function openCreate() {
  drawerMode.value = 'create'
  formError.value = ''
  Object.assign(form, {
    id: '',
    name: '',
    description: '',
    content: '# 新 Skill\n\n描述 skill 的执行步骤，使用 {{variable}} 引用输入变量。\n',
    inputs: [],
    mcp_dependencies: '',
    tags: '',
  })
  drawerOpen.value = true
}

function openEdit() {
  if (!detailMeta.value) return
  drawerMode.value = 'edit'
  formError.value = ''
  Object.assign(form, {
    id: detailMeta.value.id,
    name: detailMeta.value.name,
    description: detailMeta.value.description ?? '',
    content: detailContent.value,
    inputs: (detailMeta.value.inputs ?? []).map(i => ({ ...i })),
    mcp_dependencies: (detailMeta.value.mcp_dependencies ?? []).join(', '),
    tags: (detailMeta.value.tags ?? []).join(', '),
  })
  drawerOpen.value = true
}

function addInput() {
  form.inputs.push({ key: '', required: false })
}

function removeInput(idx: number) {
  form.inputs.splice(idx, 1)
}

function parseCsv(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

async function submitForm() {
  formError.value = ''
  if (!form.id.trim()) { formError.value = 'id 必填'; return }
  if (!form.name.trim()) { formError.value = '名称必填'; return }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(form.id)) {
    formError.value = 'id 只允许字母、数字、-、_，且需以字母或数字开头'
    return
  }

  saving.value = true
  try {
    const payload = {
      id: form.id.trim(),
      name: form.name.trim(),
      description: form.description,
      content: form.content,
      inputs: form.inputs.filter(i => i.key.trim()).map(i => ({
        key: i.key.trim(),
        label: i.label?.trim() || undefined,
        required: i.required || undefined,
        default: i.default?.trim() || undefined,
      })),
      mcp_dependencies: parseCsv(form.mcp_dependencies),
      tags: parseCsv(form.tags),
    }
    const method = drawerMode.value === 'create' ? 'workflowSkill.create' : 'workflowSkill.update'
    await rpc(method, payload)
    drawerOpen.value = false
    await loadList()
    await selectSkill(payload.id)
  }
  catch (err: any) {
    formError.value = err?.message ?? String(err)
  }
  finally {
    saving.value = false
  }
}

async function deleteSkill(id: string) {
  if (!confirm(`确认删除 skill「${id}」？此操作不可撤销。`)) return
  try {
    await rpc('workflowSkill.delete', { id })
    selectedId.value = null
    detailMeta.value = null
    detailContent.value = ''
    await loadList()
  }
  catch (err) {
    console.error('[workflowSkill.delete] failed:', err)
  }
}

onMounted(loadList)
</script>

<template>
  <div class="h-full flex flex-col">
    <header class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
      <div>
        <h2 class="text-lg font-semibold">工作流 Skills</h2>
        <p class="text-xs text-gray-500 mt-0.5">
          项目根级 <code class="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[11px]">skills/</code>
          目录下的可复用 prompt 能力包，可在工作流的 skill 节点中引用。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="search"
          type="text"
          placeholder="搜索 skill…"
          class="px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-indigo-500 w-48"
        >
        <button
          class="px-3 py-1.5 text-[13px] bg-indigo-600 text-white rounded-md hover:bg-indigo-700 flex items-center gap-1"
          @click="openCreate"
        >
          <div class="i-carbon-add w-4 h-4" />
          新建
        </button>
      </div>
    </header>

    <div class="flex-1 flex overflow-hidden">
      <!-- 左侧列表 -->
      <aside class="w-72 border-r border-gray-200 dark:border-gray-800 overflow-y-auto">
        <div v-if="loading" class="p-6 text-center text-sm text-gray-400">
          加载中…
        </div>
        <div v-else-if="filteredSkills.length === 0" class="p-6 text-center text-sm text-gray-400">
          暂无 skill<span v-if="search">（匹配 "{{ search }}"）</span>
        </div>
        <button
          v-for="s in filteredSkills"
          :key="s.id"
          class="w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 transition"
          :class="selectedId === s.id ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''"
          @click="selectSkill(s.id)"
        >
          <div class="flex items-center gap-2">
            <div class="font-medium text-[13px] truncate">
              {{ s.name }}
            </div>
          </div>
          <div class="text-[11px] text-gray-500 mt-0.5 truncate">
            {{ s.id }}
          </div>
          <div class="text-[12px] text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
            {{ s.description || '（无描述）' }}
          </div>
          <div class="flex flex-wrap gap-1 mt-2">
            <span
              v-if="s.inputs && s.inputs.length"
              class="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
            >
              {{ s.inputs.length }} 输入
            </span>
            <span
              v-for="dep in s.mcp_dependencies ?? []"
              :key="dep"
              class="px-1.5 py-0.5 text-[10px] rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
            >
              MCP: {{ dep }}
            </span>
          </div>
        </button>
      </aside>

      <!-- 右侧详情 -->
      <section class="flex-1 overflow-y-auto">
        <div v-if="!detailMeta" class="h-full flex items-center justify-center text-gray-400 text-sm">
          选择左侧 skill 查看详情
        </div>
        <div v-else class="p-6">
          <div class="flex items-start justify-between mb-4">
            <div>
              <h3 class="text-xl font-semibold">
                {{ detailMeta.name }}
              </h3>
              <div class="text-xs text-gray-500 mt-1 font-mono">
                {{ detailMeta.id }}
              </div>
              <p v-if="detailMeta.description" class="text-sm text-gray-600 dark:text-gray-400 mt-2">
                {{ detailMeta.description }}
              </p>
            </div>
            <div class="flex gap-2">
              <button
                class="px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900"
                @click="openEdit"
              >
                编辑
              </button>
              <button
                class="px-3 py-1.5 text-[13px] rounded-md border border-red-200 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                @click="deleteSkill(detailMeta.id)"
              >
                删除
              </button>
            </div>
          </div>

          <div v-if="detailMeta.inputs && detailMeta.inputs.length" class="mb-4">
            <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              输入变量
            </div>
            <div class="space-y-1.5">
              <div
                v-for="input in detailMeta.inputs"
                :key="input.key"
                class="flex items-baseline gap-2 text-[13px]"
              >
                <code class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-indigo-600 dark:text-indigo-300 font-mono">
                  {{ input.key }}
                </code>
                <span v-if="input.label" class="text-gray-600 dark:text-gray-400">{{ input.label }}</span>
                <span v-if="input.required" class="text-red-500 text-[11px]">必填</span>
                <span v-if="input.default" class="text-gray-400 text-[11px]">默认 "{{ input.default }}"</span>
              </div>
            </div>
          </div>

          <div v-if="detailMeta.mcp_dependencies && detailMeta.mcp_dependencies.length" class="mb-4">
            <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              MCP 依赖
            </div>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="dep in detailMeta.mcp_dependencies"
                :key="dep"
                class="px-2 py-0.5 text-[12px] rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
              >
                {{ dep }}
              </span>
            </div>
          </div>

          <div class="mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            SKILL.md
          </div>
          <div
            class="prose prose-sm max-w-none dark:prose-invert border border-gray-200 dark:border-gray-800 rounded-md p-4 bg-white dark:bg-gray-950"
            v-html="renderedContent"
          />
        </div>
      </section>
    </div>

    <!-- 编辑抽屉 -->
    <div
      v-if="drawerOpen"
      class="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm"
      @click.self="drawerOpen = false"
    >
      <div class="w-[640px] bg-white dark:bg-gray-950 h-full flex flex-col shadow-2xl">
        <header class="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <h3 class="text-base font-semibold">
            {{ drawerMode === 'create' ? '新建 Skill' : `编辑 Skill: ${form.id}` }}
          </h3>
          <button class="text-gray-400 hover:text-gray-600" @click="drawerOpen = false">
            <div class="i-carbon-close w-5 h-5" />
          </button>
        </header>

        <div class="flex-1 overflow-y-auto p-6 space-y-4">
          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">ID <span class="text-red-500">*</span></label>
            <input
              v-model="form.id"
              type="text"
              :disabled="drawerMode === 'edit'"
              placeholder="例如 feishu-branch-link"
              class="w-full px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 font-mono disabled:opacity-50"
            >
            <p class="text-[11px] text-gray-400 mt-1">
              目录名，创建后不可修改。只允许字母、数字、-、_。
            </p>
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">名称 <span class="text-red-500">*</span></label>
            <input
              v-model="form.name"
              type="text"
              class="w-full px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            >
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">描述</label>
            <textarea
              v-model="form.description"
              rows="2"
              class="w-full px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 resize-none"
            />
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs font-medium text-gray-600 dark:text-gray-400">输入变量</label>
              <button
                class="text-[11px] text-indigo-600 hover:underline flex items-center gap-0.5"
                @click="addInput"
              >
                <div class="i-carbon-add w-3 h-3" />
                添加
              </button>
            </div>
            <div v-if="form.inputs.length === 0" class="text-[11px] text-gray-400 italic">
              未定义输入变量
            </div>
            <div v-for="(input, idx) in form.inputs" :key="idx" class="flex items-center gap-1.5 mb-1.5">
              <input
                v-model="input.key"
                type="text"
                placeholder="key"
                class="flex-1 px-2 py-1 text-[12px] rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 font-mono"
              >
              <input
                v-model="input.label"
                type="text"
                placeholder="label"
                class="flex-1 px-2 py-1 text-[12px] rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
              >
              <input
                v-model="input.default"
                type="text"
                placeholder="default"
                class="w-20 px-2 py-1 text-[12px] rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
              >
              <label class="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400">
                <input v-model="input.required" type="checkbox">
                必填
              </label>
              <button class="text-red-500 hover:text-red-600" @click="removeInput(idx)">
                <div class="i-carbon-trash-can w-4 h-4" />
              </button>
            </div>
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">MCP 依赖（逗号分隔）</label>
            <input
              v-model="form.mcp_dependencies"
              type="text"
              placeholder="例如 lark-project, github"
              class="w-full px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            >
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">标签（逗号分隔）</label>
            <input
              v-model="form.tags"
              type="text"
              placeholder="例如 feishu, git"
              class="w-full px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            >
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">SKILL.md 内容</label>
            <textarea
              v-model="form.content"
              rows="16"
              class="w-full px-3 py-2 text-[12px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 font-mono resize-y"
            />
          </div>

          <div v-if="formError" class="text-[12px] text-red-600 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">
            {{ formError }}
          </div>
        </div>

        <footer class="px-6 py-3 border-t border-gray-200 dark:border-gray-800 flex justify-end gap-2">
          <button
            class="px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900"
            @click="drawerOpen = false"
          >
            取消
          </button>
          <button
            class="px-3 py-1.5 text-[13px] rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            :disabled="saving"
            @click="submitForm"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>
