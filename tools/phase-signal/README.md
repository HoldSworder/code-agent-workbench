# phase-signal

报告当前阶段的步骤级进度，控制用户界面是否显示"进入下一阶段"推进按钮。

## 注入条件

始终注入。

## 依赖

- Node.js

## 命令

| 命令 | 说明 |
|------|------|
| `update` | 写入/更新进度信号文件 |
| `read` | 读取当前信号（无信号时返回 `{"status":"no_signal"}`） |
| `clear` | 清除信号文件 |

## 用法

```bash
node run.mjs --dir <worktree_path> --phase <phase_id> [options] <command>
```

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--dir` | 是 | 工作目录路径 |
| `--phase` | update 时必填 | 阶段 ID |
| `--status` | 否 | `in_progress`（默认）、`ready`、`blocked` |
| `--step` | 否 | 步骤进度，如 `"2/7"` |
| `--step-name` | 否 | 步骤名称，如 `"逐个澄清需求"` |
| `--reason` | 否 | 状态原因 |

## 信号文件

写入到 `<worktree>/.code-agent/phase-signal.json`，引擎通过 `readPhaseSignal()` 读取此文件判断 blocked 状态。

## status 语义

| 值 | 用户界面效果 |
|----|-------------|
| `in_progress` | 隐藏推进按钮，显示"继续完成本阶段" |
| `blocked` | 同上，附带阻塞原因 |
| `ready` | 显示"确认并进入下一阶段"按钮 |
