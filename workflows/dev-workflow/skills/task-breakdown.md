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
> - L1 契约测试: 基于 proposal 中 API 契约，使用 mock 数据
> - L2 行为测试: 基于 spec.md 中 Scenario（WHEN/THEN）
> - L3 联调验证: 后端 spec 到达 → 校准 mock；联调 → 真实 API 重跑
> - L4 交叉验证: 测试 spec 到达 → Browser Agent 自动化（e2e-verify）

## 1. <功能模块>

- [ ] 1.1 <任务描述>（文件: `path/to/file.vue`）
      测试要点: <该 task 的 TDD 验证点>
```

---

## 任务粒度规则

- 按 **组件/页面/功能模块** 拆分，每个 task 聚焦一个前端交付物（组件、hook、store、页面等）
- 每个任务 2-5 分钟可完成
- 每个任务明确指定要修改的文件路径
- 包含测试要点（L1/L2 层验证点）
- 任务之间尽量独立
- 包含 lint/typecheck/test 验证步骤

---

## 护栏

- 展示 tasks 内容，**等待用户确认** 后才进入开发阶段
- 不在本阶段跳过任务拆分直接写实现代码
