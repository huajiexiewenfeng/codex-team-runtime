# Watchdog reminder 发送关联与回执核对（受控候选）

日期：2026-11-16。新增模块 `src/watchdog-receipts.mjs`，独立receipt ledger；本批不迁移、不自动清理、不提升旧Watchdog attempts。生产adapter allowlist仍为空。本文不代表真实发送已经完成或完整P0已验收。

## Manager 独立验证更新

同日已完成一次真实隔离验证：prepare先持久化意图与原生日志基线，再由一次性harness发送；运输结果accepted时receipt仍unknown。随后由本模块读取注册日志，得到唯一nativeReminderTurnId与task_complete，receiptStatus=turn-completed；原生wait_threads独立核对为同一轮次completed且聊天idle。businessHandled/businessAccepted始终unknown。

重跑prepare返回相同attempt/nonce，replayed=true；再次调用send被已有marker抑制，sendExecuted=false。原生游标和最新turn保持不变，没有创建第二轮。Manager独立重跑60项回归全部通过，git diff --check通过。

证据在候选外的 `artifacts/watchdog-host-validation-20261116/receipt-round/`：prepared.json、watchdog-reminder-receipts.json、send-once.json、queue-result.json、reconcile-latest.json、replay-check.json。完整受控正文仅在该私有ledger中；本文不公开原始标识。下文“随后执行”保留初次交付时的历史顺序，以此更新为准。

这证明受控的“发送前记录→原生提醒轮次→回执核对”链路可用，不代表生产身份认证、自动守护进程接入、旧attempt迁移或Worker业务执行绑定完成。未安装、未合并、未联系业务团队。

## 稳定API

```js
import {
  prepareWatchdogReminder, readPreparedWatchdogReminder,
  recordWatchdogQueueResult, reconcileWatchdogReminder,
} from './src/watchdog-receipts.mjs';

const context = {
  teamId, taskId, executionId, sourceVersion, sourceUpdatedAt,
  hostId, threadId,
};
const log = {
  path: exactAbsoluteRegisteredLogPath, hostId, threadId,
  hostLogVersion: '0.169.0-alpha.11.1',
  queueClientVersion: '0.167.0-alpha.4.1',
};
const prepared = await prepareWatchdogReminder({
  ledgerPath, context, log, at: new Date().toISOString(),
  operationId: 'isolated-receipt-round-20261116-v1', // 可省略，见下文
});
// 此时intent和完整发送正文/hash已原子落盘；API没有执行发送。
const outbound = await readPreparedWatchdogReminder(ledgerPath, prepared.attemptId);
// 仅外部受审查wrapper使用outbound.text发送；禁止把正文复制进报告。

await recordWatchdogQueueResult({
  ledgerPath, attemptId: prepared.attemptId,
  at: new Date().toISOString(), // 必须严格晚于preparedAt
  result: {outcome:'queued', queueId}, // 或 {outcome:'unknown'}
});
// 上述任意传入result是caller-declared运输声明，不是认证或消费证据。

const receipt = await reconcileWatchdogReminder({
  ledgerPath, attemptId: prepared.attemptId, at: new Date().toISOString(),
  current: {teamId, taskId, executionId, sourceVersion, hostId, threadId},
});
```

`operationId`存在时稳定复用该键；否则按team/task/execution/sourceVersion/host/thread产生稳定hash键。同键不同context、log或受控body报conflict；重跑不生成新nonce/attempt。prepare时间回退拒绝，重放不会发送。无关台账变化允许current.sourceVersion大于原版本，但小于原版本、execution变化或host/thread重绑定均unknown；current仍是caller-declared上下文，不是权限认证。

prepare持久化kind=`reminder`、随机attemptId/nonce、精确关联context、完整生成payload与SHA-256、源版本/时间、注册日志的初始字节边界/hash/文件identity、独立版本pair。生成正文只要求隔离目标短答，不要求自注册、读路径或处理业务。完整正文仅保存在专用receipt ledger并由readPrepared交给发送wrapper；回执和报告不含正文、reasoning、原始对话副本或ACK。

