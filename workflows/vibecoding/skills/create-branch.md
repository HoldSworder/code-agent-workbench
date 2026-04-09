# 创建分支

基于最新的主干分支（master/main）创建 feature 分支，确保后续开发在隔离的分支上进行。

---

## 输入

- 工作目录：`{{repo_path}}`
- 需求标题 & 描述：见上方「需求」部分

---

## 分支命名规则（重要）

1. 将需求标题翻译为 **简洁的英文短语**（3-6 个单词）
2. 全部小写，单词之间用 `-` 连接，仅保留 `a-z`、`0-9`、`-`
3. 最终分支名格式：`feature/<english-slug>`

示例：
- 需求「书签卡片增加右键菜单」→ `feature/bookmark-card-context-menu`
- 需求「修复登录页白屏问题」→ `feature/fix-login-blank-screen`
- 需求「用户列表支持批量导出」→ `feature/user-list-batch-export`

---

## 执行步骤

### Step 1: 确定分支名

根据上述命名规则，将需求标题翻译为英文并生成分支名。

### Step 2: 检查当前分支

```bash
git branch --show-current
```

如果当前已在目标 feature 分支上，跳过后续步骤，直接报告完成。

### Step 3: 检测主干分支名称

```bash
git remote show origin | grep "HEAD branch"
```

以实际检测结果确定主干分支名（下文以 `$BASE` 指代）。如果无法检测，默认使用 `master`。

### Step 4: 切换到主干分支并拉取最新代码

```bash
git checkout $BASE
git pull origin $BASE
```

### Step 5: 创建 feature 分支

```bash
git checkout -b feature/<english-slug>
```

### Step 6: 确认结果

```bash
git branch --show-current
```

验证当前分支已切换到新创建的 feature 分支。

---

## 输出

- 当前工作目录已切换到 `feature/<english-slug>` 分支
- 分支基于远程主干分支的最新提交创建

---

## 异常处理

- 如果目标分支已存在于本地：切换到该分支并从主干 rebase 最新代码
- 如果网络不可用导致 pull 失败：基于本地主干分支的最新提交创建分支，并向用户报告网络异常

---

## 护栏

- **禁止** 修改任何业务代码，本阶段仅执行 Git 操作
- **禁止** 在工作目录有未提交变更时执行（由 `working_tree_clean` 入口门禁保障）
- **禁止** 强制推送（`--force`）或执行破坏性 Git 操作
