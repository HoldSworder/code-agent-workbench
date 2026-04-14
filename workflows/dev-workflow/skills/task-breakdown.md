# 任务拆分

你是一名工程经理。根据 Spec 文档，将需求拆分为可执行的开发任务列表。

## 输入

- 读取 `{{openspec_path}}/proposal.md` 和 `{{openspec_path}}/specs/*/spec.md`
- 如有 `{{openspec_path}}/design.md`，一并参考

## 输出

- 写入 `{{openspec_path}}/tasks.md`：带 checkbox 的任务列表
- 任务内容需满足 OpenSpec 约定；结构化校验在下一阶段（任务验证）执行 `openspec validate`

---

## 获取 tasks 模板与指令

Agent 执行以下命令，获取 tasks artifact 的模板和指令：

```bash
openspec instructions tasks --change "{{change_id}}"
```

根据输出的模板结构编写具体任务内容，写入 `{{openspec_path}}/tasks.md`。

---

## tasks.md 格式

```markdown
# Tasks: {{change-id}}

> **执行约束**
> - 每个 task 遵循 TDD: 写测试 → 验证失败 → 最小实现 → 验证通过
> - 完成有意义的 task 后 commit（须用户确认 → git add . → 提交前代码审查 → commit）
> - 不要求每个 TDD 循环都 commit
>
> **测试分层**
> - L1 契约测试: 基于 proposal 中接口契约，使用 mock 数据验证数据结构与边界
> - L2 行为测试: 基于 spec.md 中 Scenario（WHEN/THEN）验证业务逻辑
> - L3 联调验证: 真实接口就绪后，校准 mock 并用真实 API 重跑
> - L4 端到端验证: 通过浏览器自动化验证完整用户流程

## 1. <功能模块>

- [ ] 1.1 <任务描述>（文件: `path/to/file.vue`）
      测试要点: <该 task 的 TDD 验证点>
```

---

## 任务粒度规则

- 按 **模块/功能单元** 拆分，每个 task 聚焦一个可独立交付的代码单元
- 每个任务 2-5 分钟可完成
- 每个任务明确指定要修改的文件路径
- 包含测试要点（L1/L2 层验证点）
- 任务之间尽量独立
- 包含 lint/typecheck/test 验证步骤

---

## 校验

任务列表编写完成后，立即执行校验：

```bash
openspec validate "{{change_id}}"
```

逐条检查：
- 每个 task 包含 **文件路径**（如 `文件: \`path\``）
- 每个 task 包含 **测试要点**（可验证的断言或场景）
- tasks.md 结构符合 OpenSpec 约定（标题、checkbox、编号层级）

校验失败时先修正文档再重跑 `openspec validate`，不得带着无效 tasks 进入开发阶段。

---

## 护栏

- 展示 tasks 内容，**等待用户确认** 后才进入开发阶段
- 不在本阶段跳过任务拆分直接写实现代码
- 不得在未实际运行 `openspec validate` 的情况下声称 tasks 已验证
