# 开发指南

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                     │
│  ┌───────────────────────┐  ┌────────────────────────┐  │
│  │     Vue 3 Frontend     │  │    Rust Bridge Layer    │  │
│  │                        │  │                        │  │
│  │  Views → Stores ──────────→ Shell Plugin ──────────┤  │
│  │    ↕         ↕         │  │         │              │  │
│  │  Router    Pinia       │  │    spawn + stdio       │  │
│  └───────────────────────┘  └─────────┬──────────────┘  │
│                                        │                  │
│  ┌─────────────────────────────────────▼──────────────┐  │
│  │              Node.js Sidecar Process                │  │
│  │                                                     │  │
│  │  stdin ──→ JSON-RPC Server ──→ Method Router        │  │
│  │                                    │                │  │
│  │              ┌─────────────────────┼───────────┐    │  │
│  │              │                     │           │    │  │
│  │         ┌────▼────┐         ┌──────▼───┐  ┌───▼──┐ │  │
│  │         │ Repos   │         │ Workflow │  │ Git  │ │  │
│  │         │ CRUD    │         │ Engine   │  │ Ops  │ │  │
│  │         └────┬────┘         └────┬─────┘  └──────┘ │  │
│  │              │                    │                  │  │
│  │         ┌────▼────────────────────▼──────────────┐  │  │
│  │         │          SQLite (better-sqlite3)        │  │  │
│  │         └─────────────────────────────────────────┘  │  │
│  │                                                     │  │
│  │  stdout ──→ JSON-RPC Response ──→ Frontend          │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
                   ┌──────────────┐
                   │  @cursor/sdk │
                   │ (local agent │
                   │  会话/流式)   │
                   └──────────────┘
```

### 通信流

1. 用户在 Vue 前端操作（如点击"确认推进"）
2. Pinia Store 调用 `rpc('workflow.confirm', { repoTaskId })` 
3. `use-sidecar.ts` 将请求序列化为 JSON-RPC，通过 Tauri Shell 插件写入 sidecar 进程的 stdin
4. Node.js Sidecar 的 `RpcServer` 解析请求，路由到对应 handler
5. Handler 调用 `WorkflowEngine`，引擎推进状态、启动 Agent Provider
6. Provider 执行完毕后，结果写入 SQLite，响应通过 stdout 返回前端

### 数据模型

```
Repo (仓库)
 └──→ RepoTask (仓库任务) ←── Requirement (需求)
        ├──→ AgentRun (Agent 执行记录)
        └──→ ConversationMessage (对话消息)
```

- **Repo**：用户添加的本地 Git 仓库
- **Requirement**：一个需求文档，可关联多个仓库
- **RepoTask**：一个需求在一个仓库下的工作流实例（最小执行单元）
- **AgentRun**：每次 Agent 执行的记录（阶段、Provider、耗时、Token）
- **ConversationMessage**：Agent 输出和用户反馈的对话记录

所有数据存储在 SQLite（`code-agent.db`），schema 定义见 `packages/sidecar/src/db/schema.ts`。

## 工作流引擎

### 状态机

```
RepoTask 生命周期：

  created ──→ running ──→ waiting_confirm ──→ running ──→ ...
                              ↑                   │
                              └── 用户反馈修改 ────┘
  
  ... ──→ waiting_event（所有 phase 完成后）
              │
              ├── 事件：后端 spec ──→ running ──→ ...
              ├── 事件：测试 spec ──→ running ──→ ...
              └── 事件：归档 ──→ completed
