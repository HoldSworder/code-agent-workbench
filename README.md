# Code Agent

将前端开发全生命周期编排为 YAML 驱动的多阶段 Agent 流水线的桌面应用。

用户创建需求后，系统自动创建 feature 分支并依次执行 **设计 → 规划 → 编码 → 审查 → 验证 → MR** 各阶段。每个阶段由独立的 Agent 执行，用户在关键节点审批确认。

## 核心特性

- **YAML 定义工作流** — 阶段顺序、确认门控、Provider 选择、MCP 配置均在 `workflow.yaml` 中声明
- **三种 Agent Provider** — LLM API 直调 / 外部 CLI（Claude Code、Cursor、Codex） / Shell 脚本
- **多仓库管理** — 一个需求可分发到多个仓库，通过 git worktree 隔离并行执行
- **文件系统即状态** — 跨阶段状态通过 OpenSpec 文件传递，每个 Agent 无状态启动
- **事件驱动** — T1 开发完成后可响应外部事件（后端 Spec、测试 Spec、E2E 验证）

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面壳 | Tauri 2.x |
| 前端 | Vue 3 + TypeScript + Pinia + Vue Router + UnoCSS |
| 后端 | Node.js Sidecar（stdio JSON-RPC） |
| 数据库 | SQLite（better-sqlite3） |
| AI | Anthropic SDK / Claude Code CLI / Cursor CLI / Codex |

## 快速开始

### 前置条件

- Node.js >= 20
- pnpm
- Rust toolchain（Tauri 编译需要）

### 安装

```bash
pnpm install
```

### 开发

```bash
# 启动前端开发服务器（浏览器模式，含 mock 数据）
pnpm dev

# 启动 sidecar 开发模式（独立运行）
pnpm dev:sidecar

# 启动完整 Tauri 桌面应用
cd apps/desktop && pnpm tauri dev
```

### 测试

```bash
pnpm test
```

### 构建

```bash
pnpm build
```

## 项目结构

```
code-agent/
├── apps/desktop/              # Tauri + Vue 前端
│   ├── src/
│   │   ├── views/             # 页面（Dashboard / RepoView / TaskDetail / Settings）
│   │   ├── stores/            # Pinia stores（repos / requirements / tasks）
│   │   └── composables/       # Sidecar RPC 客户端
│   └── src-tauri/             # Tauri Rust 配置
├── packages/sidecar/          # Node.js Sidecar
│   ├── src/
│   │   ├── db/                # SQLite schema + 5 个 Repository
│   │   ├── workflow/          # YAML Parser + WorkflowEngine 状态机
│   │   ├── providers/         # AgentProvider（API / CLI / Script）
│   │   ├── rpc/               # JSON-RPC Server
│   │   └── git/               # Git worktree 操作
│   └── __tests__/             # Vitest 测试
├── workflow.yaml              # 默认工作流配置
├── skills/                    # 各阶段 Agent 指令（Markdown）
├── mcp-configs/               # 各阶段 MCP Server 配置
└── scripts/                   # 确定性 Shell 脚本
```

## 工作流配置

默认工作流定义在 `workflow.yaml`，包含 6 个顺序阶段和 4 个事件驱动阶段：

```
设计探索 → 任务规划 → T1 开发 → 代码审查 → 验证 → 创建 MR
                              ↓ (T1 完成后等待事件)
                     后端 Spec → 联调
                     测试 Spec → 补充
                     E2E 验证 → 报告
                     归档
```

每个阶段可配置：
- `provider` — 使用哪种 Agent（`api` / `external-cli` / `script`）
- `requires_confirm` — 是否需要用户确认后推进
- `skill` — Agent 执行指令文件路径
- `mcp_config` — MCP Server 配置文件路径
- `tools` — API Provider 可用的工具列表

## License

Private
