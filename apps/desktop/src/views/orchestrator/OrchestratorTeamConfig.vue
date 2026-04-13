<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useOrchestratorStore } from '../../stores/orchestrator'
import { useReposStore } from '../../stores/repos'
import type { RoleInput, TeamConfigInput } from '../../stores/orchestrator'
import OrchestratorRoleEditor from './OrchestratorRoleEditor.vue'
import AgencyAgentBrowser from './AgencyAgentBrowser.vue'

const store = useOrchestratorStore()
const reposStore = useReposStore()

const editingRoleId = ref<string | null>(null)
const showAddRole = ref(false)
const showAgencyBrowser = ref(false)
const newRoleId = ref('')
const saving = ref(false)
const saveMessage = ref('')
const creating = ref(false)

const teamName = ref('')
const teamDescription = ref('')
const pollingInterval = ref(30)

onMounted(async () => {
  await Promise.all([store.fetchTeamConfig(), reposStore.fetchAll()])
  syncFromConfig()
})

async function handleCreateDefault() {
  creating.value = true
  try {
    await store.createDefaultConfig()
    syncFromConfig()
  }
  catch (err) {
    saveMessage.value = `创建失败: ${err instanceof Error ? err.message : err}`
  }
  finally {
    creating.value = false
  }
}

function syncFromConfig() {
  if (!store.teamConfig) return
  teamName.value = store.teamConfig.name
  teamDescription.value = store.teamConfig.description ?? ''
  pollingInterval.value = store.teamConfig.polling.interval_seconds
}

const roles = computed(() => {
  if (!store.teamConfig) return []
  return Object.entries(store.teamConfig.roles).map(([id, role]) => ({
    id,
    ...role,
  }))
})

const workerRoles = computed(() =>
  roles.value
    .filter(r => r.id !== 'leader')
    .map(r => ({ id: r.id, description: r.description })),
)

const reposSummary = computed(() =>
  reposStore.repos.map(r => ({ id: r.id, name: r.name, local_path: r.local_path })),
)

function startEdit(roleId: string) {
  editingRoleId.value = roleId
  showAddRole.value = false
}

function handleUpdateRole(roleId: string, role: RoleInput) {
  if (!store.teamConfig) return
  store.teamConfig.roles[roleId] = role
  editingRoleId.value = null
  saveConfig()
}

function handleDeleteRole(roleId: string) {
  if (!store.teamConfig || roleId === 'leader') return
  delete store.teamConfig.roles[roleId]
  editingRoleId.value = null
  saveConfig()
}

function addRole() {
  const id = newRoleId.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_')
  if (!id || !store.teamConfig || id in store.teamConfig.roles) return

  store.teamConfig.roles[id] = {
    description: '',
    provider: 'claude-code',
    model: '',
    prompt_template: '',
  }
  newRoleId.value = ''
  showAddRole.value = false
  editingRoleId.value = id
}

function handleAgencyImport(roleId: string, description: string, promptTemplate: string) {
  if (!store.teamConfig) return
  const id = roleId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
  if (id in store.teamConfig.roles) {
    saveMessage.value = `角色 "${id}" 已存在，请先删除或重命名`
    showAgencyBrowser.value = false
    return
  }

  store.teamConfig.roles[id] = {
    description,
    provider: 'claude-code',
    model: '',
    prompt_template: promptTemplate,
  }
  showAgencyBrowser.value = false
  editingRoleId.value = id
  saveConfig()
}

async function saveConfig() {
  if (!store.teamConfig) return
  saving.value = true
  saveMessage.value = ''

  try {
    const config: TeamConfigInput = {
      name: teamName.value || store.teamConfig.name,
      description: teamDescription.value || undefined,
      polling: {
        interval_seconds: pollingInterval.value,
        board_filter: store.teamConfig.polling.board_filter,
      },
      roles: store.teamConfig.roles,
    }
    await store.saveTeamConfig(config)
    saveMessage.value = '已保存'
    setTimeout(() => { saveMessage.value = '' }, 2000)
  }
  catch (err) {
    saveMessage.value = `保存失败: ${err instanceof Error ? err.message : err}`
  }
  finally {
    saving.value = false
  }
}

