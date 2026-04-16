# openspec-query

查询 OpenSpec 变更目录的状态、获取文档模板、执行校验。封装 openspec CLI 的查询类命令，提供结构化 JSON 输出和统一错误处理。

## 注入条件

始终注入。

## 依赖

- Node.js
- openspec CLI（可选，不可用时提供降级逻辑）

## 命令

| 命令 | 说明 |
|------|------|
| `status` | 查询变更目录的文件存在状态和任务进度 |
| `instructions <type>` | 获取 openspec instructions 模板（proposal / specs / tasks） |
| `validate` | 执行 openspec validate 并结构化返回结果 |

## 用法

```bash
node run.mjs --change-dir <path> --change-id <id> <command> [args]
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--change-dir` | 是 | openspec 变更目录的绝对路径 |
| `--change-id` | 是 | 变更 ID |

## 输出示例

### status

```json
{
  "changeId": "my-change",
  "exists": true,
  "hasProposal": true,
  "hasSpecs": true,
  "specFiles": ["specs/frontend/spec.md", "specs/backend/spec.md"],
  "hasTasks": true,
  "hasE2eReport": false,
  "taskProgress": "3/8"
}
```

### instructions

```json
{ "type": "proposal", "content": "..." }
```

CLI 不可用时：

```json
{ "type": "proposal", "error": "openspec not installed", "fallback": "请手动创建..." }
```

### validate

```json
{ "valid": true, "details": "..." }
```

## 降级策略

当 openspec CLI 不可用时：
- `status` — 纯文件系统检查，不依赖 CLI
- `instructions` — 返回错误和降级提示
- `validate` — 自行做基本结构检查（proposal.md 存在、specs 目录非空）
