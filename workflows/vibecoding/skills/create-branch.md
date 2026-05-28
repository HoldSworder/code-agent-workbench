# 创建分支与 worktree

为当前任务在**主仓库根目录**创建一个隔离的 git worktree，并在其中建立基于默认分支（master/main）的 feature 分支。

> 本 phase 的工作目录（cwd）由 engine 设为主仓库根目录 `{{repo_path}}`，而非任务的 worktree 路径。worktree 由本 phase 创建后，engine 会自动扫描 `git worktree list` 把真实的分支名与 worktree 路径回写到 `repo_tasks`，后续 phase 才会切到该 worktree。

---

## 输入

| 模板变量 | 说明 |
|---|---|
| `{{repo_path}}` | 主仓库根目录（等同于本 phase 的 cwd） |
| `{{requirement_title}}` | 需求标题（可能为中文） |
| `{{requirement_description}}` | 需求描述（可能为中文） |
| `{{change_id}}` | sidecar 写入的**占位** changeId，仅作回滚锚点，**不要复用为最终分支名** |

## 输出

- 新增 worktree：`{{repo_path}}/.worktrees/<final-slug>/`
- 新增本地分支：`feature/<final-slug>`（基于 `origin/<默认分支>`）
- stdout 最后一行包含可识别的结果摘要，便于人工/日志查阅

---

## 步骤 1：环境校验

```bash
# 1. 确认 cwd 就是主仓库根目录
git rev-parse --show-toplevel

# 2. working tree 必须干净
git status --porcelain
# 输出非空 → 立即停止并向用户报告。本 phase 禁止 git add / git commit / git stash 来"掩盖"未提交变更。
```

## 步骤 2：探测默认分支

```bash
# 优先用 origin/HEAD 锁定的默认分支
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true
# 输出形如 origin/master 或 origin/main
```

若上面命令为空（旧仓库未设置 origin/HEAD）：

```bash
git remote set-head origin --auto
git symbolic-ref --short refs/remotes/origin/HEAD
```

把得到的 `origin/<base>` 记为 `BASE_REF`（如 `origin/master`）。**禁止**假设 base 一定是 `master` 或 `main`。

## 步骤 3：生成语义化英文 slug

阅读 `{{requirement_title}}` 与 `{{requirement_description}}`，输出 **kebab-case 英文 slug**：

- 3-6 个小写英文单词，用 `-` 连接（例如 `add-user-login`、`refactor-feishu-sync`）
- 仅含 `[a-z0-9-]`，不含下划线/空格/中文/标点
- 不带 `feature/` 前缀
- 表达"动作 + 对象"（动词 + 名词组合优先）
- 总长度 ≤ 60 字符

把最终 slug 记为 `SLUG`。**严禁**直接复用占位的 `{{change_id}}`，那只是回滚锚点。

## 步骤 4：创建 worktree + 分支

```bash
git worktree add -b "feature/${SLUG}" ".worktrees/${SLUG}" "${BASE_REF}"
```

执行后立即校验：

```bash
git worktree list --porcelain | grep -A2 ".worktrees/${SLUG}"
# 必须看到 worktree、HEAD、branch refs/heads/feature/${SLUG} 三行
ls -la ".worktrees/${SLUG}/.git"
# 是文件不是目录（git worktree 的标识）
```

## 步骤 5：输出结果

在 stdout 末尾输出一行机器可读摘要（用于日志检索；engine 不依赖该格式，仅扫 `git worktree list` 作为权威信息源）：

```
WORKTREE_CREATED branch=feature/<SLUG> path=.worktrees/<SLUG> base=<BASE_REF>
```

---

## 护栏

- **禁止**修改主仓库的工作区或 HEAD：不得 `git checkout`、`git switch`、`git reset`、`git stash`、`git add`、`git commit`
- **禁止**使用占位 `{{change_id}}` 作为最终 slug；必须基于需求标题语义化生成
- **禁止**在 base 检测失败时强行假设 master/main，必须先 `git remote set-head origin --auto`
- **禁止**用 `git checkout -b` 在主仓库创建分支；必须用 `git worktree add -b ... <base>` 一步完成
- **禁止**预创建 `.worktrees/<SLUG>` 目录；`git worktree add` 自己负责建目录
- 同名分支或 worktree 已存在 → 报错并提示用户调 `task.delete` 或换 slug；不得 `--force`
- 失败时输出明确错误并退出，engine 的 post-phase 钩子会检测到"没有新 worktree"并把任务标为失败
