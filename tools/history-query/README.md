# history-query

渐进式搜索同一任务中其他阶段的对话历史记录。

## 注入条件

当同一任务的其他阶段存在对话记录时注入。

## 依赖

- `sqlite3` CLI

## 命令

| 命令 | 说明 |
|------|------|
| `list` | 列出所有有对话记录的阶段及摘要 |
| `get <phase-id> [limit] [offset]` | 获取指定阶段的对话详情（分页） |
| `search "<keyword>" [limit]` | 按关键词跨阶段搜索对话 |

## 用法

```bash
bash run.sh --db <db_path> --task <task_id> --phase <current_phase_id> <command>
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--db` | 是 | SQLite 数据库路径 |
| `--task` | 是 | 任务 ID |
| `--phase` | 是 | 当前阶段 ID（用于排除当前阶段的记录） |
