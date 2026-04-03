# Code Agent — 前端开发工作流 Agent 桌面应用

> **Goal:** 构建一个 Tauri 桌面应用，将前端开发全生命周期（设计 → 规划 → 编码 → 审查 → 验证 → MR → 部署）编排为数据驱动的工作流，由 Agent 自动执行各阶段任务，用户在关键节点审批确认。

**Architecture:** Tauri + Vue 3 前端 + Node.js Sidecar 后端。工作流引擎由 YAML 定义骨架，每个阶段启动独立 Agent（无跨阶段上下文），通过 OpenSpec 文件系统传递状态。支持多仓库管理，一个需求可分发到多个仓库独立执行工作流。

**Tech Stack:** Tauri 2.x, Vue 3 + TypeScript, Node.js (Sidecar), SQLite, Claude Code CLI / Cursor CLI / Codex / OpenAI-compatible API

---

## 1. 核心概念与数据模型

### 1.1 实体关系

```
Repo 1:N → RepoTask ← N:1 Requirement
```

- **Repo（仓库）**：用户添加的本地 Git 仓库
- **Requirement（需求）**：用户在总看板下发的需求文档，可关联多个仓库
- **RepoTask（仓库任务）**：一个需求在一个仓库下的工作流实例，是工作流执行的最小单元

### 1.2 Repo

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (uuid) | 主键 |
| name | string | 仓库显示名 |
| local_path | string | 本地仓库绝对路径 |
| default_branch | string | 默认分支（master/main） |
| agent_provider | string | 默认 Agent Provider ID |
| created_at | datetime | 创建时间 |

### 1.3 Requirement

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (uuid) | 主键 |
| title | string | 需求标题 |
| description | text | 需求描述（Markdown） |
| source | string | 来源（manual / feishu / gitlab） |
| source_url | string? | 来源链接 |
| status | enum | draft / active / completed / archived |
| created_at | datetime | 创建时间 |

### 1.4 RepoTask

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (uuid) | 主键 |
| requirement_id | string (fk) | 所属需求 |
| repo_id | string (fk) | 所属仓库 |
| branch_name | string | feature 分支名 |
| change_id | string | OpenSpec 变更 ID |
| current_phase | string | 当前阶段 ID（引用 workflow.yaml） |
| phase_status | enum | running / waiting_confirm / waiting_event / completed / failed |
| openspec_path | string | openspec 变更目录相对路径 |
| worktree_path | string | git worktree 工作目录绝对路径 |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 最后更新时间 |

### 1.5 AgentRun（Agent 执行记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (uuid) | 主键 |
| repo_task_id | string (fk) | 所属任务 |
| phase_id | string | 阶段 ID |
| provider | string | 使用的 Provider（api / external-cli / script） |
| status | enum | running / success / failed / cancelled |
| started_at | datetime | 开始时间 |
| finished_at | datetime? | 结束时间 |
| token_usage | number? | Token 消耗 |
| error | text? | 错误信息 |

### 1.6 ConversationMessage（对话消息）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (uuid) | 主键 |
| repo_task_id | string (fk) | 所属任务 |
| phase_id | string | 阶段 ID |
| role | enum | user / assistant |
| content | text | 消息内容（Markdown） |
| created_at | datetime | 时间 |

---

## 2. 工作流引擎

### 2.1 设计原则

- **YAML 管骨架**：阶段定义、顺序、确认门、Provider 选择、MCP 配置由 YAML 声明
- **Skill 管肉**：每个阶段的 Agent 执行逻辑由 Skill 文件（Markdown）描述
- **工作流引擎是确定性的调度器**：它不做 LLM 推理，只做状态推进、事件路由、Agent 生命周期管理
- **每个阶段启动独立 Agent**：无跨阶段上下文传递，所有状态通过 OpenSpec 文件系统共享

### 2.2 workflow.yaml Schema

