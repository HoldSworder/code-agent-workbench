# workflow-nav

查询工作流的全局结构、当前位置和可用导航路径。

## 注入条件

始终注入（当 `workflowStages` 和 `currentStageId` 上下文存在时）。

## 依赖

- Node.js

## 命令

| 命令 | 说明 |
|------|------|
| `current` | 返回当前 stage/phase 位置和信息 |
| `map` | 返回完整工作流地图，标记当前位置 |
| `next` | 返回下一个可能的 phase 及条件 |

## 用法

```bash
node run.mjs --config <base64_json> --current-stage <stage_id> --current-phase <phase_id> <command>
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--config` | 是 | Base64 编码的工作流 stages JSON |
| `--current-stage` | 是 | 当前 stage ID |
| `--current-phase` | 是 | 当前 phase ID |
| `--dir` | 否 | 工作目录路径（可选上下文） |

## 设计说明

不直接解析 `workflow.yaml`（避免 YAML 库依赖），而是由 `.tool.ts` 在 prompt 生成时将 `workflowStages` 编码为 base64 JSON 传入。
