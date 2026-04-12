# Code Agent

AI 驱动的前端研发全生命周期编排平台。

开发者创建需求后，系统通过 YAML 声明式工作流自动编排 AI Agent，依次完成设计探索、任务规划、TDD 编码、交叉审查、E2E 测试到归档部署的全流程。关键节点由人工审批把关，将重复性编码工作缩短 80%。

## 功能总览

### 需求管理看板

Kanban 风格的需求全生命周期管理，是使用 Code Agent 的第一入口。支持从飞书文档一键导入需求（通过 MCP 自动抓取），也可手动创建。每条需求下挂多个仓库任务，看板卡片实时显示工作流阶段进度。

适用场景：前端负责人接到迭代需求，在看板中统一管理优先级和进度，不必在 IM、文档和本地分支之间来回切换。

### 仓库页 — 任务管理 + 内置终端 + 会话查询

按仓库维度管理任务和 Agent 会话，左右双栏 + 底部终端面板三区布局：

- **左栏**：流水线任务列表，展示当前 Stage/Phase 和状态，支持批量操作
- **右栏**：Agent 会话查询，分页浏览历史 Transcript，支持 Cursor / Claude Code / Codex 三种格式，一键恢复到终端
- **底部**：多标签 PTY 终端，直接启动 AI Agent 并实时查看输出

适用场景：开发者在同一屏对比「Agent 实际跑了什么」与本地改动，终端、任务、会话证据集中管理，方便联调和交接。

### 任务详情与人机交互

单任务深度监控和交互页面。Stage/Phase 进度条可视化展示流水线状态，三 Tab 切换对话历史、文件变更和会话记录。

支持的人机交互操作：
- **确认推进**：审阅 Agent 输出后放行到下一阶段
- **反馈补充**：向 Agent 追加指令或修正方向
- **挂起等待**：暂停流水线等待外部依赖
- **回滚重试**：Phase 失败时回退到上一个干净提交并重新执行

适用场景：工作流跑到 Spec 审查等需人审的节点时，开发者在聊天时间线中审阅输出，对照门禁规则选择操作，关键决策由人把关。

### YAML 声明式工作流引擎 + 可视化编辑器

核心调度层，通过 `workflow.yaml` 定义 Stage → Phase 两级编排模型。内置两套工作流模板：

- **dev-workflow**：正规 Spec-Driven 研发流程，4 个 Stage、20 个 Phase，覆盖 planning → development → testing → release 全周期
- **vibecoding**：轻量快速编码，跳过 Spec 落盘直接进入开发，适合简单需求

每个 Phase 可声明 Provider 选择、Skill 注入、门禁条件、护栏约束、确认要求、循环执行等。同时提供可视化编辑器，横向 Stage 列 + Phase 卡片 + 详情面板，所见即所得配置工作流。

适用场景：团队将研发规范固化进 YAML，新同学拉仓库即复用同一套流水线；改顺序或加阶段在可视化编辑器中操作，无需手改脚本。

### 多 Agent Provider 统一抽象

`AgentProvider` 接口统一三种后端，切换 Provider 只需改一行 YAML：

| Provider | 说明 |
|----------|------|
| `api` | Anthropic SDK 直调，精确控制 token、工具和系统提示 |
| `external-cli` | Cursor CLI / Claude Code CLI / Codex CLI，完整 Agent 能力 |
| `script` | Shell 脚本，用于确定性操作（git branch、openspec validate） |

适用场景：同一工作流中不同阶段使用不同 Agent。比如 Spec 创建用 API 直调，TDD 开发用 Cursor CLI，交叉审查用 Codex，灵活切换且不改编排逻辑。

### Leader-Worker 多 Agent 编排器

对复杂需求，Leader Agent 自动分析并拆分为多个子任务，各 Worker 在独立 git worktree 中并行执行。通过 `team.yaml` 定义虚拟团队角色（Leader、前端开发、后端开发等），支持自定义 Provider 和 Prompt。编排事件和状态全程可追踪，支持取消、拒绝（含反馈）和重试。

适用场景：一条需求涉及多个模块或多仓库时，让 Leader 自动拆活，Worker 并行执行，减少人工拆 Story 的时间。

### Skill 生态系统

20+ 内置 Skill 覆盖研发全生命周期（Spec 编写、TDD 开发、交叉审查、E2E 测试等），以 Markdown 文件定义 Agent 行为指令。支持：

- **本地 Skill 管理**：跨环境（Claude Code / Codex / Cursor）统一扫描、启用/禁用
- **远程 Skill 商店**：一键安装社区 Skill
- **Phase 级精确注入**：工作流中按阶段指定 Skill，Agent 只看到当前阶段需要的指令

适用场景：编码规范、TDD 模式、验收清单等沉淀为可复用资产，新人跑同一工作流即继承同一套行为约束。

### MCP Server 管理

MCP（Model Context Protocol）Server 的全生命周期管理 + Phase 级动态绑定。支持 stdio / HTTP / SSE 三种传输方式，在工作流中将 MCP 绑定到具体的 Stage + Phase，执行前动态注入、执行后自动清除。

适用场景：前端某阶段需要接入「读飞书设计文档」等 MCP 工具，在 MCP 页添加配置并绑定到对应阶段，引擎自动注入。从「每人改一遍 mcp.json」升级为平台集中管理。

### 只读咨询服务（Consult）

一键启动局域网 Web 服务，团队成员通过浏览器安全咨询代码库，零安装、强制只读。后端注入只读护栏，CLI 使用 suggest 审批模式，确保 Agent 只能读代码给意见而不会改动仓库。

适用场景：Code Review 时，Reviewer 开好 Consult 服务，同事用手机或另一台电脑打开咨询页提问「这段逻辑合理吗」，比共享主终端更安全。

### 数据持久化

SQLite + WAL 模式，12 张核心表持久化所有需求、任务、对话消息、Agent 运行记录、阶段提交锚点、MCP 配置与绑定、编排 Run/Assignment 等。桌面应用重启后恢复完整任务状态与历史，无需自建后端即可离线/内网使用。

## 快速开始

### 前置条件

- Node.js >= 20
- pnpm >= 8
- Rust toolchain（Tauri 编译需要）
- 至少安装一种 AI Agent CLI：Cursor CLI / Claude Code / Codex

### 安装与运行

```bash
pnpm install

# 前端开发服务器（浏览器模式，含 mock 数据）
pnpm dev

# 完整 Tauri 桌面应用
pnpm dev:tauri

# 构建
pnpm build
```

## License

Private
