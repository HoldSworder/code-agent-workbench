<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useModelList } from '../composables/use-model-list'

const props = withDefaults(defineProps<{
  provider: string
  model: string
  showApiOption?: boolean
  compact?: boolean
}>(), {
  showApiOption: false,
  compact: false,
})

const emit = defineEmits<{
  'update:provider': [value: string]
  'update:model': [value: string]
}>()

const providerRef = computed(() => props.provider)
const { models: availableModels, loading: loadingModels, fetchModels, refreshModels } = useModelList(providerRef)

const customModelInput = ref(false)
const modelDropdownOpen = ref(false)
const modelSearchQuery = ref('')
const modelDropdownRef = ref<HTMLElement>()

const cliProviders = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor-cli', label: 'Cursor CLI' },
  { value: 'codex', label: 'Codex' },
]

const allProviders = computed(() =>
  props.showApiOption
    ? [...cliProviders, { value: 'custom-api', label: 'Custom API' }]
    : cliProviders,
)

const isCliMode = computed(() => ['cursor-cli', 'claude-code', 'codex'].includes(props.provider))

const selectedModelLabel = computed(() => {
  if (!props.model) return ''
  const found = availableModels.value.find(m => m.id === props.model)
  if (found) return found.label ? `${found.id} — ${found.label}` : found.id
  return props.model
})

const filteredModels = computed(() => {
  const q = modelSearchQuery.value.toLowerCase().trim()
  if (!q) return availableModels.value
  return availableModels.value.filter(
    m => m.id.toLowerCase().includes(q) || m.label?.toLowerCase().includes(q),
  )
})

watch(() => props.provider, async () => {
  emit('update:model', '')
  customModelInput.value = false
  await fetchModels()
})

watch(() => props.model, (v) => {
  if (v === '__custom__') {
    customModelInput.value = true
    emit('update:model', '')
  }
})

onMounted(async () => {
  await fetchModels()
  if (props.model && availableModels.value.length > 0) {
    if (!availableModels.value.some(m => m.id === props.model))
      customModelInput.value = true
  }
  document.addEventListener('click', onDocClick, true)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClick, true)
})

function selectModel(id: string) {
  emit('update:model', id)
  modelDropdownOpen.value = false
  modelSearchQuery.value = ''
}

function toggleModelDropdown() {
  modelDropdownOpen.value = !modelDropdownOpen.value
  if (!modelDropdownOpen.value) modelSearchQuery.value = ''
}

function onDocClick(e: MouseEvent) {
  if (modelDropdownRef.value && !modelDropdownRef.value.contains(e.target as Node)) {
    modelDropdownOpen.value = false
    modelSearchQuery.value = ''
  }
}

function switchToCustomInput() {
  customModelInput.value = true
  modelDropdownOpen.value = false
  modelSearchQuery.value = ''
  emit('update:model', '')
}
</script>

