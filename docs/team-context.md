# Team Context MCP：团队登记与全员召回

Python 确定性模块维护 Team Registry，不调用 LLM，不依赖 AGC、hook、定时器或
后台巡检。Manager、Liaison、Worker 使用同一套协作框架，召回自己、团队、精确
leader、入队状态与角色职责。

**当前是 context-only 基础层，不是已接入的团队执行系统。** V2 始终返回
`executionIntegration: not-connected`、`dispatchAllowed: false`，即使已 ready
也不能据此派工。Node 身份投影、历史任务归属、开放轮次招募和旧团队迁移是下一
增量；本轮不修改“一键升级”等现有团队。

## 两种互斥模式

| 模式 | 权威及工具 | 边界 |
| --- | --- | --- |
| `--registry`，v2 | Registry 管登记身份；`team_context.read` / `team_context.manage` | 独立登记与召回；没有 Node locator、业务状态或派工接入 |
| `--index`，v1 | Node 管身份；仅 `team_context.read` | 读取已有 locator；不再暴露早期缺少 Manager actor 区分的 register 工具 |

不能把同一真实团队同时交给两种权威，也不能用旧运行层写入绕过 v2 的错误。
旧团队原有工作不因隔离 v2 基础层的开发而取消或迁移。

## 隔离安装与初始化

需要可信 checkout、Python 3.10+ 和官方 MCP Python SDK；旧 Node CLI 需要 Node.js
22+。使用独立环境，不改全局配置：

```text
python -m venv <独立虚拟环境目录>
<该环境的-python> -m pip install -e <可信-checkout>
```

下文命令指该环境的 `codex-team-context`（Windows 为
`Scripts/codex-team-context.exe`），或用完整 Python 路径加
`-m codex_team_context.server`。测试依赖可用 `pip install -e "<可信-checkout>[test]"`。

父目录应已存在，初始化拒绝覆盖。文件丢失/损坏先查原文件，不自动建空表：

```text
codex-team-context init --registry <新的隔离-registry.json>
codex-team-context serve --registry <该-registry.json>
```

旧 locator 模式用于已有可信索引：

```text
codex-team-context serve --index <原-index.json> --state-root <允许的原状态目录>
```

旧 `init --index <new.json>` 仍可建空 locator，不登记角色。
`ContextRegistry.register` 只保留为兼容/测试用 Python API，不是 v2 团队登记，也
不再作为 MCP 写工具发布。不提供 v1 自动导入 v2 的入口。

`--state-root` 可重复，不选磁盘根或整个用户目录。V2 只访问显式 registry，不
遍历其他对话、状态目录或私人日志。启动进程的文件权限才是访问边界，工具参数
不提供额外权限。加入全局 MCP 配置需用户另行授权；以上不代表已安装到 Codex。
全局工具元数据可能进入其他对话目录，null 不等于目录开销为零。

## Read：精确匹配、无副作用

```json
{"host_id":"local","thread_id":"<当前独立任务的精确 threadId>"}
```

不是 MCP 连接 ID、标题或 session-tree 根 ID。临时子 Agent 不能用继承的父任务
环境变量冒领身份；按 Skill 的宿主身份交叉检查核对当前独立任务。

| 返回 | 解释 |
| --- | --- |
| JSON `null` | 未登记；普通工作照常，已知团队核对原定位，不猜角色或自动登记。 |
| `status: active` | V2 返回自己、团队、leader、版本、职责、onboardingReceipt 和未接入执行的屏障；不代表宿主在线、忙闲或工作授权。 |
| `status: inactive` | 身份已退出，不返回可执行职责，也不从历史恢复。 |
| `isError: true` | 无效身份、丢失/损坏文件、冲突等，不是 null 或恢复成功。 |

V1 active 仍返回 Node sourceVersion/statePath；其 Python 校验只覆盖恢复依赖的
来源/配对字段，不是整个业务状态健康证明，业务操作仍由 Node 完整校验。

成功结果和已进入核心的已知 ContextError 是单个 TextContent 中的 JSON；未知身份
文本精确为 `null`，核心错误为 `{code,message}`。缺少顶层参数、类型错误等可能先被
MCP SDK 拒绝，返回 SDK 原生错误，不能依赖其文本为 JSON。连接失败同样不是 null。
只读不登记、不记录访问时间、不刷新生命周期，也不发消息。

Active Manager 额外获得紧凑 `teamMembers` 名册（含退出记录），用于找回协调对象。
Worker/Liaison 及 inactive Manager 不带该名册。成员记录不是宿主在线状态。

## Manage：区分操作人和目标成员

