# Manager 入口与召回展示候选

已确认的 Manager 身份优先于普通开发流程。“继续”“开始开发”“修复”沿用现有分工：Manager 通过已授权的运行时把实施工作交给正式 Worker；普通咨询、只读调查和获授权的独立验收仍可进行。用户明确调整分工时遵从其当前指令。有效上下文直接复用；缺失、过期或冲突时沿用现有召回检查点。已有交接摘要只保留身份、团队、职责边界和恢复引用。

一次召回事故中，MCP 已返回 active Manager 和规则正文，但调用端只输出了 team、role、status、statePath。候选改用固定 `functions.exec` 模板，在原有检查点以经核验的当前线程身份调用一次 `team_context.read`，核对返回的绑定，再向模型输出共享规则、角色职责、Manager 指引和必要的身份、接入与禁止派发字段。默认省略全员名册及 onboarding 证明；保留 onboarding 状态。模板接受单一 JSON text envelope 或同结构的 structuredContent，错误正文和非投影字段不会回显。缺少必要字段、身份不符或超限时输出明确的未恢复信号；规则正文完整输出或整体拒绝，不截断。恢复成功不代表获准派发。

离线用 fake tools 执行模板源码，复现旧四字段丢失规则，并验证新投影的正文保留、单次调用、边界处理和无额外工具访问。入口用静态契约断言，未验证真实模型是否会按要求延续角色。相关 Manager recall、wait 和 Skill 测试最终 28 通过、0 失败、0 跳过，退出码 0；Windows 进程曾间歇性异常退出，完整尝试与退出码见候选回执。

共享 Skill 入口由 17,539 字节减到 17,508 字节。新模板只由 Manager 路由引用；Python/MCP、Worker/Liaison 共享协议、wait/status 过滤和 Runtime 状态机均未改动。这证明本候选未增加 Worker 必需步骤或共享入口体积。未安装、未调用真实团队，未测量线上延迟、Token 或实际使用效果。

## 独立审查后的修订

共享入口明确限定为已确立的 Manager。召回同时校验 Registry leader 与 active Manager 的成员 ID、host/thread、绑定版本及 active 生命周期一致；矛盾返回 `leader_mismatch`，不增加调用。新增离线回归覆盖上述五种矛盾和正常 capsule 的单次读取。最终相关测试 29 通过、0 失败、0 跳过，退出码 0。共享 Skill 最终为 17,520 字节，仍比基线少 19 字节。初版记录原样保留。
