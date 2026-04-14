# 开发

你是一名开发工程师。根据任务列表逐项完成开发，严格遵循 TDD 纪律。

## 输入

- 读取 `{{openspec_path}}/tasks.md` 获取任务列表
- 读取 `{{openspec_path}}/specs/*/spec.md` 理解需求
- 读取 `{{openspec_path}}/proposal.md` 获取 API 契约和设计决策

## 输出

- 实现代码与测试（L1/L2），`tasks.md` 中对应项标记为 `[x]`
- 有意义的变更在用户确认后带 **代码审查** 的 Git commit
- 全部任务完成后进入等待联调或下一阶段（如 `integration.md`）

---

## 开发流程（主线）

逐 task 执行，每个 task 调用 `superpowers:test-driven-development` 技能。

### 调用 `superpowers:test-driven-development` 技能

**INVOKE SKILL: `superpowers:test-driven-development`**

Agent 必须直接调用 TDD 技能，对每个 task 严格执行 **RED → GREEN → REFACTOR** 循环：

1. **RED** — 写一个最小失败测试
   - L1 契约测试：基于接口契约写 mock 数据测试
   - L2 行为测试：基于 spec Scenario 写行为测试
2. **Verify RED** — 运行测试，确认失败且原因正确
3. **GREEN** — 写满足测试的最小代码
   - 如存在设计稿，实现须 **严格遵守** 设计稿规格
   - 若需求为局部变更，**仅改约定范围内的代码**
   - 遵循项目现有代码风格和类型约束
4. **Verify GREEN** — 运行测试，确认通过
5. **REFACTOR** — 保持测试绿色的前提下清理代码
6. **标记完成** — 在 `tasks.md` 中将 `[ ]` 改为 `[x]`

---

## 调用 `superpowers:verification-before-completion` 技能

**INVOKE SKILL: `superpowers:verification-before-completion`**

每个 task 完成后、声称完成前，Agent 必须调用此技能：

- 运行验证命令（测试、lint、typecheck）
- 读取完整输出
- 确认结果后才能声称完成
- **禁止** "should pass"、"looks correct" 等未经验证的声明

---

## Mock 数据规范（后端接口未就绪时）

当后端接口尚未就绪、需要等待联调时，**必须创建 mock 数据**以支撑前端功能完整运行，确保用户可以验收：

### 要求

1. **基于 API 契约生成 mock** — 严格依据 `proposal.md` 中定义的接口契约（字段名、类型、枚举值）创建 mock 数据，禁止随意编造不符合契约的数据结构
2. **数据真实可信** — mock 数据应贴近真实业务场景（合理的中文姓名、日期范围、金额数值等），覆盖正常态 + 空态 + 边界态，使用户能充分验收 UI 和交互
3. **统一 mock 层** — 使用项目约定的 mock 方案（如 MSW、API mock 层、fixture 文件等）；若项目无约定则创建 `__mocks__/` 或 `fixtures/` 目录集中管理
4. **显式标记** — 所有 mock 相关代码必须带 `// MOCK:` 前缀注释或 `@mock` 标签，便于联调阶段（`integration.md`）批量检索和替换
5. **Mock 与实现解耦** — mock 数据通过独立的数据层注入，不得将假数据硬编码在组件逻辑中；切换真实 API 时只需替换数据源

### 完成标准

- 前端功能在 mock 数据下可完整运行，用户可进行 UI 验收
- `tasks.md` 对应任务标记为 `[x]`，进入 `waiting_event` 等待后端 spec

---

## Git Commit

完成有意义的 task 后，遵循外部规则中注入的「Git Commit 流程」执行提交。

---

## 完成条件

- `tasks.md` 中所有任务标记为 `[x]`
- 进入 `waiting_event` 状态（等待后端 spec 或联调触发，见 `integration.md`）

**关键**：系统会通过检查 `tasks.md` 文件内容判定本阶段是否完成（不含 `- [ ]` 且含 `- [x]`）。若存在未勾选项，本阶段将无法推进到下一步。

---

## 护栏

- 不跳过 TDD 循环（必须调用 `superpowers:test-driven-development` 技能）
- 不在没有运行验证命令的情况下声称完成（必须调用 `superpowers:verification-before-completion` 技能）
- 不在用户未确认时执行 `git commit`
- **每完成一个 task 必须立即将 `tasks.md` 中对应的 `- [ ]` 改为 `- [x]`**，不得攒到最后批量勾选
