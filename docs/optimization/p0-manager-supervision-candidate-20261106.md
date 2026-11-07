# P0 Manager 监督规则候选 · 2026-11-06

按 P0.3 观察口径 → P0.2 未改规则的组合回归 → P0.1 规则分层及复测执行。Manager 已独立审查规则拆分、锚点、Worker 契约和改动范围；队列组合测试已按审查意见修正并通过。

- [观察表](p0-observation-template.md)复用现有 timeline、metrics、日志。本批仅离线；自然两轮、加载、采用、时间及 Token 收益均为 `unknown`。
- [监督核心](../../skills/manager-session/references/manager-supervision.md)用于正常监督。[按需参考](../../skills/manager-session/references/manager-supervision-reference.md)用于不熟悉宿主、异常结构或参数/能力核对。保留原标题锚点和固定模板。核心 3,879 B，超过 3 KiB 目标；保留完整行为约束。
- [组合回归](../../test/p0-coordination-flow.test.mjs)使用实际监督计划、wait 模板、隔离 fixture 与现有 Manager 操作入口。双 Worker 乱序提交后由 checkpoint 补回漏通知项，按实际 FIFO 队首领取；非队首拒绝且状态不变。原 receive 重试只保留一次审查，另一任务继续待审。执行中/返工发现及过滤用例也通过。

首次在受限沙箱运行同一测试集，拆分前 42 通过 / 20 失败 / 0 skip，拆分后 43 通过 / 20 失败 / 0 skip，均退出 1。相同 20 个失败：19 个提交恢复 fixture 遇到硬链接 EPERM，1 个 queue_first fixture 初始化报 STORAGE_ERROR；独立文件探针复现 EPERM。

Manager 在支持硬链接的隔离环境独立运行 9 个相关测试文件：128 通过、1 失败（旧组合用例尝试跳过 FIFO 队首）、0 跳过，19 个提交恢复用例已通过。修正测试后，仅重跑组合文件：2 通过、0 失败、0 跳过，退出 0。其他 127 个已通过用例沿用 Manager 证据；未重跑整套。无需修改 Runtime。

未安装；未改变当前模式、生产状态、模板、Manager 操作实现及 Worker/Liaison 契约。回退候选时由 Manager 依据基线清单恢复本批修改并移除本批新增文件，保留原工作区其他修改及所有业务事实。审查证据仅在本地任务交付目录保留，不随源码上传。
