# 关联飞书工作项分支

将当前开发分支关联到飞书项目的对应工作项，便于跨系统追溯。

---

## 输入

- 分支名：`{{branch_name}}`
- 工作项链接：`{{task_url}}`

---

## 执行步骤

### Step 1: 从工作项链接解析出 `project_key` 与 `work_item_id`

飞书项目工作项 URL 通常形如：

```
https://project.feishu.cn/<project_key>/story/detail/<work_item_id>
https://project.feishu.cn/<project_key>/issue/detail/<work_item_id>
```

从 `{{task_url}}` 中提取 `project_key` 与 `work_item_id`。

### Step 2: 调用飞书项目 MCP 查询工作项

使用 `lark-project` MCP 的工作项查询能力，确认 `work_item_id` 存在且自己有编辑权限。

### Step 3: 将分支名写入工作项的「开发分支」字段

调用 `lark-project` MCP 的工作项更新能力，将 `{{branch_name}}` 追加到工作项的开发分支字段（若字段已存在其它分支，使用逗号分隔追加，避免覆盖）。

### Step 4: 在工作项下评论关联说明

调用 MCP 在工作项下添加评论：

```
已创建开发分支：{{branch_name}}
```

---

## 完成条件

- 工作项的开发分支字段包含 `{{branch_name}}`
- 工作项下存在关联评论

如任一步骤失败（MCP 不可用 / 权限不足 / URL 格式非法），终止执行并向用户报告失败原因，不要静默跳过。
