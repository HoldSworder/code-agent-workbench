# gate-status

查询 workflow.yaml 中定义的 gate 条件的实时满足状态。Agent 在执行过程中可以调用此工具了解门禁是否满足。

## 注入条件

始终注入。

## 依赖

- Node.js

## 命令

| 命令 | 说明 |
|------|------|
| `check <gate_name>` | 检查指定 gate 的详细状态 |
| `list` | 列出所有 gate 及其通过状态 |

## 用法

```bash
node run.mjs --dir <worktree_path> --openspec <openspec_path> --gates <base64_json> <command> [args]
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--dir` | 是 | 工作目录（worktree）路径 |
| `--openspec` | 否 | openspec 目录路径，用于模板变量替换 |
| `--gates` | 是 | gate 定义的 JSON（base64 编码） |

## 输出格式

### `check <gate_name>`

```json
{
  "gate": "design_approved",
  "passed": true,
  "checks": [
    { "type": "exists", "path": "/path/to/file", "passed": true },
    { "type": "file_contains", "path": "/path/to/file", "pattern": "approved", "passed": true }
  ]
}
```

### `list`

```json
{
  "gates": [
    { "name": "design_approved", "description": "设计方案已审批", "passed": true },
    { "name": "code_complete", "description": "代码实现完成", "passed": false }
  ]
}
```

## 门禁检查类型

| 类型 | 说明 |
|------|------|
| `exists` | 文件存在 |
| `not_exists` | 文件不存在 |
| `file_contains` | 文件内容包含指定字串 |
| `file_not_contains` | 文件内容不包含指定字串 |
| `file_section_matches` | 文件中 `after` 标记之后的内容匹配正则 |
| `file_section_not_matches` | 同上取反 |
| `command_succeeds` | 在 worktree 目录下执行命令，exit 0 为通过 |
