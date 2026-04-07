# 创建分支

基于最新的主干分支（master/main）创建 feature 分支，确保后续开发在隔离的分支上进行。

---

## 输入

- 分支名：`{{branch_name}}`
- 工作目录：`{{repo_path}}`

---

## 执行步骤

### Step 1: 检查当前分支

```bash
git branch --show-current
```

如果当前已在 `{{branch_name}}` 分支上，跳过后续步骤，直接报告完成。

### Step 2: 检测主干分支名称

依次检查远程是否存在 `master` 或 `main` 分支：

```bash
git remote show origin | grep "HEAD branch"
```

以实际检测结果确定主干分支名（下文以 `$BASE` 指代）。如果无法检测，默认使用 `master`。

### Step 3: 切换到主干分支

```bash
git checkout $BASE
```

### Step 4: 拉取最新代码

```bash
git pull origin $BASE
```

### Step 5: 创建 feature 分支

```bash
git checkout -b {{branch_name}}
```

### Step 6: 确认结果

```bash
git branch --show-current
```

验证当前分支已切换为 `{{branch_name}}`。

---

## 输出

- 当前工作目录已切换到 `{{branch_name}}` 分支
- 分支基于远程主干分支的最新提交创建

---

## 异常处理

- 如果 `{{branch_name}}` 分支已存在于本地：切换到该分支并从主干 rebase 最新代码
- 如果网络不可用导致 pull 失败：基于本地主干分支的最新提交创建分支，并向用户报告网络异常

---

## 护栏

- **禁止** 修改任何业务代码，本阶段仅执行 Git 操作
- **禁止** 在工作目录有未提交变更时执行（由 `working_tree_clean` 入口门禁保障）
- **禁止** 强制推送（`--force`）或执行破坏性 Git 操作
