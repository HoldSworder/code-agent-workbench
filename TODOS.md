# TODOS

## CLI 输出格式契约测试

**Priority:** Medium
**Added:** 2026-04-09 (plan-eng-review)

为 claude-code / cursor-cli / codex 各写一个 snapshot test，验证它们的输出格式在 CLI 升级后仍可被 `parseLeaderDecision()` 和 `ExternalCliProvider` 正确解析。

**Why:** Leader 的 JSON 解析和 Worker 的输出收集都依赖外部 CLI 的输出格式。CLI 版本升级可能静默改变输出结构，导致解析失败但无明确错误提示。

**Approach:** 用真实 CLI 运行一个最小 prompt，snapshot 输出结构的关键字段。CI 中标记为 skip（需要 API key），手动运行验证。

**Depends on:** Phase 1 orchestrator 完成后。

## 验收拒绝 Feedback 传递机制

**Priority:** Medium
**Added:** 2026-04-09 (plan-eng-review)

设计 Leader 在重新处理被拒需求时如何消费之前的拒绝原因。`rejectRun(runId, feedback)` 的 RPC 接口已确定（12B 决策），但 feedback 如何注入 Leader prompt 需要细化。

**Why:** 没有 feedback 的重试只会重复同样的错误，导致"拒绝→重试→再拒绝"死循环。

**Approach:** `orchestrator_runs` 表增加 `reject_feedback` 字段。Leader 抢占需求时查询最近一次 status=rejected 的 run，将 feedback 追加到 Leader 的上下文输入中（作为"上次被拒绝的原因"section）。

**Depends on:** Phase 1 基础功能完成。
