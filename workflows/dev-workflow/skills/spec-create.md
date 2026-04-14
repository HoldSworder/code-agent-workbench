# 需求对齐 & Spec 落盘

先通过 Brainstorming 与用户对齐需求理解和设计方案，再将共识结构化为 OpenSpec 变更目录下的 `proposal.md` 与 `specs/*/spec.md`，作为后续任务拆分与开发的基础。

---

## 输入

- 需求标题与描述内容（来源：需求看板中的需求记录）
- 需求关联的文档链接（如有）

---

## 执行步骤

### Step 0: 需求对齐（Brainstorming）

在写任何 OpenSpec 文档之前，先通过 `superpowers:brainstorming` 技能与用户对齐需求理解。

**优先级声明：本 skill 中的覆盖约定优先于 brainstorming 技能原流程中的冲突指令。**

**调用 brainstorming 技能时，仅执行以下 4 步，跳过其余流程：**

1. **探索项目上下文** — 检查代码结构、现有模块、技术栈、近期提交，理解当前项目状态；如果需求关联了飞书文档链接（`doc_url`），先通过 `lark-cli` 获取文档正文作为需求理解的核心输入
2. **逐个澄清需求** — 一次只问一个问题，优先使用选择题；聚焦于：目的、约束、验收标准
3. **提出 2-3 个实现方案** — 附带优劣对比和推荐理由
4. **用户确认设计方案** — 获得用户明确同意后，进入后续 OpenSpec 落盘步骤

**覆盖约定（以下 brainstorming 原流程步骤在本阶段不执行）：**

- **不写入** `docs/superpowers/specs/` 目录 — 设计共识直接体现在 proposal.md 的 Why / What Changes 章节中
- **不调用** `writing-plans` 技能 — 由后续的任务拆分阶段替代
- **不执行** spec review loop — 由 `openspec validate` 替代

---

### Step 1: 创建变更目录

```bash
openspec new change "{{change_id}}"
```

此命令仅创建 `openspec/changes/{{change_id}}/` 目录和 `.openspec.yaml` 配置文件，不生成内容文件。

### Step 2: 查看 proposal 模板与指令

```bash
openspec instructions proposal --change "{{change_id}}"
```

该命令输出 proposal artifact 的详细创建指令和模板结构，Agent 按此指令填写。

### Step 3: 编写 proposal.md

根据需求内容和 `openspec instructions` 输出的模板，将需求结构化写入：

```
openspec/changes/{{change_id}}/proposal.md
```

proposal.md 须包含以下章节：
- **Why**：变更动机与要解决的问题
- **What Changes**：具体变更内容
- **Capabilities**：新增或修改的能力点（每个 capability 用 kebab-case 命名，后续对应 `specs/<name>/spec.md`）
- **Impact**：影响范围

### Step 4: 查看 specs 模板与指令

```bash
openspec instructions specs --change "{{change_id}}"
```

### Step 5: 编写 specs

根据 proposal 中列出的 Capabilities，为每个 capability 创建对应的 spec 文件：

```
openspec/changes/{{change_id}}/specs/<capability>/spec.md
```

spec.md 使用 WHEN/THEN Scenario 风格描述行为规格：
- 使用 `## ADDED Requirements` / `## MODIFIED Requirements` 等 delta 操作
- 每个 requirement 下至少包含一个 `#### Scenario`
- Scenario 使用 `- **WHEN** ...` / `- **THEN** ...` 格式

### Step 6: 编写 design.md（按需）

如果变更涉及跨模块架构、新依赖引入、数据模型变更等复杂场景，可选创建 design 文档：

```bash
openspec instructions design --change "{{change_id}}"
```

写入 `openspec/changes/{{change_id}}/design.md`，记录关键技术决策与方案选型。

简单变更可跳过此步骤。

### Step 7: 校验

```bash
openspec validate "{{change_id}}"
```

确保所有产出符合 OpenSpec 规范。

### Step 8: 确认产出状态

```bash
openspec status --change "{{change_id}}"
```

确认 `proposal` 和 `specs` 至少已完成。

---

## 输出

1. `openspec/changes/{{change_id}}/proposal.md`
2. `openspec/changes/{{change_id}}/specs/<capability>/spec.md`（至少一个）
3. `openspec/changes/{{change_id}}/design.md`（可选）

---

## 降级策略

若 `openspec` CLI 未安装，手动创建等价目录结构：

```bash
mkdir -p openspec/changes/{{change_id}}/specs/{{capability_name}}/
```

然后手动编写 `proposal.md` 和 `specs/*/spec.md`。

---

## 护栏

- **禁止** 在用户确认前写入 `openspec/changes/**` 下任何文件
- **禁止** 在本阶段编写业务功能代码；本阶段仅产出 OpenSpec 文档
- 先读后写：确认 `openspec/changes/` 下无重复 change-id 冲突
- KISS / YAGNI：proposal 与 spec 场景以可验证、可测试为界，避免堆砌无关场景
