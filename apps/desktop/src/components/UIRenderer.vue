<script setup lang="ts">
import { ref, computed } from 'vue'

export interface UIOption {
  value: string
  label: string
  description?: string
}

export interface UIFormField {
  name: string
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'number'
  label: string
  required?: boolean
  default?: any
  options?: UIOption[]
  placeholder?: string
}

export interface UIElement {
  id: string
  type: 'select' | 'form' | 'actions'
  title?: string
  description?: string
  options?: UIOption[]
  multiple?: boolean
  fields?: UIFormField[]
  buttons?: Array<{ value: string; label: string; style?: 'primary' | 'secondary' | 'danger'; description?: string }>
  phaseId?: string | null
  response?: any
  respondedAt?: number | null
}

const props = defineProps<{
  element: UIElement
  readonly?: boolean
}>()

const emit = defineEmits<{
  submit: [elementId: string, data: unknown]
}>()

const selectedValue = ref<string | null>(null)
const selectedValues = ref<Set<string>>(new Set())
const formData = ref<Record<string, any>>({})

function initFormDefaults() {
  if (props.element.type !== 'form' || !props.element.fields) return
  const defaults: Record<string, any> = {}
  for (const field of props.element.fields) {
    if (field.default !== undefined) defaults[field.name] = field.default
    else if (field.type === 'checkbox') defaults[field.name] = false
    else if (field.type === 'number') defaults[field.name] = 0
    else defaults[field.name] = ''
  }
  formData.value = defaults
}
initFormDefaults()

const isResponded = computed(() => props.element.response != null)

function handleSelectClick(value: string) {
  if (isResponded.value || props.readonly) return
  if (props.element.multiple) {
    const s = new Set(selectedValues.value)
    s.has(value) ? s.delete(value) : s.add(value)
    selectedValues.value = s
  }
  else {
    selectedValue.value = value
  }
}

function handleSelectSubmit() {
  const data = props.element.multiple
    ? { selected: [...selectedValues.value] }
    : { selected: selectedValue.value }
  emit('submit', props.element.id, data)
}

function handleFormSubmit() {
  emit('submit', props.element.id, formData.value)
}

function handleActionClick(value: string) {
  if (isResponded.value || props.readonly) return
  emit('submit', props.element.id, { action: value })
}

const selectCanSubmit = computed(() => {
  if (props.element.multiple) return selectedValues.value.size > 0
  return selectedValue.value != null
})

const formCanSubmit = computed(() => {
  if (!props.element.fields) return false
  return props.element.fields
    .filter(f => f.required)
    .every(f => {
      const v = formData.value[f.name]
      return v !== '' && v !== null && v !== undefined
    })
})

function respondedDisplay(): string {
  const r = props.element.response
  if (!r) return ''
  if (r.selected != null) {
    const vals = Array.isArray(r.selected) ? r.selected : [r.selected]
    const labels = vals.map((v: string) => {
      const opt = props.element.options?.find(o => o.value === v)
      return opt?.label ?? v
    })
    return labels.join(', ')
  }
  if (r.action != null) {
    const btn = props.element.buttons?.find(b => b.value === r.action)
    return btn?.label ?? r.action
  }
  return JSON.stringify(r)
}
</script>

