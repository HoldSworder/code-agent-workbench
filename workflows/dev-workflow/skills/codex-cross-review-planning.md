# Codex 交叉 Review（规划阶段）

使用 gstack `/review` 对任务规划阶段的产出文档进行独立审查，以第二视角检验 Spec 与 Plan 的完整性和一致性。

## 审查对象

- `{{openspec_path}}/proposal.md` — 需求提案
- `{{openspec_path}}/specs/*/spec.md` — 各模块 Spec
- `{{openspec_path}}/tasks.md` — 任务拆分

## 审查维度

| 维度 | 检查内容 |
|------|----------|
| 需求覆盖 | proposal 中列出的所有功能点是否在 specs 中有对应描述 |
| 任务完整性 | tasks.md 中的任务项是否完整覆盖了 specs 定义的范围 |
| 边界与约束 | 是否明确了错误处理、边界情况、性能约束 |
| 可测试性 | 每个 task 是否包含可验证的断言或测试要点 |
| 一致性 | proposal / specs / tasks 三者之间是否存在矛盾或遗漏 |

## 执行步骤

### 1. 读取规划产出

读取 `{{openspec_path}}` 目录下的所有规划文档：

```bash
cat {{openspec_path}}/proposal.md
cat {{openspec_path}}/tasks.md
ls {{openspec_path}}/specs/
```

### 2. 执行审查

对照上述审查维度逐项检查，产出结构化审查报告。

### 3. 输出格式

| 维度 | 状态 | 发现 |
|------|------|------|
| 需求覆盖 | PASS / GAP | 具体缺失项 |
| 任务完整性 | PASS / GAP | 缺失的任务 |
| 边界与约束 | PASS / GAP | 未定义的边界 |
| 可测试性 | PASS / GAP | 缺少测试要点的 task |
| 一致性 | PASS / CONFLICT | 矛盾描述 |

---

## 护栏

- 不得跳过任何审查维度
- 发现 GAP 或 CONFLICT 时须给出具体修复建议
- 审查意见不得直接修改原文档，仅输出报告供人工确认
