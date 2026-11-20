---
name: watchdog
description: Use when the user explicitly asks to enable, disable, inspect, or check the Team Runtime Watchdog for an identified team state.
---

# Watchdog 管理

仅管理用户明确指定的团队；先确认 Runtime 候选路径和团队 `state.json` 的真实路径。管理 Skill 不承担常驻巡检。

从已确认的 Runtime 目录调用 Node CLI，参数作为数据传入：

| 用户意图 | 命令 |
| --- | --- |
| 开启 | `node src/cli.mjs watchdog-on <state.json>` |
| 关闭 | `node src/cli.mjs watchdog-off <state.json>` |
| 状态 | `node src/cli.mjs watchdog-status <state.json>` |
| 检查一次 | `node src/cli.mjs watchdog-check <state.json>` |

默认读取紧凑状态。仅在排查具体异常并确有需要时使用 `watchdog-status <state.json> --detail`，不常规带回全部历史。

- 开关默认 true，但 enabled 不等于进程存活、宿主可用或已开始监控。
- 检查一次遵守持久关闭状态，不顺带开启，不发送“正常”确认消息。
- 报告 `phase`、`monitoring`、`lastFault`、待提醒/未决投递计数与宿主 unknown；不得将 CLI 成功、queued 或 pending 写成已消费、已处理或已验收。
- 不调用 Worker，不增加其启动、恢复、汇报材料或模型轮次；不做派工、重派、取消、批准或业务修复。
- 不自行启动 `watchdog-serve`、安装 Skill/服务、添加 autostart、抢占/删除遗留锁、改宿主配置或切换投递通道。现有授权范围内的管理命令无需重复确认。
- 发送仅支持显式deployment注册的固定实测local queue提醒pair；可信生产业务执行摘要仍未接入。能力、日志版本或绑定不符就保留pending/unknown，不能换普通消息发送兜底。

候选边界与命令参考：[Watchdog P0 candidate](../../docs/watchdog-p0-candidate-20261116.md)。

最新候选支持用户显式本地deployment manifest，只允许固定实测local queue提醒pair；不是任意消息JSON可声明safe。用户明确要求带部署配置检查时可使用 `node src/cli.mjs watchdog-check <state.json> --deployment <manifest.json>`。只有另有明确前台运行授权时才使用 `watchdog-serve <manifest.json>`；不因开关开启自动安装或启动服务。当前精确能力与未验证项以[deployment候选](../../docs/watchdog-deployment-candidate-20261116.md)为准。


本地安装时先读同目录 `runtime-root.json` 中的独立版本Runtime路径，再按该目录的安装manifest核对；不得把当前cwd或运行中的MCP companion视为本Skill安装目标。安装/回退参考：[本地安装](references/installation.md)。安装完成不等于服务已启动或已接入任何团队。

## 后台常驻正式入口

用户已授权后台巡检时，使用独立Runtime的 `watchdog-background-start <production-manifest.json> <control-root>`；状态/停止分别为 `watchdog-background-status <control-root>` / `watchdog-background-stop <control-root>`。已有授权不重复确认，不将其解释为登录自启、修改MCP或接管历史任务。保持每队newtasks-only cutover；mode和pendingReason必须逐队说明，observe-only不能写成已验证可提醒。正常停止使用owner控制端点，不杀其他node、不删锁。详见[后台分级与cutover](../../docs/watchdog-background-production-20261116.md)。
