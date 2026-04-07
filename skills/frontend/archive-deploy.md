# 归档与发布

将 OpenSpec 变更归档到 Git，推送当前分支并创建 Merge Request，完成发布前代码侧闭环。

## 输入

- `{{openspec_path}}` 与 `{{change_id}}`
- E2E 浏览器测试验收结论：**通过** 或 **用户明确同意带债**（见 `e2e-test.md` / `e2e-report.md`）
- 当前分支已包含待合并的实现与测试变更

## 输出

- `openspec archive` 执行结果（变更目录按 OpenSpec 规则归档）
- Git：`openspec` 相关路径的 `chore:` commit（若有变更）
- 远程分支推送与 MR 链接（或手动创建 MR 的说明）
- 归档文件列表、commit hash、MR URL（若成功）

---

## 步骤 1：OpenSpec 归档

在验收结论允许发布时执行：

```bash
openspec archive "{{change_id}}" --yes
```

执行后验证：

```bash
ls openspec/changes/{{change_id}}/ 2>/dev/null && echo "WARN: 目录仍存在" || echo "OK: 已归档"
```

若流程中已在其它步骤执行过 archive，以实际目录状态为准，避免重复破坏历史。

---

## 步骤 2：提交归档到 Git

### 确认路径

读取上下文中的 `openspec_path`，确认目录存在且包含预期产出。

### 提交（仅 openspec 相关变更时优先单独 commit）

```bash
git add "{{openspec_path}}"
git commit -m "chore: archive openspec for {{change_id}}"
```

若 working tree 中尚有未提交的实现代码，应按团队规范：**或与本次 MR 一并提交**，或 **先提交实现再提交归档**；不得遗漏应进入 MR 的变更。

若没有需要提交的变更，输出「无需归档 commit，已是最新状态」。

### 确认结果

输出归档涉及文件列表与 commit hash。

---

## 步骤 3：推送分支

```bash
git push -u origin "$(git branch --show-current)"
```

---

## 步骤 4：创建 MR

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

- 仅提交 openspec 目录的归档 commit 时，**不得误含无关未审变更**；若一并推送功能代码，须已通过代码 Review（`self-test.md`）与 E2E 浏览器测试（`e2e-test.md`）门禁
- `git commit` message 在纯归档步骤使用 `chore:` 前缀
- 推送前确认当前分支不是 `main` 或 `master`（除非流程明确允许）
- 目标分支默认为 `develop`，除非上下文另有指定
- 不得执行 `--force` 推送
- 验收未通过且用户未同意带债时，不得执行本阶段归档与 MR
