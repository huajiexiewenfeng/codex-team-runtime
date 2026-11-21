# Watchdog execution P0：证据边界候选（2026-11-20）

后续 A/B 证据和本地 Desktop 接线见 [当前候选](watchdog-desktop-execution-20261120.md)。下文记录接线前的证据边界。

## 结论

**生产结束/同执行冲突检测仍被真实原生关联缺口阻塞，不能启用。** 本候选完成能力诊断、防误报加固和入口离线回归，不是已实现可用的生产 ended-without-submission，也没有生产 native task/execution→turn 的已认证 provider。

从 a9f1369310805028295d3e8567b1483e77f4de1c 创建独立 worktree：
C:/Users/admin/Documents/New project 2/artifacts/watchdog-execution-p0-20261120
分支 codex/watchdog-execution-p0-20261120。未改原集成工作区内容，未安装、合并、提交或推送。

## 已核实的真实证据范围

当前真实发送工具入参为 threadId/可选hostId/prompt，模型参数可选；返回类型为通用 CallToolResult，并未声明可信 task/execution→turn 关联。read_thread/wait_threads以聊天为查询对象，也不接受业务 execution 选择器。

留存的原生发送回执仅返回 threadId：
C:/Users/admin/Documents/New project 2/artifacts/dispatch-host-validation-20261117/native-dispatch-result.raw.json
SHA256 9861ac454b571c974b123217b718af4c6e01b1bb24d760142a375c51d9b9216e

同一隔离验证的后续wait样本虽包含turnId，却没有宿主生成的任务/执行关联：
C:/Users/admin/Documents/New project 2/artifacts/dispatch-host-validation-20261117/actual-dispatch-evidence.json
SHA256 5b4e266831e0d3b48f1d87fa96ffaa2d8900fc5e4a929ad5a38fc60ef126c321

程序审计明确得到：sendHasTurnId=false、sendHasExecutionId=false、observationTurnIdsPresent=true、observationHasTaskExecutionBinding=false、correlationVerified=false。程序没有使用回复正文、时间匹配或latestTurn做关联。原始审计文件在仓库外的watchdog-native-evidence-audit-20261120.json。

已有本地queue日志回执验证的是 kind=reminder、目标Manager 的提醒消费/完成。其 nativeReminderTurnId 不能转用为 Worker 业务执行turn，即使提醒context带taskId/executionId。现有固定派发的程序attemptId也不能自己认证原生turn。没有把合成ID或fixture facts登记为生产关联。

## 本批实现

- watchdogStatus增加只读executionCapability，明确status=unavailable、reason=no-verified-task-turn-provider，两个生产检查仍unsupported。没有新增持久化store字段或迁移。
- 生产/manual来源不接受fixture adapter；任意对象、safe=true和手填完整ID也不能获取原生信任，且不会被查询。
- 缺字段、重复/矛盾facts、无效生命周期和reader异常降级unknown，不把这类观察失败升级成原生执行异常，也不妨碍其他账本检查。
- 复用taskProgress的current blocker投影。reportBlocker本身不改变task.status；因此executing/rework且已有未处理Worker blocker，不得报“ended without submission”。当前execution之后已有submit也不按无回执处理。
- 不增加same-execution-host-conflict规则：submitted/reviewing + running可以合法共存，重复且互相矛盾的输入是关联不明，不是可证明的生产异常。
- 沿用原异常key、去重、cooldown、intent/unknown保护及通知，不新增第二条发送路径；测试正例保持fixture-host，不能提升生产信任。
- 未改Worker启动/恢复/MCP/提交调用、固定派发、任务状态机、准入、业务state或Registry，无团队例外。未读取三个业务团队，未调用真实send/read_thread/wait_threads。

## 验证

新增13项入口回归明确分开：
- 生产CLI/手填生产事实：保持unknown，不查询宿主、不改业务文件；
- fixture-only正例、宽限、重启去重、晚提交、rework新旧轮次、错误目标/重绑、notLoaded、缺字段/重复/矛盾、blocker、reader故障；
- submitted+running无冲突，Worker可正常提交。

受影响Watchdog回归88项通过、0失败、0跳过。日志在仓库外watchdog-execution-regression-20261120.log。最初失败日志保留；新增测试夹具最初遗漏blocker.evidenceRef已修正。

额外用a9f1369原模块与候选作纯合成差分：同一executing + Worker blocker + fixture完成事实，旧模块误报1条，新模块0条，业务快照字节未变。证据watchdog-blocker-control-20261120.json。**这不是生产结束检测正例。**

Worker/固定派发相关文件相对基线diff=0。没有新Worker调用、LLM轮次、后台probe或服务启动。

## 后续隔离验证的必要条件

在任何生产启用前，需要父Manager另行授权独立隔离测试，取得下列一种真实、可重放核验的关联机制：

1. 宿主实际发送回执提供具有明确因果语义的turnId或request/delivery ID；原生started/terminal证据引用同一ID。程序在原固定发送入口记录真实结果，绑定准确team/round/task/execution/dispatch attempt及当前/历史Worker完整binding。不能由Manager手填关联事实。
2. 或经独立验证的精确Worker原生日志协议，能用程序发送的唯一受控payload、发送前不可变baseline、原生消息provenance/turn attribution建立关联。现有Manager reminder queue profile不能自动授权这一用途；不能只匹配nonce、正文语义或时间接近。

还必须验证：
- native completion确属同一当前执行/原生turn，旧轮、重绑、重试attempt和coalesced多消息均排除；
- 源版本、binding revision、日志身份/边界与独立native生命周期可核验，任何缺失/重复/未知元数据保持unknown；
- 足够宽限后仍executing/rework，且没有当前execution回执、未处理blocker；发送前再次核对；
- 正例、晚提交、故障降级、重启与去重；消息消费/原生turn结束不等于业务验收；
- 同执行冲突只能基于独立且有明确定义的原生不变量，而不是业务状态与generic running的对比。

当前缺的是这层真实关联证据，不是时间阈值。增加等待、读最新轮次或编造turn ID都不能补齐。监控侧不能借此暂停/重派/修改任务。
