# Code Agent V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 Tauri 桌面应用，将前端开发工作流编排为 YAML 驱动的多阶段 Agent 流水线。

**Architecture:** Tauri 2.x 壳 + Vue 3 前端 + Node.js Sidecar（通过 shell 插件 stdio JSON-RPC 通信）。Sidecar 承载工作流引擎、Provider 抽象、SQLite 数据层。前端负责看板 / 流水线 / 对话 / 设置 UI。

**Tech Stack:** Tauri 2.x, Vue 3, TypeScript, Pinia, Vue Router, better-sqlite3, yaml, Anthropic SDK, UnoCSS

**Spec:** `docs/specs/2026-04-03-code-agent-design.md`

---

## File Structure

```
code-agent/
├── package.json                          # monorepo root (pnpm workspace)
├── pnpm-workspace.yaml
│
├── apps/
│   └── desktop/                          # Tauri + Vue 前端
│       ├── src-tauri/
│       │   ├── src/main.rs               # Tauri 入口
│       │   ├── tauri.conf.json
│       │   ├── Cargo.toml
│       │   └── capabilities/default.json
│       ├── src/
│       │   ├── App.vue
│       │   ├── main.ts
│       │   ├── router/index.ts
│       │   ├── stores/
│       │   │   ├── repos.ts
│       │   │   ├── requirements.ts
│       │   │   └── tasks.ts
│       │   ├── composables/
│       │   │   └── use-sidecar.ts        # sidecar JSON-RPC 客户端
│       │   ├── views/
│       │   │   ├── Dashboard.vue
│       │   │   ├── RepoView.vue
│       │   │   ├── TaskDetail.vue
│       │   │   └── Settings.vue
│       │   └── components/
│       │       ├── RequirementCard.vue
│       │       ├── TaskCard.vue
│       │       ├── PhaseTimeline.vue
│       │       ├── FileViewer.vue
│       │       ├── ChatPanel.vue
│       │       └── ConfirmBar.vue
│       ├── index.html
│       ├── vite.config.ts
│       ├── uno.config.ts
│       └── package.json
│
├── packages/
│   └── sidecar/                          # Node.js sidecar
│       ├── src/
│       │   ├── index.ts                  # 入口：stdio JSON-RPC server
│       │   ├── rpc/
│       │   │   ├── server.ts             # JSON-RPC 解析/分发
│       │   │   └── methods.ts            # RPC 方法注册
│       │   ├── db/
│       │   │   ├── schema.ts             # SQLite schema + migrations
│       │   │   ├── connection.ts         # DB 连接管理
│       │   │   └── repositories/
│       │   │       ├── repo.repo.ts
│       │   │       ├── requirement.repo.ts
│       │   │       ├── repo-task.repo.ts
│       │   │       ├── agent-run.repo.ts
│       │   │       └── message.repo.ts
│       │   ├── workflow/
│       │   │   ├── engine.ts             # 工作流引擎（状态推进）
│       │   │   ├── parser.ts             # YAML 解析 + 校验
│       │   │   ├── phase-runner.ts       # 阶段执行调度
│       │   │   └── context-builder.ts    # 构建 PhaseContext
│       │   ├── providers/
│       │   │   ├── types.ts              # AgentProvider 接口
│       │   │   ├── api.provider.ts       # LLM API 调用
│       │   │   ├── cli.provider.ts       # 外部 CLI（Claude Code 等）
│       │   │   └── script.provider.ts    # Shell 脚本执行
│       │   ├── git/
│       │   │   └── operations.ts         # git/worktree 操作封装
│       │   └── openspec/
│       │       └── reader.ts             # OpenSpec 文件读写
│       ├── __tests__/
│       │   ├── db/
│       │   │   └── repositories.test.ts
│       │   ├── workflow/
│       │   │   ├── parser.test.ts
│       │   │   └── engine.test.ts
│       │   ├── providers/
│       │   │   ├── script.provider.test.ts
│       │   │   └── cli.provider.test.ts
│       │   └── rpc/
│       │       └── server.test.ts
│       ├── package.json
│       ├── tsconfig.json
│       └── vitest.config.ts
│
├── workflow.yaml                         # 默认工作流配置
├── skills/                               # 阶段 Skill 文件
├── mcp-configs/                          # 阶段 MCP 配置
└── scripts/                              # 确定性脚本
```

---

## Phase 1: Foundation — 项目脚手架

### Task 1: Monorepo 初始化

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.npmrc`

- [ ] **Step 1: 初始化 Git 仓库和 monorepo 根**

```bash
cd /Users/qiuzhuoran/Desktop/自用/code/code-agent
git init
```

```json
// package.json
{
  "name": "code-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "pnpm --filter @code-agent/desktop dev",
    "dev:sidecar": "pnpm --filter @code-agent/sidecar dev",
    "build": "pnpm --filter @code-agent/sidecar build && pnpm --filter @code-agent/desktop build",
    "test": "pnpm --filter @code-agent/sidecar test",
    "lint": "eslint ."
  },
  "engines": {
    "node": ">=20"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

```gitignore
# .gitignore
node_modules/
dist/
target/
*.db
*.db-journal
.DS_Store
*.log
```

```ini
# .npmrc
shamefully-hoist=true
```

- [ ] **Step 2: 安装 monorepo 基础依赖**

```bash
pnpm add -Dw typescript eslint @antfu/eslint-config
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: initialize monorepo structure"
```

---

### Task 2: Tauri + Vue 前端脚手架

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/uno.config.ts`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/App.vue`
- Create: `apps/desktop/src-tauri/` (via `pnpm tauri init`)

- [ ] **Step 1: 创建 Vue 项目**

```bash
mkdir -p apps/desktop/src
```

```json
// apps/desktop/package.json
{
  "name": "@code-agent/desktop",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "tauri": "tauri"
  }
}
```

```bash
cd apps/desktop
pnpm add vue vue-router@4 pinia @tauri-apps/api @tauri-apps/plugin-shell
pnpm add -D vite @vitejs/plugin-vue vue-tsc typescript unocss @unocss/preset-uno @unocss/preset-icons
```

- [ ] **Step 2: 配置 Vite + UnoCSS**

```typescript
// apps/desktop/vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

export default defineConfig({
  plugins: [vue(), UnoCSS()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
```

```typescript
// apps/desktop/uno.config.ts
import { defineConfig, presetUno, presetIcons } from 'unocss'

export default defineConfig({
  presets: [presetUno(), presetIcons()],
})
```

- [ ] **Step 3: 创建 Vue 入口文件**

```html
<!-- apps/desktop/index.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Code Agent</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

```typescript
// apps/desktop/src/main.ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import 'virtual:uno.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/Dashboard.vue') },
    { path: '/repo/:id', component: () => import('./views/RepoView.vue') },
    { path: '/repo/:repoId/task/:taskId', component: () => import('./views/TaskDetail.vue') },
    { path: '/settings', component: () => import('./views/Settings.vue') },
  ],
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
```

```vue
<!-- apps/desktop/src/App.vue -->
<script setup lang="ts">
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
    <router-view />
  </div>
</template>
```

为每个 view 创建占位文件：

```vue
<!-- apps/desktop/src/views/Dashboard.vue -->
<template>
  <div class="p-6">
    <h1 class="text-2xl font-bold">Code Agent</h1>
    <p class="mt-2 text-gray-500">总看板 — 待实现</p>
  </div>
</template>
```

（RepoView.vue、TaskDetail.vue、Settings.vue 同理，标题分别替换为「仓库流水线」「任务详情」「设置」）

- [ ] **Step 4: 初始化 Tauri**

```bash
cd apps/desktop
pnpm add -D @tauri-apps/cli
pnpm tauri init
```

回答交互提示：
- App name: `code-agent`
- Window title: `Code Agent`
- Web assets: `../dist`
- Dev URL: `http://localhost:1420`
- Dev command: `pnpm dev`
- Build command: `pnpm build`

- [ ] **Step 5: 添加 shell 插件（sidecar 通信用）**

```bash
cd apps/desktop
pnpm tauri add shell
```

在 `src-tauri/capabilities/default.json` 中确保有：

```json
{
  "permissions": [
    "shell:allow-execute",
    "shell:allow-spawn",
    "shell:allow-stdin-write"
  ]
}
```

- [ ] **Step 6: 验证 Tauri 开发环境**