```yaml
# 工作流配置
name: fe-dev-workflow
description: 前端需求研发工作流

# 阶段定义（按顺序执行）
phases:
  - id: design
    name: 设计探索
    requires_confirm: true        # 阶段产出需要用户确认
    provider: api                 # agent provider 类型
    skill: skills/design.md       # agent 执行指南
    tools:                        # API provider 可用工具
      - feishu-read-doc
      - figma-get-node
      - read-file
      - list-directory
    mcp_config: null              # CLI provider 的 MCP 配置文件路径
    confirm_files:                # 确认时展示给用户的文件
      - "{{openspec_path}}/proposal.md"
      - "{{openspec_path}}/specs/*/spec.md"

  - id: plan
    name: 任务规划
    requires_confirm: true
    provider: api
    skill: skills/plan.md
    tools:
      - read-file
      - write-file
    confirm_files:
      - "{{openspec_path}}/tasks.md"

  - id: t1-dev
    name: T1 前端开发
    requires_confirm: false
    provider: external-cli
    skill: skills/t1-dev.md
    mcp_config: mcp-configs/dev.json
    completion_check: "tasks-all-checked"  # 完成条件：tasks.md 全部 [x]

  - id: review
    name: 代码审查
    requires_confirm: true
    provider: api
    skill: skills/review.md
    tools:
      - git-diff
      - read-file
    confirm_files:
      - "__agent_output__"        # 展示 Agent 输出内容

  - id: verify
    name: 验证
    requires_confirm: false
    provider: script
    script: scripts/verify.sh     # 跑 lint + typecheck + test + build

  - id: mr
    name: 创建 MR
    requires_confirm: true
    provider: script
    script: scripts/gitlab-mr.sh
    args: ["--target", "develop", "--auto-merge"]

# 事件驱动阶段（T1 完成后，等待外部事件触发）
events:
  - id: backend-spec-arrived
    name: 后端 Spec 到达
    after_phase: t1-dev           # 仅 T1 完成后接受此事件
    skill: skills/integration.md
    provider: external-cli
    mcp_config: mcp-configs/integration.json

  - id: test-spec-arrived
    name: 测试 Spec 到达
    after_phase: t1-dev
    skill: skills/test-spec.md
    provider: api

  - id: e2e-verify
    name: E2E 验证
    after_phase: t1-dev
    skill: skills/e2e.md
    provider: external-cli
    mcp_config: mcp-configs/e2e.json
    confirm_files:
      - "{{openspec_path}}/e2e-report.md"

  - id: archive
    name: 归档
    after_phase: e2e-verify
    provider: script
    script: scripts/archive.sh
```

### 2.3 阶段状态机

```
Phase 执行流程：

  ┌─────────┐
  │ 准备上下文 │ ← 从 OpenSpec 文件 + repo 状态收集
  └─────┬───┘
        │
  ┌─────▼─────┐
  │ 启动 Agent │ ← 新进程，注入 skill + 上下文
  └─────┬─────┘
        │
  ┌─────▼─────┐
  │ Agent 执行 │ ← 读写 OpenSpec 文件、编辑代码、调用工具
  └─────┬─────┘
        │
  ┌─────▼──────────┐
  │ 检查完成条件     │
  └─────┬──────────┘
        │
        ├── requires_confirm: true
        │   └── phase_status = waiting_confirm
        │       └── UI 展示 confirm_files 内容
        │           ├── 用户确认 → 推进下一阶段
        │           └── 用户反馈 → 启动新 Agent 修改，再次等确认
        │
        ├── requires_confirm: false
        │   └── 自动推进下一阶段
        │
        └── 最后一个 phase 完成
            └── 进入 waiting_event 状态（等待外部事件）

RepoTask 全局状态机：

  created → running → waiting_confirm → running → ...
                          ↑                │
                          └── 用户反馈 ────┘
  ... → waiting_event（T1 完成）
           │
           ├── 事件：后端 spec → running → ...
           ├── 事件：测试 spec → running → ...
           ├── 事件：跑 e2e → running → waiting_confirm → ...
           └── 事件：归档 → completed
```

### 2.4 工作流引擎核心接口

```typescript
interface WorkflowEngine {
  // 创建新任务并启动工作流
  startWorkflow(repoTaskId: string): Promise<void>

  // 推进到下一阶段
  advancePhase(repoTaskId: string): Promise<void>

  // 用户确认当前阶段产出
  confirmPhase(repoTaskId: string): Promise<void>

  // 用户对当前阶段产出提供反馈（触发修改）
  provideFeedback(repoTaskId: string, feedback: string): Promise<void>

  // 外部事件触发
  triggerEvent(repoTaskId: string, eventId: string, payload?: any): Promise<void>

  // 取消当前正在运行的 Agent
  cancelCurrentAgent(repoTaskId: string): Promise<void>
}
```

---

## 3. Agent 执行模型

### 3.1 设计原则

