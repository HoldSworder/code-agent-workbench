# Codex 交叉 Review（代码开发阶段）

使用 gstack `/review` 对当前分支的代码变更进行独立的交叉审查，提供第二视角的代码质量把关。

## 审查对象

- 当前分支相对于 base 分支的全部代码变更（git diff）
- 关联的 `{{openspec_path}}/tasks.md` 作为需求对照

## 执行步骤

### 1. 运行 gstack review

在工作区根目录下执行 gstack pre-landing review：

```
/review
```

该指令会自动完成：
- 检测 base 分支并获取完整 diff
- Scope Drift Detection（对照 tasks.md 检查实现是否偏离需求）
- Pass 1 CRITICAL 审查：SQL 安全、竞态条件、LLM 信任边界、枚举完整性
- Pass 2 INFORMATIONAL 审查：条件副作用、魔法值、死代码、测试覆盖
- 测试覆盖分析图（Code Path Coverage + User Flow Coverage）
- Fix-First 处理：AUTO-FIX 项直接修复，ASK 项等待确认

### 2. 审查报告确认

1. 检查是否存在 CRITICAL 级别问题
2. 对 ASK 类问题逐条确认修复或跳过
3. 确认 AUTO-FIX 已应用的变更无副作用

### 3. 输出格式

| 维度 | 状态 | 备注 |
|------|------|------|
| Scope Drift | CLEAN / DRIFT | 是否偏离原始需求 |
| Critical Issues | 数量 | 已修复 / 待确认 |
| Informational Issues | 数量 | 已修复 / 待确认 |
| Test Coverage | 百分比 | 覆盖路径数 / 总路径数 |

---

## 护栏

- 不得跳过 review 的任何检查步骤
- CRITICAL 问题必须全部解决后方可通过此阶段
- AUTO-FIX 修复后须重新运行验证确保无回归