async function saveGeneralSettings() {
  if (!store.teamConfig) return
  store.teamConfig.name = teamName.value
  store.teamConfig.description = teamDescription.value || undefined
  store.teamConfig.polling.interval_seconds = pollingInterval.value
  await saveConfig()
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <!-- 未配置状态 -->
    <div v-if="!store.teamConfig" class="flex items-center justify-center h-full">
      <div class="text-center max-w-sm">
        <div class="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gray-100 dark:bg-white/[0.04] flex items-center justify-center">
          <div class="i-carbon-group w-7 h-7 text-gray-300 dark:text-gray-600" />
        </div>
        <h3 class="text-[15px] font-semibold text-gray-800 dark:text-gray-200 mb-1">未找到 team.yaml 配置</h3>
        <p class="text-[13px] text-gray-400 dark:text-gray-500 mb-5">创建默认团队配置以开始使用多 Agent 编排</p>
        <button
          class="cfg-save-btn"
          :disabled="creating"
          @click="handleCreateDefault"
        >
          <div class="i-carbon-add w-3.5 h-3.5" />
          {{ creating ? '创建中…' : '创建默认配置' }}
        </button>
        <p v-if="store.configError" class="mt-4 text-xs text-red-500 break-all">
          {{ store.configError }}
        </p>
        <p v-if="saveMessage" class="mt-4 text-xs text-red-500">
          {{ saveMessage }}
        </p>
      </div>
    </div>

    <div v-else class="max-w-2xl mx-auto px-6 py-6 space-y-6">
      <!-- 基本设置 -->
      <section class="cfg-card">
        <div class="cfg-card-header">
          <div class="cfg-card-icon bg-violet-50 dark:bg-violet-500/10">
            <div class="i-carbon-settings w-4 h-4 text-violet-500" />
          </div>
          <div>
            <h3 class="cfg-card-title">基本设置</h3>
            <p class="cfg-card-desc">团队名称、描述与轮询策略</p>
          </div>
        </div>
        <div class="cfg-card-body space-y-5">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="cfg-label">团队名称</label>
              <input
                v-model="teamName"
                type="text"
                class="cfg-input"
                placeholder="my-team"
              >
            </div>
            <div>
              <label class="cfg-label">轮询间隔 (秒)</label>
              <input
                v-model.number="pollingInterval"
                type="number"
                min="5"
                max="300"
                class="cfg-input"
              >
              <p class="cfg-hint">Leader 检查新需求的间隔，范围 5–300</p>
            </div>
          </div>
          <div>
            <label class="cfg-label">描述</label>
            <input
              v-model="teamDescription"
              type="text"
              class="cfg-input"
              placeholder="可选，描述团队用途"
            >
          </div>
          <div class="flex items-center gap-3">
            <button
              class="cfg-save-btn"
              :disabled="saving"
              @click="saveGeneralSettings"
            >
              <div class="i-carbon-checkmark w-3.5 h-3.5" />
              保存设置
            </button>
            <Transition name="fade">
              <span
                v-if="saveMessage"
                class="text-[12px] font-medium"
                :class="saveMessage.startsWith('保存失败') ? 'text-red-500' : 'text-emerald-500'"
              >
                {{ saveMessage }}
              </span>
            </Transition>
          </div>
        </div>
      </section>

      <!-- 角色列表 -->
      <section class="cfg-card">
        <div class="cfg-card-header">
          <div class="cfg-card-icon bg-indigo-50 dark:bg-indigo-500/10">
            <div class="i-carbon-user-multiple w-4 h-4 text-indigo-500" />
          </div>
          <div class="flex-1">
            <h3 class="cfg-card-title">Agent 角色 ({{ roles.length }})</h3>
            <p class="cfg-card-desc">定义团队中各 Agent 的职责、CLI 工具和模型</p>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg bg-violet-50 text-violet-600 hover:bg-violet-100 dark:bg-violet-500/10 dark:text-violet-400 dark:hover:bg-violet-500/20 transition-all"
              @click="showAgencyBrowser = true; editingRoleId = null; showAddRole = false"
            >
              <div class="i-carbon-catalog w-3 h-3" />
              从 Agency 导入
            </button>
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-400 dark:hover:bg-indigo-500/20 transition-all"
              @click="showAddRole = true; editingRoleId = null"
            >
              <div class="i-carbon-add w-3 h-3" />
              添加角色
            </button>
          </div>
        </div>
        <div class="cfg-card-body">
          <!-- 添加新角色 -->
          <Transition name="fade">
            <div v-if="showAddRole" class="mb-4 p-4 rounded-xl border border-dashed border-indigo-300/60 dark:border-indigo-500/20 bg-indigo-50/30 dark:bg-indigo-500/[0.03]">
              <label class="cfg-label">角色 ID</label>
              <div class="flex items-center gap-2">
                <div class="flex-1 relative">
                  <div class="absolute left-3 top-1/2 -translate-y-1/2 i-carbon-user-role w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
                  <input
                    v-model="newRoleId"
                    type="text"
                    class="cfg-input !pl-9"
                    placeholder="如 frontend_dev、reviewer"
                    @keyup.enter="addRole"
                  >
                </div>
                <button
                  class="cfg-save-btn"
                  :disabled="!newRoleId.trim()"
                  @click="addRole"
                >
                  创建
                </button>
                <button
                  class="px-3 py-2 text-[13px] font-medium rounded-xl text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.04] transition-all"
                  @click="showAddRole = false; newRoleId = ''"
                >
                  取消
                </button>
              </div>
              <p class="cfg-hint">仅支持小写字母、数字、下划线和连字符</p>
            </div>
          </Transition>

          <!-- 角色卡片列表 -->
          <div class="space-y-3">
            <template v-for="r in roles" :key="r.id">
              <OrchestratorRoleEditor
                v-if="editingRoleId === r.id"
                :role-id="r.id"
                :role="r"
                :is-leader="r.id === 'leader'"
                :worker-roles="workerRoles"
                :repos="reposSummary"
                @update="handleUpdateRole"
                @delete="handleDeleteRole"
                @cancel="editingRoleId = null"
              />

              <!-- 折叠态 -->
              <button
                v-else
                class="cfg-role-item"
                @click="startEdit(r.id)"
              >
                <div class="flex-1 min-w-0 flex items-center gap-2.5">
                  <div
                    class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    :class="r.id === 'leader' ? 'bg-amber-50 dark:bg-amber-500/10' : 'bg-gray-100 dark:bg-white/[0.04]'"
                  >
                    <div :class="[r.id === 'leader' ? 'i-carbon-crown text-amber-500' : 'i-carbon-user-role text-gray-400 dark:text-gray-500', 'w-3.5 h-3.5']" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-[13px] font-medium text-gray-800 dark:text-gray-200 truncate">{{ r.id }}</span>
                      <span
                        v-if="r.id === 'leader'"
                        class="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
                      >
                        Leader
                      </span>
                    </div>
                    <p class="text-[12px] text-gray-400 dark:text-gray-500 truncate mt-0.5">
                      {{ r.description || '未设置描述' }}
                    </p>
                  </div>
                </div>
                <div class="shrink-0 flex items-center gap-1.5">
                  <span class="px-2 py-1 rounded-lg text-[10px] font-medium bg-gray-100 dark:bg-white/[0.04] text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {{ r.provider }}
                  </span>
                  <span v-if="r.model" class="px-2 py-1 rounded-lg text-[10px] font-mono bg-gray-100 dark:bg-white/[0.04] text-gray-500 dark:text-gray-400 max-w-32 truncate">
                    {{ r.model }}
                  </span>
                  <div class="i-carbon-chevron-right w-3.5 h-3.5 text-gray-300 dark:text-gray-600 ml-1" />
                </div>
              </button>
            </template>
          </div>
        </div>
      </section>
    </div>

    <Teleport to="body">
      <AgencyAgentBrowser
        v-if="showAgencyBrowser"
        @import="handleAgencyImport"
        @close="showAgencyBrowser = false"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.cfg-card {
  background: white;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
:is(.dark) .cfg-card {
  background: #28282c;
  border-color: rgba(255, 255, 255, 0.04);
  box-shadow: none;
}

.cfg-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
:is(.dark) .cfg-card-header {
  border-bottom-color: rgba(255, 255, 255, 0.04);
}

.cfg-card-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.cfg-card-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
  line-height: 1.3;
}
:is(.dark) .cfg-card-title {
  color: #e5e7eb;
}

.cfg-card-desc {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 1px;
}
:is(.dark) .cfg-card-desc {
  color: #6b7280;
}

.cfg-card-body {
  padding: 16px 20px;
}

.cfg-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #6b7280;
  margin-bottom: 6px;
}
:is(.dark) .cfg-label {
  color: #9ca3af;
}