- 每个阶段启动独立 Agent 进程，执行完毕后销毁
- Agent 无跨阶段记忆，所有上下文从 OpenSpec 文件系统读取
- 文件系统是唯一的"共享状态"
- 用户反馈触发的修改会启动**新 Agent 实例**，注入原始 Skill + OpenSpec 上下文 + 用户反馈内容
- 同一仓库下使用 **git worktree** 隔离并行任务（每个 RepoTask 有独立的工作目录），避免分支切换冲突

### 3.2 Agent Provider 抽象

```typescript
interface AgentProvider {
  run(context: PhaseContext): Promise<PhaseResult>
  cancel(): Promise<void>
}

interface PhaseContext {
  phaseId: string
  repoPath: string
  openspecPath: string
  branchName: string
  skillContent: string            // Skill 文件内容
  tools?: string[]                // API provider: 可用工具 ID
  mcpConfig?: string              // CLI provider: MCP 配置文件路径
  userMessage?: string            // 用户的额外指令或反馈
}

interface PhaseResult {
  status: 'success' | 'failed' | 'cancelled'
  output?: string                 // Agent 的文本输出（展示在对话中）
  error?: string
  tokenUsage?: number
}
```

### 3.3 三种 Provider 实现

**ApiProvider** — 直接调 LLM API

适用阶段：设计探索、任务规划、代码审查等不需要文件编辑的阶段。

- 使用 Anthropic / OpenAI 兼容 API
- 自行实现 Agent Loop（tool_use → execute → loop）
- tools 数组从 workflow.yaml 配置中注册
- 支持用户配置 API Key / Base URL / Model

**ExternalCliProvider** — 调外部 Agent CLI

适用阶段：T1 开发、联调、E2E 验证等需要文件编辑的阶段。

- 支持 Cursor CLI、Claude Code CLI、Codex
- 通过 child_process 启动，传入 prompt + MCP 配置
- 在目标仓库目录下执行
- 每个阶段可指定不同的 mcp_config

**ScriptProvider** — 执行 Shell 脚本

适用阶段：验证（lint/test/build）、创建 MR、归档等确定性操作。

- 直接调 shell 脚本
- 传入参数，解析 stdout/stderr
- 复用现有的 gitlab-mr.sh、jarvis-deploy.sh 等脚本

### 3.4 Provider 配置（设置页面）

```typescript
interface ProviderConfig {
  // API Provider 配置
  api: {
    type: 'anthropic' | 'openai-compatible'
    apiKey: string
    baseUrl?: string
    model: string
  }

  // External CLI Provider 配置
  externalCli: {
    type: 'cursor-cli' | 'claude-code' | 'codex'
    binaryPath?: string           // CLI 可执行文件路径，默认从 PATH 查找
  }
}
```

每个仓库可以覆盖全局 Provider 配置，每个阶段可以覆盖仓库级配置。优先级：

```
阶段级 > 仓库级 > 全局默认
```

---

## 4. 多仓库与需求分发

### 4.1 需求创建流程

1. 用户在总看板点击「新建需求」
2. 输入需求文档（手动输入 / 粘贴飞书链接 / 上传文件）
3. Agent 分析需求内容，识别涉及哪些已添加的仓库
4. 用户确认仓库分发方案
5. 为每个仓库创建 RepoTask：
   - 从最新 default_branch 创建 feature 分支
   - 初始化 openspec 变更目录
   - 启动工作流

### 4.2 分支管理与 Worktree 隔离

每个 RepoTask 使用独立的 git worktree，避免同一仓库下多任务的分支切换冲突：

```typescript
async function createRepoTask(repo: Repo, requirement: Requirement): Promise<RepoTask> {
  const changeId = generateChangeId(requirement.title)
  const branchName = `feature/${changeId}`

  // 在主仓库中拉取最新
  await git(repo.local_path, ['fetch', 'origin', repo.default_branch])

  // 创建 worktree + feature 分支（基于最新 default_branch）
  const worktreePath = path.join(repo.local_path, '.worktrees', changeId)
  await git(repo.local_path, [
    'worktree', 'add', '-b', branchName,
    worktreePath, `origin/${repo.default_branch}`
  ])

  return createRepoTaskRecord({
    requirement_id: requirement.id,
    repo_id: repo.id,
    branch_name: branchName,
    change_id: changeId,
    current_phase: 'design',
    phase_status: 'running',
    openspec_path: `openspec/changes/${changeId}`,
    worktree_path: worktreePath,  // Agent 在此目录下执行
  })
}
```

Agent 执行时的 `cwd` 指向 `worktree_path` 而非 `repo.local_path`，因此多个 RepoTask 可以同时运行，互不干扰。