<template>
  <div :class="compact ? 'space-y-3' : 'space-y-5'">
    <!-- Provider -->
    <div>
      <label class="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">Agent CLI</label>
      <div :class="compact ? 'flex gap-1.5 flex-wrap' : 'grid grid-cols-2 gap-2'">
        <button
          v-for="p in allProviders"
          :key="p.value"
          type="button"
          class="flex items-center gap-2 text-left transition-all duration-150 rounded-lg border"
          :class="[
            provider === p.value
              ? 'border-indigo-500/40 bg-indigo-50/50 dark:bg-indigo-500/[0.06] ring-1 ring-indigo-500/20'
              : 'border-gray-200 dark:border-white/[0.06] hover:border-gray-300 dark:hover:border-white/10 hover:bg-gray-50 dark:hover:bg-white/[0.02]',
            compact ? 'px-2.5 py-1.5' : 'px-3.5 py-3',
          ]"
          @click="emit('update:provider', p.value)"
        >
          <div
            class="rounded-full border-2 transition-colors shrink-0"
            :class="[
              provider === p.value
                ? 'border-indigo-500 bg-indigo-500'
                : 'border-gray-300 dark:border-gray-600',
              compact ? 'w-3 h-3' : 'w-3.5 h-3.5',
            ]"
          >
            <div
              v-if="provider === p.value"
              class="w-full h-full rounded-full flex items-center justify-center"
            >
              <div class="w-1.5 h-1.5 rounded-full bg-white" />
            </div>
          </div>
          <span
            :class="[
              'font-medium',
              compact ? 'text-[12px]' : 'text-[13px]',
              provider === p.value ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-600 dark:text-gray-300',
            ]"
          >{{ p.label }}</span>
        </button>
      </div>
    </div>

    <!-- Model (CLI mode only) -->
    <div v-if="isCliMode">
      <label class="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">模型</label>
      <div class="flex gap-2 items-center">
        <div class="flex-1 relative" ref="modelDropdownRef">
          <!-- Loading -->
          <div
            v-if="loadingModels && availableModels.length === 0 && !customModelInput"
            class="selector-trigger cursor-default"
          >
            <div class="i-carbon-circle-dash w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0 animate-spin" />
            <span class="flex-1 text-left text-gray-400 dark:text-gray-500 text-[13px]">加载模型列表...</span>
          </div>

          <!-- Dropdown trigger -->
          <button
            v-else-if="availableModels.length > 0 && !customModelInput"
            type="button"
            class="selector-trigger"
            :class="modelDropdownOpen && 'selector-trigger--active'"
            @click="toggleModelDropdown"
          >
            <div class="i-carbon-machine-learning-model w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0" />
            <span class="flex-1 min-w-0 truncate text-left text-[13px]" :class="model ? 'text-gray-800 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'">
              {{ model ? selectedModelLabel : '使用默认模型' }}
            </span>
            <div
              class="i-carbon-chevron-down w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0 transition-transform duration-200"
              :class="modelDropdownOpen && 'rotate-180'"
            />
          </button>

          <!-- Dropdown panel -->
          <Transition name="dropdown">
            <div v-if="modelDropdownOpen" class="selector-panel">
              <div class="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-white/[0.06]">
                <div class="i-carbon-search w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0" />
                <input
                  v-model="modelSearchQuery"
                  type="text"
                  class="flex-1 bg-transparent border-none outline-none text-[13px] text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
                  placeholder="搜索模型..."
                  @click.stop
                >
              </div>
              <div class="max-h-60 overflow-y-auto p-1">
                <button
                  type="button"
                  class="selector-option"
                  :class="!model && 'selector-option--selected'"
                  @click="selectModel('')"
                >
                  <span class="flex-1 text-gray-500 dark:text-gray-400">使用默认模型</span>
                  <div v-if="!model" class="i-carbon-checkmark w-3.5 h-3.5 text-indigo-500" />
                </button>
                <button
                  v-for="m in filteredModels"
                  :key="m.id"
                  type="button"
                  class="selector-option"
                  :class="model === m.id && 'selector-option--selected'"
                  @click="selectModel(m.id)"
                >
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] text-gray-800 dark:text-gray-100 font-mono truncate">{{ m.id }}</div>
                    <div v-if="m.label" class="text-[11px] text-gray-400 dark:text-gray-500 truncate mt-0.5">{{ m.label }}</div>
                  </div>
                  <div v-if="model === m.id" class="i-carbon-checkmark w-3.5 h-3.5 text-indigo-500 shrink-0" />
                </button>
                <div v-if="filteredModels.length === 0 && modelSearchQuery" class="px-3 py-4 text-center text-[12px] text-gray-400">
                  未找到匹配的模型
                </div>
              </div>
              <button
                type="button"
                class="flex items-center gap-1.5 w-full px-3 py-2 text-[12px] text-gray-500 border-t border-gray-100 dark:border-white/[0.06] hover:text-indigo-500 hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition-colors"
                @click="switchToCustomInput"
              >
                <div class="i-carbon-edit w-3.5 h-3.5" />
                自定义输入
              </button>
            </div>
          </Transition>

          <!-- Manual input fallback -->
          <div v-if="customModelInput || (availableModels.length === 0 && !loadingModels)" class="relative">
            <div class="absolute left-3 top-1/2 -translate-y-1/2 i-carbon-machine-learning-model w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
            <input
              :value="model"
              type="text"
              placeholder="输入模型名称"
              class="w-full h-9 pl-9 pr-3 py-2 rounded-xl bg-[#fafafa] dark:bg-white/[0.04] text-[13px] border border-gray-200 dark:border-white/[0.08] placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 outline-none transition-all"
              @input="emit('update:model', ($event.target as HTMLInputElement).value)"
            >
          </div>
        </div>

        <button
          v-if="customModelInput && availableModels.length > 0"
          class="flex items-center justify-center w-9 h-9 rounded-xl border border-gray-200 dark:border-white/[0.08] text-gray-400 hover:text-indigo-500 hover:border-indigo-200 dark:hover:border-indigo-500/30 hover:bg-indigo-50/50 dark:hover:bg-indigo-500/[0.06] transition-all shrink-0"
          title="切换到选择列表"
          @click="customModelInput = false; emit('update:model', '')"
        >
          <div class="i-carbon-list w-4 h-4" />
        </button>
        <button
          class="flex items-center justify-center w-9 h-9 rounded-xl border border-gray-200 dark:border-white/[0.08] text-gray-400 hover:text-indigo-500 hover:border-indigo-200 dark:hover:border-indigo-500/30 hover:bg-indigo-50/50 dark:hover:bg-indigo-500/[0.06] transition-all shrink-0 disabled:opacity-30"
          :disabled="loadingModels"
          title="刷新模型列表"
          @click="refreshModels()"
        >
          <div class="i-carbon-renew w-4 h-4" :class="loadingModels && 'animate-spin'" />
        </button>
      </div>
      <p v-if="customModelInput" class="text-[11px] text-gray-400 mt-1">
        手动输入模型名称，点击列表图标切回选择
      </p>
    </div>
  </div>
</template>

<style scoped>
.selector-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border-radius: 12px;
  background: #fafafa;
  border: 1px solid rgba(0, 0, 0, 0.08);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
:is(.dark) .selector-trigger {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}
.selector-trigger:hover {
  border-color: #d1d5db;
  background: #f5f5f5;
}
:is(.dark) .selector-trigger:hover {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
}
.selector-trigger--active {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  background: white;
}
:is(.dark) .selector-trigger--active {
  background: rgba(255, 255, 255, 0.06);
}

.selector-panel {
  position: absolute;
  z-index: 50;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  background: white;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 1px 4px rgba(0, 0, 0, 0.04);
}
:is(.dark) .selector-panel {
  background: #28282c;
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
}

.selector-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  transition: all 0.1s;
}
.selector-option:hover {
  background: #f3f4f6;
}
.selector-option--selected {
  background: #eef2ff;
}
:is(.dark) .selector-option:hover {
  background: rgba(255, 255, 255, 0.06);
}
:is(.dark) .selector-option--selected {
  background: rgba(99, 102, 241, 0.08);
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.15s ease;
}
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
