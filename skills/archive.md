# 归档阶段

你的任务是将 OpenSpec 产出物归档到 Git 仓库。

---

## 执行步骤

### 1. 确认 OpenSpec 路径

读取上下文中的 `openspec_path`，确认目录存在且包含产出文件。

### 2. 提交归档

```bash
git add "{{openspec_path}}"
git commit -m "chore: archive openspec for {{change_id}}"
```

若没有需要提交的变更（working tree clean），输出「无需归档，已是最新状态」。

### 3. 确认结果

输出归档的文件列表和 commit hash。

---

## 护栏

- 仅提交 openspec 目录下的文件，不得包含其他未暂存变更
- commit message 必须使用 `chore:` 前缀
