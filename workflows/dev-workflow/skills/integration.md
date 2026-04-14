# 联调

你是一名开发工程师，负责接口联调。

## 输入

- 开发（`tdd-dev.md`）完成：`tasks.md` 全部为 `[x]`
- 用户提供后端 Spec 链接或内容（「后端 spec 到了」「API 文档到了」等）
- 现有 `proposal.md`、前端实现与测试

## 输出

- `{{openspec_path}}/backend-*.md`（或用户粘贴的 spec 落盘）
- API 差异报告（字段、类型、枚举、错误码、分页等）
- 代码侧：Mock → 真实 API，类型与边界与实际接口一致
- 全量 TDD 重跑通过后的可提交变更（遵循外部规则中注入的 Git Commit 流程）

---

## 步骤 1：拉取后端 Spec

**INVOKE SKILL: `fe-specflow:pull-spec`**

### 若用户提供 GitLab URL

1. 检查 `GITLAB_TOKEN` 环境变量：

   ```bash
   echo ${GITLAB_TOKEN:+ok}
   ```

2. 通过 GitLab API 拉取文件内容：

   ```bash
   curl -sf --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
     "https://{{gitlab_host}}/api/v4/projects/{{project_id}}/repository/files/{{file_path}}/raw?ref={{branch}}"
   ```

3. 写入 `{{openspec_path}}/backend-{{name}}.md`（自动注入 metadata 头部）

### 若 GITLAB_TOKEN 不可用

提示用户粘贴 spec 内容，Agent 直接写入文件。

### 写入后验证

```bash
ls {{openspec_path}}/backend-*.md
```

---

## 步骤 2：对比 API 契约

- 对比 `proposal.md` 中定义的接口契约与后端 spec 实际接口
- 输出差异报告：字段名/类型不匹配、缺失字段、枚举值差异、错误码差异、分页参数差异

---

## 步骤 3：切换 Mock → 真实 API

- 切换 mock 数据为真实 API 调用
- 处理接口差异和边界情况
- 更新类型定义以匹配实际返回

---

## 步骤 4：全量重跑 TDD

**INVOKE SKILL: `superpowers:test-driven-development`**

- 重跑 **L1 契约测试 + L2 行为测试**
- 根据实际返回校准 mock 数据
- 修复不通过的测试

---

## 步骤 5：调用 `superpowers:verification-before-completion` 验证

**INVOKE SKILL: `superpowers:verification-before-completion`**

联调完成后，运行全部验证命令确认结果，然后才能声称联调完成。

---

## 步骤 6：Git Commit

联调修复完成后，遵循外部规则中注入的 Git Commit 流程。

---

## 护栏

- 不在对比完成前直接替换代码
- 差异过大时先与用户确认处理方案
- 不在未跑验证的情况下声称联调完成
