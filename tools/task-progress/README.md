# task-progress

查询当前任务的工作流全局状态、各阶段进度和提交记录。

## 注入条件

始终注入。

## 依赖

- `sqlite3` CLI

## 命令

| 命令 | 说明 |
|------|------|
| `overview` | 任务概况：当前 stage/phase、状态、分支、路径等 |
| `phases` | 所有已激活阶段的详情：消息数、commit、最近一次 agent 运行状态 |
| `commits` | 各阶段关联的 commit 记录 |

## 用法

```bash
bash run.sh --db <db_path> --task <task_id> <command>
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--db` | 是 | SQLite 数据库路径 |
| `--task` | 是 | 任务 ID |
