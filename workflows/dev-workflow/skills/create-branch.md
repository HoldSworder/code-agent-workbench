# 创建分支与 worktree

为当前任务在**主仓库根目录**创建一个隔离的 git worktree，并基于默认分支建立 feature 分支。
分支命名规范对齐团队公共 skill `create-feature-branch`：`feat/<迭代>-<任务名称>-m-<ID>`。

> 本 phase 的工作目录（cwd）由 engine 设为主仓库根目录 `{{repo_path}}`，而非任务的 worktree 路径。
> worktree 由本 phase 创建后，engine 会自动扫描 `git worktree list` 把真实的分支名与 worktree 路径回写到 `repo_tasks`，后续 phase 才会切到该 worktree。
> **不要** `git push`：worktree 模型下，分支推送由后续 phase 自行决定时机；本 phase 只建本地。

---

## 输入

| 模板变量 | 说明 |
|---|---|
| `{{repo_path}}` | 主仓库根目录（等同于本 phase 的 cwd） |
| `{{requirement_title}}` | 需求标题（中文，prompt 顶部「## 需求」段也会附带） |
| `{{requirement_source_url}}` | 飞书项目工作项 URL，形如 `https://project.feishu.cn/<tenant>/<workItemType>/detail/<ID>` |
| `{{change_id}}` | sidecar 写入的**占位** changeId，仅作回滚锚点，**不要复用为最终分支名** |

## 输出

- 新增 worktree：`{{repo_path}}/.worktrees/<final-slug>/`
- 新增本地分支：`feat/<final-slug>`（基于 `origin/<默认分支>`）
- stdout 末尾输出一行机器可读摘要

---

## 步骤 1：环境校验

```bash
git rev-parse --show-toplevel       # 确认 cwd 是主仓库根
git status --porcelain               # 必须为空；非空立即停止，禁止 add/commit/stash
```

## 步骤 2：探测默认分支

```bash
git fetch origin
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true
```

若为空（旧仓库未设置 origin/HEAD）：

```bash
git remote set-head origin --auto
git symbolic-ref --short refs/remotes/origin/HEAD
```

把得到的 `origin/<base>` 记为 `BASE_REF`（如 `origin/master`、`origin/main`）。
**禁止**假设 base 一定是 `master` 或 `main`。

## 步骤 3：解析飞书工作项 ID

从 `{{requirement_source_url}}` 用正则 `/detail/(\d+)` 抓取第一个匹配作为 `WORK_ITEM_ID`。

- 当前 task 模型只支持单飞书链接，多链接请等后续扩展。
- 解析失败（URL 为空 / 不匹配）：跳到「降级路径」。

## 步骤 4：确定任务名称与迭代

需求信息已由 engine 通过飞书项目（meegle）预先拉取并注入到 prompt 顶部「## 需求」段，**直接取用，不要调用任何 MCP 工具**：

- `TASK_NAME` ← `{{requirement_title}}`（prompt 已提供的需求标题）
- `ITER` ← `unknown`（当前 prompt 不提供「规划迭代」信息，分支名走「无迭代」格式）

> 重要：本 phase **未注入任何 MCP**。早期通过 `lark-project` MCP 查询工作项的方式已彻底下线，需求名称改由 engine 直接注入。**严禁**尝试调用 `get_workitem_brief` 等 MCP 工具——会话里不存在该工具，调用会直接导致本次 run 失败。

`TASK_NAME` 为空（极少数情况）：置为 `unknown`，继续往下走，**不要**因此终止。

## 步骤 5：格式化分支名

对 `TASK_NAME` 做 sanitize：

- 保留 `[a-zA-Z0-9\u4e00-\u9fa5]`，移除空格、标点、emoji 等所有其它字符
- 结果记为 `NAME_SLUG`

组合：

- 默认：`BRANCH=feat/<ITER>-<NAME_SLUG>-m-<WORK_ITEM_ID>`
- 若 `ITER === 'unknown'`：`BRANCH=feat/<NAME_SLUG>-m-<WORK_ITEM_ID>`
- 总长度（含 `feat/`）截断到 ≤ 60 字符；若超长，优先截短 `NAME_SLUG`，**保留** `-m-<ID>` 尾段

`SLUG`（用于 worktree 目录名 + openspec 路径） = `BRANCH` 去掉 `feat/` 前缀。

### 降级路径（无飞书链接 / 解析失败）

回退到旧规则，但仍用 `feat/` 前缀以与引擎识别保持一致：

- 阅读 `{{requirement_title}}`，输出 3–6 个英文小写词的 kebab-case slug
- `BRANCH=feat/<kebab-slug>`
- 在 stdout 输出一条警告说明走的是降级路径

## 步骤 6：创建 worktree + 分支

```bash
git worktree add -b "${BRANCH}" ".worktrees/${SLUG}" "${BASE_REF}"
```

校验：

```bash
git worktree list --porcelain | grep -A2 ".worktrees/${SLUG}"
# 必须看到 worktree、HEAD、branch refs/heads/feat/${SLUG} 三行
ls -la ".worktrees/${SLUG}/.git"
# 是文件不是目录（git worktree 的标识）
```

## 步骤 7：输出结果

在 stdout 末尾输出一行机器可读摘要：

```
WORKTREE_CREATED branch=<BRANCH> path=.worktrees/<SLUG> base=<BASE_REF> work_item=<WORK_ITEM_ID|none>
```

---

## 护栏

- **禁止** `git push` / `git push -u origin`；worktree 模型下推送由后续 phase 决定
- **禁止**修改主仓库的工作区或 HEAD：不得 `git checkout`、`git switch`、`git reset`、`git stash`、`git add`、`git commit`
- **禁止**使用占位 `{{change_id}}` 作为最终 slug
- **禁止**在 base 检测失败时强行假设 master/main，必须先 `git remote set-head origin --auto`
- **禁止**用 `git checkout -b` 在主仓库创建分支；必须用 `git worktree add -b ... <base>` 一步完成
- **禁止**预创建 `.worktrees/<SLUG>` 目录；`git worktree add` 自己负责建目录
- **禁止**使用 `--force`；同名分支或 worktree 已存在时报错并提示用户处理
- **禁止**调用任何 MCP 工具（本 phase 未注入 MCP，`get_workitem_brief` 等不存在，调用会使 run 失败）
- 需求标题缺失：用 `unknown` 占位继续，**不要**终止 phase；无飞书链接：走降级路径
- 失败时输出明确错误并退出；engine 的 post-phase 钩子会检测到「没有新 worktree」并把任务标为失败