<template>
  <div class="rounded-xl border border-indigo-200/60 dark:border-indigo-500/15 bg-indigo-50/30 dark:bg-indigo-500/[0.04] px-4 py-3 max-w-[85%]">
    <!-- Title -->
    <div v-if="element.title" class="flex items-center gap-2 mb-2">
      <div class="i-carbon-interactive-segmentation-cursor w-4 h-4 text-indigo-500" />
      <span class="text-[13px] text-indigo-700 dark:text-indigo-400 font-medium">{{ element.title }}</span>
    </div>
    <p v-if="element.description && !isResponded" class="text-[12px] text-gray-500 dark:text-gray-400 mb-3 ml-6">
      {{ element.description }}
    </p>

    <!-- Responded state -->
    <div v-if="isResponded" class="ml-6">
      <div class="flex items-center gap-2 text-[12px] text-gray-500 dark:text-gray-400">
        <div class="i-carbon-checkmark-filled w-3.5 h-3.5 text-green-500" />
        <span>已选择: <span class="text-gray-700 dark:text-gray-300 font-medium">{{ respondedDisplay() }}</span></span>
      </div>
    </div>

    <!-- Select type -->
    <template v-else-if="element.type === 'select' && element.options">
      <div class="ml-6 space-y-1.5 mb-3">
        <button
          v-for="opt in element.options"
          :key="opt.value"
          class="w-full text-left px-3 py-2 rounded-lg text-[12px] border transition-all duration-150"
          :class="(selectedValue === opt.value || selectedValues.has(opt.value))
            ? 'border-indigo-400 dark:border-indigo-500/40 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-400/30'
            : 'border-gray-200/60 dark:border-white/8 bg-white/60 dark:bg-white/[0.03] text-gray-700 dark:text-gray-300 hover:border-indigo-300 dark:hover:border-indigo-500/25 hover:bg-indigo-50/50 dark:hover:bg-indigo-500/5'"
          @click="handleSelectClick(opt.value)"
        >
          <div class="flex items-center gap-2">
            <div
              class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors"
              :class="(selectedValue === opt.value || selectedValues.has(opt.value))
                ? 'border-indigo-500 bg-indigo-500'
                : 'border-gray-300 dark:border-gray-600'"
            >
              <div v-if="selectedValue === opt.value || selectedValues.has(opt.value)" class="w-1.5 h-1.5 rounded-full bg-white" />
            </div>
            <span class="font-medium">{{ opt.label }}</span>
          </div>
          <p v-if="opt.description" class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 ml-6">{{ opt.description }}</p>
        </button>
      </div>
      <div class="flex justify-end">
        <button
          :disabled="!selectCanSubmit"
          class="px-4 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-150 active:scale-[0.97]"
          :class="selectCanSubmit
            ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-600/20'
            : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'"
          @click="handleSelectSubmit"
        >
          确认选择
        </button>
      </div>
    </template>

    <!-- Form type -->
    <template v-else-if="element.type === 'form' && element.fields">
      <div class="ml-6 space-y-3 mb-3">
        <div v-for="field in element.fields" :key="field.name">
          <label class="block text-[12px] font-medium text-gray-600 dark:text-gray-400 mb-1">
            {{ field.label }}
            <span v-if="field.required" class="text-red-400 ml-0.5">*</span>
          </label>

          <!-- text -->
          <input
            v-if="field.type === 'text' || field.type === 'number'"
            v-model="formData[field.name]"
            :type="field.type"
            :placeholder="field.placeholder"
            class="w-full px-2.5 py-1.5 rounded-lg text-[12px] bg-white dark:bg-[#1e1e22] border border-gray-200/60 dark:border-white/10 text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-400/50"
          >

          <!-- textarea -->
          <textarea
            v-else-if="field.type === 'textarea'"
            v-model="formData[field.name]"
            :placeholder="field.placeholder"
            rows="3"
            class="w-full px-2.5 py-1.5 rounded-lg text-[12px] bg-white dark:bg-[#1e1e22] border border-gray-200/60 dark:border-white/10 text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 resize-y focus:outline-none focus:ring-1 focus:ring-indigo-400/50"
          />

          <!-- select -->
          <select
            v-else-if="field.type === 'select'"
            v-model="formData[field.name]"
            class="w-full px-2.5 py-1.5 rounded-lg text-[12px] bg-white dark:bg-[#1e1e22] border border-gray-200/60 dark:border-white/10 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-400/50"
          >
            <option value="" disabled>{{ field.placeholder || '请选择...' }}</option>
            <option v-for="opt in field.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>

          <!-- checkbox -->
          <label v-else-if="field.type === 'checkbox'" class="flex items-center gap-2 cursor-pointer">
            <input
              v-model="formData[field.name]"
              type="checkbox"
              class="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500/30"
            >
            <span class="text-[12px] text-gray-600 dark:text-gray-400">{{ field.placeholder || '' }}</span>
          </label>

          <!-- radio -->
          <div v-else-if="field.type === 'radio' && field.options" class="space-y-1">
            <label v-for="opt in field.options" :key="opt.value" class="flex items-center gap-2 cursor-pointer">
              <input
                v-model="formData[field.name]"
                type="radio"
                :value="opt.value"
                class="w-3.5 h-3.5 border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500/30"
              >
              <span class="text-[12px] text-gray-600 dark:text-gray-400">{{ opt.label }}</span>
            </label>
          </div>
        </div>
      </div>
      <div class="flex justify-end">
        <button
          :disabled="!formCanSubmit"
          class="px-4 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-150 active:scale-[0.97]"
          :class="formCanSubmit
            ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-600/20'
            : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'"
          @click="handleFormSubmit"
        >
          提交
        </button>
      </div>
    </template>

    <!-- Actions type -->
    <template v-else-if="element.type === 'actions' && element.buttons">
      <div class="ml-6 flex flex-wrap items-center gap-2">
        <button
          v-for="btn in element.buttons"
          :key="btn.value"
          class="px-4 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-150 active:scale-[0.97]"
          :class="{
            'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-600/20': btn.style === 'primary',
            'border border-gray-200 dark:border-gray-600/30 text-gray-600 dark:text-gray-400 hover:bg-gray-100/50 dark:hover:bg-gray-500/10': btn.style === 'secondary' || !btn.style,
            'bg-red-600 text-white hover:bg-red-500 shadow-sm shadow-red-600/20': btn.style === 'danger',
          }"
          @click="handleActionClick(btn.value)"
        >
          {{ btn.label }}
        </button>
      </div>
    </template>
  </div>
</template>