```json
{
  "actor_host_id":"local",
  "actor_thread_id":"<已核对的当前 Manager threadId>",
  "request":{
    "action":"register_member",
    "operation_id":"register-worker-1",
    "team_id":"example-team",
    "expected_revision":1,
    "member_id":"worker-1",
    "name":"后端开发",
    "role":"Worker",
    "target_host_id":"local",
    "target_thread_id":"<已创建并核对的 Worker threadId>",
    "authorization_ref":"<此次成员创建/登记的授权证据引用>"
  }
}
```

这是接口示例，不是真实登记许可。expected_revision 来自新读取的 team.revision，
不能照抄数字。身份仍是 caller-declared：服务核对表内声明权限，不是宿主认证，
不能防止有同等文件/工具权限的调用者冒填 Manager。

`manage` 因包含当前 API 不可撤回的 exit_member，标为 `destructiveHint: true`；
这是保守客户端提示，不是实际身份认证或用户授权检查。

request 拒绝未知字段，以下字段均必填：

| action | 除 action 外的字段 |
| --- | --- |
| bootstrap | operation_id, team_id, team_name, member_id, name, authorization_ref |
| register_member | operation_id, team_id, expected_revision, member_id, name, role, target_host_id, target_thread_id, authorization_ref；Liaison 另需 consent_ref |
| confirm_ready | operation_id, team_id, expected_revision, member_id, receipt, evidence_ref |
| exit_member | operation_id, team_id, expected_revision, member_id, authorization_ref |

Bootstrap 只在用户明确授权后执行，首次 Manager 就是 actor，不另填目标 Manager。
authorization_ref 仅记录在宿主核对过的许可，本身不是授权证明。其他写入要求该
团队 active Manager；Worker/Liaison 不自助登记、不改 leader、不写 ready。

V2 支持 Manager-only 初始化，随后加入 Worker 和至多一位 Liaison。consent_ref
指向 Liaison 目标自己的确认，不代替旧 Node 的双向 attach。角色/绑定不静默改，
退出保留；不自动重绑、换队、选举 leader 或按空闲时间清理。

## 入队确认不是派工许可

```text
保留原创建回执 → 解析正式身份 → Manager 登记 pending
→ 成员 read 并返回 onboardingReceipt → Manager 核对原回复并 confirm_ready
→ 重新 read → 已接入运行层的独立派工检查（本增量尚未接入）
```

Receipt 是 `v2:` 加 SHA-256 十六进制摘要，绑定 registry、team、member、角色、绑定
版本、leader 身份和 policyRevision（旧 locator 使用的字段叫 policyVersion）。
Manager 原样提交成员的 receipt 和 evidence_ref，不自己拼一个代替原回复。错误
身份、旧规则或其他 registry 的 receipt 被拒绝；加入无关新成员不使回执过期。

正常旧规则版本的记录保留可读，但旧回执需重新确认，不是注册表损坏。
Receipt 是确定性声明，不是秘密、认证凭据、阅读/理解或未来召回证明。ready 不等于
空闲、工作授权、免除后续 read 或可以绕过队列/验收/投递检查。Manager 自己也要
read/确认。Registry 不调用原生 create/send；创建不确定时核对原任务，不能因为
登记失败重复创建。只有 registry 已收到的操作才有它的幂等保证。

## 并发、重试、退出

操作和幂等回执在一次原子替换中写入。相同 operation_id 与完全相同 actor/request
返回原结果，同 ID 改内容冲突。丢响应后保留原请求；不换 ID 绕过，不盲重试版本
冲突。返回 operationId/teamId/teamRevision/memberId/outcome 是历史操作回执，
不是当前状态或授权，需重新 read。同版本并发仅一项提交，其余明确冲突。

锁等待有限，不自动删除崩溃遗留锁或重新初始化绕过；先核对持锁进程。只读不拿
写锁。退出由 Manager 在外部核对授权后登记，不取消 Node 任务或归档宿主对话。
Manager 退出后，成员仍能读团队和 exited leader，不自动换 leader。没有在线检测，
active 不保证 Manager 在运行；后续动作需要 leader 时保留证据并请用户决定。

## 召回与验证

全员在入队、团队续接/上下文丢失、身份或规则冲突时 read；交付/接收/验收前检查，
其他角色操作在上下文缺失/过时时检查。不每次文件/工具操作重复读，不用定时器。
MCP 不会自行调用自己，入口仍可能被漏用。

[全员规则](../skills/manager-session/references/team-context.md) 保留 Worker 提交通知、
Manager 独立审查、Liaison 不派工及工作关闭后停止普通汇报。完成不退出角色。

[Registry 基础层验证](team-registry-validation.md)、[历史 locator 证据](team-context-validation.md)
与[本轮方案](superpowers/specs/2026-09-10-team-registry-design.md) 分开记录。确定性协议
测试、明示入口 guided 样本、真实宿主自然续接/压缩不是同一证据；单测通过不等于
解决跨月遗忘。
