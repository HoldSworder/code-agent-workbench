# 事件 B：测试 Spec 到达

根据测试团队提供的测试 Spec，补充和调整前端代码。

---

## 触发条件

- T1 开发完成（tasks.md 全部 `[x]`）
- 用户提供测试 Spec 链接或内容（"测试 spec 到了"、"QA 文档到了"等）

---

## 步骤 1：调用 `fe-specflow:pull-spec` 技能拉取测试 Spec

**INVOKE SKILL: `fe-specflow:pull-spec`**

Agent 必须直接调用 pull-spec 技能，执行以下操作：

### 若用户提供 GitLab URL

1. 检查 `GITLAB_TOKEN`：
   ```bash
   echo ${GITLAB_TOKEN:+ok}
   ```

2. 通过 GitLab API 拉取：
   ```bash
   curl -sf --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
     "https://{{gitlab_host}}/api/v4/projects/{{project_id}}/repository/files/{{file_path}}/raw?ref={{branch}}"
   ```

3. 写入 `{{openspec_path}}/qa-{{name}}.md`（自动注入 metadata 头部）

### 目录规范

前后端同一需求共用同一 `change-id`，在各自仓库内都落到 `openspec/changes/<change-id>/qa-*.md`。

### 写入后验证

```bash
ls {{openspec_path}}/qa-*.md
```

---

## 步骤 2：差异分析

对比前端已有 Scenario 与测试 spec 中的验收条件：

| 对比维度 | 说明 |
|----------|------|
| 场景覆盖 | 前端 spec 已覆盖 vs 测试 spec 新增的场景 |
| 边界情况 | 测试 spec 中标注但前端未处理的边界 |
| 验收标准 | 预期行为差异（前端 spec vs 测试 spec） |
| 盲区识别 | 前端未考虑到的测试维度 |

输出增量/盲区清单。

---

## 步骤 3：补充前端代码（如有差异）

- 根据差异分析补充缺失的边界情况处理
- 确保所有测试用例可通过

**INVOKE SKILL: `superpowers:verification-before-completion`**

补充代码后运行验证命令确认结果。

- 若需 Git Commit，遵循 T1 阶段的 Git Commit 流程

---

## 步骤 4：可选衔接 E2E

拉取并解析完 `qa-*.md` 后，可向用户提示是否立即进入 Browser 交叉验证。**仅当用户明确同意** 后才调用 `fe-specflow:e2e-verify` 技能。

---

## 护栏

- 测试 spec 与前端 spec 冲突时，**以测试 spec 为验收口径**
- 在报告中显著标明差异，不得一笔带过
