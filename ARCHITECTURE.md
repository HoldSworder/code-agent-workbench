# 技术架构文档

## 整体架构

Code Agent 采用 **Tauri 2.x 桌面应用 + Node.js Sidecar** 架构，前后端通过 stdin/stdout JSON-RPC 2.0 通信。

```
┌──────────────────────────────────────────────────────────┐
│                    Tauri 2.x 桌面壳                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Vue 3 前端 (apps/desktop)              │  │
│  │  Dashboard │ RepoView │ TaskDetail │ WorkflowEditor │  │
│  │  SkillsView │ McpView │ ConsultView │ Orchestrator  │  │
│  │─────────────────────────────────────────────────────│  │
│  │  Pinia Stores │ Composables (RPC Client) │ xterm.js │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │ stdin/stdout JSON-RPC 2.0       │
│  ┌──────────────────────▼─────────────────────────────┐  │
│  │           Node.js Sidecar (packages/sidecar)        │  │
│  │  RPC Server │ WorkflowEngine │ Orchestrator         │  │
│  │  Providers │ Skill Scanner │ MCP Writer │ Consult   │  │
│  │─────────────────────────────────────────────────────│  │
│  │  SQLite (better-sqlite3) │ Git Operations           │  │
│  └─────────────┬──────────────────┬────────────────────┘  │
│                │                  │                        │
└────────────────┼──────────────────┼────────────────────────┘
                 │                  │
    ┌────────────▼───┐   ┌─────────▼──────────┐
    │  AI Agent CLI  │   │   MCP Servers       │
    │  Cursor CLI    │   │   飞书文档 / API    │
    │  Claude Code   │   │   自定义工具        │
    │  Codex CLI     │   └────────────────────┘
    │  Anthropic API │
    └────────────────┘
```

## 技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| 桌面壳 | Tauri 2.x | Rust 编写的轻量桌面容器，管理窗口和系统 API |
| 前端 | Vue 3 + TypeScript + Pinia + Vue Router | SPA 单页应用 |
| 样式 | UnoCSS (Preset Uno + Icons + Typography) | 原子化 CSS |
| 终端 | xterm.js + tauri-pty | 真实 PTY 终端模拟 |
| 后端 | Node.js Sidecar (SEA) | 编译为单文件可执行程序，随 Tauri 分发 |
| 通信 | stdin/stdout JSON-RPC 2.0 | 60+ 个 RPC 方法 |
| 数据库 | SQLite (better-sqlite3, WAL) | 12 张核心表，inline migration |
| AI | Anthropic SDK / Cursor CLI / Claude Code / Codex | 多 Provider 统一抽象 |
| 构建 | pnpm monorepo + Vite + tsup | 前端 Vite 构建，Sidecar tsup + SEA 打包 |
| 测试 | Vitest | Sidecar 单元测试 |

## Monorepo 结构

```
code-agent/
├── apps/
│   ├── desktop/                  # Tauri + Vue 桌面应用
│   │   ├── src/
│   │   │   ├── views/            # 页面视图
│   │   │   ├── stores/           # Pinia 状态管理
│   │   │   └── composables/      # RPC 客户端封装
│   │   └── src-tauri/            # Tauri Rust 配置
│   └── consult/                  # 只读咨询 Web 前端（独立 SPA）
├── packages/
│   └── sidecar/                  # Node.js Sidecar 后端
│       ├── src/
│       │   ├── rpc/              # JSON-RPC Server + 方法注册
│       │   ├── db/               # SQLite schema + Repository 层
│       │   ├── workflow/         # YAML 解析 + 工作流状态机
│       │   ├── providers/        # AgentProvider 抽象层
│       │   ├── orchestrator/     # Leader-Worker 编排器
│       │   ├── consult/          # 咨询服务 HTTP Server
│       │   ├── skill/            # Skill 扫描 + 远程商店
│       │   ├── mcp/              # MCP 配置注入
│       │   ├── git/              # Git worktree / 分支操作
│       │   └── transcript/       # Agent 会话 Transcript 解析
│       └── __tests__/
└── workflows/                    # 工作流模板 + Skill 文件
    ├── dev-workflow/
    ├── vibecoding/
    └── shared/
```

## 核心模块设计

### JSON-RPC 通信层

前端与 Sidecar 通过 stdin/stdout JSON-RPC 2.0 通信，共 60+ 个方法，按域划分：

