# Spec 落盘

将需求内容结构化为 OpenSpec 变更目录下的 `proposal.md` 与 `specs/*/spec.md`，作为后续任务拆分与开发的基础。本阶段是任务规划的第一步，Agent 根据需求描述完成 Spec 文档的生成。

---

## 输入

- 需求标题与描述内容（来源：需求看板中的需求记录）
- 需求关联的文档链接（如有）

---

## 执行步骤

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
