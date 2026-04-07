<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { rpc } from '../composables/use-sidecar'

// ── Types ──

interface PhaseConfig {
  id: string
  name: string
  provider: 'api' | 'external-cli'
  skill?: string
  invoke_skills?: string[]
  invoke_commands?: string[]
  tools?: string[]
  guardrails?: string[]
  requires_confirm: boolean
  confirm_files?: string[]
  completion_check?: string
  entry_gate?: string
  is_terminal?: boolean
  optional?: boolean
  skippable?: boolean
  loopable?: boolean
  loop_target?: string
  triggers?: string[]
}

interface StageConfig {
  id: string
  name: string
  gate?: string
  phases: PhaseConfig[]
}

interface DependencyConfig {
  type: 'cli' | 'skill-pack'
  check?: string
  install_hint?: string
  commands?: string[]
  skills?: Record<string, string>
}

interface GateCheck {
  type: 'exists' | 'not_exists' | 'file_contains' | 'file_not_contains' | 'file_section_matches' | 'file_section_not_matches' | 'command_succeeds'
  path?: string
  pattern?: string
  after?: string
  command?: string
}

interface GateDef {
  description: string
  checks: GateCheck[]
}

interface GuardrailDef {
  description: string
  severity: 'hard' | 'soft'
}

interface StateRule {
  condition: string
  stage: string
  phase: string
  description?: string
}

interface TriggerEntry {
  patterns: string[]
  target_stage: string
  target_phase?: string
  strategy?: 'infer_from_state'
}

interface WorkflowConfig {
  name: string
  description: string
  dependencies?: Record<string, DependencyConfig>
  gate_definitions?: Record<string, GateDef>
  guardrail_definitions?: Record<string, GuardrailDef>
  state_inference?: { rules: StateRule[] }
  requirement_phases?: PhaseConfig[]
  stages: StageConfig[]
  trigger_mapping?: TriggerEntry[]
}

// ── Markdown ──

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

// ── State ──

const loading = ref(true)
const config = ref<WorkflowConfig | null>(null)

type PanelTarget =
  | { type: 'phase', phase: PhaseConfig, stageId: string, stageName: string, isRequirement: boolean }
  | { type: 'stage', stage: StageConfig, stageIdx: number }
  | { type: 'gate', gate: string, stageId: string, stageName: string, stageIdx: number }

const panelTarget = ref<PanelTarget | null>(null)
const skillContent = ref('')
const skillLoading = ref(false)

const expandedSections = reactive<Record<string, boolean>>({})

const showYaml = ref(false)
const rawYaml = ref('')
const phaseEnabledMap = ref<Record<string, boolean>>({})

// ── Condition description map (driven by gate_definitions) ──

const conditionDescMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const [id, def] of Object.entries(config.value?.gate_definitions ?? {}))
    map[id] = def.description
  for (const rule of config.value?.state_inference?.rules ?? []) {
    if (rule.description && !map[rule.condition])
      map[rule.condition] = rule.description
  }
  return map
})

function describeCondition(condition: string): string {
  return conditionDescMap.value[condition] ?? condition
}

function resolveGateDef(condition: string): GateDef | undefined {
  return config.value?.gate_definitions?.[condition]
}

const checkTypeLabels: Record<string, string> = {
  exists: '文件/目录存在',
  not_exists: '文件/目录不存在',
  file_contains: '文件包含',
  file_not_contains: '文件不包含',
  file_section_matches: '文件段落匹配',
  file_section_not_matches: '文件段落不匹配',
  command_succeeds: '命令执行成功',
}

const checkTypeIcons: Record<string, string> = {
  exists: 'i-carbon-document-add',
  not_exists: 'i-carbon-document-subtract',
  file_contains: 'i-carbon-text-search',
  file_not_contains: 'i-carbon-text-clear-format',
  file_section_matches: 'i-carbon-search-locate',
  file_section_not_matches: 'i-carbon-search-locate',
  command_succeeds: 'i-carbon-terminal',
}

// ── Stage colors ──

