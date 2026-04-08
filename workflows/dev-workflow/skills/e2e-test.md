# E2E 浏览器测试

执行端到端验证，确保功能在真实浏览器环境中正常工作。

## 输入

- 变更目录 `{{openspec_path}}` 下的 spec：`qa-*.md`、`specs/*/spec.md`、`backend-*.md` 等
- 用户命令或事件：「跑 e2e」「浏览器验证」、测试 spec 到达后用户确认进入
- 可运行的前端应用（URL 由项目或用户指定）

## 输出

- 写入 `{{openspec_path}}/e2e-report.md`，必须包含 `## 验收结论`
- 验收结论驱动下一步：**通过** 或 **带债同意** → 可进入归档与发布（`archive-deploy.md`）；**不通过且未同意带债** → Bug 修复（`bug-fix.md`）修复后回到本阶段重跑

---

## 触发方式

| 入口 | 说明 |
|------|------|
| 用户主动命令 | 「跑 e2e」「浏览器验证」「跑一下 `<change-id>` 的 e2e」 |
| 测试 spec 到达后提示 | 拉取 `qa-*.md` 后，用户确认后进入 |
| 延迟模式 | 无活跃变更目录时，用户手动指定 spec 来源 |

---

## 调用 `fe-specflow:e2e-verify` 技能

**INVOKE SKILL: `fe-specflow:e2e-verify`**

Agent 必须直接调用 e2e-verify 技能，使用 **Cursor 内置浏览器**（`browser_*` 工具）执行完整验证流程：

### 步骤 1：定位验证依据

| 场景 | 处理 |
|------|------|
| 触发语含 change-id | 直接使用 |
| 仅 1 个变更目录 | 自动选定 |
| 多个变更目录 | 列出请用户选择 |
| 无变更目录（延迟触发） | 请用户指定 spec 来源 |

### 步骤 2：生成验证清单

综合阅读变更目录内的所有 spec，按置信度优先级：

| Spec 类型 | 置信度 | 说明 |
|-----------|--------|------|
| `qa-*.md`（测试 spec） | **最高** | 验收口径以此为准 |
| `specs/*/spec.md`（前端 spec） | 中 | 交叉核对 |
| `backend-*.md`（后端 spec） | 中 | 交叉核对 |

### 步骤 3：TDD / 静态验证（优先）

在浏览器自动化前，先跑通已有 TDD 测试并做静态对照。

**INVOKE SKILL: `superpowers:verification-before-completion`**

运行测试命令，确认结果后再进入浏览器验证。

### 步骤 4：用户确认后执行 Browser 自动化

使用 Cursor 内置浏览器（`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_fill` 等）逐场景执行。

### 步骤 5：输出验证报告

写入 `{{openspec_path}}/e2e-report.md`，必须包含 `## 验收结论`。

---

## 与归档与发布的衔接

| 验收结论 | 处理方式 |
|----------|----------|
| 通过 | 进入归档与发布（`archive-deploy.md`） |
| 不通过 + 用户同意带债 | 报告中记录后仍可进入归档与发布（`archive-deploy.md`）（需用户明确同意） |
| 不通过 + 未同意 | **不得** 进入归档发布；进入 Bug 修复（`bug-fix.md`） → 回到本阶段重跑 |

`openspec archive` 与 MR 推送统一在 `archive-deploy.md` 中执行，不在本阶段单独归档。

---

## 护栏

- 不得在未确认时自动执行浏览器自动化
- 使用 Cursor 内置浏览器（cursor-ide-browser），不用 chrome-devtools-mcp
- 验收结论是进入归档与发布（`archive-deploy.md`）的主要门禁之一
- **与测试 spec 冲突时，在报告中显著标明差异**