.cfg-input {
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
.cfg-input::placeholder {
  color: #c4c4c4;
}
.cfg-input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  background: white;
}
:is(.dark) .cfg-input {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
}
:is(.dark) .cfg-input::placeholder {
  color: #4b5563;
}
:is(.dark) .cfg-input:focus {
  background: rgba(255, 255, 255, 0.06);
}

.cfg-hint {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 4px;
  line-height: 1.5;
}
:is(.dark) .cfg-hint {
  color: #6b7280;
}

.cfg-save-btn {
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
.cfg-save-btn:hover {
  background: #6366f1;
  box-shadow: 0 2px 8px rgba(79, 70, 229, 0.35);
}
.cfg-save-btn:active {
  transform: scale(0.97);
}
.cfg-save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cfg-role-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  text-align: left;
  padding: 12px 16px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: #fafafa;
  transition: all 0.15s;
  cursor: pointer;
}
.cfg-role-item:hover {
  border-color: rgba(99, 102, 241, 0.3);
  background: rgba(99, 102, 241, 0.02);
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.06);
}
:is(.dark) .cfg-role-item {
  background: rgba(255, 255, 255, 0.02);
  border-color: rgba(255, 255, 255, 0.04);
}
:is(.dark) .cfg-role-item:hover {
  border-color: rgba(99, 102, 241, 0.2);
  background: rgba(99, 102, 241, 0.04);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