```

### YAML 骨架 + Skill 肉

工作流由两部分组成：

- **`workflow.yaml`**（骨架）：定义阶段顺序、Provider 类型、确认门控等确定性调度逻辑
- **`skills/*.md`**（肉）：定义每个阶段 Agent 的具体执行指令，使用自然语言描述

引擎本身是确定性的调度器，不做任何 LLM 推理。所有智能行为由 Agent Provider 执行。

### Agent Provider 抽象

```typescript
interface AgentProvider {
  run(context: PhaseContext): Promise<PhaseResult>
  cancel(): Promise<void>
}
```

当前唯一实现：

| Provider | 场景 | 机制 |
|----------|------|------|
| `CursorSdkProvider` | 全部阶段 / review / consult | 通过 `@cursor/sdk` 的 `Agent.create` / `Agent.resume` / `Agent.prompt` 运行 local agent |

- 凭证统一读 `agent.cursorApiKey` 设置项（或 `CURSOR_API_KEY` 环境变量），模型读 `agent.model`。
- 实例化必须经 `packages/sidecar/src/providers/factory.ts` 的 `loadAgentRuntimeFromSettings` + `createCursorSdkProvider`，不要直接 `new CursorSdkProvider` 或裸调 `Agent.create`。
- `workflow.yaml` 里历史保留的 `provider` 字段（`api` / `external-cli` / `codex`）已不再区分后端，仅作 schema 兼容；运行时一律走 Cursor SDK。
- Claude / Codex 官方 SDK 后续再接入；届时在 factory 增加分支即可，调用方无需改动。

> MCP 注入：SDK local agent 默认 `settingSources=[]`，不读项目 `.cursor/mcp.json`。engine 把阶段绑定的 MCP server 转成 inline 配置塞进 `PhaseContext.sdkMcpServers`，由 `CursorSdkProvider` 透传给 `Agent.create`。

### 单会话与跨阶段状态传递

整个工作流是**同一个 agent 会话**：首个 phase 用 `Agent.create` 建会话，后续 phase 通过 `Agent.resume(agentId)` 续接，仅追加一条 follow-up 用户消息，无需重灌完整 system prompt。`agentId` 即 provider 的 `sessionId`。

agent 通过 **advance-phase 工具**写信号文件声明阶段意图（next / target / pending_input / terminal），engine 据此推进；回合是否结束由 SDK 的 `RunResult.status` 判定。不再使用 `<<PHASE_COMPLETE>>` / `<<PENDING_INPUT>>` 文本标记。

阶段产出仍落盘到 **OpenSpec 文件系统**，便于门禁校验与人工查看：

```
{repo}/.worktrees/{change_id}/openspec/changes/{change_id}/
├── proposal.md        # 设计方案（design 阶段产出）
├── specs/
│   └── {module}/
│       └── spec.md    # 模块 spec（design 阶段产出）
├── tasks.md           # 任务列表（plan 阶段产出）
└── e2e-report.md      # E2E 报告（e2e 阶段产出）
```

### 任务生命周期（worktree 创建 → 等待合并 → 清理）

| 阶段 | 触发 | DB 状态 | 副作用 |
|---|---|---|---|
| 创建 | `task.create` RPC | `lifecycle_status='active'` | 用需求标题生成占位 slug（`changeIdFromRequirement`）→ `git worktree add -b feature/<slug> .worktrees/<slug>` → 写入 DB → best-effort 飞书项目同步；语义化英文 slug 由 create-branch 阶段的 agent 生成后经 `task.renameBranch`（内部 `normalizeSlug`）回写 |
| 开发 | workflow phases 执行 | 同上 | Agent cwd 指向 worktree，正常推进各 phase |
| 等待合并 | `archive-deploy` phase 完成 | `lifecycle_status='pending_merge'` | 已推送 origin + 创建 MR，但本地 worktree 与分支**保留**，方便处理 review 反馈 |
| 清理 | 用户在 Dashboard 点「已合并，清理 worktree」 | `lifecycle_status='archived'` | 调 `task.cleanupAfterMerge`，校验本地 feature 分支已合入 default branch → `git worktree remove --force` → `git branch -d feature/<slug>` |

slug 不满意时可调 `task.renameBranch` RPC（内部 `git branch -m feature/<new>`），不再需要单独的 `create-branch` workflow phase。

### 多任务隔离

同一仓库下的多个 RepoTask 通过 **git worktree** 真实隔离（task.create 时调用 `git worktree add` 创建独立工作目录与分支）：

```
{repo}/                                # 主仓库始终停在 default branch，不参与任务工作
├── .worktrees/                        # 由 .git/info/exclude 隐藏，不污染用户 .gitignore
│   ├── {change-id-1}/                 # RepoTask 1 的 main worktree（branch = feature/{change-id-1}）
│   ├── {change-id-2}/                 # RepoTask 2 的 main worktree（互不干扰）
│   ├── orchestrator-{assignment-A}/   # Leader 拆分出的 worker A
│   └── orchestrator-{assignment-B}/   # Leader 拆分出的 worker B
└── ...
```

- Agent 的 `cwd` 指向对应 worktree 目录，多任务可并行执行
- 每个 worker 完成后通过 `git merge --no-ff` 把自己的分支合回 RepoTask 的 main worktree，merge commit SHA 写入 `assignment_commits` 表
- 任务最终交付的就是 main worktree 的分支 `feature/{change-id}`

### 回滚机制（两层）

| 层级 | 入口 RPC | 操作 |
|---|---|---|
| Phase | `workflow.rollback` / `workflow.rollbackPaused` / `workflow.rollbackToStage` | main worktree `git reset --hard <phase_sha>`，连带清理目标 phase 之后所有 worker worktree 与 `assignment_commits` 行 |
| Worker | `workflow.rollbackAssignment` | main worktree reset 到该 worker 合并前 SHA，再 cherry-pick 之后其它 worker 的 merge commits；冲突时自动恢复，并提示改用 phase 级回滚 |

`phase_commits` 始终是「线性历史上的一个点」，cherry-pick 重建后会更新 worker merge SHA，保持这个不变量。

### 孤儿 worktree 清理

`task.cleanupOrphanWorktrees` RPC 扫描所有仓库的 `.worktrees/`，把不在数据库中的目录强制 `git worktree remove --force`。

## 开发环境搭建

### 前置条件

| 工具 | 版本要求 | 用途 |
|------|---------|------|
| Node.js | >= 20 | Sidecar 运行时 |
| pnpm | >= 8 | 包管理 |
| Rust | latest stable | Tauri 编译 |

### 安装依赖

```bash
pnpm install
```

### 开发模式

**方式一：纯前端开发（推荐日常 UI 调试）**

```bash
pnpm dev
```

在浏览器中打开 `http://localhost:1420`。前端自动进入 mock 模式，所有 RPC 调用返回空数据。适合 UI 布局和交互调试。

**方式二：Sidecar 独立开发**

```bash
pnpm dev:sidecar
```

Sidecar 通过 stdin/stdout 通信，可直接发送 JSON-RPC 测试：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"repo.list","params":{}}' | \
  pnpm --filter @code-agent/sidecar dev
```

**方式三：完整 Tauri 桌面应用**

```bash
cd apps/desktop
pnpm tauri dev
```

Tauri 会同时启动 Vite 开发服务器和 Rust 编译，首次启动较慢。

### 运行测试

```bash
# 运行所有 sidecar 测试
pnpm test

# 监听模式
cd packages/sidecar && pnpm test:watch

# 运行单个测试文件
cd packages/sidecar && pnpm test -- __tests__/workflow/engine.test.ts
```

### 类型检查

```bash
# Sidecar
cd packages/sidecar && npx tsc --noEmit

# 前端
cd apps/desktop && npx vue-tsc --noEmit
```

### 构建

```bash
# 构建 sidecar（输出到 packages/sidecar/dist/）
cd packages/sidecar && pnpm build

# 构建前端（输出到 apps/desktop/dist/）
cd apps/desktop && pnpm build

# 构建 Tauri 桌面应用
cd apps/desktop && pnpm tauri build
```

## Monorepo 结构

```
code-agent/                    # pnpm workspace root
├── apps/
│   └── desktop/               # @code-agent/desktop
│       ├── src/               #   Vue 前端源码
│       └── src-tauri/         #   Tauri Rust 层
├── packages/
│   └── sidecar/               # @code-agent/sidecar
│       ├── src/               #   Node.js 源码
│       └── __tests__/         #   Vitest 测试
├── workflow.yaml              # 工作流定义（运行时读取）
├── skills/                    # Agent 指令文件（运行时读取）
├── mcp-configs/               # MCP 配置（运行时读取）
└── scripts/                   # Shell 脚本（运行时执行）
```

依赖关系：`desktop` → (stdio) → `sidecar`。两个包之间没有代码级依赖，仅通过 JSON-RPC 通信。

## JSON-RPC 协议

前端和 Sidecar 之间的通信协议基于 [JSON-RPC 2.0](https://www.jsonrpc.org/specification)，以换行符分隔。

### 请求

```json
{"jsonrpc":"2.0","id":1,"method":"repo.list","params":{}}
```

### 响应

```json
{"jsonrpc":"2.0","id":1,"result":[{"id":"...","name":"my-app",...}]}
```

### 可用方法

| 方法 | 参数 | 说明 |
|------|------|------|
| `repo.list` | — | 列出所有仓库 |
| `repo.create` | `{ name, local_path, default_branch }` | 添加仓库 |
| `repo.delete` | `{ id }` | 删除仓库 |
| `requirement.list` | — | 列出所有需求 |
| `requirement.create` | `{ title, description, source, source_url? }` | 创建需求 |
| `requirement.get` | `{ id }` | 获取需求详情 |
| `task.create` | `{ requirementId, repoId }` | 创建任务：LLM 翻译标题为英文 slug，git worktree add 创建独立分支与目录 |
| `task.renameBranch` | `{ taskId, newSlug }` | 重命名 feature 分支（用户对 LLM 生成的 slug 不满意时） |
| `task.cleanupAfterMerge` | `{ taskId, force? }` | MR 合并后清理：移除 worktree + 删除本地 feature 分支 |
| `task.listByRepo` | `{ repoId }` | 按仓库列出任务 |
| `task.listByRequirement` | `{ requirementId }` | 按需求列出任务 |
| `task.get` | `{ id }` | 获取任务详情 |
| `message.list` | `{ taskId, phaseId }` | 获取阶段对话 |
| `workflow.start` | `{ repoTaskId }` | 启动工作流 |
| `workflow.confirm` | `{ repoTaskId }` | 确认当前阶段 |
| `workflow.feedback` | `{ repoTaskId, feedback }` | 提交修改意见 |
| `workflow.triggerEvent` | `{ repoTaskId, eventId }` | 触发外部事件 |
| `workflow.cancel` | `{ repoTaskId }` | 取消当前 Agent |

## 添加新的工作流阶段

1. 在 `workflow.yaml` 的某个 stage 的 `phases` 下添加阶段定义
2. 创建对应的 `skills/{phase-id}.md` 文件
3. 阶段需要 MCP 时，在数据库绑定或 phase 的 `mcp_servers` 里声明（engine 会 inline 注入 SDK，无需写 `mcp-configs/*.json`）

引擎会自动识别新阶段，无需修改代码。

## 接入新的 Agent 后端（Claude / Codex 等）

当前所有调用都走 `CursorSdkProvider`。后续接入其它官方 SDK 时：

1. 在 `packages/sidecar/src/providers/` 下新增 Provider 类，实现 `AgentProvider` 接口（`run` + `cancel`）
2. 在 `packages/sidecar/src/providers/factory.ts` 的 `createCursorSdkProvider` 旁新增 `createXxxProvider`，并扩展 `AgentProviderKind`
3. 调用方（`WorkflowEngine.resolveProvider` / `Orchestrator.resolveProviderForRole` / `review/llm.ts`）按 runtime 选择对应工厂

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 单会话 + advance-phase 工具 | 全流程同一 agent 会话，工具信号驱动推进 | 保留跨阶段上下文，去掉文本信号协议 |
| 统一走 @cursor/sdk | 移除自写 CLI spawn 与 Anthropic 直调 | 收敛后端、复用 SDK 的会话/流式/错误处理 |
| YAML + Skill 分离 | 骨架与肉分开 | 调度逻辑确定性，Agent 指令灵活可调 |
| git worktree 隔离 | 同仓库多任务并行 | 避免分支切换冲突 |
| JSON-RPC over stdio | 前后端通信 | 简单可靠，与 Tauri sidecar 模式匹配 |
| SQLite | 本地数据存储 | 桌面应用无需外部数据库 |