| 域 | 数量 | 代表方法 |
|---|------|---------|
| `repo.*` | 4 | list / create / delete / sessionTranscript |
| `requirement.*` | 11 | CRUD + startFetch / getLiveOutput / retryFetch |
| `task.*` | 9 | listByRepo / changedFiles / fileDiff / agentRuns |
| `workflow.*` | 30+ | start / confirm / suspend / feedback / rollback / retry / cancel / routeTrigger / resolveSkill / previewPrompt |
| `skill.*` | 4 | scan / readContent / enable / disable |
| `skillStore.*` | 5 | list / search / detail / install / uninstall |
| `mcp.*` | 7 | CRUD + toggle + getBindings / setBindings |
| `consult.*` | 5 | start / stop / status / listSessions / getSessionMessages |
| `orchestrator.*` | 10+ | dispatch / cancel / reject / retry / runs / events / teamConfig |
| `settings.*` | 3 | get / set / getAll |
| `message.*` | 2 | list / listAll |
| `agent.*` | 1 | listModels |

非 Tauri 环境（浏览器开发模式）下自动注入 Mock 实现，前端无需区分运行环境。

### 工作流引擎

工作流采用 Stage → Phase 两级编排模型，由 `WorkflowEngine` 状态机驱动：

```
          workflow.yaml
               │
     ┌─────────▼──────────┐
     │    YAML Parser      │  解析 stages / phases / gates / guardrails
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │  Context Builder    │  构建 prompt：skill 内容 + 变量插值 + 护栏注入
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │  WorkflowEngine     │  状态机推进 Phase，调用 Provider 执行
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │  AgentProvider      │  API / ExternalCLI / Script
     └────────────────────┘
```

**Phase 状态机：**

```
pending → running → ┬─ <<PENDING_INPUT>>      → waiting_input
                    ├─ completion_check 未通过  → waiting_input
                    ├─ requires_confirm        → waiting_confirm
                    ├─ is_terminal             → completed ✅
                    ├─ loopable                → loop_target (running)
                    ├─ 有下一 phase            → 自动推进 (running)
                    └─ 执行异常                → failed ❌

waiting_input   ── feedback ──→ running
waiting_confirm ── confirm  ──→ next phase
                ── feedback ──→ running
                ── suspend  ──→ suspended
suspended       ── feedback ──→ running
failed          ── retry    ──→ running (skipEntryGate)
```

**门禁系统：** 6 种 check 类型（`exists` / `not_exists` / `file_contains` / `file_not_contains` / `file_section_matches` / `command_succeeds`），所有 checks 为 AND 关系。分为 `entry_gate`（执行前检查）和 `completion_check`（完成后验收）。

**护栏系统：** 注入 prompt 的行为约束，分为 🚫 hard（强制）和 ⚠️ soft（建议）两级。

**状态推断：** 7 条声明式规则，根据文件系统状态（分支是否存在、OpenSpec 文件是否存在等）自动推断当前阶段位置，支持断点续跑。

### AgentProvider 抽象

```typescript
interface AgentProvider {
  run(params: AgentRunParams): Promise<AgentRunResult>
  cancel(sessionId: string): Promise<void>
}
```

三种实现：

| Provider | 机制 | 进程管理 |
|----------|------|---------|
| `ApiProvider` | Anthropic SDK 直调，支持 tool_use | 无外部进程 |
| `ExternalCliProvider` | 子进程启动 CLI Agent | 管理 stdin/stdout/stderr |
| `ScriptProvider` | 执行 Shell 命令 | child_process.exec |

**ExternalCliProvider 关键机制：**

- **信号提示词**（Signal Prompt）：在 prompt 中注入 `<<PHASE_COMPLETE>>` / `<<PENDING_INPUT>>` 等标记，通过监听 stdout 检测 Agent 输出中的信号来推断阶段完成状态
- **会话恢复**：记录 CLI Agent 的 session_id，支持 `--resume` 从中断处继续
- **多 CLI 适配**：统一 Cursor CLI / Claude Code / Codex 的命令行参数差异（`--print` vs `--output-format` 等）

### Leader-Worker 编排器

```
┌──────────────────┐
│  Orchestrator     │  管理编排生命周期
└────────┬─────────┘
         │
┌────────▼─────────┐
│  LeaderLoop       │  调用 Leader Agent 分析需求，解析 <decision> 输出
└────────┬─────────┘
         │ split / single_worker / blocked
         │
┌────────▼─────────┐     ┌───────────────┐
│  WorkerRunner #1  │     │ WorkerRunner #N │  各自独立 git worktree
│  (frontend_dev)   │     │ (backend_dev)   │
└──────────────────┘     └───────────────┘
```