任务归档后清理 worktree：
```typescript
await git(repo.local_path, ['worktree', 'remove', worktreePath])
```

### 4.3 并行与独立

- 同一需求在不同仓库的 RepoTask **完全独立执行**，互不阻塞
- 同一仓库下可以有多个活跃的 RepoTask（通过 git worktree 隔离，各自独立工作目录）
- 新需求可以随时插入，不影响已有任务
- 每个 Agent 进程的 cwd 指向对应 worktree 目录

---

## 5. UI 设计

### 5.1 页面结构

| 页面 | 路由 | 说明 |
|------|------|------|
| 总看板 | `/` | 全局需求列表，展示每个需求在各仓库的进度 |
| 仓库视图 | `/repo/:id` | 该仓库下所有任务的阶段流水线 |
| 任务详情 | `/repo/:id/task/:taskId` | 任务的文件查看 + Agent 对话 |
| 设置 | `/settings` | Agent 配置、工作流编辑、仓库管理 |

### 5.2 总看板

- 需求卡片列表，每个卡片显示：需求标题、来源、创建时间
- 卡片内展示关联的仓库及各自的进度条和当前阶段
- 状态标签：进行中 / 待确认（醒目） / 等待事件 / 已完成
- 操作：新建需求、搜索、按状态筛选

### 5.3 仓库视图

- 泳道式流水线，列为工作流阶段（设计 → 规划 → T1 → 等待事件 → E2E → 归档）
- 每个 RepoTask 是一张卡片，位于其当前阶段的列中
- 卡片展示：需求名、阶段状态、进度（如 tasks 6/8）
- 「待确认」状态的卡片有醒目视觉提示

### 5.4 任务详情

两个 Tab：

**文件 Tab：**
- 树形展示 openspec 变更目录下的所有文件
- 点击文件展开 Markdown 渲染预览
- 当 phase_status = waiting_confirm 时，展示确认操作按钮
- 确认按钮：✅ 确认（推进） / ✏️ 修改意见（进入对话） / ⏸ 暂不处理

**对话 Tab：**
- 展示当前阶段的 Agent 输出和用户交互
- 用户可以发送消息给当前阶段的 Agent
- 提供修改意见时自动切换到此 Tab
- 对话仅限当前阶段，切换阶段后清空（因为每个阶段是独立 Agent）

### 5.5 设置页面

三个 Tab：

**Agent 配置：**
- 全局默认 Provider 选择（Cursor CLI / Codex / Claude Code / 自定义 API）
- API Key / Base URL / Model 配置
- CLI 路径配置

**工作流配置：**
- 内嵌 Monaco Editor 编辑 workflow.yaml
- 或未来迭代为可视化编辑器

**仓库管理：**
- 添加/删除仓库
- 设置仓库级 Provider 覆盖
- 配置默认分支

---

## 6. 技术架构

### 6.1 项目结构

```
code-agent/
├── src-tauri/                     # Tauri Rust 层
│   ├── src/
│   │   └── main.rs                # Tauri 入口，注册 IPC commands
│   └── Cargo.toml
│
├── src/                           # Vue 前端
│   ├── App.vue
│   ├── views/
│   │   ├── Dashboard.vue          # 总看板
│   │   ├── RepoView.vue           # 仓库流水线
│   │   ├── TaskDetail.vue         # 任务详情（文件+对话）
│   │   └── Settings.vue           # 设置
│   ├── components/
│   │   ├── RequirementCard.vue
│   │   ├── TaskCard.vue
│   │   ├── FileViewer.vue         # OpenSpec 文件预览
│   │   ├── ChatPanel.vue          # Agent 对话
│   │   └── ConfirmBar.vue         # 确认/反馈操作栏
│   └── stores/
│       ├── repos.ts
│       ├── requirements.ts
│       └── tasks.ts
│
├── sidecar/                       # Node.js Sidecar（核心逻辑）
│   ├── src/
│   │   ├── index.ts               # Sidecar 入口
│   │   ├── workflow/
│   │   │   ├── engine.ts          # 工作流引擎
│   │   │   ├── phase-runner.ts    # 阶段执行器
│   │   │   └── event-bus.ts       # 事件总线
│   │   ├── providers/
│   │   │   ├── api-provider.ts    # LLM API 调用
│   │   │   ├── cli-provider.ts    # 外部 CLI 调用
│   │   │   └── script-provider.ts # 脚本执行
│   │   ├── repo/
│   │   │   ├── manager.ts         # 仓库管理（git 操作）
│   │   │   └── openspec.ts        # OpenSpec 文件读写
│   │   ├── db/
│   │   │   └── sqlite.ts          # SQLite 数据访问
│   │   └── ipc/
│   │       └── handler.ts         # Tauri IPC 处理
│   ├── package.json
│   └── tsconfig.json
│
├── workflow.yaml                  # 默认工作流配置
├── skills/                        # 阶段 Skill 文件
│   ├── design.md
│   ├── plan.md
│   ├── t1-dev.md
│   ├── review.md
│   ├── integration.md
│   ├── test-spec.md
│   └── e2e.md
├── mcp-configs/                   # 阶段 MCP 配置
│   ├── design.json
│   ├── dev.json
│   ├── integration.json
│   └── e2e.json
├── scripts/                       # 确定性脚本
│   ├── verify.sh
│   ├── gitlab-mr.sh
│   └── archive.sh
│
├── package.json
└── vite.config.ts
```