queueId只表示已解析的运输接受，不能关联原生turn：当前原生日志不提供queueId。`recordWatchdogQueueResult`始终标注transportAssurance=caller-declared，不允许不同queueId覆盖同attempt。真实一次性harness对精确execFile结果做整行正则、exit0、空stderr和exactthread校验再记录queued；其他结果unknown，不能重发。

## 精确日志契约

只读prepare注册的canonical绝对路径，不扫描其他日志。唯一session_meta必须在首行，id等于精确thread，cli_version等于hostLogVersion。hostId来自显式注册，不从日志伪造认证。log中的宿主版本与queue客户端版本分别记录；本轮pair为host log **0.169.0-alpha.11.1/source=vscode** 与queue client **0.167.0-alpha.4.1**。

读取整个打开边界，要求文件identity、size、mtime/ctime在读取前后稳定；最大8MiB、50000行、单行1MiB，严格UTF-8/JSONL且最后一行完整。超过边界、坏JSON、截断、文件替换、prepare时完整前缀hash不符、未来记录均unknown，不从截取部分宣布唯一。

仅原生response_item user消息的**完整单一input_text**等于完整payload/hash才是候选匹配；不是短nonce、ACK、语义相近文本或latest消息。必须唯一，且internal_chat_message_metadata_passthrough中存在精确turn_id、create_time；同turn不能有第二个user消息。原生task_started必须唯一，turn_attribution.turn_id匹配，turn_trigger必须是queue；正文自称queue无效。user/start都必须是prepare后追加的字节和时间，不按时间最近猜测。

原生task_complete须同turn唯一、时间和started_at/completed_at自洽，或显式同turn中断事件。唯一user+start但无terminal只可写consumed；完成写turn-completed，中断写turn-interrupted。来源、时间、缺失或重复矛盾均unknown。没有读取assistant ACK或reasoning。回执始终businessHandled/businessAccepted=unknown；reminder native turn与业务execution明确分开。

每次重新检查整个注册边界，已确认后若追加第二个完整匹配会降为unknown。先前有效证据只保留最多8份status/turnId/时间/hash/行号，不保留正文。ledger最多1000个entry/32MiB，超限拒绝新intent，不删除未知历史自动恢复。旧Watchdog attempts仍legacy unknown，本批不接管其容量或历史。

## 仅隔离一次性harness

已创建但**子代理未执行send**：

`artifacts/watchdog-host-validation-20261116/receipt-round/harness.mjs`

脚本只接受prepare/send/reconcile/replay四个命令；thread、精确日志、version pair、fixture context和binary path硬编码，无任意目标参数，不调用业务。prepare读取精确binary --version并保存SHA-256。send先wx+fsync创建send-once marker，再检查binary hash并用execFile参数数组发送一次；任何失败或重跑都保留marker，禁止再次发送/换通道。replay只验证prepare去重，不发送。reconcile只读取注册日志并输出有界证据JSON。

```text
node <absolute-harness.mjs> prepare
node <absolute-harness.mjs> send       # 由父节点执行，子代理不执行
node <absolute-harness.mjs> reconcile
node <absolute-harness.mjs> replay
```

外部harness所在evidence目录不纳入候选代码变更，也不改写父节点host验证文档。prepare/readPrepared/result/reconcile模块自身不启动进程、不发消息。harness非生产adapter，不改变空allowlist，也不能把受控文本关联当身份认证。

## 离线证据

新增receipt用例14/14通过；联合Watchdog/receipt/supervision/supervision-cli/manager-session-skill共60项通过，exit0。覆盖发送前intent、稳定重放、运输接受分层、唯一原生turn、consumed/complete/interrupted区分、首次及后续重复、metadata缺失、旧execution/重绑定、无关sourceVersion增长、prefix/截断/坏JSON/未来/过限、version pair、queue trigger、相同与回退时间、queueID冲突、无ACK依赖、reasoning不进入报告。

真实一次发送与对账由父节点随后执行，结果另存evidence；本说明不会提前宣称live通过。
