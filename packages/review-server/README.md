# @code-agent/review-server

迭代评审协同中枢：在团队所有桌面端之间共享同一份"开发 Spec"，纯 WebSocket + HTTP 协同 + SQLite 持久化。
**不依赖 lark-cli、不依赖任何 AI SDK、不依赖 MCP SDK** —— 这些副作用全部下放到桌面端 sidecar。

## 架构

```
桌面端 A (Tauri)                                ┌────────────────────────────┐
  ├─ ReviewView.vue                            │   review-server (Docker)   │
  ├─ Sidecar (Node)                            │  ┌─────────────────────┐   │
  │   ├─ lark-cli auth/docs                    │  │  HTTP /api/*         │   │
  │   ├─ feishu-project MCP（HTTP streamable） │  │  WS /ws              │   │
  │   ├─ Anthropic SDK 生成 dev-spec / 估点    │  │  SpecSync (内存)     │   │
  │   └─ ReviewServerClient ───── HTTP ───────►│  │  SQLite (/data)      │   │
  └─ ReviewWS ─────────────────── WS ─────────►│  └─────────────────────┘   │
                                               └────────────────────────────┘
桌面端 B、C…（角色：frontend / backend / qa）  ┘
```

职责拆分：

| 能力 | 谁来做 |
| --- | --- |
| 创建 / 覆盖 / 追加飞书云文档 | 桌面端 sidecar 通过 lark-cli |
| 调用飞书项目 MCP（拉需求 / 回写故事点） | 桌面端 sidecar，目标 MCP 由 MCP 页面"全局飞书项目 MCP"标记 |
| 生成 dev-spec / 评估故事点 | 桌面端 sidecar 通过 Anthropic SDK |
| spec 内存版本号 + 乐观锁 + 广播 | review-server |
| 澄清记录 / 评估结果持久化 | review-server (SQLite) |
| 飞书文档同步 | host 客户端监听 `spec.updated` 后 1.5s debounce 调 sidecar |

## Docker 部署

```bash
cd packages/review-server
docker compose up -d --build
# 默认监听 4100，数据持久化到 ./data/review-server.db
```

或：

```bash
docker build -t code-agent-review-server:latest .
docker run --rm -p 4100:4100 -v $PWD/data:/data code-agent-review-server:latest
```

环境变量：

- `REVIEW_SERVER_PORT`（默认 `4100`）
- `REVIEW_DB_PATH`（默认 `/data/review-server.db`）

## 本地开发

```bash
pnpm --filter @code-agent/review-server dev   # tsx watch
pnpm --filter @code-agent/review-server test  # vitest
```

## 主要 HTTP API

所有需要写操作的请求都需要携带身份头：`X-Lark-User-Id`、`X-Lark-User-Name`，可选 `X-Lark-Role`。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/sessions` | 列出全部会话 |
| POST | `/api/sessions` | 创建会话（飞书 spec 文档由客户端预先创建后传 token/url） |
| GET | `/api/sessions/:id` | 拿到会话快照（含 spec、澄清、参与者） |
| POST | `/api/sessions/:id/clarifications` | 追加澄清 |
| POST | `/api/sessions/:id/close` | 关闭会话 |
| POST | `/api/spec/:id/upsert` | 提交整段 spec 内容（baseVersion 校验，`force=true` 跳过） |
| POST | `/api/assessment/:id/results` | 上交 AI 评估结果，会标记会话 `confirmed` 并广播 |
| GET | `/api/assessment/:id` | 查询持久化的评估结果 |

## WebSocket

`ws://<host>:4100/ws`，客户端首条消息：

```json
{ "type": "auth", "larkUserId": "ou_xxx", "larkUserName": "张三", "role": "host" }
```

之后支持：`join` / `leave` / `spec.patch` / `clarify.add` / `ping`。
服务端推送：`session.snapshot` / `spec.updated` / `spec.conflict` / `clarify.added` / `participant.joined|left` / `assessment.completed` / `session.confirmed`。

## 数据库

SQLite，5 张表：`review_sessions`、`review_spec_cache`、`review_clarifications`、`review_assessments`，全部用 `session_id` 串起来，`ON DELETE CASCADE`。

## 测试

```bash
pnpm --filter @code-agent/review-server test
```

覆盖 `SpecSyncService` 的初始化、版本递增与冲突拒绝。
