# E04 派发接口使用与运维

实现依据：[E04 设计](design/e04-dispatch-runtime.md)。E03 依赖基线为
`7dd69adbbd91ca43c904f4f5ed4ed338155c14b8`。开发完成不代表已更新本机安装或正式启用。

## 启用条件

统一升级配置中的 Node companion、Python/MCP、实际 CLI 写入口和 Skill 路由，重连后确认
`team_context.dispatch` / `team_context.dispatch_status`。旧 E03 程序可以读初始 E04 state，
却不理解其对象保护；不得将旧程序与新 writer 混用。不能约束旧写入器时暂不启用，或另行评估 schema3。
Runtime 不会替用户发送消息、创建 Worker、修改模型或部署安装。

## 冻结交接材料

以下是示例值，证据引用必须来自实际核对。正常情况下在原本编写 brief 时完成保存：

```json
{
  "schemaVersion": 1,
  "teamId": "team-demo",
  "roundId": "round-demo",
  "taskId": "task-demo",
  "actor": {"hostId": "local", "threadId": "manager-demo"},
  "text": "原始任务正文，原样保存。",
  "scope": "已确认的工作范围与验收要求",
  "materialRefs": ["verified-original-material"],
  "authorizationRef": "verified-user-authorization",
  "dependencyRef": "verified-prerequisites"
}
```

```text
node src/cli.mjs dispatch-freeze <state.json> <brief.json>
```

返回 briefRef、正文 SHA-256、bodyBytes 和源版本，不改变 state。新 queue-task 的 source.ref
使用该 briefRef。旧 queued 任务需要额外填写 enqueueEventId 和 originalSourceRef，精确关联原入队记录。
正文上限 64 KiB，对象/请求/响应有 1 MiB 限制。已提交对象图最多 8192 个对象、总 canonical 内容 64 MiB；超限显式拒绝，不自动清理历史。对象存放在可信 state 路径旁的
`<state文件名>.e04-objects/`，不接受调用者指定存储根。

## 三步派发与恢复

1. `team_context.dispatch(action="prepare")`：按设计 §3.2 填写完整模板。首次仅 startTask +1；
   prepare 不再传正文。scope_evidence_ref 在 brief 内授权/依赖引用不充分时补充。
2. 全新成功且 sendNow=true 时，按已有授权至多执行一次固定 hostRequest。任何重放/查询均无发送许可。
3. `team_context.dispatch(action="result")`：公共定位字段之外填写独立 operation_id、attempt_id 和
   `result: {outcome, evidence_ref, summary}`。outcome 为 accepted、unknown、terminal-not-delivered 或 denied。

第一次写入传输状态 unknown 并占用 Worker；accepted 表示宿主接受，不表示完成。
明确非送达后，以新的 operation_id、retry_of_attempt_id 和当前 admission 重新 prepare，仅产生 claim +1。
unknown、policy-denied、已有工作观察或冲突 hold 不能重试。迟到的 accepted/unknown 可以补记，保持业务阶段不变。
已经终结的相同结果返回 ATTEMPT_RESOLVED、operationRecorded=false；unknown 不覆盖已终结事实。
矛盾终态返回 DELIVERY_CONFLICT、recorded=true，并持久阻止该 Worker 的新启动。

`dispatch_status` 不接收 action。可按 operation_id 或 attempt_id 查询；两者同时给出时必须对应。
sourceVersion 是选中操作的原提交版本，currentStateVersion 是本次读到的版本。
无选择器的 latestAttemptId 标记 correlationVerified=false。include_content 只返回可读材料，不恢复发送许可。
源观察时间缺失时 observationAgeMs=null，不生成虚假时间。

只有确证写进程结束并查询不到事件，才能重试原未提交 operation；对象存在不等于已提交。
status 不清锁。写入不确定时先确认 executionEnded，再处理 cleanupStatus，不能因为桥接超时就重新发送。

可用确定性 CLI 调试同一个协议，无宿主发送：

```text
node src/cli.mjs dispatch-request <state.json> <request.json>
```

## 撤回、备份与回退

`action="cancel"` 要求新的 operation_id、attempt_id 和设计 §8 的 cancellation 证据。
明确任务撤回授权、所有尝试已终止未接收、没有实际工作或在途请求都齐备，才追加 cancelUndelivered 并释放占用。
cancelStopped 的 delivered/停止证据不能替代此契约。不会自动重新入队，也没有冲突 hold 自助解除入口。

```text
node src/cli.mjs dispatch-export <state.json> <new-directory>
```

导出在 guard 内验证 state/对象，复制可达 brief/operation 对象，最后写 READY.json。
目录必须不存在；不包含 Registry。恢复前核对 manifest 哈希、可达对象、Registry 身份和路径绑定。
导出副本可离线读验，不要直接作为另一个活动团队启动。无 READY 的目录视为未完成导出。
未引用对象首版不清理，不允许将已引用对象当缓存删除。

回退先停用新 prepare，保留 E04-aware 的读取、结果登记和保护。不能恢复旧 state 覆盖新业务进展，
也不能直接换回旧二进制后写 E04 数据。冲突 hold 需要另行评审的恢复协议，不能用数据编辑解除。

观测沿用显式团队 allowlist，只保存 action、关联 ID、版本、原因码和请求/响应字节数，不保存正文或证据内容。
prepare 返回的 bodyBytes 是三个正文位置的协议字节量，nativeSend 是计划值；实际原生发送与耗时须从宿主证据另行采集。
不把字节数当精确 Token，也不把合成测试当真实团队效率收益。
