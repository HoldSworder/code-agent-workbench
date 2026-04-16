# inspect-logs

查看 code-agent 的引擎日志和 Provider 调用日志，用于排查运行问题。

## 注入条件

始终注入。

## 依赖

- `tail`、`grep`、`stat`、`wc`（标准 Unix 工具）

## 命令

| 命令 | 说明 |
|------|------|
| `list` | 列出所有 `code-agent-*.log` 日志文件 |
| `tail <log-name> [lines]` | 查看日志末尾（默认 50 行） |
| `search <log-name> "<keyword>" [limit]` | 在日志中搜索关键词（默认 20 条） |

## 用法

```bash
bash run.sh --tmpdir <tmp_dir> <command>
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--tmpdir` | 是 | 临时目录路径（日志文件所在目录） |

## 常见日志文件

- `code-agent-engine.log` — 工作流引擎日志
- `code-agent-provider.log` — Agent 调用日志
