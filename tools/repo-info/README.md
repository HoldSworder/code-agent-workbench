# repo-info

查询系统中已配置的仓库列表、别名、路径及关联任务信息。

## 注入条件

始终注入。

## 依赖

- sqlite3 CLI

## 命令

| 命令 | 说明 |
|------|------|
| `list` | 列出所有已配置仓库 |
| `get <id\|name\|alias>` | 按 id、名称或别名查询单个仓库 |
| `tasks <id\|name\|alias>` | 列出指定仓库的所有任务 |

## 用法

```bash
bash run.sh --db <db_path> <command> [args]
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--db` | 是 | code-agent 数据库路径 |

## 输出示例

### list

```json
[
  {
    "id": "abc-123",
    "name": "my-project",
    "alias": "proj",
    "local_path": "/Users/me/code/my-project",
    "default_branch": "main",
    "agent_provider": null,
    "created_at": "2025-01-01 00:00:00"
  }
]
```

### get

```json
[
  {
    "id": "abc-123",
    "name": "my-project",
    "alias": "proj",
    "local_path": "/Users/me/code/my-project",
    "default_branch": "main",
    "agent_provider": null,
    "created_at": "2025-01-01 00:00:00"
  }
]
```

### tasks

```json
[
  {
    "id": "task-456",
    "branch_name": "feature/login",
    "change_id": "add-login",
    "current_stage": "development",
    "current_phase": "tdd-dev",
    "phase_status": "waiting_input",
    "workflow_completed": 0,
    "created_at": "2025-01-02 00:00:00",
    "updated_at": "2025-01-03 00:00:00",
    "requirement_title": "实现用户登录"
  }
]
```
