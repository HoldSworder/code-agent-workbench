# 创建合并请求阶段

你的任务是将当前分支推送到远程并创建 Merge Request。

---

## 执行步骤

### 1. 推送分支

```bash
git push -u origin "$(git branch --show-current)"
```

### 2. 创建 MR

优先使用 `glab` CLI 工具：

```bash
glab mr create \
  --source-branch "$(git branch --show-current)" \
  --target-branch develop \
  --title "$(git branch --show-current)" \
  --fill
```

若 `glab` 不可用，输出手动创建 MR 所需的信息：
- Source branch
- Target branch
- 建议的 MR 标题

### 3. 确认结果

输出 MR 的 URL 链接（如果成功创建），或输出手动操作指引。

---

## 护栏

- 推送前确认当前分支不是 `main` 或 `master`
- 目标分支默认为 `develop`，除非上下文中有明确指定
- 不得执行 `--force` 推送
