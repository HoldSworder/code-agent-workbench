# Codex 交叉 Review（代码开发阶段）

作为独立 reviewer，对当前分支的代码变更进行交叉审查，提供第二视角的代码质量把关。

## 审查对象

- 当前分支相对于 base 分支的全部代码变更（git diff）
- 关联的 `{{openspec_path}}/tasks.md` 作为需求对照

## 执行步骤

### 1. 获取变更上下文

```bash
# 检测 base 分支（main 或 master）
BASE=$(git rev-parse --verify main 2>/dev/null || git rev-parse --verify master)
# 获取完整 diff
git diff "$BASE"...HEAD
# 查看变更文件列表
git diff "$BASE"...HEAD --stat
# 读取需求对照
cat {{openspec_path}}/tasks.md
```

### 2. Scope Drift 检测

对比 `tasks.md` 中定义的任务范围与实际代码变更：
- 是否存在 tasks.md 中未列出的额外变更（scope creep）
- 是否存在 tasks.md 中要求但未实现的内容（遗漏）

### 3. CRITICAL 审查（必须全部通过）

逐文件检查以下高危问题：

| 检查项 | 说明 |
|--------|------|
| 安全漏洞 | SQL 注入、XSS、敏感数据泄露、硬编码密钥 |
| 竞态条件 | 并发访问共享状态、缺少锁/原子操作 |
| 错误处理 | 未捕获的异常、静默吞掉错误、缺少边界校验 |
| 破坏性变更 | 不兼容的接口变更、删除公共 API |

### 4. INFORMATIONAL 审查

| 检查项 | 说明 |
|--------|------|
| 代码质量 | 魔法值、重复代码、过长函数、命名不一致 |
| 死代码 | 未使用的导入、注释掉的代码块、不可达分支 |
| 测试覆盖 | 新增逻辑是否有对应测试、边界用例是否覆盖 |
| 条件副作用 | 条件分支中是否隐含非显而易见的状态修改 |

### 5. 输出结构化报告

```
## Review Summary

| 维度 | 状态 | 备注 |
|------|------|------|
| Scope Drift | CLEAN / DRIFT | 是否偏离原始需求 |
| Critical Issues | 数量 | 逐条列出 |
| Informational Issues | 数量 | 逐条列出 |
| Test Coverage | 评估 | 新增代码的测试覆盖情况 |

## Critical Issues（如有）
- [ ] [文件:行号] 问题描述 → 建议修复方式

## Informational Issues（如有）
- [ ] [文件:行号] 问题描述 → 建议修复方式
```

---

## 护栏

- 不得跳过任何审查步骤
- CRITICAL 问题必须逐条列出，不得遗漏
- 不得直接修改源代码，仅输出报告
