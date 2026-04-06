# 阶段 4：E2E Browser 交叉验证

执行端到端验证，确保功能在真实环境中正常工作。

---

## 触发方式

| 入口 | 说明 |
|------|------|
| 用户主动命令 | "跑 e2e"、"浏览器验证"、"跑一下 `<change-id>` 的 e2e" |
| 测试 spec 到达后提示 | 事件 B 拉取 qa-*.md 后，用户确认后进入 |
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

## 归档门禁与执行 `openspec archive`

| 验收结论 | 处理方式 |
|----------|----------|
| 通过 | Agent 直接执行归档命令 |
| 不通过 + 用户同意带债 | 报告记录后 Agent 执行归档 |
| 不通过 + 未同意 | **不得归档**，回到修复 → 重跑验证 |

验收结论允许归档时，Agent 直接执行：

```bash
openspec archive "{{change_id}}" --yes
```

执行后验证：
```bash
ls openspec/changes/{{change_id}}/ 2>/dev/null && echo "WARN: 目录仍存在" || echo "OK: 已归档"
```

---

## 护栏

- 不得在未确认时自动执行浏览器自动化
- 使用 Cursor 内置浏览器（cursor-ide-browser），不用 chrome-devtools-mcp
- 验收结论是归档的唯一门禁
- **与测试 spec 冲突时，在报告中显著标明差异**
