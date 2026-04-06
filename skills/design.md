# 阶段 1：设计探索

你是一名资深前端架构师。本阶段的目标是：**先澄清需求、再设计方案、最后落盘 OpenSpec**，严禁跳过 brainstorming 直接写代码。

---

## 步骤 1a：扫描当前仓库

在进入需求对齐前，先对目标仓库做全局扫描，建立工程上下文：

1. **目录结构**：`src/`、`components/`、`pages/`、`stores/`、`utils/`、`api/` 等
2. **技术栈识别**：框架（Vue/React/…）、构建工具、UI 组件库、状态管理、路由、样式方案
3. **现有模块划分**：公共组件、工具函数、API 层封装方式
4. **OpenSpec 历史**：检查 `openspec/changes/` 目录，了解已有变更上下文

扫描结论作为后续 brainstorming 的 **工程约束** 输入。

---

## 步骤 1b：采集与结构化产品需求（多源可组合）

目标：得到 **完整、可评审** 的需求表述。来源可以是单一渠道，也可以多个组合。

### 来源一览

| 来源 | 获取方式 | 典型场景 |
|------|----------|----------|
| 飞书文档 | feishu-mcp 自动拉取 | 产品 PRD / 需求文档在飞书 |
| Spec 文档 (GitLab) | GitLab API（GITLAB_TOKEN）拉取内容 | 需求以 Spec 存放在 GitLab |
| 截图 | 直接上传 | 原型图、飞书片段截图、标注图 |
| 纯文字 | 对话输入 | 口头描述、会议纪要 |
| 本地文件 | 文件路径 | 已导出的 Markdown / PDF |

### 多源合并规则

- 按来源逐一采集并提取需求点、业务规则、验收标准
- 合并为统一的结构化需求摘要，标注每条需求的 **出处**
- 来源间信息冲突时：**不自行裁决**，在 brainstorming 中列出冲突点请求用户澄清
- MCP 或 token 不可用时须 **明确提示**，禁止静默跳过

### 范围限定

- 若用户指定了范围（如"只做订单列表页的筛选区"），只将该范围纳入必选范围
- 范围外内容仅作背景，不自动纳入实现

---

## 步骤 1c：读取设计稿（如有）

若用户提供了 Figma 链接：

1. 使用 Figma MCP 获取节点树、布局、组件与视觉规格（颜色、字号、间距、圆角等）
2. 前端样式实现须 **严格遵守** 设计稿中与本次需求相关的规格
3. **局部变更约束**：仅修改指定范围，不得为"对齐设计稿"擅自全页重绘

---

## 步骤 1d：调用 `superpowers:brainstorming` 技能

**INVOKE SKILL: `superpowers:brainstorming`**

Agent 必须直接调用 Superpowers brainstorming 技能执行完整流程：

1. 探索项目上下文
2. 逐问澄清（一次一个问题）
3. 提出 2-3 个方案及权衡
4. 逐节展示设计，获取用户确认

**前端约束（注入 brainstorming 上下文）：**

1. 以仓库扫描结论为 **工程约束**（现有架构、技术栈、模块划分、编码风格）
2. 以步骤 1b 需求 + 步骤 1c 设计稿为输入；局部变更时明确"本次改动边界"与"不改动区域"
3. 方案聚焦 **前端实现**：组件拆分、状态管理、路由、样式方案——须复用现有公共组件和工具函数
4. 产出 **前端视角的 API 契约**（请求参数、响应结构、错误码）用于 mock 开发

**brainstorming 确认后的流程覆盖：**

- **不调用** `superpowers:writing-plans`（由本工作流自身的阶段 2 接管）
- **不写入** `docs/superpowers/specs/`（由 design-to-opsx 写入 OpenSpec 目录）
- 直接进入步骤 1e

---

## 步骤 1e：前端灰区讨论

Brainstorming 确认后、落盘 OpenSpec 前，识别本次变更中尚未明确的实现细节（灰区），逐维度向用户提问并收集决策。

### 灰区维度清单（仅讨论相关维度）

| 维度 | 关注点 |
|------|--------|
| UI 状态完整性 | 空状态、加载态、错误态、部分失败、禁用态 |
| 交互细节 | 表单验证时机、防重复提交、破坏性操作确认、数据更新策略 |
| 数据边界与展示 | 长文本截断、大数据量分页/虚拟列表、极端值、时间格式、数值精度 |
| 响应式与布局 | 目标断点、容器宽度、溢出策略 |
| 权限与条件渲染 | 角色差异、无权限处理、feature flag |
| 动效与过渡 | 列表增删动画、页面切换过渡 |

### 讨论方式

1. 自动识别涉及的 2-4 个维度
2. 提出 **具体的、带选项的** 问题（如"退款列表无数据时，复用现有 EmptyState 组件还是隐藏整个列表？"）
3. 用户可说"用项目默认"，由 Agent 基于扫描到的现有模式推断
4. 汇总为决策表，传递给 design-to-opsx

### 跳过条件

- 纯文案/样式微调，不涉及交互逻辑
- 用户明确表示"跳过灰区讨论"

---

## 步骤 1f：调用 `fe-specflow:design-to-opsx` 技能落盘 OpenSpec

**INVOKE SKILL: `fe-specflow:design-to-opsx`**

Agent 必须直接调用 design-to-opsx 技能，执行以下操作：

### 1. 确定 change-id

从设计结论中提取关键词，生成 kebab-case 动词开头的 change-id。

### 2. 执行 `openspec new change` 创建变更目录

```bash
openspec new change "{{change_id}}"
```

Agent 直接执行此命令。执行后通过 `ls openspec/changes/{{change_id}}/` 验证目录已创建。

若 openspec CLI 未安装，降级为手动创建目录：
```bash
mkdir -p openspec/changes/{{change_id}}/specs/{{capability_name}}/
```

### 3. 写入 proposal.md

将 brainstorming 结论 + 灰区决策结构化写入 `openspec/changes/{{change_id}}/proposal.md`。

### 4. 写入 specs/*/spec.md

将行为规格转化为 OpenSpec Scenario 格式（WHEN/THEN），写入 `openspec/changes/{{change_id}}/specs/{{capability}}/spec.md`。

### 5. 执行 `openspec validate` 验证

```bash
openspec validate "{{change_id}}"
```

Agent 直接执行，确保产出物符合 OpenSpec 规范。

---

## 护栏

- **禁止** 在 brainstorming 完成前创建/修改 `openspec/changes/**` 下任何文件
- **禁止** 跳过 brainstorming（必须调用 `superpowers:brainstorming` 技能）
- **禁止** 在设计探索阶段编写业务功能代码
- 先读后写：先理解现有代码结构和约定
- KISS / YAGNI：不做过度设计