### 6.2 通信架构

```
Vue 前端 ←── Tauri IPC (invoke/listen) ──→ Rust Bridge
                                              │
                                      Sidecar 管理
                                              │
                                         Node.js Sidecar
                                         (stdio JSON-RPC)
```

- 前端通过 `@tauri-apps/api` 的 `invoke` 调用 Rust 命令
- Rust 层转发请求到 Node.js Sidecar（通过 stdin/stdout JSON-RPC）
- Sidecar 通过 Tauri event 系统推送实时状态更新到前端

### 6.3 数据存储

- **SQLite**：存储 Repo、Requirement、RepoTask、AgentRun、ConversationMessage
- **文件系统**：workflow.yaml、skills/*.md、mcp-configs/*.json 存储在应用数据目录
- **Git 仓库内**：OpenSpec 文件（proposal.md、tasks.md 等）存储在仓库 feature 分支中

---

## 7. V1 Scope

### V1 包含

- [ ] Tauri 应用骨架（Vue + Node.js Sidecar）
- [ ] SQLite 数据模型和基础 CRUD
- [ ] 仓库添加/管理
- [ ] 需求创建（手动输入）
- [ ] 需求 → 仓库分发（手动选择仓库）
- [ ] 自动创建 feature 分支
- [ ] 工作流引擎核心（阶段推进、确认门、事件驱动）
- [ ] ApiProvider 实现（调 LLM API）
- [ ] ExternalCliProvider 实现（调 Claude Code CLI）
- [ ] ScriptProvider 实现（调 shell 脚本）
- [ ] 总看板 UI
- [ ] 仓库流水线 UI
- [ ] 任务详情 UI（文件查看 + 对话）
- [ ] 确认流程 UI
- [ ] 设置页面（Provider 配置 + workflow.yaml 编辑）
- [ ] 默认 workflow.yaml + 阶段 Skill 文件

### V1 不包含（后续迭代）

- 需求智能分发（Agent 自动识别涉及哪些仓库）
- Eval 面板
- Agent Trace 可视化
- 工作流可视化编辑器
- 并行 Task 执行（同一任务的多个 Agent 同时跑）
- 飞书 / GitLab Webhook 触发
- 多任务队列管理

---

## 8. 关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 平台 | Tauri 桌面应用 | 原生体验，前端技能复用 |
| 前端框架 | Vue 3 + TypeScript | 用户技术栈 |
| 核心逻辑运行时 | Node.js (Sidecar) | AI 生态支持好，Claude Code 也用 Node |
| 工作流定义 | YAML（骨架）+ Skill（肉） | YAML 确定性调度，Skill 灵活表达 |
| Agent 执行模型 | 每阶段独立 Agent | OpenSpec 文件传递状态，无需上下文管理 |
| 跨阶段状态传递 | OpenSpec 文件系统 | 与现有 fe-specflow 工作流一致 |
| Agent Provider | 三种（API / CLI / Script） | 不同阶段不同需求，可灵活配置 |
| MCP 加载 | 按阶段配置 | 最小权限，不同阶段不同工具集 |
| 数据存储 | SQLite | 本地应用，无需外部数据库 |
| 确认门控 | YAML 可配置 | 工作流灵活调整 |
| 多任务隔离 | git worktree | 同一仓库多任务并行不冲突 |
| 完成检测 | 引擎解析 OpenSpec 文件 | tasks.md 全部 `[x]` 即 T1 完成 |
| 用户反馈 | 启动新 Agent + 注入反馈 | Agent 无状态，每次重建上下文 |
