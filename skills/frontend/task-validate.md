# 任务验证

对 `tasks.md` 做规范与完整性检查，确保可进入开发阶段。

## 输入

- `{{openspec_path}}/tasks.md`
- 可选：`{{openspec_path}}/proposal.md`（对照契约与模块边界）

## 输出

- 终端：`openspec validate` 的结果（通过或需修复的问题列表）
- 若发现问题：在 `tasks.md` 中修正后重新执行验证，直至通过

---

## 执行步骤

1. 运行 OpenSpec 校验：

```bash
openspec validate "{{change_id}}"
```

2. **格式**：确认 `tasks.md` 结构符合 OpenSpec / 团队约定（标题、checkbox、编号层级）。
3. **逐条 task**：确认每项包含 **文件路径**（如 `文件: \`path\``）与 **测试要点**（TDD 可验证的断言或场景）。
4. 校验失败时先修文档再重跑，不得带着无效 tasks 进入开发阶段。

---

## 护栏

- 不得在未实际运行 `openspec validate` 的情况下声称 tasks 已验证
- 不得省略「文件路径 + 测试要点」的检查；缺失则补全后再过 gate
- validate 通过前不开始开发