- **团队定义**：`team.yaml` 声明角色、Provider、Prompt 模板
- **任务分配**：Leader 输出 `<decision>` JSON，包含 `split` / `single_worker` / `blocked` 三种决策
- **隔离执行**：每个 Worker 在独立 git worktree 中工作，互不干扰
- **事件追踪**：所有编排事件（dispatched / assigned / completed / failed）写入 `orchestrator_events` 表

### 数据持久化

SQLite + WAL 模式，12 张核心表：

| 表 | 用途 | 关键字段 |
|---|------|---------|
| `repos` | 仓库注册 | name, local_path(UNIQUE), default_branch, agent_provider |
| `requirements` | 需求管理 | title, description, source, status, mode |
| `repo_tasks` | 任务执行 | requirement_id, repo_id, current_stage, current_phase, phase_status |
| `agent_runs` | Agent 运行记录 | repo_task_id, phase_id, provider, session_id, model, token_usage |
| `conversation_messages` | 对话消息 | repo_task_id, phase_id, role, content |
| `settings` | 全局设置 | key(PK), value |
| `phase_commits` | Phase 提交锚点 | repo_task_id + phase_id (联合 PK), commit_sha |
| `mcp_servers` | MCP 配置 | name(UNIQUE), transport, command, args, url, enabled |
| `phase_mcp_bindings` | MCP 绑定 | stage_id, phase_id, mcp_server_id |
| `orchestrator_runs` | 编排运行 | requirement_id, team_config, status, leader_decision |
| `assignments` | 任务分配 | run_id, role, title, acceptance_criteria, status |
| `orchestrator_events` | 编排事件 | run_id, assignment_id, event_type, payload |

采用 inline migration 策略，schema 变更在应用启动时自动执行。

### MCP 配置注入

MCP Server 按 Phase 动态绑定。执行流程：

1. Phase 执行前，读取该 Phase 绑定的 MCP Server 列表
2. 备份 Agent CLI 的现有 MCP 配置文件（如 `.cursor/mcp.json`）
3. 将绑定的 MCP Server 配置合并写入
4. Agent 执行完成后，恢复原始配置

这确保 Agent 在每个阶段只看到它需要的工具，避免全局挂载导致的上下文窗口浪费。

### Consult 咨询服务

独立的 HTTP Server，嵌入 Sidecar 进程中：

```
┌─────────────────┐        ┌──────────────────────────┐
│  浏览器客户端     │  HTTP  │  Consult HTTP Server      │
│  (apps/consult)  │◄──────►│  静态文件 + API 路由       │
└─────────────────┘        │  ConsultChatHandler       │
                           │  ├─ 只读护栏注入           │
                           │  └─ Agent CLI (suggest 模式)│
                           └──────────────────────────┘
```

API 路由：`/api/repos`（仓库列表）、`/api/sessions`（会话管理）、`/api/chat`（SSE 流式对话）。

### Skill 系统

Skill 以 Markdown 文件定义，包含 Agent 行为指令。扫描路径覆盖三种 Agent 环境：

- Claude Code：`~/.claude/skills/`
- Codex：`~/.codex/skills/`
- Cursor：`~/.cursor/skills/`

工作流中通过 `skill` 字段指定当前 Phase 的主 Skill，通过 `invoke_skills` 注入额外 Skill。Context Builder 在构建 prompt 时将 Skill 内容拼接为系统指令。

## 构建与分发

### Sidecar 构建

Sidecar 使用 Node.js SEA（Single Executable Application）打包：

```bash
tsup src/index.ts          # TypeScript → ESM bundle
node --experimental-sea-config  # 生成 SEA blob
# 注入到 node 二进制 → 生成独立可执行文件
```

产物随 Tauri 应用一起分发，无需目标机器安装 Node.js。

### 前端构建

```bash
vite build                 # Vue SPA → 静态资源
tauri build                # 打包为平台原生安装包
```

### 开发模式

```bash
pnpm dev          # Vite dev server（浏览器模式，RPC 自动 Mock）
pnpm dev:sidecar  # tsx watch（Sidecar 热重载）
pnpm dev:tauri    # Sidecar SEA + Tauri dev（完整桌面应用）
```
