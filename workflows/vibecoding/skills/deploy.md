# 发布

推送当前分支并创建 Merge Request，完成发布前代码侧闭环。

## 输入

- 代码 Review 通过
- 当前分支已包含待合并的实现与测试变更

## 输出

- 远程分支推送结果
- MR 链接（或手动创建 MR 的说明）

---

## 步骤 1：提交未暂存的变更

检查是否有未提交的变更：

```bash
git status --short
```

若有未提交变更，遵循开发（`dev.md`）的 Git Commit 流程提交。

---

## 步骤 2：推送分支

```bash
git push -u origin "$(git branch --show-current)"
```

---

## 步骤 3：创建 MR

优先使用 `glab` CLI：

```bash
glab mr create \
  --source-branch "$(git branch --show-current)" \
  --target-branch develop \
  --title "$(git branch --show-current)" \
  --fill
```

若 `glab` 不可用，输出手动创建 MR 所需信息：

- Source branch
- Target branch
- 建议的 MR 标题

### 确认结果

输出 MR 的 URL，或手动操作指引。

---

## 护栏

- 推送前确认当前分支不是 `main` 或 `master`（除非流程明确允许）
- 目标分支默认为 `develop`，除非上下文另有指定
- 不得执行 `--force` 推送
