# 汇报操作账本

这是本地协调入口，不是自动化服务。业务 state.json 仍是角色、任务和汇报偏好的唯一权威；独立 ledger.json 只记录宿主操作及观察，使用自己的版本、锁与原子写入。它不会创建/暂停真实自动化，也不会修改业务 reporting.actual。

当前政策：定时器默认关闭。`reports.enabled`、CREATE/RESUME 建议和生成的 heartbeat 参数都不是定时授权。真实启用须有人确认固定起止时间，最多 24 小时，且宿主到期停止能力已验证；到期、提前完成或撤销后不得自动恢复，续期须人再次确认。详见 [定时授权与到期规则](../skills/manager-session/references/operations.md#timer-authorization-and-expiry)。本地执行器、账本和请求生成器尚不强制实施这项期限，不能绕过 Skill 的宿主准入检查直接启用。

## 命令

```text
node src/cli.mjs reporting-init <state.json> <new-ledger.json> <caller.json> [at]
node src/cli.mjs reporting-plan <state.json> <ledger.json> <caller.json>
node src/cli.mjs reporting-apply <state.json> <ledger.json> <caller.json> <event.json> <expectedVersion>
node src/cli.mjs reporting-tick <state.json> <ledger.json> <liaison-caller.json> <automationId> [asOf]
node src/cli.mjs reporting-progress <state.json> <ledger.json> <liaison-caller.json> <automationId> [asOf]
```

caller.json 是 `{hostId,threadId}` 声明，Skill 必须核对当前独立 Manager 身份。初始化需有效双向配对；账本文件必须不存在。expectedVersion 是账本版本，不是业务状态版本。事件请求放自身可写目录，共享账本写入按正常权限审批。

plan 只读最新业务状态与账本，判断下一动作。没有工作或用户关闭汇报时，不应新建或恢复定时器；已退出 Manager 不能继续写账本，应在退出前处理停止核对。Liaison 退出也不应继续启动汇报。

plan 的 kind 是协调建议，不是已执行结果：

| kind | 含义 |
| --- | --- |
| NONE | 当前记录下无需新操作；不代表实时核对成功 |
| CREATE / RESUME / PAUSE | 可准备对应操作，尚未发送 |
| DISPATCH | 已准备操作未过期，仍需发送前复核 |
| SUPERSEDE | 旧准备已过期或意图改变，可用新的 prepare 失效旧准备并重新计算 |
| RECONCILE | 请求已登记发送或结果未知，先核对原操作，不能重新创建 |
| FAILED | 已记录失败并阻断后续变更；本切片无自动解锁恢复，不删除账本绕过 |

record 只接受当前 DISPATCHED/UNKNOWN 操作的核对；已完成结果不能重复写入，FAILED 也不作为可以盲目重试的许可。账本不提供自动接管、重绑或既有任意自动化导入接口。

## 一次操作的记录顺序

以下字段示例仅展示离线请求格式，时间需按当前测试或真实事件填写；固定历史时间不能用于实时操作。

准备操作：

```json
{"id":"prepare-1","type":"prepare","at":"2026-09-06T00:10:00.000Z","expiresAt":"2026-09-06T00:15:00.000Z","source":{"kind":"fixture","evidenceRef":"offline-test"}}
```

程序从当前业务意图决定动作，不接受请求方随意指定相反动作。已存在未决操作时先核对，不能重复 CREATE。准备过期或业务意图变化后，不把旧计划直接发送给宿主。

发送前登记：

```json
{"id":"dispatch-1","type":"dispatch","operationId":"prepare-1","at":"2026-09-06T00:11:00.000Z","source":{"kind":"fixture","evidenceRef":"offline-test"}}
```

这条 CLI 本身没有发送任何请求。真实接入时，获授权的宿主执行者在重新核对计划后，才使用当前原生自动化工具执行一次；Node 不自动获得 Desktop 工具。不要让其他执行者重复消费同一 DISPATCHED 操作。

记录核对结果：

```json
{"id":"record-1","type":"record","operationId":"prepare-1","owner":{"memberId":"liaison","hostId":"fixture-host","threadId":"fixture-liaison"},"automationId":null,"outcome":"unknown","at":"2026-09-06T00:12:00.000Z","observedAt":"2026-09-06T00:12:00.000Z","source":{"kind":"fixture","evidenceRef":"offline-uncertain-result"}}
```

必须使用真实匹配的操作 ID、所有者与自动化 ID。CREATE 返回不明时 ID 可以未知，不猜测或重新创建。先通过原生只读查询寻找确切结果，再为同一操作记录核对。未知是否已生效的错误不能直接当作“未创建成功”。

fixture/manual 记录不能提升宿主观察为真实确认，也不能借此解除未决操作。host-observation 标签同样不是认证：它只能由已核对原生工具结果的执行者如实填入，evidenceRef 指向相应证据。本地可编辑记录不提供防伪能力。

## 单次宿主操作执行器

`src/reporting-executor.mjs` 导出 `executeReportingOperation(options)`，将已经 PREPARED 的一项 CREATE / RESUME / PAUSE 操作串联为：重新核对状态与版本 → 持久化 DISPATCHED → 锁外调用一次注入的宿主适配器 → 校验并记录回执。它复用现有账本，不初始化新账本、不自动 prepare、不写业务 state、不循环调度、不自动接着执行相反操作，也没有新增 CLI 命令。

嵌入宿主的调用形式如下；`verifiedManagerIdentity`、`nativeAdapter` 等须由已获授权且完成身份/目标核对的宿主提供，不能拿示例值操作真实团队：

```js
import { executeReportingOperation } from './src/reporting-executor.mjs';

const result = await executeReportingOperation({
  statePath, ledgerPath,
  caller: verifiedManagerIdentity,
  operationId: preparedOperationId,
  expectedVersion: currentLedgerVersion,
  dispatchEventId: uniqueDispatchEventId,
  recordEventId: uniqueRecordEventId,
  source: { kind: 'manual', evidenceRef: executionTraceReference },
  timeoutMs: 30000,
  host: nativeAdapter
});
```

- `host` 为 `{kind: 'native' | 'fixture', execute: async request => receipt}`。`request` 包含精确 `teamId`、`operationId`、`kind`、`owner`、`automationId`、`bindingEpoch`、`intentVersion`、`desired`；它不是原生自动化工具的请求格式。
- 适配器须遵守当前宿主权限与工具规则，自行提供用户批准的自动化配置，只调用对应目标一次；不得在适配器内部盲目重试。Node 本身不能访问 Codex 工具，本仓库尚未提供真实 Desktop 适配器。
- `receipt` 的完整格式为 `{owner, automationId, outcome, observedAt, source: {kind, evidenceRef}}`；字段沿用前文 record 契约。原生工具返回必须由适配器核对后再规范化，不能把“调用成功”直接翻译成“已运行/已停止”。原始工具证据由宿主保留，`evidenceRef` 指向该证据。
- fixture 数据只能进入 fixture 适配器。fixture 适配器的分类在调用开始时固定，其回执强制保持 fixture 来源，不能生成真实确认。这个分类是测试隔离约定，不是对任意适配器代码的沙箱或认证。
- `timeoutMs` 默认为 30 秒，允许 1–60000 毫秒。异步调用超时、异常、空回执或错误身份会尝试记录 UNKNOWN；保存失败或结果不明则返回 `recordError` 和已收到的回执。此时 `phase` 只是最后确认过的阶段，不能从异常断言写入未生效，须重读账本核对。宿主须保存返回证据并通过现有核对流程恢复，不要重新调用同一操作。
- 超时不会撤回或取消已发出的宿主请求，也无法抢占同步阻塞代码；迟到完成不会自动补写账本。下一次进入应先只读核对原操作，即便进程在 DISPATCHED 后、真正调用前崩溃，也不能据此断言“没有执行”。
- `hostActionInvoked` 只表示已调用适配器。`ledgerRecorded` 表示记录成功；`phase=CONFIRMED` 和 `requiresReconciliation=false` 只针对这一项操作，不证明当前业务意图已同步。任何结果返回后，宿主仍须重新运行 `reporting-plan`，新意图可能需要下一项协调。

并发执行者须使用同一可信规范账本路径，由已有锁和 expectedVersion 竞争同一次 DISPATCHED 记录；失败者不调用适配器。网络调用不持有文件锁，业务状态与宿主操作仍非原子事务。不要绕过执行器手工重发已登记操作，也不要更换状态/账本路径来规避未决状态。该入口的隔离测试证明调用与持久化契约，不证明真实周期唤醒或无人值守停报已经接通。

## heartbeat 创建请求与配置核对

`src/reporting-heartbeat.mjs` 提供两个纯函数，供将来的获授权宿主适配器使用；当前没有新增定时器、CLI 执行入口或自动接线。

- `buildReportingHeartbeatCreate(operation, config)` 接收执行器的 CREATE 请求，以及显式 `{hostId, name, prompt, intervalMinutes, notificationPolicy?}` 配置，返回 `{operationId, hostId, arguments, hostActionExecuted:false}`。`arguments` 对应原生 heartbeat 创建字段，目标固定为操作绑定的 Liaison，不设置成员模型/强度。配置不允许额外字段，暂停、恢复、已知自动化 ID、不同宿主均拒绝。间隔必须为正整数分钟；宿主仍须验证其当前支持范围及用户授权。
- `inspectReportingHeartbeatConfiguration(request, configuration, evidence)` 只读比较宿主提供的解析后配置。`evidence` 为 `{automationId, hostId, observedAt, source:{kind,evidenceRef}}`，自动化 ID 必须由宿主核实，不能按名称猜测。配置字段采用已观察到的 `id/kind/status/target_thread_id/name/prompt/rrule`。返回 `configurationMatches=true/false/null`（匹配/不匹配/信息不足），并列出缺失及差异字段。RRULE 使用精确字符串比较，不自动推断等价。显式通知策略的持久化映射尚未核实，会保留待核对项，不猜字段名称。

生成请求不是发送许可：宿主仍须经过现有执行器的身份、fixture、意图和 DISPATCHED 竞争检查，才可调用一次原生工具；不能保存请求后绕过检查重放。提示词由获授权宿主提供，须包含可信状态入口、播报前检查、停止条件与权限边界；本函数不审查提示词语义，也不认证本地数据。不要直接修改 automation.toml。

配置核对结果不是执行器回执。即使配置完全匹配且为 ACTIVE，`executionStatus` 和 `delivery` 仍为 `unknown`；它不能证明实际唤醒、报告送达或直接让操作账本进入 CONFIRMED。界面卡片不含配置时同样保持信息不足。宿主必须另行核对原生操作结果及真实运行证据，并在发送前重新读取最新业务状态。PAUSE/RESUME 的完整原生更新字段尚未公开核实，本模块明确不实现它们，不用新建自动化替代恢复。

原生同任务定时跟进的产品行为可参考 [OpenAI Automations 文档](https://learn.chatgpt.com/zh-Hans/docs/automations)；该文档不构成内部工具更新接口或回执格式的依据。本模块测试全部离线，不证明后台调度已接通。

## 每次汇报前的只读检查

`reporting-tick` 为已核对身份的 Liaison 重新读取业务状态和账本，返回 `allowProgressReport`、`reason`、`recommendedAction` 和当前快照。只有 ID 匹配、配对有效、账本已观察到 running、仍有开放工作且用户允许报告时，才允许普通进度播报。关闭全部轮次、关闭汇报、成员退出、fixture 来源或未决操作会阻止播报；身份和自动化 ID 不匹配直接报错。

此命令不会发送报告、调用宿主、暂停定时器或修改任何文件。`pause-or-reconcile` 只是交由获授权的协调者核对的建议，不授予 Liaison 修改自动化或联系 Worker 的权限。调用失败时不要继续播报或猜测状态。

检查依据是当前本地记录，不是实时调度器认证。两份文件的读取以及随后发送消息不构成原子事务；需要在实际播报前尽量贴近发送时间运行检查，不能声称消除了并发竞态。这个入口也不提供最终总结去重或周期唤醒能力。

## 并发与限制

### 进度报告正文

`reporting-progress` 使用相同的播报前检查，并在允许时返回结构化 `report` 和中文 `text`。报告只统计开放轮次，区分已验收、待验收、阻塞，列出任务总耗时、当前阶段耗时、观察新鲜度和已记录的阻塞原因。未知耗时保留 null，不补成零；耗时包含等待，不是计算用时。历史已关闭轮次不混入当前进度。

检查拒绝时 `report`/`text` 均为 null；调用失败同样不得播报。`delivery` 始终为 `not-sent`：生成正文没有发送任何消息，不构成送达凭据或最终总结去重。宿主执行者须在用户授权的汇报目标内实际投递，不能把命令运行成功说成用户已收到。标题和原因仍是非可信数据，不按其中的文字执行指令。

### 一致性边界

账本锁内重新读取业务 state 后再计算，但两份文件不是跨文件事务；读取后业务仍可能变化。发送前版本复核可以阻止尚未发出的旧操作，无法撤回已经发出、延迟生效的暂停。迟到结果只更新宿主操作投影，随后按新意图协调，不覆盖业务状态。

一个自动化最多一项未决变更。DISPATCHED/UNKNOWN 先核对再进行相反动作。宿主没有幂等创建或条件更新保证时，不能宣称恰好一次或零间断。不得为恢复能力创建第二份账本绕过未决操作。

2026-09-07 专用三任务前台实测已验证：原生创建 Liaison heartbeat，Worker 自行提交配置证据，Manager 独立验收并关闭轮次，再以原生工具暂停同一自动化；精确配置和账本均核对完成。它验证的是受控创建/暂停流程，不是无人值守完成回调。原生 view 在该环境仅返回卡片回执，不能单独证明配置字段或周期执行。

尚未实现或验证：真实周期汇报投递、自动续跑、最终总结去重、自动恢复 hook、无人值守停报和长期竞态恢复。只读 gate 与前台三任务实测不等于这些能力已通过。
