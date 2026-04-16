# task-checklist

管理 tasks.md 文件中的任务 checkbox 状态（勾选/取消勾选），并查询进度统计。

## 注入条件

始终注入。

## 依赖

- Node.js

## 命令

| 命令 | 说明 |
|------|------|
| `list` | 返回所有任务的 id/标题/状态及进度统计 |
| `check <id\|line>` | 将指定任务标记为完成 |
| `uncheck <id\|line>` | 将指定任务标记为未完成 |
| `progress` | 仅返回进度统计 |

## 用法

```bash
node run.mjs --file <tasks_md_path> <command> [target]
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--file` | 是 | tasks.md 文件的绝对路径 |

## Target 格式

| 格式 | 说明 |
|------|------|
| `T1`, `T2` | 从任务内容中提取的 id（匹配 `T\d+:` 或 `任务\d+:`） |
| `L3`, `3` | 按行号定位 |

## 输出示例

### list

```json
{ "total": 8, "completed": 3, "pending": 5, "tasks": [{ "line": 3, "id": "T1", "title": "实现用户登录", "checked": true }] }
```

### check / uncheck

```json
{ "ok": true, "task": { "line": 3, "id": "T1", "title": "...", "checked": true }, "progress": "4/8" }
```

### progress

```json
{ "total": 8, "completed": 3, "pending": 5, "progress": "3/8", "allDone": false }
```