const stageThemes = [
  { bg: 'bg-indigo-50/50 dark:bg-indigo-500/[0.04]', border: 'border-indigo-200/60 dark:border-indigo-500/20', header: 'text-indigo-700 dark:text-indigo-300', num: 'bg-indigo-100 dark:bg-indigo-500/10 text-indigo-600', badge: 'bg-indigo-100 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400' },
  { bg: 'bg-emerald-50/50 dark:bg-emerald-500/[0.04]', border: 'border-emerald-200/60 dark:border-emerald-500/20', header: 'text-emerald-700 dark:text-emerald-300', num: 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600', badge: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  { bg: 'bg-amber-50/50 dark:bg-amber-500/[0.04]', border: 'border-amber-200/60 dark:border-amber-500/20', header: 'text-amber-700 dark:text-amber-300', num: 'bg-amber-100 dark:bg-amber-500/10 text-amber-600', badge: 'bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  { bg: 'bg-rose-50/50 dark:bg-rose-500/[0.04]', border: 'border-rose-200/60 dark:border-rose-500/20', header: 'text-rose-700 dark:text-rose-300', num: 'bg-rose-100 dark:bg-rose-500/10 text-rose-600', badge: 'bg-rose-100 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  { bg: 'bg-cyan-50/50 dark:bg-cyan-500/[0.04]', border: 'border-cyan-200/60 dark:border-cyan-500/20', header: 'text-cyan-700 dark:text-cyan-300', num: 'bg-cyan-100 dark:bg-cyan-500/10 text-cyan-600', badge: 'bg-cyan-100 dark:bg-cyan-500/15 text-cyan-600 dark:text-cyan-400' },
]
function theme(idx: number) { return stageThemes[idx % stageThemes.length] }

// ── Load ──

async function loadConfig() {
  loading.value = true
  try {
    const [cfg, enabledMap] = await Promise.all([
      rpc<WorkflowConfig>('workflow.getFullConfig'),
      rpc<Record<string, boolean>>('workflow.getPhaseEnabledMap'),
    ])
    config.value = cfg
    if (enabledMap) phaseEnabledMap.value = enabledMap
  } catch (err) {
    console.error('Failed to load workflow config:', err)
  } finally {
    loading.value = false
  }
}

async function togglePhaseEnabled(phaseId: string) {
  const current = phaseEnabledMap.value[phaseId] ?? false
  const next = !current
  phaseEnabledMap.value = { ...phaseEnabledMap.value, [phaseId]: next }
  try {
    await rpc('workflow.setPhaseEnabled', { phaseId, enabled: next })
  } catch {
    phaseEnabledMap.value = { ...phaseEnabledMap.value, [phaseId]: current }
  }
}

async function loadRawYaml() {
  try {
    const res = await rpc<{ yaml: string }>('workflow.getRawYaml')
    rawYaml.value = res.yaml
  } catch { rawYaml.value = '' }
}

onMounted(loadConfig)

// ── Panel ──

function selectPhase(phase: PhaseConfig, stageId: string, stageName: string, isRequirement = false) {
  panelTarget.value = { type: 'phase', phase, stageId, stageName, isRequirement }
  loadPhaseSkill(phase)
}

function selectStage(stage: StageConfig, stageIdx: number) {
  panelTarget.value = { type: 'stage', stage, stageIdx }
  skillContent.value = ''
}

function selectGate(gate: string, stageId: string, stageName: string, stageIdx: number) {
  panelTarget.value = { type: 'gate', gate, stageId, stageName, stageIdx }
  skillContent.value = ''
}

function getRelatedRules(condition: string): StateRule[] {
  return (config.value?.state_inference?.rules ?? []).filter(r => r.condition === condition)
}

function getGateStages(gate: string): StageConfig[] {
  return (config.value?.stages ?? []).filter(s => s.gate === gate)
}

function stageIdxById(id: string): number {
  return (config.value?.stages ?? []).findIndex(s => s.id === id)
}

function getGatePhases(gate: string): { phase: PhaseConfig, stageId: string, stageName: string }[] {
  const result: { phase: PhaseConfig, stageId: string, stageName: string }[] = []
  for (const stage of config.value?.stages ?? []) {
    for (const phase of stage.phases) {
      if (phase.entry_gate === gate || phase.completion_check === gate)
        result.push({ phase, stageId: stage.id, stageName: stage.name })
    }
  }
  return result
}

function closePanel() {
  panelTarget.value = null
  skillContent.value = ''
}

async function loadPhaseSkill(phase: PhaseConfig) {
  if (!phase.skill) { skillContent.value = ''; return }
  skillLoading.value = true
  try {
    const res = await rpc<{ content: string }>('workflow.resolveSkill', { skillPath: phase.skill })
    skillContent.value = res.content ?? ''
  } catch {
    skillContent.value = ''
  } finally {
    skillLoading.value = false
  }
}

const renderedSkill = computed(() => {
  if (!skillContent.value) return ''
  let raw = skillContent.value
  const fmMatch = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n/)
  if (fmMatch) raw = raw.slice(fmMatch[0].length)
  return md.render(raw)
})

const promptPreview = ref('')
const promptLoading = ref(false)
const showPrompt = ref(false)

async function loadPromptPreview(phaseId: string) {
  showPrompt.value = !showPrompt.value
  if (!showPrompt.value) return
  promptLoading.value = true
  try {
    const res = await rpc<{ prompt: string }>('workflow.previewPromptTemplate', { phaseId })
    promptPreview.value = res?.prompt ?? ''
  }
  catch (e: any) {
    promptPreview.value = `加载失败: ${e.message ?? e}`
  }
  finally {
    promptLoading.value = false
  }
}

watch(panelTarget, () => {
  showPrompt.value = false
  promptPreview.value = ''
})

// ── Guardrail resolution ──

function resolveGuardrail(id: string): GuardrailDef | undefined {
  return config.value?.guardrail_definitions?.[id]
}

// ── Phase flag helpers ──

interface FlagInfo { label: string, icon: string, color: string, desc: string }

function getPhaseFlags(p: PhaseConfig): FlagInfo[] {
  const flags: FlagInfo[] = []
  if (p.requires_confirm) flags.push({ label: '确认', icon: 'i-carbon-checkmark-outline', color: 'text-blue-500 bg-blue-50 dark:bg-blue-500/10', desc: '该阶段完成后需要用户手动确认才会进入下一阶段' })
  if (p.optional) flags.push({ label: '可选', icon: 'i-carbon-circle-dash', color: 'text-amber-500 bg-amber-50 dark:bg-amber-500/10', desc: '默认跳过，需要触发短语激活才会执行' })
  if (p.skippable) flags.push({ label: '可跳过', icon: 'i-carbon-skip-forward-filled', color: 'text-amber-500 bg-amber-50 dark:bg-amber-500/10', desc: '默认执行，但用户可选择跳过' })
  if (p.loopable) flags.push({ label: '循环', icon: 'i-carbon-restart', color: 'text-violet-500 bg-violet-50 dark:bg-violet-500/10', desc: `完成后可跳回 ${p.loop_target ?? '?'} 重新执行` })
  if (p.is_terminal) flags.push({ label: '终止', icon: 'i-carbon-stop-filled', color: 'text-red-500 bg-red-50 dark:bg-red-500/10', desc: '工作流在此阶段结束' })
  return flags
}

// ── Section toggle ──

function isExpanded(key: string) { return expandedSections[key] ?? false }
function toggle(key: string) { expandedSections[key] = !expandedSections[key] }

// ── Yaml toggle ──

function toggleYaml() {
  showYaml.value = !showYaml.value
  if (showYaml.value) loadRawYaml()
}
</script>

<template>
  <div class="h-full overflow-y-auto">
      <!-- Loading -->
      <div v-if="loading" class="flex items-center justify-center h-full">
        <div class="flex items-center gap-3 text-gray-400 text-sm">
          <div class="w-4 h-4 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
          正在加载工作流配置…
        </div>
      </div>

      <div v-else-if="config" class="p-8 space-y-8">
        <!-- ─── Header ─── -->
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <div class="i-carbon-flow w-5 h-5 text-white" />
            </div>
            <div>
              <h1 class="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">{{ config.name }}</h1>
              <p class="text-[13px] text-gray-400 dark:text-gray-500 mt-0.5 max-w-xl">{{ config.description }}</p>
            </div>
          </div>
          <button
            class="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium border border-gray-200 dark:border-white/10 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-all shrink-0"
            @click="toggleYaml"
          >
            <div class="i-carbon-code w-3.5 h-3.5" />
            {{ showYaml ? '关闭 YAML' : 'YAML' }}
          </button>
        </div>

        <!-- YAML Preview -->
        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          leave-active-class="transition-all duration-150 ease-in"
          enter-from-class="opacity-0 -translate-y-2"
          leave-to-class="opacity-0 -translate-y-2"
        >
          <div v-if="showYaml" class="rounded-xl bg-[#fafafa] dark:bg-[#161618] border border-gray-200 dark:border-white/[0.06] overflow-hidden">
            <div class="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-white/5 text-[12px] text-gray-400">
              <div class="i-carbon-document w-3.5 h-3.5" />
              workflow.yaml
            </div>
            <pre class="px-4 py-3 text-[12px] font-mono leading-relaxed text-gray-600 dark:text-gray-400 max-h-80 overflow-auto">{{ rawYaml || '加载中…' }}</pre>
          </div>
        </Transition>

        <!-- ─── Requirement Phases ─── -->
        <section v-if="config.requirement_phases?.length" class="wf-card">
          <div class="px-4 py-3 border-b border-gray-100 dark:border-white/[0.04] flex items-center gap-2.5">
            <div class="w-7 h-7 rounded-lg bg-violet-100 dark:bg-violet-500/10 flex items-center justify-center">
              <div class="i-carbon-task w-3.5 h-3.5 text-violet-500" />
            </div>
            <div>
              <h3 class="text-[13px] font-semibold text-gray-700 dark:text-gray-200">需求收集</h3>
              <p class="text-[11px] text-gray-400">独立于主流程，在需求看板中执行</p>
            </div>
          </div>
          <div class="p-3 flex gap-2 overflow-x-auto">
            <div
              v-for="phase in config.requirement_phases"
              :key="phase.id"
              class="phase-card shrink-0 min-w-[160px]"
              :class="panelTarget?.type === 'phase' && (panelTarget as any).phase.id === phase.id && 'ring-2 ring-indigo-500/40'"
              @click="selectPhase(phase, '_requirements', '需求收集', true)"
            >
              <div class="text-[13px] font-medium text-gray-800 dark:text-gray-100 mb-0.5">{{ phase.name }}</div>
              <div class="text-[11px] text-gray-400 font-mono mb-2">{{ phase.id }}</div>
              <div class="flex items-center gap-1 flex-wrap">
                <span class="phase-badge" :class="phase.provider === 'api' ? 'phase-badge--api' : 'phase-badge--cli'">{{ phase.provider }}</span>
                <span v-for="f in getPhaseFlags(phase)" :key="f.label" class="phase-badge" :class="f.color">{{ f.label }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- ─── Main Pipeline ─── -->
        <section>
          <h2 class="text-[15px] font-semibold text-gray-800 dark:text-gray-100 mb-4">工作流阶段</h2>
          <div class="overflow-x-auto -mx-2 px-2 pb-4">
            <div class="flex gap-3 min-w-max">
              <template v-for="(stage, si) in config.stages" :key="stage.id">
                <div v-if="si > 0" class="flex items-center justify-center w-6 shrink-0 self-stretch">
                  <div class="i-carbon-chevron-right w-5 h-5 text-gray-300 dark:text-gray-600" />
                </div>

                <div
                  class="stage-col border rounded-2xl overflow-hidden shrink-0"
                  :class="[theme(si).bg, theme(si).border]"
                >
                  <!-- Stage header (clickable) -->
                  <div
                    class="px-4 py-3 border-b cursor-pointer transition-opacity hover:opacity-80"
                    :class="theme(si).border"
                    @click="selectStage(stage, si)"
                  >
                    <div class="flex items-center gap-2 mb-1">
                      <div class="w-6 h-6 rounded-lg flex items-center justify-center" :class="theme(si).num">
                        <span class="text-[11px] font-bold">{{ si + 1 }}</span>
                      </div>
                      <span class="text-[13px] font-semibold" :class="theme(si).header">{{ stage.name }}</span>
                    </div>
                    <div class="text-[11px] font-mono text-gray-400 mb-1">{{ stage.id }}</div>
                    <!-- Gate with description (independently clickable) -->
                    <div
                      v-if="stage.gate"
                      class="gate-block mt-1.5"
                      :class="panelTarget?.type === 'gate' && (panelTarget as any).gate === stage.gate && (panelTarget as any).stageId === stage.id && 'ring-2 ring-indigo-500/40'"
                      @click.stop="selectGate(stage.gate, stage.id, stage.name, si)"
                    >
                      <div class="flex items-center justify-between mb-0.5">
                        <div class="flex items-center gap-1.5">
                          <div class="i-carbon-locked w-3 h-3 text-gray-400" />
                          <span class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">完成门禁</span>
                        </div>
                        <div class="i-carbon-chevron-right w-3 h-3 text-gray-300 dark:text-gray-600 gate-arrow" />
                      </div>
                      <div class="text-[11px] font-mono" :class="theme(si).badge.replace('bg-', 'text-').split(' ')[1]">{{ stage.gate }}</div>
                      <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">{{ describeCondition(stage.gate) }}</p>
                    </div>
                  </div>

                  <!-- Phases -->
                  <div class="p-3 space-y-2">
                    <div
                      v-for="phase in stage.phases"
                      :key="phase.id"
                      class="phase-card"
                      :class="[
                        panelTarget?.type === 'phase' && (panelTarget as any).phase.id === phase.id && 'ring-2 ring-indigo-500/40',
                        phase.id in phaseEnabledMap && !phaseEnabledMap[phase.id] && 'opacity-50',
                      ]"
                      @click="selectPhase(phase, stage.id, stage.name)"
                    >
                      <div class="flex items-center justify-between mb-0.5">
                        <div class="text-[13px] font-medium text-gray-800 dark:text-gray-100">{{ phase.name }}</div>
                        <button
                          v-if="phase.id in phaseEnabledMap"
                          class="phase-toggle shrink-0 ml-2"
                          :class="phaseEnabledMap[phase.id] ? 'phase-toggle--on' : 'phase-toggle--off'"
                          :title="phaseEnabledMap[phase.id] ? '点击关闭' : '点击启用'"
                          @click.stop="togglePhaseEnabled(phase.id)"
                        >
                          <div class="phase-toggle-dot" />
                        </button>
                      </div>
                      <div class="text-[11px] text-gray-400 font-mono mb-1.5">{{ phase.id }}</div>
                      <div class="flex items-center gap-1 flex-wrap mb-1.5">
                        <span class="phase-badge" :class="phase.provider === 'api' ? 'phase-badge--api' : 'phase-badge--cli'">{{ phase.provider }}</span>
                        <span v-for="f in getPhaseFlags(phase)" :key="f.label" class="phase-badge" :class="f.color">{{ f.label }}</span>
                      </div>
                      <div v-if="phase.skill" class="text-[11px] text-gray-400 font-mono truncate flex items-center gap-1">
                        <div class="i-carbon-document w-3 h-3 shrink-0 opacity-50" />
                        {{ phase.skill }}
                      </div>
                      <!-- Inline gate/check summary -->
                      <div v-if="phase.completion_check || phase.entry_gate" class="mt-1.5 flex flex-col gap-0.5">
                        <div v-if="phase.entry_gate" class="text-[10px] text-gray-400 flex items-center gap-1">
                          <div class="i-carbon-locked w-2.5 h-2.5 opacity-60" />
                          入口: {{ phase.entry_gate }}
                        </div>
                        <div v-if="phase.completion_check" class="text-[10px] text-gray-400 flex items-center gap-1">
                          <div class="i-carbon-task-complete w-2.5 h-2.5 opacity-60" />
                          完成: {{ phase.completion_check }}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </section>

        <!-- ─── Config sections ─── -->
        <div class="border-t border-gray-200 dark:border-white/[0.06] pt-8 space-y-3">
          <h2 class="text-[15px] font-semibold text-gray-800 dark:text-gray-100 mb-4">配置详情</h2>

          <!-- Gate Definitions -->
          <div class="wf-card">
            <button class="section-toggle" @click="toggle('gates')">
              <div class="flex items-center gap-2">
                <div class="i-carbon-locked w-4 h-4 text-gray-400" />
                <span>门禁定义</span>
                <span class="text-[11px] text-gray-400 font-normal">({{ Object.keys(config.gate_definitions ?? {}).length }})</span>
              </div>
              <div class="i-carbon-chevron-down w-3.5 h-3.5 text-gray-400 transition-transform duration-200" :class="isExpanded('gates') && 'rotate-180'" />
            </button>
            <div v-if="isExpanded('gates')" class="p-4 pt-0 space-y-2">
              <div
                v-for="(gate, gateId) in config.gate_definitions"
                :key="gateId"
                class="detail-block cursor-pointer hover:border-amber-300 dark:hover:border-amber-500/25 transition-all"
                @click="selectGate(String(gateId), '', '', -1)"
              >
                <div class="flex items-center gap-2 mb-1">
                  <div class="i-carbon-locked w-3 h-3 text-amber-500 shrink-0" />
                  <span class="text-[12px] font-mono font-medium text-gray-600 dark:text-gray-300">{{ gateId }}</span>
                  <span class="text-[10px] text-gray-400 ml-auto">{{ gate.checks.length }} 项检查</span>
                </div>
                <p class="text-[12px] text-gray-500 dark:text-gray-400 leading-relaxed">{{ gate.description }}</p>
              </div>
              <p v-if="!config.gate_definitions || !Object.keys(config.gate_definitions).length" class="empty-hint">暂无门禁定义</p>
            </div>
          </div>

          <!-- Dependencies -->
          <div class="wf-card">
            <button class="section-toggle" @click="toggle('deps')">
              <div class="flex items-center gap-2">
                <div class="i-carbon-package w-4 h-4 text-gray-400" />
                <span>依赖项</span>
                <span class="text-[11px] text-gray-400 font-normal">({{ Object.keys(config.dependencies ?? {}).length }})</span>
              </div>
              <div class="i-carbon-chevron-down w-3.5 h-3.5 text-gray-400 transition-transform duration-200" :class="isExpanded('deps') && 'rotate-180'" />
            </button>
            <div v-if="isExpanded('deps')" class="p-4 pt-0 space-y-3">
              <div
                v-for="(dep, name) in config.dependencies"
                :key="name"
                class="detail-block"
              >
                <div class="flex items-center gap-2 mb-1.5">
                  <span class="text-[13px] font-medium text-gray-700 dark:text-gray-200">{{ name }}</span>
                  <span class="pill pill--gray">{{ dep.type }}</span>
                </div>
                <div v-if="dep.check" class="detail-kv"><span class="detail-k">check</span><code class="detail-v-code">{{ dep.check }}</code></div>
                <div v-if="dep.install_hint" class="detail-kv"><span class="detail-k">install</span><code class="detail-v-code">{{ dep.install_hint }}</code></div>
                <div v-if="dep.commands?.length" class="mt-2 space-y-0.5">
                  <div class="detail-k mb-1">commands</div>
                  <code v-for="cmd in dep.commands" :key="cmd" class="block text-[11px] font-mono text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.03] px-2.5 py-1 rounded">{{ cmd }}</code>
                </div>
                <div v-if="dep.skills && Object.keys(dep.skills).length" class="mt-2 space-y-0.5">
                  <div class="detail-k mb-1">skills</div>
                  <div v-for="(v, k) in dep.skills" :key="k" class="detail-kv">
                    <span class="detail-k">{{ k }}</span>
                    <code class="detail-v-code">{{ v }}</code>
                  </div>
                </div>
              </div>
              <p v-if="!config.dependencies || !Object.keys(config.dependencies).length" class="empty-hint">暂无依赖项</p>
            </div>
          </div>

          <!-- Guardrails -->
          <div class="wf-card">
            <button class="section-toggle" @click="toggle('guardrails')">
              <div class="flex items-center gap-2">
                <div class="i-carbon-shield-check w-4 h-4 text-gray-400" />
                <span>护栏规则</span>
                <span class="text-[11px] text-gray-400 font-normal">({{ Object.keys(config.guardrail_definitions ?? {}).length }})</span>
              </div>
              <div class="i-carbon-chevron-down w-3.5 h-3.5 text-gray-400 transition-transform duration-200" :class="isExpanded('guardrails') && 'rotate-180'" />
            </button>
            <div v-if="isExpanded('guardrails')" class="p-4 pt-0 space-y-2">
              <div
                v-for="(guard, gKey) in config.guardrail_definitions"
                :key="gKey"
                class="detail-block"
              >
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[12px] font-mono font-medium text-gray-600 dark:text-gray-300">{{ gKey }}</span>
                  <span
                    class="pill"
                    :class="guard.severity === 'hard' ? 'pill--red' : 'pill--amber'"
                  >{{ guard.severity }}</span>
                </div>
                <p class="text-[12px] text-gray-500 dark:text-gray-400 leading-relaxed">{{ guard.description }}</p>
              </div>
              <p v-if="!config.guardrail_definitions || !Object.keys(config.guardrail_definitions).length" class="empty-hint">暂无护栏规则</p>
            </div>
          </div>

          <!-- State Inference -->
          <div class="wf-card">
            <button class="section-toggle" @click="toggle('state')">
              <div class="flex items-center gap-2">
                <div class="i-carbon-decision-tree w-4 h-4 text-gray-400" />
                <span>状态推断规则</span>
                <span class="text-[11px] text-gray-400 font-normal">({{ config.state_inference?.rules?.length ?? 0 }})</span>
              </div>
              <div class="i-carbon-chevron-down w-3.5 h-3.5 text-gray-400 transition-transform duration-200" :class="isExpanded('state') && 'rotate-180'" />
            </button>
            <div v-if="isExpanded('state')" class="p-4 pt-0 space-y-2">
              <div
                v-for="(rule, ri) in config.state_inference?.rules"
                :key="ri"
                class="detail-block"
              >
                <div class="flex items-center gap-2 text-[12px] font-mono mb-1">
                  <code class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-700 dark:text-gray-300 font-semibold">{{ rule.condition }}</code>
                  <span class="text-gray-400">→</span>
                  <span class="pill pill--indigo">{{ rule.stage }}</span>
                  <span class="text-gray-300">/</span>
                  <span class="pill pill--green">{{ rule.phase }}</span>
                </div>
                <p v-if="rule.description" class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">{{ rule.description }}</p>
              </div>
              <p v-if="!config.state_inference?.rules?.length" class="empty-hint">暂无推断规则</p>
            </div>
          </div>

          <!-- Trigger Mapping -->
          <div class="wf-card">
            <button class="section-toggle" @click="toggle('triggers')">
              <div class="flex items-center gap-2">
                <div class="i-carbon-flash w-4 h-4 text-gray-400" />
                <span>触发语映射</span>
                <span class="text-[11px] text-gray-400 font-normal">({{ config.trigger_mapping?.length ?? 0 }})</span>
              </div>
              <div class="i-carbon-chevron-down w-3.5 h-3.5 text-gray-400 transition-transform duration-200" :class="isExpanded('triggers') && 'rotate-180'" />
            </button>
            <div v-if="isExpanded('triggers')" class="p-4 pt-0 space-y-2">
              <div
                v-for="(t, ti) in config.trigger_mapping"
                :key="ti"
                class="detail-block"
              >
                <div class="flex items-center gap-1.5 flex-wrap mb-1.5">
                  <span v-for="p in t.patterns" :key="p" class="pill pill--sky">{{ p }}</span>
                </div>
                <div class="flex items-center gap-2 text-[11px]">
                  <span class="text-gray-400">→</span>
                  <span class="pill pill--indigo">{{ t.target_stage }}</span>
                  <template v-if="t.target_phase">
                    <span class="text-gray-300">/</span>
                    <span class="pill pill--green">{{ t.target_phase }}</span>
                  </template>
                  <span v-if="t.strategy" class="pill pill--amber">{{ t.strategy }}</span>
                </div>
              </div>
              <p v-if="!config.trigger_mapping?.length" class="empty-hint">暂无触发语</p>
            </div>
          </div>
        </div>
      </div>

    <!-- ════ Detail Panel (overlay slide-over) ════ -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-opacity duration-200 ease-out"
        leave-active-class="transition-opacity duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-if="panelTarget"
          class="fixed inset-0 z-50 bg-black/20 dark:bg-black/40 backdrop-blur-[2px]"
          @click.self="closePanel"
        />
      </Transition>
      <Transition
        enter-active-class="transition-transform duration-300 ease-out"
        leave-active-class="transition-transform duration-200 ease-in"
        enter-from-class="translate-x-full"
        leave-to-class="translate-x-full"
      >
        <div
          v-if="panelTarget"
          class="detail-panel"
        >
        <!-- ── Phase detail ── -->
        <template v-if="panelTarget.type === 'phase'">
          <div class="sticky top-0 z-10 bg-white/95 dark:bg-[#1e1e22]/95 backdrop-blur-xl border-b border-gray-200/60 dark:border-white/[0.06] px-6 py-5">
            <div class="flex items-start justify-between">
              <div class="flex-1 min-w-0">
                <h2 class="text-[17px] font-bold text-gray-900 dark:text-gray-50 tracking-tight">{{ panelTarget.phase.name }}</h2>
                <div class="flex items-center gap-2 mt-1.5">
                  <span class="text-[11px] font-mono text-gray-400">{{ panelTarget.phase.id }}</span>
                  <span v-if="panelTarget.isRequirement" class="pill pill--violet text-[10px]">需求阶段</span>
                  <span v-else class="pill pill--gray text-[10px]">{{ panelTarget.stageName }}</span>
                </div>
              </div>
              <button class="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors ml-3 shrink-0" @click="closePanel">
                <div class="i-carbon-close w-4.5 h-4.5" />
              </button>
            </div>
          </div>

          <div class="px-6 py-5 space-y-6">
            <!-- Basic info -->
            <section>
              <h3 class="panel-title">基本信息</h3>
              <div class="panel-grid">
                <span class="panel-k">Provider</span>
                <span class="phase-badge inline-block" :class="panelTarget.phase.provider === 'api' ? 'phase-badge--api' : 'phase-badge--cli'">{{ panelTarget.phase.provider }}</span>
                <template v-if="panelTarget.phase.skill">
                  <span class="panel-k">Skill</span>
                  <code class="text-[11px] font-mono text-gray-600 dark:text-gray-400 break-all">{{ panelTarget.phase.skill }}</code>
                </template>
              </div>
            </section>

            <!-- Flow control flags -->
            <section>
              <h3 class="panel-title">流程控制</h3>
              <div class="space-y-2">
                <div
                  v-for="f in getPhaseFlags(panelTarget.phase)"
                  :key="f.label"
                  class="flex items-start gap-2.5 p-2.5 rounded-lg bg-gray-50 dark:bg-white/[0.02]"
                >
                  <div class="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5" :class="f.color">
                    <div class="w-3.5 h-3.5" :class="f.icon" />
                  </div>
                  <div>
                    <div class="text-[12px] font-medium text-gray-700 dark:text-gray-200">{{ f.label }}</div>
                    <p class="text-[11px] text-gray-400 leading-relaxed mt-0.5">{{ f.desc }}</p>
                  </div>
                </div>
                <p v-if="getPhaseFlags(panelTarget.phase).length === 0" class="text-[12px] text-gray-400 py-2">无特殊流程标记</p>
              </div>
            </section>

            <!-- Gate / checks with descriptions -->
            <section v-if="panelTarget.phase.entry_gate || panelTarget.phase.completion_check || panelTarget.phase.loop_target">
              <h3 class="panel-title">门禁与条件</h3>
              <div class="space-y-2">
                <div
                  v-if="panelTarget.phase.entry_gate"
                  class="condition-block condition-block--clickable"
                  @click="selectGate(panelTarget.phase.entry_gate, panelTarget.stageId, panelTarget.stageName, stageIdxById(panelTarget.stageId))"
                >
                  <div class="flex items-center justify-between">
                    <div class="condition-label">
                      <div class="i-carbon-locked w-3 h-3" />
                      入口门禁
                    </div>
                    <div class="i-carbon-chevron-right w-3 h-3 text-gray-300 dark:text-gray-600" />
                  </div>
                  <code class="condition-code">{{ panelTarget.phase.entry_gate }}</code>
                  <p class="condition-desc">{{ describeCondition(panelTarget.phase.entry_gate) }}</p>
                </div>
                <div
                  v-if="panelTarget.phase.completion_check"
                  class="condition-block condition-block--clickable"
                  @click="selectGate(panelTarget.phase.completion_check, panelTarget.stageId, panelTarget.stageName, stageIdxById(panelTarget.stageId))"
                >
                  <div class="flex items-center justify-between">
                    <div class="condition-label">
                      <div class="i-carbon-task-complete w-3 h-3" />
                      完成条件
                    </div>
                    <div class="i-carbon-chevron-right w-3 h-3 text-gray-300 dark:text-gray-600" />
                  </div>
                  <code class="condition-code">{{ panelTarget.phase.completion_check }}</code>
                  <p class="condition-desc">{{ describeCondition(panelTarget.phase.completion_check) }}</p>
                </div>
                <div v-if="panelTarget.phase.loop_target" class="condition-block">
                  <div class="condition-label">
                    <div class="i-carbon-restart w-3 h-3" />
                    循环目标
                  </div>
                  <code class="condition-code">{{ panelTarget.phase.loop_target }}</code>
                  <p class="condition-desc">完成后可跳回该阶段重新执行</p>
                </div>
              </div>
            </section>

            <!-- Invoked skills -->
            <section v-if="panelTarget.phase.invoke_skills?.length">
              <h3 class="panel-title">调用的 Skills</h3>
              <div class="space-y-1">
                <div v-for="sk in panelTarget.phase.invoke_skills" :key="sk" class="flex items-center gap-2 p-2 rounded-lg bg-violet-50/50 dark:bg-violet-500/[0.04]">
                  <div class="i-carbon-skill-level-advanced w-3.5 h-3.5 text-violet-400 shrink-0" />
                  <code class="text-[12px] font-mono text-violet-600 dark:text-violet-400">{{ sk }}</code>
                </div>
              </div>
            </section>

            <!-- Invoked commands -->
            <section v-if="panelTarget.phase.invoke_commands?.length">
              <h3 class="panel-title">调用的命令</h3>
              <div class="space-y-1">
                <code
                  v-for="cmd in panelTarget.phase.invoke_commands"
                  :key="cmd"
                  class="block text-[11px] font-mono text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.03] px-3 py-2 rounded-lg leading-relaxed"
                >{{ cmd }}</code>
              </div>
            </section>

            <!-- Guardrails with full definitions -->
            <section v-if="panelTarget.phase.guardrails?.length">
              <h3 class="panel-title">护栏规则</h3>
              <div class="space-y-2">
                <div v-for="gId in panelTarget.phase.guardrails" :key="gId" class="guardrail-block">
                  <div class="flex items-center gap-2 mb-1">
                    <div class="i-carbon-shield-check w-3.5 h-3.5 shrink-0" :class="resolveGuardrail(gId)?.severity === 'hard' ? 'text-red-500' : 'text-amber-500'" />
                    <span class="text-[12px] font-mono font-medium text-gray-700 dark:text-gray-200">{{ gId }}</span>
                    <span
                      v-if="resolveGuardrail(gId)"
                      class="pill text-[9px]"
                      :class="resolveGuardrail(gId)!.severity === 'hard' ? 'pill--red' : 'pill--amber'"
                    >{{ resolveGuardrail(gId)!.severity }}</span>
                  </div>
                  <p v-if="resolveGuardrail(gId)?.description" class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed pl-5.5">
                    {{ resolveGuardrail(gId)!.description }}
                  </p>
                </div>
              </div>
            </section>

            <!-- Confirm files -->
            <section v-if="panelTarget.phase.confirm_files?.length">
              <h3 class="panel-title">确认产出文件</h3>
              <div class="space-y-1">
                <div v-for="cf in panelTarget.phase.confirm_files" :key="cf" class="flex items-center gap-2 text-[11px] font-mono text-gray-600 dark:text-gray-400">
                  <div class="i-carbon-document w-3 h-3 text-gray-400 shrink-0" />
                  {{ cf }}
                </div>
              </div>
            </section>

            <!-- Triggers -->
            <section v-if="panelTarget.phase.triggers?.length">
              <h3 class="panel-title">触发短语</h3>
              <div class="flex flex-wrap gap-1.5">
                <span v-for="tr in panelTarget.phase.triggers" :key="tr" class="pill pill--sky">{{ tr }}</span>
              </div>
            </section>

            <!-- Prompt preview -->
            <section>
              <button
                class="w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all"
                :class="showPrompt
                  ? 'bg-indigo-50 dark:bg-indigo-500/[0.06] border-indigo-200 dark:border-indigo-500/20'
                  : 'bg-gray-50 dark:bg-white/[0.02] border-gray-100 dark:border-white/5 hover:border-indigo-300 dark:hover:border-indigo-500/20'"
                @click="loadPromptPreview(panelTarget.phase.id)"
              >
                <div class="flex items-center gap-2.5">
                  <div
                    class="w-7 h-7 rounded-lg flex items-center justify-center"
                    :class="showPrompt
                      ? 'bg-indigo-100 dark:bg-indigo-500/15'
                      : 'bg-gray-100 dark:bg-white/5'"
                  >
                    <div class="i-carbon-view w-3.5 h-3.5" :class="showPrompt ? 'text-indigo-500' : 'text-gray-400'" />
                  </div>
                  <div class="text-left">
                    <div class="text-[13px] font-semibold" :class="showPrompt ? 'text-indigo-700 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-200'">
                      Agent 提示词预览
                    </div>
                    <p class="text-[11px] text-gray-400 mt-0.5">查看该阶段发送给 CLI Agent 的完整 prompt</p>
                  </div>
                </div>
                <div
                  class="i-carbon-chevron-down w-4 h-4 transition-transform duration-200"
                  :class="[
                    showPrompt ? 'rotate-180 text-indigo-400' : 'text-gray-300',
                  ]"
                />
              </button>
              <Transition
                enter-active-class="transition-all duration-200 ease-out"
                leave-active-class="transition-all duration-150 ease-in"
                enter-from-class="opacity-0 -translate-y-1"
                leave-to-class="opacity-0 -translate-y-1"
              >
                <div v-if="showPrompt" class="mt-3 prompt-preview-section">
                  <div class="prompt-preview-header">
                    <div class="flex items-center gap-2">
                      <div class="i-carbon-terminal w-3.5 h-3.5 text-indigo-400" />
                      <span class="text-[12px] font-medium text-gray-600 dark:text-gray-300">Prompt 内容</span>
                    </div>
                    <span v-if="promptPreview" class="text-[10px] text-gray-400 tabular-nums">
                      {{ promptPreview.length.toLocaleString() }} 字符
                    </span>
                  </div>
                  <div v-if="promptLoading" class="flex items-center gap-2 py-10 justify-center text-gray-400 text-[12px]">
                    <div class="w-3.5 h-3.5 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
                    正在生成预览…
                  </div>
                  <div v-else class="prompt-preview-body">
                    <div
                      class="skill-prose prose prose-sm dark:prose-invert max-w-none"
                      v-html="md.render(promptPreview)"
                    />
                  </div>
                </div>
              </Transition>
            </section>

            <!-- Skill content -->
            <section v-if="panelTarget.phase.skill" class="skill-section">
              <div class="skill-section-header">
                <div class="flex items-center gap-2">
                  <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center shadow-sm">
                    <div class="i-carbon-document w-3.5 h-3.5 text-white" />
                  </div>
                  <div>
                    <h3 class="text-[13px] font-semibold text-gray-800 dark:text-gray-100 m-0">SKILL 内容</h3>
                    <p class="text-[11px] text-gray-400 font-mono mt-0.5 truncate max-w-[280px]">{{ panelTarget.phase.skill }}</p>
                  </div>
                </div>
              </div>
              <div v-if="skillLoading" class="flex items-center gap-2 py-10 justify-center text-gray-400 text-[12px]">
                <div class="w-3.5 h-3.5 border-2 border-gray-300 border-t-violet-500 rounded-full animate-spin" />
                加载 Skill…
              </div>
              <div v-else-if="!renderedSkill" class="text-[12px] text-gray-400 text-center py-10">
                无法加载 Skill 内容
              </div>
              <div
                v-else
                class="skill-prose prose prose-sm dark:prose-invert max-w-none"
                v-html="renderedSkill"
              />
            </section>
          </div>
        </template>

        <!-- ── Gate detail ── -->
        <template v-else-if="panelTarget.type === 'gate'">
          <div class="sticky top-0 z-10 bg-white/95 dark:bg-[#1e1e22]/95 backdrop-blur-xl border-b border-gray-200/60 dark:border-white/[0.06] px-6 py-5">
            <div class="flex items-start justify-between">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-500/10 flex items-center justify-center">
                    <div class="i-carbon-locked w-4 h-4 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <h2 class="text-[17px] font-bold text-gray-900 dark:text-gray-50 tracking-tight">门禁条件</h2>
                    <div class="flex items-center gap-2 mt-1">
                      <code class="text-[12px] font-mono text-amber-600 dark:text-amber-400 font-semibold">{{ panelTarget.gate }}</code>
                    </div>
                  </div>
                </div>
              </div>
              <button class="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors ml-3 shrink-0" @click="closePanel">
                <div class="i-carbon-close w-4.5 h-4.5" />
              </button>
            </div>
          </div>

          <div class="px-6 py-5 space-y-6">
            <!-- Condition description -->
            <section>
              <h3 class="panel-title">条件说明</h3>
              <div class="condition-block">
                <div class="condition-label">
                  <div class="i-carbon-information w-3 h-3" />
                  含义
                </div>
                <p class="condition-desc mt-1">{{ describeCondition(panelTarget.gate) }}</p>
              </div>
            </section>

            <!-- Declarative checks -->
            <section v-if="resolveGateDef(panelTarget.gate)">
              <h3 class="panel-title">检查规则 ({{ resolveGateDef(panelTarget.gate)!.checks.length }})</h3>
              <div class="space-y-2">
                <div
                  v-for="(check, ci) in resolveGateDef(panelTarget.gate)!.checks"
                  :key="ci"
                  class="gate-check-block"
                >
                  <div class="flex items-center gap-2 mb-1.5">
                    <div class="w-5 h-5 rounded-md bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center shrink-0">
                      <div class="w-3 h-3" :class="checkTypeIcons[check.type] ?? 'i-carbon-help'" />
                    </div>
                    <span class="text-[11px] font-semibold text-gray-600 dark:text-gray-300">{{ checkTypeLabels[check.type] ?? check.type }}</span>
                  </div>
                  <div class="pl-7 space-y-1">
                    <div v-if="check.path" class="detail-kv">
                      <span class="detail-k">路径</span>
                      <code class="detail-v-code">{{ check.path }}</code>
                    </div>
                    <div v-if="check.command" class="detail-kv">
                      <span class="detail-k">命令</span>
                      <code class="detail-v-code">{{ check.command }}</code>
                    </div>
                    <div v-if="check.pattern" class="detail-kv">
                      <span class="detail-k">匹配</span>
                      <code class="detail-v-code">{{ check.pattern }}</code>
                    </div>
                    <div v-if="check.after" class="detail-kv">
                      <span class="detail-k">段落</span>
                      <code class="detail-v-code">{{ check.after }}</code>
                    </div>
                  </div>
                </div>
              </div>
              <p class="text-[10px] text-gray-400 mt-2 leading-relaxed">所有检查规则之间为 AND 关系，全部通过则条件满足。</p>
            </section>

            <!-- Belongs to stage (only when opened from a specific stage) -->
            <section v-if="panelTarget.stageIdx >= 0">
              <h3 class="panel-title">所属 Stage</h3>
              <div
                class="p-3 rounded-lg border cursor-pointer transition-all hover:border-indigo-300 dark:hover:border-indigo-500/30"
                :class="[theme(panelTarget.stageIdx).bg, theme(panelTarget.stageIdx).border]"
                @click="selectStage(config!.stages[panelTarget.stageIdx], panelTarget.stageIdx)"
              >
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <div class="w-6 h-6 rounded-lg flex items-center justify-center" :class="theme(panelTarget.stageIdx).num">
                      <span class="text-[11px] font-bold">{{ panelTarget.stageIdx + 1 }}</span>
                    </div>
                    <span class="text-[13px] font-semibold" :class="theme(panelTarget.stageIdx).header">{{ panelTarget.stageName }}</span>
                  </div>
                  <div class="i-carbon-chevron-right w-3 h-3 text-gray-300" />
                </div>
                <div class="text-[11px] font-mono text-gray-400 mt-1 ml-8">{{ panelTarget.stageId }}</div>
              </div>
            </section>

            <!-- Related state inference rules -->
            <section v-if="getRelatedRules(panelTarget.gate).length">
              <h3 class="panel-title">关联的状态推断规则</h3>
              <div class="space-y-2">
                <div
                  v-for="(rule, ri) in getRelatedRules(panelTarget.gate)"
                  :key="ri"
                  class="condition-block"
                >
                  <div class="flex items-center gap-2 text-[12px] font-mono mb-1.5">
                    <code class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-700 dark:text-gray-300 font-semibold">{{ rule.condition }}</code>
                    <span class="text-gray-400">→</span>
                    <span class="pill pill--indigo">{{ rule.stage }}</span>
                    <span class="text-gray-300">/</span>
                    <span class="pill pill--green">{{ rule.phase }}</span>
                  </div>
                  <p v-if="rule.description" class="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">{{ rule.description }}</p>
                </div>
              </div>
            </section>

            <!-- Stages using this gate -->
            <section v-if="getGateStages(panelTarget.gate).length > (panelTarget.stageIdx >= 0 ? 1 : 0)">
              <h3 class="panel-title">{{ panelTarget.stageIdx >= 0 ? '共用此门禁的 Stage' : '使用此门禁的 Stage' }}</h3>
              <div class="space-y-2">
                <div
                  v-for="(s, si2) in getGateStages(panelTarget.gate)"
                  :key="s.id"
                  class="flex items-center gap-2 p-2.5 rounded-lg bg-gray-50 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-all"
                  @click="selectStage(s, config!.stages.indexOf(s))"
                >
                  <div class="i-carbon-flow w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <div class="flex-1 min-w-0">
                    <span class="text-[12px] font-medium text-gray-700 dark:text-gray-200">{{ s.name }}</span>
                    <span class="text-[11px] font-mono text-gray-400 ml-2">{{ s.id }}</span>
                  </div>
                  <div class="i-carbon-chevron-right w-3 h-3 text-gray-300" />
                </div>
              </div>
            </section>

            <!-- Phases that reference this condition -->
            <section v-if="getGatePhases(panelTarget.gate).length">
              <h3 class="panel-title">引用此条件的 Phase</h3>
              <div class="space-y-2">
                <div
                  v-for="item in getGatePhases(panelTarget.gate)"
                  :key="item.phase.id"
                  class="p-3 rounded-lg bg-gray-50 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-all"
                  @click="selectPhase(item.phase, item.stageId, item.stageName)"
                >
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-[13px] font-medium text-gray-800 dark:text-gray-100">{{ item.phase.name }}</span>
                    <div class="i-carbon-chevron-right w-3 h-3 text-gray-300" />
                  </div>
                  <div class="text-[11px] font-mono text-gray-400 mb-1.5">{{ item.phase.id }}</div>
                  <div class="flex items-center gap-1 flex-wrap">
                    <span v-if="item.phase.entry_gate === panelTarget.gate" class="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <div class="i-carbon-locked w-2.5 h-2.5" />
                      作为入口门禁
                    </span>
                    <span v-if="item.phase.completion_check === panelTarget.gate" class="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <div class="i-carbon-task-complete w-2.5 h-2.5" />
                      作为完成条件
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </template>

        <!-- ── Stage detail ── -->
        <template v-else-if="panelTarget.type === 'stage'">
          <div class="sticky top-0 z-10 bg-white/95 dark:bg-[#1e1e22]/95 backdrop-blur-xl border-b border-gray-200/60 dark:border-white/[0.06] px-6 py-5">
            <div class="flex items-start justify-between">
              <div>
                <div class="flex items-center gap-2.5">
                  <div class="w-7 h-7 rounded-lg flex items-center justify-center" :class="theme(panelTarget.stageIdx).num">
                    <span class="text-[12px] font-bold">{{ panelTarget.stageIdx + 1 }}</span>
                  </div>
                  <h2 class="text-[17px] font-bold tracking-tight" :class="theme(panelTarget.stageIdx).header">{{ panelTarget.stage.name }}</h2>
                </div>
                <span class="text-[11px] font-mono text-gray-400 mt-1.5 block">{{ panelTarget.stage.id }}</span>
              </div>
              <button class="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0" @click="closePanel">
                <div class="i-carbon-close w-4.5 h-4.5" />
              </button>
            </div>
          </div>

          <div class="px-6 py-5 space-y-6">
            <!-- Gate (clickable to open gate detail) -->
            <section v-if="panelTarget.stage.gate">
              <h3 class="panel-title">完成门禁</h3>
              <div
                class="condition-block condition-block--clickable"
                @click="selectGate(panelTarget.stage.gate, panelTarget.stage.id, panelTarget.stage.name, panelTarget.stageIdx)"
              >
                <div class="flex items-center justify-between">
                  <div class="condition-label">
                    <div class="i-carbon-locked w-3 h-3" />
                    完成条件
                  </div>
                  <div class="i-carbon-chevron-right w-3 h-3 text-gray-300 dark:text-gray-600" />
                </div>
                <code class="condition-code">{{ panelTarget.stage.gate }}</code>
                <p class="condition-desc">满足此条件后才能进入下一阶段</p>
                <p class="condition-desc">{{ describeCondition(panelTarget.stage.gate) }}</p>
              </div>
            </section>

            <!-- Phases summary -->
            <section>
              <h3 class="panel-title">包含的 Phase ({{ panelTarget.stage.phases.length }})</h3>
              <div class="space-y-2">
                <div
                  v-for="phase in panelTarget.stage.phases"
                  :key="phase.id"
                  class="p-3 rounded-lg bg-gray-50 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-all"
                  @click="selectPhase(phase, panelTarget.stage.id, panelTarget.stage.name)"
                >
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-[13px] font-medium text-gray-800 dark:text-gray-100">{{ phase.name }}</span>
                    <div class="i-carbon-chevron-right w-3 h-3 text-gray-300" />
                  </div>
                  <div class="text-[11px] font-mono text-gray-400 mb-1.5">{{ phase.id }}</div>
                  <div class="flex items-center gap-1 flex-wrap">
                    <span class="phase-badge" :class="phase.provider === 'api' ? 'phase-badge--api' : 'phase-badge--cli'">{{ phase.provider }}</span>
                    <span v-for="f in getPhaseFlags(phase)" :key="f.label" class="phase-badge" :class="f.color">{{ f.label }}</span>
                  </div>
                  <div v-if="phase.completion_check || phase.entry_gate" class="mt-1.5 space-y-0.5">
                    <div v-if="phase.entry_gate" class="text-[10px] text-gray-400">
                      <span class="font-medium">入口门禁:</span> {{ describeCondition(phase.entry_gate) }}
                    </div>
                    <div v-if="phase.completion_check" class="text-[10px] text-gray-400">
                      <span class="font-medium">完成条件:</span> {{ describeCondition(phase.completion_check) }}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── Stage column ── */
