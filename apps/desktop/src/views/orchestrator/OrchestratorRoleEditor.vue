<script setup lang="ts">
import { ref, watch } from 'vue'
import type { RoleInput } from '../../stores/orchestrator'
import AgentSelector from '../../components/AgentSelector.vue'

const props = defineProps<{
  roleId: string
  role: RoleInput
  isLeader: boolean
}>()

const emit = defineEmits<{
  update: [roleId: string, role: RoleInput]
  delete: [roleId: string]
  cancel: []
}>()

const form = ref<RoleInput>({ ...props.role })

watch(() => props.role, (v) => {
  form.value = { ...v }
}, { deep: true })

function save() {
  emit('update', props.roleId, { ...form.value })
}
</script>

<template>
  <div class="role-card">
    <!-- Header -->
    <div class="role-card-header">
      <div class="flex items-center gap-2.5">
        <div class="role-card-icon" :class="isLeader ? 'bg-amber-50 dark:bg-amber-500/10' : 'bg-indigo-50 dark:bg-indigo-500/10'">
          <div :class="[isLeader ? 'i-carbon-crown text-amber-500' : 'i-carbon-user-role text-indigo-500', 'w-4 h-4']" />
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h3 class="role-card-title">{{ roleId }}</h3>
            <span
              v-if="isLeader"
              class="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
            >
              Leader
            </span>
          </div>
          <p class="role-card-desc">{{ form.description || '编辑角色配置' }}</p>
        </div>
      </div>
      <button
        v-if="!isLeader"
        class="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all"
        title="删除角色"
        @click="emit('delete', roleId)"
      >
        <div class="i-carbon-trash-can w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Body -->
    <div class="role-card-body space-y-5">
      <!-- 描述 -->
      <div>
        <label class="role-label">描述</label>
        <input
          v-model="form.description"
          type="text"
          class="role-input"
          placeholder="角色职责描述"
        >
      </div>

      <!-- Agent CLI + Model -->
      <AgentSelector
        :provider="form.provider"
        :model="form.model ?? ''"
        compact
        @update:provider="form.provider = $event"
        @update:model="form.model = $event"
      />

      <!-- Prompt -->
      <div>
        <label class="role-label">Prompt</label>
        <textarea
          v-model="form.prompt_template"
          rows="6"
          class="role-input font-mono !text-[12px] resize-y !h-auto"
          placeholder="Agent 系统提示词…"
        />
        <p class="role-hint">
          支持变量: <code class="role-code">{requirement}</code> <code class="role-code">{plan}</code> <code class="role-code">{repo_path}</code>
        </p>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-end gap-2 pt-1">
        <button
          class="px-4 py-2 text-[13px] font-medium rounded-xl text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.04] transition-all"
          @click="emit('cancel')"
        >
          取消
        </button>
        <button class="role-save-btn" @click="save">
          <div class="i-carbon-checkmark w-3.5 h-3.5" />
          保存
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.role-card {
  background: white;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
:is(.dark) .role-card {
  background: #28282c;
  border-color: rgba(255, 255, 255, 0.04);
  box-shadow: none;
}

.role-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
:is(.dark) .role-card-header {
  border-bottom-color: rgba(255, 255, 255, 0.04);
}

.role-card-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.role-card-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
  line-height: 1.3;
}
:is(.dark) .role-card-title {
  color: #e5e7eb;
}

.role-card-desc {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 1px;
}
:is(.dark) .role-card-desc {
  color: #6b7280;
}

.role-card-body {
  padding: 16px 20px;
}

.role-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #6b7280;
  margin-bottom: 6px;
}
:is(.dark) .role-label {
  color: #9ca3af;
}

.role-input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border-radius: 12px;
  background: #fafafa;
  border: 1px solid rgba(0, 0, 0, 0.08);
  font-size: 13px;
  color: #1f2937;
  outline: none;
  transition: all 0.15s;
}
.role-input::placeholder {
  color: #c4c4c4;
}
.role-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  background: white;
}
:is(.dark) .role-input {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
}
:is(.dark) .role-input::placeholder {
  color: #4b5563;
}
:is(.dark) .role-input:focus {
  background: rgba(255, 255, 255, 0.06);
}
textarea.role-input {
  height: auto;
  padding: 8px 12px;
}

.role-hint {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 4px;
  line-height: 1.5;
}
:is(.dark) .role-hint {
  color: #6b7280;
}

.role-code {
  font-size: 11px;
  padding: 1px 5px;
  background: #f3f4f6;
  border-radius: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
:is(.dark) .role-code {
  background: rgba(255, 255, 255, 0.05);
}

.role-save-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  border-radius: 10px;
  background: #4f46e5;
  color: white;
  font-size: 13px;
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(79, 70, 229, 0.3);
  transition: all 0.15s;
}
.role-save-btn:hover {
  background: #6366f1;
  box-shadow: 0 2px 8px rgba(79, 70, 229, 0.35);
}
.role-save-btn:active {
  transform: scale(0.97);
}
</style>