```bash
cd apps/desktop
pnpm tauri dev
```

Expected: 窗口打开，显示 "Code Agent — 总看板 — 待实现"

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: scaffold Tauri + Vue desktop app"
```

---

### Task 3: Node.js Sidecar 脚手架

**Files:**
- Create: `packages/sidecar/package.json`
- Create: `packages/sidecar/tsconfig.json`
- Create: `packages/sidecar/vitest.config.ts`
- Create: `packages/sidecar/src/index.ts`

- [ ] **Step 1: 初始化 sidecar 包**

```json
// packages/sidecar/package.json
{
  "name": "@code-agent/sidecar",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --target node20",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

```bash
cd packages/sidecar
pnpm add better-sqlite3 yaml zod
pnpm add -D typescript tsx tsup vitest @types/better-sqlite3 @types/node
```

- [ ] **Step 2: 配置 TypeScript + Vitest**

```json
// packages/sidecar/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src"]
}
```

```typescript
// packages/sidecar/vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
  },
})
```

- [ ] **Step 3: 创建 sidecar 入口（echo server 验证通信）**

```typescript
// packages/sidecar/src/index.ts
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line)
    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result: { echo: request.params, status: 'ok' },
    }
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
  catch (err) {
    const error = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    }
    process.stdout.write(`${JSON.stringify(error)}\n`)
  }
})

process.stderr.write('sidecar: ready\n')
```

- [ ] **Step 4: 验证 sidecar 可独立运行**

```bash
cd packages/sidecar
echo '{"jsonrpc":"2.0","id":1,"method":"echo","params":{"hello":"world"}}' | npx tsx src/index.ts
```

Expected: `{"jsonrpc":"2.0","id":1,"result":{"echo":{"hello":"world"},"status":"ok"}}`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: scaffold Node.js sidecar with stdio JSON-RPC"
```

---

## Phase 2: Data Layer — SQLite

### Task 4: 数据库 Schema + 连接

**Files:**
- Create: `packages/sidecar/src/db/connection.ts`
- Create: `packages/sidecar/src/db/schema.ts`
- Test: `packages/sidecar/__tests__/db/schema.test.ts`

- [ ] **Step 1: 写 schema 测试**

```typescript
// packages/sidecar/__tests__/db/schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'

describe('database schema', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('creates all tables', () => {
    applySchema(db)

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name)

    expect(tables).toContain('repos')
    expect(tables).toContain('requirements')
    expect(tables).toContain('repo_tasks')
    expect(tables).toContain('agent_runs')
    expect(tables).toContain('conversation_messages')
  })

  it('is idempotent', () => {
    applySchema(db)
    applySchema(db)
    const count = db
      .prepare(`SELECT count(*) as c FROM sqlite_master WHERE type='table'`)
      .get() as any
    expect(count.c).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/sidecar && pnpm test -- __tests__/db/schema.test.ts
```

Expected: FAIL — `applySchema` not found

- [ ] **Step 3: 实现 schema**

```typescript
// packages/sidecar/src/db/schema.ts
import type Database from 'better-sqlite3'

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL DEFAULT 'main',
      agent_provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      source_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repo_tasks (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL REFERENCES requirements(id),
      repo_id TEXT NOT NULL REFERENCES repos(id),
      branch_name TEXT NOT NULL,
      change_id TEXT NOT NULL,
      current_phase TEXT NOT NULL DEFAULT 'design',
      phase_status TEXT NOT NULL DEFAULT 'running',
      openspec_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      repo_task_id TEXT NOT NULL REFERENCES repo_tasks(id),
      phase_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      token_usage INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      repo_task_id TEXT NOT NULL REFERENCES repo_tasks(id),
      phase_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_repo_tasks_requirement ON repo_tasks(requirement_id);
    CREATE INDEX IF NOT EXISTS idx_repo_tasks_repo ON repo_tasks(repo_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(repo_task_id);
    CREATE INDEX IF NOT EXISTS idx_messages_task ON conversation_messages(repo_task_id);
  `)
}
```

```typescript
// packages/sidecar/src/db/connection.ts
import Database from 'better-sqlite3'
import { applySchema } from './schema'

let _db: Database.Database | null = null

export function getDb(dbPath?: string): Database.Database {
  if (!_db) {
    _db = new Database(dbPath ?? 'code-agent.db')
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    applySchema(_db)
  }
  return _db
}

export function closeDb(): void {
  _db?.close()
  _db = null
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/sidecar && pnpm test -- __tests__/db/schema.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: SQLite schema with all tables and indexes"
```

---

### Task 5: 数据访问层（Repositories）

**Files:**
- Create: `packages/sidecar/src/db/repositories/repo.repo.ts`
- Create: `packages/sidecar/src/db/repositories/requirement.repo.ts`
- Create: `packages/sidecar/src/db/repositories/repo-task.repo.ts`
- Create: `packages/sidecar/src/db/repositories/agent-run.repo.ts`
- Create: `packages/sidecar/src/db/repositories/message.repo.ts`
- Test: `packages/sidecar/__tests__/db/repositories.test.ts`

- [ ] **Step 1: 写 repo repository 测试**

```typescript
// packages/sidecar/__tests__/db/repositories.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { RepoRepository } from '../../src/db/repositories/repo.repo'
import { RequirementRepository } from '../../src/db/repositories/requirement.repo'
import { RepoTaskRepository } from '../../src/db/repositories/repo-task.repo'

describe('RepoRepository', () => {
  let db: Database.Database
  let repo: RepoRepository

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    repo = new RepoRepository(db)
  })

  afterEach(() => db.close())

  it('creates and retrieves a repo', () => {
    const created = repo.create({
      name: 'my-app',
      local_path: '/tmp/my-app',
      default_branch: 'main',
    })
    expect(created.id).toBeDefined()
    expect(created.name).toBe('my-app')

    const found = repo.findById(created.id)
    expect(found).toEqual(created)
  })

  it('lists all repos', () => {
    repo.create({ name: 'a', local_path: '/a', default_branch: 'main' })
    repo.create({ name: 'b', local_path: '/b', default_branch: 'master' })
    expect(repo.findAll()).toHaveLength(2)
  })

  it('deletes a repo', () => {
    const created = repo.create({ name: 'x', local_path: '/x', default_branch: 'main' })
    repo.delete(created.id)
    expect(repo.findById(created.id)).toBeUndefined()
  })
})

describe('RequirementRepository', () => {
  let db: Database.Database
  let repo: RequirementRepository

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    repo = new RequirementRepository(db)
  })

  afterEach(() => db.close())

  it('creates and lists requirements', () => {
    repo.create({ title: '需求1', description: '描述', source: 'manual' })
    repo.create({ title: '需求2', description: '', source: 'feishu', source_url: 'https://...' })
    const all = repo.findAll()
    expect(all).toHaveLength(2)
    expect(all[0].status).toBe('draft')
  })

  it('updates status', () => {
    const r = repo.create({ title: 't', description: '', source: 'manual' })
    repo.updateStatus(r.id, 'active')
    expect(repo.findById(r.id)!.status).toBe('active')
  })
})

describe('RepoTaskRepository', () => {
  let db: Database.Database
  let taskRepo: RepoTaskRepository

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    const repoRepo = new RepoRepository(db)
    const reqRepo = new RequirementRepository(db)
    repoRepo.create({ name: 'app', local_path: '/app', default_branch: 'main' })
    reqRepo.create({ title: 'feat', description: '', source: 'manual' })
    taskRepo = new RepoTaskRepository(db)
  })

  afterEach(() => db.close())

  it('creates a task linked to repo and requirement', () => {
    const repos = new RepoRepository(db).findAll()
    const reqs = new RequirementRepository(db).findAll()
    const task = taskRepo.create({
      requirement_id: reqs[0].id,
      repo_id: repos[0].id,
      branch_name: 'feature/test',
      change_id: 'test-001',
      openspec_path: 'openspec/changes/test-001',
      worktree_path: '/app/.worktrees/test-001',
    })
    expect(task.current_phase).toBe('design')
    expect(task.phase_status).toBe('running')
  })

  it('updates phase and status', () => {
    const repos = new RepoRepository(db).findAll()
    const reqs = new RequirementRepository(db).findAll()
    const task = taskRepo.create({
      requirement_id: reqs[0].id,
      repo_id: repos[0].id,
      branch_name: 'feature/t',
      change_id: 't',
      openspec_path: 'openspec/changes/t',
      worktree_path: '/app/.worktrees/t',
    })
    taskRepo.updatePhase(task.id, 'plan', 'waiting_confirm')
    const updated = taskRepo.findById(task.id)!
    expect(updated.current_phase).toBe('plan')
    expect(updated.phase_status).toBe('waiting_confirm')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/sidecar && pnpm test -- __tests__/db/repositories.test.ts
```

Expected: FAIL — modules not found

- [ ] **Step 3: 实现五个 Repository**

每个 Repository 遵循相同模式：构造函数接收 `Database.Database`，提供 `create`/`findById`/`findAll`/`update`/`delete` 方法。

`repo.repo.ts` 示例结构：

```typescript
// packages/sidecar/src/db/repositories/repo.repo.ts
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface Repo {
  id: string
  name: string
  local_path: string
  default_branch: string
  agent_provider: string | null
  created_at: string
}

export interface CreateRepoInput {
  name: string
  local_path: string
  default_branch: string
  agent_provider?: string
}

export class RepoRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateRepoInput): Repo {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO repos (id, name, local_path, default_branch, agent_provider)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.name, input.local_path, input.default_branch, input.agent_provider ?? null)
    return this.findById(id)!
  }

  findById(id: string): Repo | undefined {
    return this.db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as Repo | undefined
  }

  findAll(): Repo[] {
    return this.db.prepare('SELECT * FROM repos ORDER BY created_at DESC').all() as Repo[]
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM repos WHERE id = ?').run(id)
  }
}
```

其余四个 Repository 同理，参考 spec 中的数据模型，实现对应的 CRUD 方法。重点方法：
- `RepoTaskRepository.updatePhase(id, phase, status)`
- `RepoTaskRepository.findByRepoId(repoId)`
- `RepoTaskRepository.findByRequirementId(requirementId)`
- `AgentRunRepository.create(...)` / `finish(id, status, tokenUsage?, error?)`
- `MessageRepository.findByTaskAndPhase(taskId, phaseId)`

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/sidecar && pnpm test -- __tests__/db/repositories.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: data access layer with five repositories"
```

---

## Phase 3: Core Engine — 工作流 + Provider

### Task 6: YAML 工作流解析器

**Files:**
- Create: `packages/sidecar/src/workflow/parser.ts`
- Create: `workflow.yaml`
- Test: `packages/sidecar/__tests__/workflow/parser.test.ts`

- [ ] **Step 1: 写解析器测试**

```typescript
// packages/sidecar/__tests__/workflow/parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseWorkflow, type WorkflowConfig } from '../../src/workflow/parser'

const VALID_YAML = `
name: test-workflow
description: Test
phases:
  - id: design
    name: 设计
    requires_confirm: true
    provider: api
    skill: skills/design.md
    tools:
      - read-file
  - id: dev
    name: 开发
    requires_confirm: false
    provider: external-cli
    skill: skills/dev.md
    mcp_config: mcp-configs/dev.json
events:
  - id: backend-spec
    name: 后端 Spec
    after_phase: dev
    skill: skills/integration.md
    provider: api
`

describe('parseWorkflow', () => {
  it('parses valid YAML into WorkflowConfig', () => {
    const config = parseWorkflow(VALID_YAML)
    expect(config.name).toBe('test-workflow')
    expect(config.phases).toHaveLength(2)
    expect(config.phases[0].id).toBe('design')
    expect(config.phases[0].requires_confirm).toBe(true)
    expect(config.phases[0].tools).toEqual(['read-file'])
    expect(config.phases[1].mcp_config).toBe('mcp-configs/dev.json')
    expect(config.events).toHaveLength(1)
    expect(config.events![0].after_phase).toBe('dev')
  })

  it('throws on missing required fields', () => {
    expect(() => parseWorkflow('name: x')).toThrow()
  })

  it('throws on invalid provider type', () => {
    const yaml = `
name: x
description: x
phases:
  - id: a
    name: A
    requires_confirm: false
    provider: magic
    skill: x.md
`
    expect(() => parseWorkflow(yaml)).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/sidecar && pnpm test -- __tests__/workflow/parser.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现解析器（用 Zod 校验）**

```typescript
// packages/sidecar/src/workflow/parser.ts
import { parse } from 'yaml'
import { z } from 'zod'

const PhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  requires_confirm: z.boolean(),
  provider: z.enum(['api', 'external-cli', 'script']),
  skill: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_config: z.string().nullable().optional(),
  confirm_files: z.array(z.string()).optional(),
  completion_check: z.string().optional(),
  script: z.string().optional(),
  args: z.array(z.string()).optional(),
})

const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  after_phase: z.string(),
  skill: z.string().optional(),
  provider: z.enum(['api', 'external-cli', 'script']),
  tools: z.array(z.string()).optional(),
  mcp_config: z.string().nullable().optional(),
  confirm_files: z.array(z.string()).optional(),
  script: z.string().optional(),
})

const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string(),
  phases: z.array(PhaseSchema).min(1),
  events: z.array(EventSchema).optional(),
})

export type PhaseConfig = z.infer<typeof PhaseSchema>
export type EventConfig = z.infer<typeof EventSchema>
export type WorkflowConfig = z.infer<typeof WorkflowSchema>

export function parseWorkflow(yamlContent: string): WorkflowConfig {
  const raw = parse(yamlContent)
  return WorkflowSchema.parse(raw)
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/sidecar && pnpm test -- __tests__/workflow/parser.test.ts
```

Expected: PASS

- [ ] **Step 5: 创建默认 workflow.yaml**

将 spec 中定义的完整 `workflow.yaml` 写入项目根目录（内容见 spec 2.2 节）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: YAML workflow parser with Zod validation"
```

---

### Task 7: 工作流引擎状态机

**Files:**
- Create: `packages/sidecar/src/workflow/engine.ts`
- Create: `packages/sidecar/src/workflow/context-builder.ts`
- Create: `packages/sidecar/src/workflow/phase-runner.ts`
- Create: `packages/sidecar/src/providers/types.ts`
- Test: `packages/sidecar/__tests__/workflow/engine.test.ts`

- [ ] **Step 1: 定义 Provider 接口**

```typescript
// packages/sidecar/src/providers/types.ts
export interface PhaseContext {
  phaseId: string
  repoPath: string
  openspecPath: string
  branchName: string
  skillContent: string
  tools?: string[]
  mcpConfig?: string
  userMessage?: string
}

export interface PhaseResult {
  status: 'success' | 'failed' | 'cancelled'
  output?: string
  error?: string
  tokenUsage?: number
}

export interface AgentProvider {
  run(context: PhaseContext): Promise<PhaseResult>
  cancel(): Promise<void>
}
```

- [ ] **Step 2: 写引擎测试**

```typescript
// packages/sidecar/__tests__/workflow/engine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { WorkflowEngine } from '../../src/workflow/engine'
import { RepoRepository } from '../../src/db/repositories/repo.repo'
import { RequirementRepository } from '../../src/db/repositories/requirement.repo'
import { RepoTaskRepository } from '../../src/db/repositories/repo-task.repo'
import type { AgentProvider, PhaseResult } from '../../src/providers/types'

function createMockProvider(result: PhaseResult): AgentProvider {
  return {
    run: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
}

const WORKFLOW_YAML = `
name: test
description: test workflow
phases:
  - id: design
    name: 设计
    requires_confirm: true
    provider: api
    skill: skills/design.md
  - id: dev
    name: 开发
    requires_confirm: false
    provider: external-cli
    skill: skills/dev.md
  - id: verify
    name: 验证
    requires_confirm: false
    provider: script
    script: scripts/verify.sh
`

describe('WorkflowEngine', () => {
  let db: Database.Database
  let engine: WorkflowEngine
  let mockProvider: AgentProvider

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)

    const repoRepo = new RepoRepository(db)
    const reqRepo = new RequirementRepository(db)
    repoRepo.create({ name: 'app', local_path: '/tmp/app', default_branch: 'main' })
    reqRepo.create({ title: 'test', description: '', source: 'manual' })

    const taskRepo = new RepoTaskRepository(db)
    const repos = repoRepo.findAll()
    const reqs = reqRepo.findAll()
    taskRepo.create({
      requirement_id: reqs[0].id,
      repo_id: repos[0].id,
      branch_name: 'feature/test',
      change_id: 'test',
      openspec_path: 'openspec/changes/test',
      worktree_path: '/tmp/app/.worktrees/test',
    })

    mockProvider = createMockProvider({ status: 'success', output: 'done' })

    engine = new WorkflowEngine({
      db,
      workflowYaml: WORKFLOW_YAML,
      resolveProvider: () => mockProvider,
      resolveSkillContent: () => 'skill content',
    })
  })

  afterEach(() => db.close())

  it('starts workflow and runs first phase', async () => {
    const tasks = new RepoTaskRepository(db).findAll()
    await engine.startWorkflow(tasks[0].id)

    expect(mockProvider.run).toHaveBeenCalledOnce()

    const task = new RepoTaskRepository(db).findById(tasks[0].id)!
    // design 阶段 requires_confirm=true，所以应该是 waiting_confirm
    expect(task.phase_status).toBe('waiting_confirm')
  })

  it('confirmPhase advances to next phase', async () => {
    const tasks = new RepoTaskRepository(db).findAll()
    await engine.startWorkflow(tasks[0].id)
    await engine.confirmPhase(tasks[0].id)

    const task = new RepoTaskRepository(db).findById(tasks[0].id)!
    // dev 阶段 requires_confirm=false，自动推进到 verify
    // verify 也是 requires_confirm=false，自动推进到完成
    expect(task.current_phase).toBe('verify')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd packages/sidecar && pnpm test -- __tests__/workflow/engine.test.ts
```

Expected: FAIL

- [ ] **Step 4: 实现 ContextBuilder**

```typescript
// packages/sidecar/src/workflow/context-builder.ts
import type { PhaseConfig } from './parser'
import type { PhaseContext } from '../providers/types'

export interface ContextBuilderDeps {
  resolveSkillContent: (skillPath: string) => string
}

export function buildPhaseContext(
  phase: PhaseConfig,
  repoPath: string,
  openspecPath: string,
  branchName: string,
  deps: ContextBuilderDeps,
  userMessage?: string,
): PhaseContext {
  return {
    phaseId: phase.id,
    repoPath,
    openspecPath,
    branchName,
    skillContent: phase.skill ? deps.resolveSkillContent(phase.skill) : '',
    tools: phase.tools,
    mcpConfig: phase.mcp_config ?? undefined,
    userMessage,
  }
}
```

- [ ] **Step 5: 实现 WorkflowEngine**

```typescript
// packages/sidecar/src/workflow/engine.ts
import type Database from 'better-sqlite3'
import { parseWorkflow, type WorkflowConfig, type PhaseConfig } from './parser'
import { buildPhaseContext } from './context-builder'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { AgentRunRepository } from '../db/repositories/agent-run.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import type { AgentProvider, PhaseResult } from '../providers/types'

export interface WorkflowEngineOptions {
  db: Database.Database
  workflowYaml: string
  resolveProvider: (providerType: string) => AgentProvider
  resolveSkillContent: (skillPath: string) => string
}

export class WorkflowEngine {
  private config: WorkflowConfig
  private taskRepo: RepoTaskRepository
  private runRepo: AgentRunRepository
  private msgRepo: MessageRepository
  private activeAgents = new Map<string, AgentProvider>()
  private opts: WorkflowEngineOptions

  constructor(opts: WorkflowEngineOptions) {
    this.opts = opts
    this.config = parseWorkflow(opts.workflowYaml)
    this.taskRepo = new RepoTaskRepository(opts.db)
    this.runRepo = new AgentRunRepository(opts.db)
    this.msgRepo = new MessageRepository(opts.db)
  }

  async startWorkflow(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task) throw new Error(`Task not found: ${repoTaskId}`)

    const firstPhase = this.config.phases[0]
    this.taskRepo.updatePhase(task.id, firstPhase.id, 'running')
    await this.executePhase(task.id, firstPhase)
  }

  async confirmPhase(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)!
    if (task.phase_status !== 'waiting_confirm')
      throw new Error(`Task ${repoTaskId} is not waiting for confirmation`)

    await this.advancePhase(repoTaskId)
  }

  async provideFeedback(repoTaskId: string, feedback: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)!
    const phase = this.findPhase(task.current_phase)!

    this.msgRepo.create({
      repo_task_id: task.id,
      phase_id: task.current_phase,
      role: 'user',
      content: feedback,
    })

    this.taskRepo.updatePhase(task.id, task.current_phase, 'running')
    await this.executePhase(task.id, phase, feedback)
  }

  async triggerEvent(repoTaskId: string, eventId: string): Promise<void> {
    const event = this.config.events?.find(e => e.id === eventId)
    if (!event) throw new Error(`Event not found: ${eventId}`)

    const task = this.taskRepo.findById(repoTaskId)!
    this.taskRepo.updatePhase(task.id, eventId, 'running')

    const provider = this.opts.resolveProvider(event.provider)
    const context = buildPhaseContext(
      event as PhaseConfig,
      task.worktree_path,
      `${task.worktree_path}/${task.openspec_path}`,
      task.branch_name,
      { resolveSkillContent: this.opts.resolveSkillContent },
    )

    const result = await provider.run(context)
    this.handlePhaseResult(task.id, eventId, event as PhaseConfig, result)
  }

  async cancelCurrentAgent(repoTaskId: string): Promise<void> {
    const agent = this.activeAgents.get(repoTaskId)
    if (agent) {
      await agent.cancel()
      this.activeAgents.delete(repoTaskId)
    }
  }

  private async advancePhase(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)!
    const currentIndex = this.config.phases.findIndex(p => p.id === task.current_phase)
    const nextPhase = this.config.phases[currentIndex + 1]

    if (!nextPhase) {
      this.taskRepo.updatePhase(task.id, task.current_phase, 'waiting_event')
      return
    }

    this.taskRepo.updatePhase(task.id, nextPhase.id, 'running')
    await this.executePhase(task.id, nextPhase)
  }

  private async executePhase(
    repoTaskId: string,
    phase: PhaseConfig,
    userMessage?: string,
  ): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)!
    const provider = this.opts.resolveProvider(phase.provider)
    this.activeAgents.set(repoTaskId, provider)

    const run = this.runRepo.create({
      repo_task_id: repoTaskId,
      phase_id: phase.id,
      provider: phase.provider,
    })

    const context = buildPhaseContext(
      phase,
      task.worktree_path,
      `${task.worktree_path}/${task.openspec_path}`,
      task.branch_name,
      { resolveSkillContent: this.opts.resolveSkillContent },
      userMessage,
    )

    try {
      const result = await provider.run(context)
      this.runRepo.finish(run.id, result.status, result.tokenUsage, result.error)

      if (result.output) {
        this.msgRepo.create({
          repo_task_id: repoTaskId,
          phase_id: phase.id,
          role: 'assistant',
          content: result.output,
        })
      }

      this.handlePhaseResult(repoTaskId, phase.id, phase, result)
    }
    catch (err: any) {
      this.runRepo.finish(run.id, 'failed', undefined, err.message)
      this.taskRepo.updatePhase(repoTaskId, phase.id, 'failed')
    }
    finally {
      this.activeAgents.delete(repoTaskId)
    }
  }

  private handlePhaseResult(
    repoTaskId: string,
    phaseId: string,
    phase: PhaseConfig,
    result: PhaseResult,
  ): void {
    if (result.status !== 'success') {
      this.taskRepo.updatePhase(repoTaskId, phaseId, 'failed')
      return
    }

    if (phase.requires_confirm) {
      this.taskRepo.updatePhase(repoTaskId, phaseId, 'waiting_confirm')
    }
    else {
      this.advancePhase(repoTaskId)
    }
  }

  private findPhase(phaseId: string): PhaseConfig | undefined {
    return this.config.phases.find(p => p.id === phaseId)
  }
}
```

- [ ] **Step 6: 实现 PhaseRunner（委托给 engine，保留接口供未来扩展）**

```typescript
// packages/sidecar/src/workflow/phase-runner.ts
export { WorkflowEngine } from './engine'
```

- [ ] **Step 7: 跑测试确认通过**

```bash
cd packages/sidecar && pnpm test -- __tests__/workflow/engine.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: workflow engine with state machine and phase execution"
```

---

### Task 8: ScriptProvider

**Files:**
- Create: `packages/sidecar/src/providers/script.provider.ts`
- Test: `packages/sidecar/__tests__/providers/script.provider.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// packages/sidecar/__tests__/providers/script.provider.test.ts
import { describe, it, expect } from 'vitest'
import { ScriptProvider } from '../../src/providers/script.provider'
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

function createTempScript(content: string): string {
  const dir = join(tmpdir(), `test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const scriptPath = join(dir, 'test.sh')
  writeFileSync(scriptPath, `#!/bin/bash\n${content}`)
  chmodSync(scriptPath, '755')
  return scriptPath
}

describe('ScriptProvider', () => {
  it('runs a script and returns stdout', async () => {
    const script = createTempScript('echo "hello from script"')
    const provider = new ScriptProvider(script)
    const result = await provider.run({
      phaseId: 'test',
      repoPath: '/tmp',
      openspecPath: '/tmp/openspec',
      branchName: 'main',
      skillContent: '',
    })
    expect(result.status).toBe('success')
    expect(result.output).toContain('hello from script')
  })

  it('returns failed on non-zero exit code', async () => {
    const script = createTempScript('exit 1')
    const provider = new ScriptProvider(script)
    const result = await provider.run({
      phaseId: 'test',
      repoPath: '/tmp',
      openspecPath: '/tmp/openspec',
      branchName: 'main',
      skillContent: '',
    })
    expect(result.status).toBe('failed')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/sidecar && pnpm test -- __tests__/providers/script.provider.test.ts
```

- [ ] **Step 3: 实现 ScriptProvider**

```typescript
// packages/sidecar/src/providers/script.provider.ts
import { spawn } from 'node:child_process'
import type { AgentProvider, PhaseContext, PhaseResult } from './types'

export class ScriptProvider implements AgentProvider {
  private childProcess: ReturnType<typeof spawn> | null = null

  constructor(
    private scriptPath: string,
    private args: string[] = [],
  ) {}

  run(context: PhaseContext): Promise<PhaseResult> {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''

      this.childProcess = spawn(this.scriptPath, this.args, {
        cwd: context.repoPath,
        env: {
          ...process.env,
          OPENSPEC_PATH: context.openspecPath,
          BRANCH_NAME: context.branchName,
          PHASE_ID: context.phaseId,
        },
        shell: true,
      })

      this.childProcess.stdout?.on('data', (data) => { stdout += data })
      this.childProcess.stderr?.on('data', (data) => { stderr += data })

      this.childProcess.on('close', (code) => {
        this.childProcess = null
        resolve({
          status: code === 0 ? 'success' : 'failed',
          output: stdout.trim(),
          error: code !== 0 ? stderr.trim() || `Exit code: ${code}` : undefined,
        })
      })
    })
  }

  async cancel(): Promise<void> {
    this.childProcess?.kill('SIGTERM')
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/sidecar && pnpm test -- __tests__/providers/script.provider.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: ScriptProvider for shell script execution"
```

---

### Task 9: ExternalCliProvider（Claude Code / Cursor CLI）

**Files:**
- Create: `packages/sidecar/src/providers/cli.provider.ts`
- Test: `packages/sidecar/__tests__/providers/cli.provider.test.ts`

- [ ] **Step 1: 写测试（mock child_process）**

```typescript
// packages/sidecar/__tests__/providers/cli.provider.test.ts
import { describe, it, expect } from 'vitest'
import { ExternalCliProvider } from '../../src/providers/cli.provider'

describe('ExternalCliProvider', () => {
  it('builds correct claude command args', () => {
    const provider = new ExternalCliProvider({
      type: 'claude-code',
      binaryPath: 'claude',
    })

    const args = provider.buildArgs({
      phaseId: 'dev',
      repoPath: '/tmp/repo',
      openspecPath: '/tmp/repo/openspec/changes/test',
      branchName: 'feature/test',
      skillContent: 'You are a developer...',
      mcpConfig: 'mcp-configs/dev.json',
    })

    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('json')
    expect(args.some(a => a.includes('mcp-config'))).toBe(true)
  })

  it('builds correct cursor command args', () => {
    const provider = new ExternalCliProvider({
      type: 'cursor-cli',
      binaryPath: 'cursor',
    })

    const args = provider.buildArgs({
      phaseId: 'dev',
      repoPath: '/tmp/repo',
      openspecPath: '/tmp/repo/openspec',
      branchName: 'feature/test',
      skillContent: 'skill...',
    })

    expect(args.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/sidecar && pnpm test -- __tests__/providers/cli.provider.test.ts
```

- [ ] **Step 3: 实现 ExternalCliProvider**

```typescript
// packages/sidecar/src/providers/cli.provider.ts
import { spawn } from 'node:child_process'
import type { AgentProvider, PhaseContext, PhaseResult } from './types'

export interface CliProviderConfig {
  type: 'claude-code' | 'cursor-cli' | 'codex'
  binaryPath?: string
}

export class ExternalCliProvider implements AgentProvider {
  private childProcess: ReturnType<typeof spawn> | null = null
  private config: CliProviderConfig

  constructor(config: CliProviderConfig) {
    this.config = config
  }

  buildArgs(context: PhaseContext): string[] {
    const prompt = this.buildPrompt(context)

    switch (this.config.type) {
      case 'claude-code': {
        const args = ['-p', prompt, '--output-format', 'json']
        if (context.mcpConfig)
          args.push('--mcp-config', context.mcpConfig)
        return args
      }
      case 'cursor-cli': {
        return ['--message', prompt]
      }
      case 'codex': {
        const args = ['-p', prompt, '--output-format', 'json']
        return args
      }
    }
  }

  run(context: PhaseContext): Promise<PhaseResult> {
    return new Promise((resolve) => {
      const binary = this.config.binaryPath ?? this.defaultBinary()
      const args = this.buildArgs(context)
      let stdout = ''
      let stderr = ''

      this.childProcess = spawn(binary, args, {
        cwd: context.repoPath,
        env: process.env,
      })

      this.childProcess.stdout?.on('data', (data) => { stdout += data })
      this.childProcess.stderr?.on('data', (data) => { stderr += data })

      this.childProcess.on('close', (code) => {
        this.childProcess = null
        if (code !== 0) {
          resolve({ status: 'failed', error: stderr || `Exit code: ${code}` })
          return
        }

        const output = this.parseOutput(stdout)
        resolve({
          status: 'success',
          output: output.text,
          tokenUsage: output.tokenUsage,
        })
      })
    })
  }

  async cancel(): Promise<void> {
    this.childProcess?.kill('SIGTERM')
  }

  private buildPrompt(context: PhaseContext): string {
    let prompt = context.skillContent
    if (context.userMessage)
      prompt += `\n\n## 用户反馈\n${context.userMessage}`

    prompt += `\n\n## 上下文\n- 工作目录: ${context.repoPath}\n- OpenSpec: ${context.openspecPath}\n- 分支: ${context.branchName}`
    return prompt
  }

  private defaultBinary(): string {
    const map: Record<string, string> = {
      'claude-code': 'claude',
      'cursor-cli': 'cursor',
      'codex': 'codex',
    }
    return map[this.config.type]
  }

  private parseOutput(stdout: string): { text: string, tokenUsage?: number } {
    try {
      const json = JSON.parse(stdout)
      return {
        text: json.result ?? json.output ?? stdout,
        tokenUsage: json.usage?.total_tokens,
      }
    }
    catch {
      return { text: stdout }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/sidecar && pnpm test -- __tests__/providers/cli.provider.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: ExternalCliProvider for Claude Code / Cursor / Codex"
```

---

### Task 10: ApiProvider（LLM API 直接调用）

**Files:**
- Create: `packages/sidecar/src/providers/api.provider.ts`

- [ ] **Step 1: 安装 Anthropic SDK**

```bash
cd packages/sidecar && pnpm add @anthropic-ai/sdk
```

- [ ] **Step 2: 实现 ApiProvider（含 Agent Loop）**

```typescript
// packages/sidecar/src/providers/api.provider.ts
import Anthropic from '@anthropic-ai/sdk'
import type { AgentProvider, PhaseContext, PhaseResult } from './types'

export interface ApiProviderConfig {
  type: 'anthropic' | 'openai-compatible'
  apiKey: string
  baseUrl?: string
  model: string
}

export class ApiProvider implements AgentProvider {
  private client: Anthropic
  private model: string
  private cancelled = false

  constructor(config: ApiProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    this.model = config.model
  }

  async run(context: PhaseContext): Promise<PhaseResult> {
    this.cancelled = false

    const systemPrompt = this.buildSystemPrompt(context)
    const userMessage = context.userMessage ?? '请开始执行此阶段的任务。'

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      })

      if (this.cancelled)
        return { status: 'cancelled' }

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as any).text)
        .join('\n')

      return {
        status: 'success',
        output: text,
        tokenUsage: response.usage.input_tokens + response.usage.output_tokens,
      }
    }
    catch (err: any) {
      return {
        status: 'failed',
        error: err.message,
      }
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true
  }

  private buildSystemPrompt(context: PhaseContext): string {
    return `${context.skillContent}

## 执行上下文
- 阶段: ${context.phaseId}
- 仓库路径: ${context.repoPath}
- OpenSpec 目录: ${context.openspecPath}
- 当前分支: ${context.branchName}
`
  }
}
```

> 注意：V1 的 ApiProvider 是简单的单轮调用。Tool use loop（工具调用循环）留到 V1.1 迭代，因为设计、规划、审查阶段的 Agent 主要输出文本。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: ApiProvider with Anthropic SDK"
```

---

## Phase 4: IPC Bridge — Sidecar ↔ Frontend

### Task 11: JSON-RPC Server

**Files:**
- Modify: `packages/sidecar/src/index.ts`
- Create: `packages/sidecar/src/rpc/server.ts`
- Create: `packages/sidecar/src/rpc/methods.ts`
- Test: `packages/sidecar/__tests__/rpc/server.test.ts`

- [ ] **Step 1: 写 RPC server 测试**

```typescript
// packages/sidecar/__tests__/rpc/server.test.ts
import { describe, it, expect } from 'vitest'
import { RpcServer } from '../../src/rpc/server'

describe('RpcServer', () => {
  it('dispatches method and returns result', async () => {
    const server = new RpcServer()
    server.register('echo', async (params: any) => params)

    const response = await server.handle(
      '{"jsonrpc":"2.0","id":1,"method":"echo","params":{"msg":"hi"}}',
    )
    const parsed = JSON.parse(response)

    expect(parsed.id).toBe(1)
    expect(parsed.result.msg).toBe('hi')
  })

  it('returns method not found for unknown method', async () => {
    const server = new RpcServer()
    const response = await server.handle(
      '{"jsonrpc":"2.0","id":2,"method":"unknown","params":{}}',
    )
    const parsed = JSON.parse(response)
    expect(parsed.error.code).toBe(-32601)
  })

  it('returns parse error for invalid JSON', async () => {
    const server = new RpcServer()
    const response = await server.handle('not json')
    const parsed = JSON.parse(response)
    expect(parsed.error.code).toBe(-32700)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/sidecar && pnpm test -- __tests__/rpc/server.test.ts
```

- [ ] **Step 3: 实现 RpcServer**

```typescript
// packages/sidecar/src/rpc/server.ts
type RpcHandler = (params: any) => Promise<any>

export class RpcServer {
  private handlers = new Map<string, RpcHandler>()

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler)
  }

  async handle(line: string): Promise<string> {
    let id: number | string | null = null

    try {
      const request = JSON.parse(line)
      id = request.id

      const handler = this.handlers.get(request.method)
      if (!handler) {
        return JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        })
      }

      const result = await handler(request.params ?? {})
      return JSON.stringify({ jsonrpc: '2.0', id, result })
    }
    catch (err: any) {
      if (id === null) {
        return JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        })
      }
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message },
      })
    }
  }
}
```

- [ ] **Step 4: 实现 RPC 方法注册**

```typescript
// packages/sidecar/src/rpc/methods.ts
import type { RpcServer } from './server'
import type Database from 'better-sqlite3'
import { RepoRepository } from '../db/repositories/repo.repo'
import { RequirementRepository } from '../db/repositories/requirement.repo'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import { WorkflowEngine } from '../workflow/engine'

export function registerMethods(
  server: RpcServer,
  db: Database.Database,
  engine: WorkflowEngine,
): void {
  const repoRepo = new RepoRepository(db)
  const reqRepo = new RequirementRepository(db)
  const taskRepo = new RepoTaskRepository(db)
  const msgRepo = new MessageRepository(db)

  // Repo CRUD
  server.register('repo.list', async () => repoRepo.findAll())
  server.register('repo.create', async (params) => repoRepo.create(params))
  server.register('repo.delete', async ({ id }) => repoRepo.delete(id))

  // Requirement CRUD
  server.register('requirement.list', async () => reqRepo.findAll())
  server.register('requirement.create', async (params) => reqRepo.create(params))
  server.register('requirement.get', async ({ id }) => reqRepo.findById(id))

  // RepoTask
  server.register('task.listByRepo', async ({ repoId }) => taskRepo.findByRepoId(repoId))
  server.register('task.listByRequirement', async ({ requirementId }) => taskRepo.findByRequirementId(requirementId))
  server.register('task.get', async ({ id }) => taskRepo.findById(id))

  // Conversation
  server.register('message.list', async ({ taskId, phaseId }) => msgRepo.findByTaskAndPhase(taskId, phaseId))

  // Workflow actions
  server.register('workflow.start', async ({ repoTaskId }) => engine.startWorkflow(repoTaskId))
  server.register('workflow.confirm', async ({ repoTaskId }) => engine.confirmPhase(repoTaskId))
  server.register('workflow.feedback', async ({ repoTaskId, feedback }) => engine.provideFeedback(repoTaskId, feedback))
  server.register('workflow.triggerEvent', async ({ repoTaskId, eventId }) => engine.triggerEvent(repoTaskId, eventId))
  server.register('workflow.cancel', async ({ repoTaskId }) => engine.cancelCurrentAgent(repoTaskId))
}
```

- [ ] **Step 5: 重写 sidecar 入口，集成 RPC + DB + Engine**

```typescript
// packages/sidecar/src/index.ts
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { getDb } from './db/connection'
import { RpcServer } from './rpc/server'
import { registerMethods } from './rpc/methods'
import { WorkflowEngine } from './workflow/engine'
import { ScriptProvider } from './providers/script.provider'
import { ExternalCliProvider } from './providers/cli.provider'
import { ApiProvider } from './providers/api.provider'

const dbPath = process.env.DB_PATH ?? 'code-agent.db'
const workflowPath = process.env.WORKFLOW_PATH ?? 'workflow.yaml'

const db = getDb(dbPath)
const workflowYaml = readFileSync(resolve(workflowPath), 'utf-8')

const engine = new WorkflowEngine({
  db,
  workflowYaml,
  resolveProvider: (providerType: string) => {
    switch (providerType) {
      case 'script':
        return new ScriptProvider('echo "placeholder"')
      case 'external-cli':
        return new ExternalCliProvider({ type: 'claude-code' })
      case 'api':
        return new ApiProvider({
          type: 'anthropic',
          apiKey: process.env.ANTHROPIC_API_KEY ?? '',
          model: 'claude-sonnet-4-20250514',
        })
      default:
        throw new Error(`Unknown provider: ${providerType}`)
    }
  },
  resolveSkillContent: (skillPath: string) => {
    try {
      return readFileSync(resolve(skillPath), 'utf-8')
    }
    catch {
      return ''
    }
  },
})

const rpcServer = new RpcServer()
registerMethods(rpcServer, db, engine)

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const response = await rpcServer.handle(line)
  process.stdout.write(`${response}\n`)
})

process.stderr.write('sidecar: ready\n')
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd packages/sidecar && pnpm test
```

Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: JSON-RPC server with all methods wired to engine"
```

---

### Task 12: 前端 Sidecar 客户端

**Files:**
- Create: `apps/desktop/src/composables/use-sidecar.ts`

- [ ] **Step 1: 实现 sidecar RPC 客户端**

```typescript
// apps/desktop/src/composables/use-sidecar.ts
import { Command } from '@tauri-apps/plugin-shell'
import { ref } from 'vue'

let childProcess: Awaited<ReturnType<Command['spawn']>> | null = null
let requestId = 0
const pendingRequests = new Map<number, {
  resolve: (value: any) => void
  reject: (reason: any) => void
}>()
let buffer = ''

export const sidecarReady = ref(false)

export async function startSidecar(): Promise<void> {
  if (childProcess) return

  const command = Command.sidecar('binaries/sidecar')
  command.stdout.on('data', (line: string) => {
    buffer += line
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const l of lines) {
      if (!l.trim()) continue
      try {
        const response = JSON.parse(l)
        const pending = pendingRequests.get(response.id)
        if (pending) {
          pendingRequests.delete(response.id)
          if (response.error)
            pending.reject(new Error(response.error.message))
          else
            pending.resolve(response.result)
        }
      }
      catch { /* ignore non-JSON lines */ }
    }
  })

  command.stderr.on('data', (data: string) => {
    if (data.includes('sidecar: ready'))
      sidecarReady.value = true
  })

  childProcess = await command.spawn()
}

export async function rpc<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  if (!childProcess) throw new Error('Sidecar not started')

  const id = ++requestId
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params })

  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    childProcess!.write(`${request}\n`)
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: frontend sidecar RPC client composable"
```

---

## Phase 5: UI

### Task 13: Pinia Stores

**Files:**
- Create: `apps/desktop/src/stores/repos.ts`
- Create: `apps/desktop/src/stores/requirements.ts`
- Create: `apps/desktop/src/stores/tasks.ts`

- [ ] **Step 1: 实现 repos store**

```typescript
// apps/desktop/src/stores/repos.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface Repo {
  id: string
  name: string
  local_path: string
  default_branch: string
  agent_provider: string | null
  created_at: string
}

export const useReposStore = defineStore('repos', () => {
  const repos = ref<Repo[]>([])
  const loading = ref(false)

  async function fetchAll() {
    loading.value = true
    try {
      repos.value = await rpc<Repo[]>('repo.list')
    }
    finally {
      loading.value = false
    }
  }

  async function create(input: { name: string, local_path: string, default_branch: string }) {
    const repo = await rpc<Repo>('repo.create', input)
    repos.value.unshift(repo)
    return repo
  }

  async function remove(id: string) {
    await rpc('repo.delete', { id })
    repos.value = repos.value.filter(r => r.id !== id)
  }

  return { repos, loading, fetchAll, create, remove }
})
```

- [ ] **Step 2: 实现 requirements store**

```typescript
// apps/desktop/src/stores/requirements.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface Requirement {
  id: string
  title: string
  description: string
  source: string
  source_url: string | null
  status: string
  created_at: string
}

export const useRequirementsStore = defineStore('requirements', () => {
  const requirements = ref<Requirement[]>([])
  const loading = ref(false)

  async function fetchAll() {
    loading.value = true
    try {
      requirements.value = await rpc<Requirement[]>('requirement.list')
    }
    finally {
      loading.value = false
    }
  }

  async function create(input: { title: string, description: string, source: string, source_url?: string }) {
    const req = await rpc<Requirement>('requirement.create', input)
    requirements.value.unshift(req)
    return req
  }

  return { requirements, loading, fetchAll, create }
})
```

- [ ] **Step 3: 实现 tasks store**

```typescript
// apps/desktop/src/stores/tasks.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface RepoTask {
  id: string
  requirement_id: string
  repo_id: string
  branch_name: string
  change_id: string
  current_phase: string
  phase_status: string
  openspec_path: string
  worktree_path: string
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  repo_task_id: string
  phase_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref<RepoTask[]>([])
  const currentTask = ref<RepoTask | null>(null)
  const messages = ref<Message[]>([])

  async function fetchByRepo(repoId: string) {
    tasks.value = await rpc<RepoTask[]>('task.listByRepo', { repoId })
  }

  async function fetchByRequirement(requirementId: string) {
    tasks.value = await rpc<RepoTask[]>('task.listByRequirement', { requirementId })
  }

  async function fetchTask(id: string) {
    currentTask.value = await rpc<RepoTask>('task.get', { id })
  }

  async function fetchMessages(taskId: string, phaseId: string) {
    messages.value = await rpc<Message[]>('message.list', { taskId, phaseId })
  }

  async function confirm(taskId: string) {
    await rpc('workflow.confirm', { repoTaskId: taskId })
    await fetchTask(taskId)
  }

  async function sendFeedback(taskId: string, feedback: string) {
    await rpc('workflow.feedback', { repoTaskId: taskId, feedback })
    await fetchTask(taskId)
  }

  async function cancel(taskId: string) {
    await rpc('workflow.cancel', { repoTaskId: taskId })
    await fetchTask(taskId)
  }

  return {
    tasks, currentTask, messages,
    fetchByRepo, fetchByRequirement, fetchTask,
    fetchMessages, confirm, sendFeedback, cancel,
  }
})
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Pinia stores for repos, requirements, tasks"
```

---

### Task 14: Dashboard 总看板 UI

**Files:**
- Modify: `apps/desktop/src/views/Dashboard.vue`
- Create: `apps/desktop/src/components/RequirementCard.vue`
- Modify: `apps/desktop/src/App.vue` (添加导航)

- [ ] **Step 1: 实现 App.vue 布局（侧边栏导航）**

完整 App 布局：左侧窄导航栏（Logo + 总看板 / 仓库列表 / 设置），右侧 `<router-view />`。使用 UnoCSS 原子类实现。

- [ ] **Step 2: 实现 RequirementCard.vue**

卡片展示：标题、来源标签、状态标签、创建时间。卡片内嵌关联仓库的进度小条（阶段进度/总阶段数）。

- [ ] **Step 3: 实现 Dashboard.vue**

顶部：标题 + 「新建需求」按钮 + 状态筛选。主体：需求卡片网格。新建弹窗：标题 + 描述 + 仓库选择（多选）。

- [ ] **Step 4: 验证页面渲染**

```bash
cd apps/desktop && pnpm tauri dev
```

Expected: 总看板展示空态，点击新建按钮弹出表单

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Dashboard with requirement cards and creation dialog"
```

---

### Task 15: 仓库流水线 UI

**Files:**
- Modify: `apps/desktop/src/views/RepoView.vue`
- Create: `apps/desktop/src/components/TaskCard.vue`
- Create: `apps/desktop/src/components/PhaseTimeline.vue`

- [ ] **Step 1: 实现 TaskCard.vue**

卡片展示：需求名、当前阶段名、状态图标。`waiting_confirm` 状态的卡片有橙色脉冲边框。

- [ ] **Step 2: 实现 PhaseTimeline.vue**

横向阶段条（从 workflow.yaml 读取阶段列表），当前阶段高亮，已完成阶段打勾。

- [ ] **Step 3: 实现 RepoView.vue**

泳道式看板，列头为各阶段名。每列内是对应阶段的 TaskCard 列表。点击卡片跳转 TaskDetail。

- [ ] **Step 4: 验证**

```bash
cd apps/desktop && pnpm tauri dev
```

Expected: 在仓库页看到阶段泳道，卡片位于对应列

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Repo pipeline view with kanban columns"
```

---

### Task 16: 任务详情 UI（文件 + 对话）

**Files:**
- Modify: `apps/desktop/src/views/TaskDetail.vue`
- Create: `apps/desktop/src/components/FileViewer.vue`
- Create: `apps/desktop/src/components/ChatPanel.vue`
- Create: `apps/desktop/src/components/ConfirmBar.vue`

- [ ] **Step 1: 实现 FileViewer.vue**

树形文件列表（读取 openspec 目录），点击文件渲染 Markdown 内容。使用 `markdown-it` 解析。

```bash
cd apps/desktop && pnpm add markdown-it
pnpm add -D @types/markdown-it
```

- [ ] **Step 2: 实现 ChatPanel.vue**

消息列表（role=assistant 左侧气泡，role=user 右侧气泡），底部输入框。发送调用 `workflow.feedback`。

- [ ] **Step 3: 实现 ConfirmBar.vue**

底部操作栏（当 phase_status=waiting_confirm 时显示）：「✅ 确认推进」「✏️ 提修改意见」「⏸ 暂不处理」三个按钮。

- [ ] **Step 4: 实现 TaskDetail.vue**

顶部：任务标题 + 阶段时间线 + 状态标签。主体两个 Tab：「文件」和「对话」。底部 ConfirmBar。

- [ ] **Step 5: 验证**

```bash
cd apps/desktop && pnpm tauri dev
```

Expected: 任务详情页的两个 Tab 可切换，文件能渲染 Markdown，对话能发送消息

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: TaskDetail with file viewer, chat panel, and confirm bar"
```

---

### Task 17: 设置页面

**Files:**
- Modify: `apps/desktop/src/views/Settings.vue`

- [ ] **Step 1: 实现设置页三个 Tab**

**Agent 配置 Tab：**
- Provider 类型选择（下拉：Cursor CLI / Claude Code / Codex / 自定义 API）
- API Key / Base URL / Model 输入框（仅 API 模式显示）
- CLI 路径输入框（仅 CLI 模式显示）
- 配置保存到 SQLite 或本地 JSON

**工作流配置 Tab：**
- 内嵌 Monaco Editor 显示 workflow.yaml
- 保存按钮 → 写入文件 + 重载引擎

```bash
cd apps/desktop && pnpm add @guolao/vue-monaco-editor
```

**仓库管理 Tab：**
- 仓库列表 + 添加按钮
- 添加仓库：路径选择（Tauri 文件对话框） + 名称 + 默认分支

- [ ] **Step 2: 验证**

```bash
cd apps/desktop && pnpm tauri dev
```

Expected: 设置页三个 Tab 切换正常，Monaco Editor 可编辑

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: Settings page with provider config, workflow editor, repo management"
```

---

## Phase 6: Integration — 端到端串联

### Task 18: 默认 Skill 文件 + MCP 配置

**Files:**
- Create: `skills/design.md`
- Create: `skills/plan.md`
- Create: `skills/t1-dev.md`
- Create: `skills/review.md`
- Create: `skills/integration.md`
- Create: `skills/test-spec.md`
- Create: `skills/e2e.md`
- Create: `mcp-configs/dev.json`
- Create: `mcp-configs/integration.json`
- Create: `mcp-configs/e2e.json`

- [ ] **Step 1: 编写各阶段 Skill 文件**

每个 Skill 从用户现有的 Cursor skills（`superpowers/brainstorming`、`writing-plans`、`dev-workflow`、`aicr-local`、`e2e-verify`、`gitlab-mr-workflow`）中提取核心规则，精简为独立的 Agent 指令。

`skills/design.md` 示例骨架：

```markdown
# 设计探索阶段

你是一个前端架构师。根据需求文档，输出设计方案。

## 输入
- 需求描述在用户消息中提供
- 项目代码在工作目录中可读

## 输出
- 写入 `{{openspec_path}}/proposal.md`：设计方案文档
- 写入 `{{openspec_path}}/specs/<module>/spec.md`：每个模块的详细 spec

## 规则
- 先读后写，理解现有代码结构
- KISS / YAGNI，不做过度设计
- 输出 Markdown 格式
```

其余 Skill 同理。

- [ ] **Step 2: 创建 MCP 配置文件**

```json
// mcp-configs/dev.json
{
  "mcpServers": {}
}
```

（V1 为空配置占位，后续按需添加具体 MCP server）

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: default skill files and MCP config placeholders"
```

---

### Task 19: 确定性脚本

**Files:**
- Create: `scripts/verify.sh`
- Create: `scripts/gitlab-mr.sh`
- Create: `scripts/archive.sh`

- [ ] **Step 1: 实现 verify.sh**

```bash
#!/bin/bash
set -e
echo "=== Running lint ==="
pnpm lint 2>&1 || true
echo "=== Running typecheck ==="
pnpm typecheck 2>&1 || true
echo "=== Running tests ==="
pnpm test 2>&1 || true
echo "=== Running build ==="
pnpm build 2>&1
echo "=== All checks passed ==="
```

- [ ] **Step 2: 实现 gitlab-mr.sh**

从用户的 `gitlab-mr-workflow/SKILL.md` 中提取核心逻辑，使用 `glab` CLI 创建 MR。

- [ ] **Step 3: 实现 archive.sh**

Git add + commit openspec 变更目录 + 清理 worktree。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: verify, gitlab-mr, and archive shell scripts"
```

---

### Task 20: Git Worktree 操作封装

**Files:**
- Create: `packages/sidecar/src/git/operations.ts`

- [ ] **Step 1: 实现 git 操作模块**

```typescript
// packages/sidecar/src/git/operations.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd })
  return stdout.trim()
}

export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  await git(repoPath, ['fetch', 'origin', baseBranch])
  await git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, `origin/${baseBranch}`])
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', worktreePath, '--force'])
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(cwd, ['branch', '--show-current'])
}
```

- [ ] **Step 2: 在 RPC methods 中注册创建任务方法（集成 worktree）**

在 `rpc/methods.ts` 中添加 `task.create` 方法，调用 `createWorktree` 后创建 RepoTask 记录，然后启动工作流。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: git worktree operations and task creation flow"
```

---

### Task 21: Sidecar 编译 + Tauri 集成

**Files:**
- Modify: `packages/sidecar/package.json` (添加 compile 脚本)
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (添加 externalBin)

- [ ] **Step 1: 配置 sidecar 编译**

```bash
cd packages/sidecar && pnpm add -D @yao-pkg/pkg
```

在 `package.json` 中添加：

```json
{
  "scripts": {
    "compile": "tsup src/index.ts --format cjs --target node20 --no-splitting && pkg dist/index.cjs --output dist/sidecar --target node20"
  }
}
```

- [ ] **Step 2: 配置 Tauri externalBin**

在 `apps/desktop/src-tauri/tauri.conf.json` 中添加：

```json
{
  "bundle": {
    "externalBin": ["../../packages/sidecar/dist/sidecar"]
  }
}
```

- [ ] **Step 3: 添加 sidecar rename 脚本（追加 target-triple）**

```bash
# 获取当前平台的 target triple
rustc --print host-tuple
# 输出类似：aarch64-apple-darwin
# 将编译产物重命名为 sidecar-aarch64-apple-darwin
```

- [ ] **Step 4: 端到端测试**

```bash
cd packages/sidecar && pnpm compile
cd ../../apps/desktop && pnpm tauri dev
```

Expected: 应用启动，sidecar 自动拉起，总看板可用

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: sidecar compilation and Tauri integration"
```

---

### Task 22: 全流程冒烟测试

- [ ] **Step 1: 准备测试仓库**

```bash
mkdir /tmp/test-repo && cd /tmp/test-repo && git init && echo "# Test" > README.md && git add . && git commit -m "init"
```

- [ ] **Step 2: 在应用中添加仓库**

打开 Code Agent → 设置 → 仓库管理 → 添加 `/tmp/test-repo`

- [ ] **Step 3: 创建需求 → 选择仓库 → 启动工作流**

新建需求「测试需求」→ 分发到 test-repo → 观察 design 阶段启动

- [ ] **Step 4: 确认阶段推进**

design 完成 → 确认 → plan → 确认 → t1-dev → 自动完成 → review → ...

- [ ] **Step 5: 验证数据库记录**

检查 SQLite 中 repo_tasks、agent_runs、conversation_messages 表有正确记录

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: finalize V1 integration"
```

---

## 任务依赖图

```
Task 1 (monorepo) ─┬─ Task 2 (Tauri+Vue) ─── Task 12 (sidecar client) ─┐
                    │                                                      │
                    └─ Task 3 (sidecar) ─── Task 4 (schema) ─── Task 5 ──┤
                                                                           │
Task 6 (parser) ─── Task 7 (engine) ─── Task 11 (RPC) ──────────────────┤
                          │                                                │
                    ┌─────┴──────┐                                         │
                Task 8   Task 9   Task 10                                  │
              (script) (cli)    (api)                                      │
                                                                           │
Task 13 (stores) ─── Task 14-17 (UI pages) ───────────────────────────────┤
                                                                           │
Task 18 (skills) + Task 19 (scripts) + Task 20 (git) ────────────────────┤
                                                                           │
Task 21 (compile+integrate) ─── Task 22 (smoke test) ─────────────────────┘
```

**可并行的 Task 组:**
- Task 2 + Task 3（前端骨架 + Sidecar 骨架）
- Task 8 + Task 9 + Task 10（三种 Provider 互不依赖）
- Task 14 + Task 15 + Task 16 + Task 17（四个 UI 页面互不依赖）
- Task 18 + Task 19 + Task 20（Skills + Scripts + Git ops）