.stage-col { width: 260px; min-height: 200px; }

/* ── Phase card ── */
.phase-card {
  padding: 10px 12px;
  border-radius: 10px;
  background: white;
  border: 1px solid rgba(0, 0, 0, 0.06);
  cursor: pointer;
  transition: all 0.15s;
}
.phase-card:hover { border-color: rgba(0, 0, 0, 0.14); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04); }
:is(.dark) .phase-card { background: rgba(255, 255, 255, 0.03); border-color: rgba(255, 255, 255, 0.06); }
:is(.dark) .phase-card:hover { border-color: rgba(255, 255, 255, 0.14); }

/* ── Badges ── */
.phase-badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 500; line-height: 1.5; }
.phase-badge--api { background: rgba(99, 102, 241, 0.1); color: #6366f1; }
.phase-badge--cli { background: rgba(16, 185, 129, 0.1); color: #059669; }
:is(.dark) .phase-badge--api { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
:is(.dark) .phase-badge--cli { background: rgba(16, 185, 129, 0.15); color: #34d399; }

/* ── Pills ── */
.pill { font-size: 11px; padding: 1px 7px; border-radius: 5px; font-weight: 500; font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
.pill--gray { background: #f3f4f6; color: #6b7280; }
.pill--indigo { background: rgba(99, 102, 241, 0.1); color: #4f46e5; }
.pill--green { background: rgba(16, 185, 129, 0.1); color: #059669; }
.pill--red { background: rgba(239, 68, 68, 0.1); color: #dc2626; }
.pill--amber { background: rgba(245, 158, 11, 0.1); color: #d97706; }
.pill--sky { background: rgba(14, 165, 233, 0.1); color: #0284c7; }
.pill--violet { background: rgba(139, 92, 246, 0.1); color: #7c3aed; }
:is(.dark) .pill--gray { background: rgba(255, 255, 255, 0.06); color: #9ca3af; }
:is(.dark) .pill--indigo { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
:is(.dark) .pill--green { background: rgba(16, 185, 129, 0.15); color: #34d399; }
:is(.dark) .pill--red { background: rgba(239, 68, 68, 0.15); color: #f87171; }
:is(.dark) .pill--amber { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
:is(.dark) .pill--sky { background: rgba(14, 165, 233, 0.15); color: #38bdf8; }
:is(.dark) .pill--violet { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }

/* ── Card / section ── */
.wf-card { background: white; border: 1px solid rgba(0, 0, 0, 0.06); border-radius: 14px; overflow: hidden; }
:is(.dark) .wf-card { background: #28282c; border-color: rgba(255, 255, 255, 0.04); }

.section-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 14px 16px; font-size: 13px; font-weight: 600; color: #374151; cursor: pointer; transition: background 0.1s; }
.section-toggle:hover { background: rgba(0, 0, 0, 0.02); }
:is(.dark) .section-toggle { color: #e5e7eb; }
:is(.dark) .section-toggle:hover { background: rgba(255, 255, 255, 0.02); }

/* ── Phase toggle ── */
.phase-toggle {
  position: relative;
  width: 28px;
  height: 16px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: background 0.2s;
  padding: 0;
}
.phase-toggle--on { background: #6366f1; }
.phase-toggle--off { background: #d1d5db; }
:is(.dark) .phase-toggle--off { background: rgba(255, 255, 255, 0.15); }
.phase-toggle-dot {
  position: absolute;
  top: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: white;
  transition: left 0.2s;
}
.phase-toggle--on .phase-toggle-dot { left: 14px; }
.phase-toggle--off .phase-toggle-dot { left: 2px; }

/* ── Detail block ── */
.detail-block { padding: 10px 12px; border-radius: 10px; background: #fafafa; border: 1px solid rgba(0, 0, 0, 0.04); }
:is(.dark) .detail-block { background: rgba(255, 255, 255, 0.02); border-color: rgba(255, 255, 255, 0.04); }

.detail-kv { display: flex; align-items: baseline; gap: 8px; font-size: 11px; }
.detail-k { color: #9ca3af; font-weight: 500; white-space: nowrap; min-width: 50px; }
.detail-v-code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 11px; color: #4b5563; word-break: break-all; }
:is(.dark) .detail-v-code { color: #d1d5db; }

.empty-hint { text-align: center; padding: 16px 0; color: #9ca3af; font-size: 12px; }

/* ── Panel ── */
.panel-title { font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
:is(.dark) .panel-title { color: #9ca3af; }

.panel-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; align-items: baseline; }
.panel-k { font-size: 12px; font-weight: 500; color: #9ca3af; }

/* ── Gate block (in stage card) ── */
.gate-block {
  padding: 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(0, 0, 0, 0.04);
  cursor: pointer;
  transition: all 0.15s;
}
.gate-block:hover { border-color: rgba(245, 158, 11, 0.3); background: rgba(255, 255, 255, 0.8); }
.gate-block:hover .gate-arrow { color: #d97706; }
:is(.dark) .gate-block { background: rgba(255, 255, 255, 0.03); border-color: rgba(255, 255, 255, 0.05); }
:is(.dark) .gate-block:hover { border-color: rgba(245, 158, 11, 0.25); background: rgba(255, 255, 255, 0.05); }
:is(.dark) .gate-block:hover .gate-arrow { color: #fbbf24; }

/* ── Condition block ── */
.condition-block { padding: 10px 12px; border-radius: 10px; background: #fafafa; border: 1px solid rgba(0, 0, 0, 0.04); }
:is(.dark) .condition-block { background: rgba(255, 255, 255, 0.02); border-color: rgba(255, 255, 255, 0.04); }
.condition-block--clickable { cursor: pointer; transition: all 0.15s; }
.condition-block--clickable:hover { border-color: rgba(245, 158, 11, 0.3); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04); }
:is(.dark) .condition-block--clickable:hover { border-color: rgba(245, 158, 11, 0.25); }
.condition-label { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: #6b7280; margin-bottom: 4px; }
:is(.dark) .condition-label { color: #9ca3af; }
.condition-code { display: block; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; color: #4f46e5; font-weight: 500; margin-bottom: 2px; }
:is(.dark) .condition-code { color: #818cf8; }
.condition-desc { font-size: 12px; color: #6b7280; line-height: 1.6; }
:is(.dark) .condition-desc { color: #9ca3af; }

/* ── Gate check block ── */
.gate-check-block {
  padding: 10px 12px;
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.03), rgba(217, 119, 6, 0.02));
  border: 1px solid rgba(245, 158, 11, 0.1);
}
:is(.dark) .gate-check-block {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.04), rgba(217, 119, 6, 0.02));
  border-color: rgba(245, 158, 11, 0.15);
}

/* ── Guardrail block ── */
.guardrail-block { padding: 10px 12px; border-radius: 10px; background: #fafafa; border: 1px solid rgba(0, 0, 0, 0.04); }
:is(.dark) .guardrail-block { background: rgba(255, 255, 255, 0.02); border-color: rgba(255, 255, 255, 0.04); }

/* ── Detail Panel (overlay) ── */
.detail-panel {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 51;
  width: 520px;
  max-width: 90vw;
  height: 100vh;
  overflow-y: auto;
  background: white;
  border-left: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.08), -2px 0 8px rgba(0, 0, 0, 0.03);
}
:is(.dark) .detail-panel {
  background: #1e1e22;
  border-color: rgba(255, 255, 255, 0.06);
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.4);
}

/* ── Prompt preview ── */
.prompt-preview-section {
  border-radius: 14px;
  border: 1px solid rgba(99, 102, 241, 0.15);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.02), rgba(79, 70, 229, 0.01));
  overflow: hidden;
}
:is(.dark) .prompt-preview-section {
  border-color: rgba(99, 102, 241, 0.2);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.04), rgba(79, 70, 229, 0.02));
}
.prompt-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(99, 102, 241, 0.1);
  background: rgba(99, 102, 241, 0.03);
}
:is(.dark) .prompt-preview-header {
  border-bottom-color: rgba(99, 102, 241, 0.15);
  background: rgba(99, 102, 241, 0.05);
}
.prompt-preview-body {
  padding: 16px;
  max-height: 500px;
  overflow-y: auto;
}

/* ── Skill section ── */
.skill-section {
  margin-top: 8px;
  border-radius: 14px;
  border: 1px solid rgba(139, 92, 246, 0.15);
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.03), rgba(99, 102, 241, 0.02));
  overflow: hidden;
}
:is(.dark) .skill-section {
  border-color: rgba(139, 92, 246, 0.2);
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.05), rgba(99, 102, 241, 0.03));
}
.skill-section-header {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(139, 92, 246, 0.1);
  background: rgba(139, 92, 246, 0.04);
}
:is(.dark) .skill-section-header {
  border-bottom-color: rgba(139, 92, 246, 0.15);
  background: rgba(139, 92, 246, 0.06);
}

/* ── Skill prose ── */
.skill-prose { padding: 16px; }
.skill-prose :deep(h1) { font-size: 16px; font-weight: 700; margin-top: 0; margin-bottom: 12px; color: #1f2937; }
:is(.dark) .skill-prose :deep(h1) { color: #f3f4f6; }
.skill-prose :deep(h2) { font-size: 14px; font-weight: 700; margin-top: 20px; margin-bottom: 8px; color: #374151; }
:is(.dark) .skill-prose :deep(h2) { color: #e5e7eb; }
.skill-prose :deep(h3) { font-size: 13px; font-weight: 600; margin-top: 16px; margin-bottom: 6px; color: #4b5563; }
:is(.dark) .skill-prose :deep(h3) { color: #d1d5db; }
.skill-prose :deep(p) { font-size: 13px; line-height: 1.7; color: #6b7280; margin-bottom: 8px; }
:is(.dark) .skill-prose :deep(p) { color: #9ca3af; }
.skill-prose :deep(li) { font-size: 13px; color: #6b7280; }
:is(.dark) .skill-prose :deep(li) { color: #9ca3af; }
.skill-prose :deep(code) {
  font-size: 12px;
  padding: 2px 6px;
  background: rgba(139, 92, 246, 0.08);
  color: #7c3aed;
  border-radius: 5px;
  border: 1px solid rgba(139, 92, 246, 0.12);
  font-weight: 500;
}
:is(.dark) .skill-prose :deep(code) {
  background: rgba(139, 92, 246, 0.12);
  color: #a78bfa;
  border-color: rgba(139, 92, 246, 0.2);
}
.skill-prose :deep(pre) {
  font-size: 12px;
  background: #1e1e2e;
  color: #cdd6f4;
  border-radius: 10px;
  padding: 14px 16px;
  overflow-x: auto;
  border: 1px solid rgba(0, 0, 0, 0.06);
  line-height: 1.7;
}
:is(.dark) .skill-prose :deep(pre) {
  background: #11111b;
  color: #cdd6f4;
  border-color: rgba(255, 255, 255, 0.06);
}
.skill-prose :deep(pre code) {
  padding: 0;
  background: none;
  border: none;
  color: inherit;
  font-weight: normal;
}
.skill-prose :deep(strong) { color: #374151; font-weight: 600; }
:is(.dark) .skill-prose :deep(strong) { color: #e5e7eb; }
.skill-prose :deep(a) { color: #6366f1; text-decoration: underline; text-decoration-color: rgba(99, 102, 241, 0.3); text-underline-offset: 2px; }
:is(.dark) .skill-prose :deep(a) { color: #818cf8; text-decoration-color: rgba(129, 140, 248, 0.3); }
.skill-prose :deep(hr) { border-color: rgba(139, 92, 246, 0.1); margin: 16px 0; }
:is(.dark) .skill-prose :deep(hr) { border-color: rgba(139, 92, 246, 0.15); }
.skill-prose :deep(blockquote) {
  border-left: 3px solid rgba(139, 92, 246, 0.3);
  padding-left: 12px;
  color: #6b7280;
  font-style: italic;
}
:is(.dark) .skill-prose :deep(blockquote) {
  border-left-color: rgba(139, 92, 246, 0.4);
  color: #9ca3af;
}
</style>
