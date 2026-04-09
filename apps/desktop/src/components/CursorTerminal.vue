<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { rpc } from '../composables/use-sidecar'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  repoPath: string
  visible: boolean
  sessionId?: string
}>()

const emit = defineEmits<{
  exit: [code: number]
}>()

const containerRef = ref<HTMLElement>()
const status = ref<'idle' | 'running' | 'exited'>('idle')
const exitCode = ref<number | null>(null)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let pty: any = null
let resizeObserver: ResizeObserver | null = null
let dataDisposable: { dispose(): void } | null = null
let exitDisposable: { dispose(): void } | null = null

const TERM_THEME = {
  background: '#1e1e22',
  foreground: '#d4d4d8',
  cursor: '#a78bfa',
  cursorAccent: '#1e1e22',
  selectionBackground: '#6366f140',
  selectionForeground: '#f4f4f5',
  black: '#27272a',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#6366f1',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#d4d4d8',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#818cf8',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
}

async function getProxyEnv(): Promise<Record<string, string>> {
  try {
    const all = await rpc<Record<string, string>>('settings.getAll')
    if (all['proxy.enabled'] !== 'true' || !all['proxy.url']) return {}
    return {}
  }
  catch {
    return {}
  }
}

async function spawnCursorAgent() {
  if (!isTauri() || !containerRef.value) return

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace",
    lineHeight: 1.4,
    theme: TERM_THEME,
    scrollback: 10000,
    allowTransparency: true,
    convertEol: true,
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(containerRef.value)

  await nextTick()
  fitAddon.fit()

  const { spawn } = await import('tauri-pty')
  const shell = getDefaultShell()
  const proxyEnv = await getProxyEnv()

  pty = spawn(shell, [], {
    cols: term.cols,
    rows: term.rows,
    cwd: props.repoPath,
    env: proxyEnv,
  })

  status.value = 'running'

  dataDisposable = pty.onData((data: string) => {
    term?.write(data)
  })

  exitDisposable = pty.onExit(({ exitCode: code }: { exitCode: number }) => {
    status.value = 'exited'
    exitCode.value = code
    term?.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`)
    emit('exit', code)
  })

  term.onData((data: string) => {
    pty?.write(data)
  })

  resizeObserver = new ResizeObserver(() => {
    if (fitAddon && term && pty && status.value === 'running') {
      fitAddon.fit()
      pty.resize(term.cols, term.rows)
    }
  })
  resizeObserver.observe(containerRef.value)

  sendCursorAgentCommand()
}

function sendCursorAgentCommand() {
  if (!pty || status.value !== 'running') return
  let cmd = `agent --workspace "${props.repoPath}"`
  if (props.sessionId)
    cmd += ` --resume ${props.sessionId}`
  pty.write(`${cmd}\r`)
}

function getDefaultShell(): string {
  return '/bin/zsh'
}

function dispose() {
  resizeObserver?.disconnect()
  resizeObserver = null
  dataDisposable?.dispose()
  dataDisposable = null
  exitDisposable?.dispose()
  exitDisposable = null

  if (pty && status.value === 'running') {
    try { pty.kill() } catch {}
  }
  pty = null

  term?.dispose()
  term = null

  status.value = 'idle'
  exitCode.value = null
}

function restart() {
  dispose()
  nextTick(() => spawnCursorAgent())
}

watch(() => props.visible, (visible) => {
  if (visible && !term) {
    nextTick(() => spawnCursorAgent())
  }
  else if (visible && fitAddon && term) {
    nextTick(() => {
      fitAddon?.fit()
      if (pty && status.value === 'running') {
        pty.resize(term!.cols, term!.rows)
      }
    })
  }
})

onMounted(() => {
  if (props.visible) {
    spawnCursorAgent()
  }
})

onBeforeUnmount(() => dispose())

defineExpose({ restart, dispose })
</script>

<template>
  <div class="cursor-terminal flex flex-col h-full">
    <!-- Terminal header -->
    <div class="flex items-center gap-2 px-3 py-1.5 bg-[#1e1e22] border-b border-white/[0.06] shrink-0">
      <div
        class="w-2 h-2 rounded-full"
        :class="{
          'bg-emerald-500': status === 'running',
          'bg-gray-500': status === 'idle',
          'bg-red-500': status === 'exited',
        }"
      />
      <span class="text-[11px] font-mono text-gray-400">
        agent
      </span>
      <span
        v-if="status === 'running'"
        class="text-[10px] text-emerald-500/70"
      >running</span>
      <span
        v-else-if="status === 'exited'"
        class="text-[10px] text-gray-500"
      >exited ({{ exitCode }})</span>

      <div class="flex-1" />

      <button
        v-if="status === 'exited' || status === 'idle'"
        class="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors"
        @click="restart"
      >
        <div class="i-carbon-restart w-3 h-3" />
        重启
      </button>
      <button
        v-if="status === 'running'"
        class="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        @click="dispose"
      >
        <div class="i-carbon-stop-filled w-3 h-3" />
        停止
      </button>
    </div>

    <!-- xterm.js container -->
    <div
      ref="containerRef"
      class="flex-1 min-h-0 bg-[#1e1e22]"
    />

    <!-- Placeholder when not in Tauri -->
    <div
      v-if="!containerRef && status === 'idle'"
      class="flex-1 flex items-center justify-center bg-[#1e1e22] text-gray-500 text-[13px]"
    >
      <div class="text-center">
        <div class="i-carbon-terminal w-10 h-10 mx-auto mb-2 opacity-30" />
        <p>终端仅在 Tauri 环境中可用</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cursor-terminal :deep(.xterm) {
  padding: 8px 4px;
  height: 100%;
}

.cursor-terminal :deep(.xterm-viewport) {
  overflow-y: auto !important;
}

.cursor-terminal :deep(.xterm-viewport::-webkit-scrollbar) {
  width: 6px;
}

.cursor-terminal :deep(.xterm-viewport::-webkit-scrollbar-track) {
  background: transparent;
}

.cursor-terminal :deep(.xterm-viewport::-webkit-scrollbar-thumb) {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.cursor-terminal :deep(.xterm-viewport::-webkit-scrollbar-thumb:hover) {
  background: rgba(255, 255, 255, 0.2);
}
</style>
