# E05：Manager 收件队列与工作续办协议

设计日期：2026-10-08；初审修订：2026-10-09。状态：**U12 设计稿，待逐项评审；本文拟新增接口均未实现**。
源码核对基线：`83d1450da26d9bb6a466bec027be48410ff2c4cc`。
本轮仅新增本文和文档索引，不修改 runtime、测试、生产 Skill、安装或全局配置。

## 1. 要解决的两个行为缺口

用户确认的方向是：普通 Worker 回复先排队，Manager 完成当前工作步骤后再处理；
不能靠每条原生消息插入当前对话来驱动调度。目标是**不遗漏收件、能恢复正在做的事**，
不是自动批准、永久在线或一个新的消息平台。

限定本地调查材料为 `manager-turn-evidence.json` 与 `ledger-evidence.json`。
原文件含工作内容和本机引用，留在授权的本地制品目录，不随本文发布。下表只保留与协议相关的事实；
时间均为北京时间（UTC+08:00），不扩展到其他会话或团队。

| 事故 | 已有事实 | 设计需要补什么 |
| --- | --- | --- |
| A：10/7 首提交，在另一策划工作中漏收 | 正式提交18:02:19.919；通知宿主受理18:03:32.807。Manager 的另一策划回合为18:00:17–18:07:34，结束后没有这份提交的 review。用户18:10:30追问，18:12:41.684才出现 review | 送达不等于收件/审查。当前步骤结束和回复结束前应有确定性的待收件检查与处置记录 |
| B：10/8 返工，压缩后退回已完成封面工作 | 返工提交21:39:57.371；21:42开始的回合已提及权限审查并执行 supervision 检查，随后 contextCompaction，最终回到封面成果。通知宿主受理21:44:02.501；用户21:59:24追问后，22:00:24.752 review、22:03:05.256 approve | 看过证据/执行过 supervision 不是续办保证。必须恢复当前权限审查的工作点，而非按最后出现的成果或旧 final 选择下一步 |

材料证明这两次通知有 `accepted` 记录，不能把原因改写为传输失败；检查标签也不能证明已经完成源码审查。
E05 不回填这些历史队列记录，不修改原 review/approve，不接管调查中的业务团队。

## 2. 已有能力与明确缺口

| 当前源码 | 已有行为 | E05 复用方式 |
| --- | --- | --- |
| `src/runtime.mjs`、`src/store.mjs` | submit/review/rework/approve 与任务阶段在同一 state；expectedVersion、Registry 投影、锁内演算、单文件原子替换 | 业务事实仍只有这份 state；不另建“已验收”状态 |
| `src/submission-notice.mjs` | 从精确 submit 事件生成 notice；pendingSubmissions 找当前 submitted；receiveSubmissionNotice 实际写 review；重复、过时、closed/rework 等有门禁 | inbox 的正式提交项只引用该事件；“收件”不能调用 receive-submission 冒充开始审查 |
| `src/submission-recovery.mjs`、`src/notice-runtime.mjs` | E03 ledger 保存精确 notice、发送 attempt、unknown/denied/accepted 和 operation 重放 | 保持传输证据原样；入队不创建 accepted 或清除历史限制 |
| `src/supervision.mjs` | submitted/reviewing/blocked 等 durable taskChecks、pending notices、精确原生查询 batches；plan 不执行查询。`--notifications` 的 ledger 读取注明 atomicWithState=false | checkpoint 必须联合这些事实恢复；空/错误原生结果不删除待审工作 |
| `src/dispatch-runtime.mjs` 等 E04 | 明确 queued 任务、就绪与占用、prepare/result、未知发送保留 | 不由 inbox 派工，不放宽忙碌 Worker，不把回复当新任务授权 |
| `src/registry-projection.mjs` | `withStateGuard` 按 Registry.lock → state.lock → 附加文件.lock 顺序；当前简单锁不证明宿主活跃，E03 adapter 有本次锁归属证据 | 新写入遵守原锁顺序；不排序改变现有顺序，不做全局 stale-lock 清扫 |
| 当前 Skill 的召回、监督、完成协议 | 前台恢复/交付/接收检查；Worker 通过既有 E03 通知 | 增加可执行 checkpoint 和续办规范；安装文件不能自动刷新既有 Agent 上下文 |

当前没有普通 progress/stage/blocker 的持久化收件 API，没有 Manager 工作续办对象，
也没有可验证的“只唤醒 idle、绝不插入忙碌回合”宿主工具。现有 `receive-submission` 的名字容易被误解：
它实际启动 review，不能用作新队列的普通收件回执。

## 3. 第一版核心选择：一个附加控制账本，业务提交派生

选择每个已连接团队一个受可信 state 定位的 `state.json.manager-inbox.json`，
schema 拟为 `manager-inbox/v1`。外部接口不接受自选路径、命令或 Manager 目标。
它同时保存非提交消息审计、队列投影、操作回执、消费 claim 和事实性续办点，
避免再拆成 inbox/todo/续办文件的多重同步。

| 数据 | 唯一真源 | 附加账本可保存什么 |
| --- | --- | --- |
| 正式 submit、任务状态、review/rework/approve、Worker 占用 | 原业务 state 的事件/投影 | submitEventId、submissionVersion、规范 notice digest、消费记录；业务状态只读派生 |
| 原生发送结果 | 原 E03 ledger / 原生结果证据 | 只读引用、读取版本和 unknown；不复制成新的权威传输状态 |
| 普通 progress/stage/Worker 报告的 blocker | E05 不可变消息审计 | 摘要、显式 task/step、证据引用、当前/历史身份核对、接纳 seq；这是报告，不自动成为业务事件 |
| Manager 的工作续办、收件/claim/defer、用户优先级核对 | E05 操作审计与其投影 | 有界事实对象和 CAS 修订；不是思维链、审批结论或宿主运行锁 |

原 Worker 仍先 durable submit，再 `inbox.post(kind=submission, submit_event_id=...)`。
提交项的正文/notice 由程序从原 state 生成，Worker 不重复提交任意另一份“正式摘要”。
**submit 成功、post 失败/未执行**是合法可恢复窗口：checkpoint 和任何 post 在同一个 state guard 内，
先把最新 submitted 以及需续办的 reviewing 提交补入队列，再处理本次操作。
不让 Worker 同时更新业务 state 与 inbox，不声称两文件有原子事务。
`pending-submissions` 只提供 submitted；reviewing 与 blocked 的续办必须联合 supervision 的 taskChecks 和业务审计。
blocked 若仍有未决正式提交也保持该提交待办；没有 submit 的业务阻塞只作为 blocker 检查，不能伪造正式项。

派生键为 `(teamId, roundId, taskId, submitEventId)`；无论由 Worker post 还是 checkpoint 发现，都只有一项。
reviewing 的漏投影项标 `businessReviewAlreadyStarted=true`，仍需显式续办/处置；不伪造 E05 的历史 claim 或 receivedAt。
已经批准/取消的旧提交在首次启用时只留业务引用和迁移水位，不生成新待办。
对已排队项，最新 resubmit 会把旧提交标 superseded；旧正文/传输/消费审计不删除。

## 4. 附加账本与消息的具体结构（拟新增）

账本顶层至少包含：`schemaVersion, teamId, registryId, statePathBindingHash, version,
controlRevision, nextArrivalSeq, checkpointOrdinal, mode, leaderBinding,
messageAudit, queueProjection, operations, claims, continuations, activeWorkId,
consumer, claimsPaused`。
它绑定真实 Registry/team/领导身份，不能把同名文件用于另一个团队。

- `version`：每次成功账本提交增加；原子替换前只读取锁内最新图像。
- `controlRevision`：只在 Manager 控制、续办、claim、模式变更时增加；普通 Worker post 不使 Manager 的续办 CAS 无意义地冲突。
- `arrivalSeq`：本账本接纳顺序，单调唯一。服务生成接纳时间，不按 Worker 自报时钟排序。
- 每个操作保存规范输入 fingerprint 和有界响应。同 operation_id 同输入重放无新效果；改输入/actor/action 报 OPERATION_CONFLICT。
- 私有事实、正文与本地引用不出现在 Git；MCP 返回本团队有界数据，内容均作为不可信报告，不能变成指令或授权。

以下是**拟新增普通消息请求示例**，所有标识、摘要、哈希与时间为合成示意，不是已有 API 或真实事故记录：

```json
{
  "action": "post",
  "actor_host_id": "local",
  "actor_thread_id": "worker-thread-example",
  "team_id": "team-example",
  "operation_id": "post-progress-example-1",
  "reason": "before_delivery",
  "message": {
    "message_id": "progress-example-1",
    "kind": "progress",
    "round_id": "round-example",
    "task_id": "task-example",
    "step_id": "source-check",
    "producer_seq": 7,
    "summary": "完成范围核对，下一步检查隔离测试结果。尚未正式提交。",
    "evidence": [
      {"kind": "artifact", "ref": "approved-artifact:source-check", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
    ]
  }
}
```

queue_first 下成功回执示意：`{status:"enqueued", itemId:"item-example", arrivalSeq:42,
inboxVersion:15, hostActionExecuted:false, wakeStatus:"not-requested"}`。
没有 `delivered/accepted/reviewed/approved`。正式消息用 `kind=submission + submit_event_id`，
不接收示例的任意 summary/evidence 作为正式业务真源。

普通消息准入规则：

1. 必须是当前 active、ready 的原 Worker；actor 与 Registry host/thread、原任务/round 的 Worker 身份一致。
   memberId、role、bindingRevision、精确 Manager 目标由可信定位推导，不由请求任意指定；记录当前团队/策略修订和历史核对结论。
2. `progress/stage` 仅限自己的未终结既定工作；submitted/reviewing 中只能追加获授权的澄清/证据，不能借它替换 submit 或恢复执行。
   queued/approved/cancelled 的新工作进度拒绝。blocker 有业务 blockEventId 时精确核对；没有时明确为 worker-reported，Manager 再判断，不能自动修改 task.status。
3. 每条完整 UTF-8 请求最多16 KiB，摘要最多2000字符，证据最多16个且单 ref 最多512字符；封闭字段、规范标识、Unicode/JSON 深度/重复键均校验。
   不含提示词、工具输出、凭据或整份源日志；引用/哈希不是授权，也不自动读取文件或执行内容。
4. 普通去重键为 `(teamId, memberId, bindingRevision, taskId, kind, messageId)`；同键不同内容拒绝。
   producer_seq 在精确 sender/task/step/kind 流内单调；重复序号不同内容冲突、旧序号拒绝或返回已有一致回执，不覆盖新报告。
   新 operation_id 不能绕过 message 去重、历史 denied 或身份冲突。
5. 接纳后身份变化：审计保留，在消费前重新验证；不把旧身份消息归给新 Worker，不能改发给新领导。领导身份/团队权威冲突停止整次处理；单项 Worker 冲突进入 identity-hold。

第一版账本上限拟为16 MiB、512个未终结队列项、8192条审计动作（以总字节上限先到为准）。
不静默丢弃/TTL 删除。容量、损坏或磁盘失败返回明确错误；正式 state 不丢，Manager 可在原授权内读取 supervision/pending 作人工恢复。
长期归档/操作墓碑压缩需另行设计、评审后实现；第一版不承诺无限保留容量。

## 5. 队列状态、FIFO、合并和优先级

传输、消费、业务三列独立：`enqueued` 不代表 Manager 看过；`received` 是 Manager 显式操作回执，
不证明模型理解；`processing` 是领取检查工作，不等于 business review；只有原 state 的 review/approve 才证明相应业务阶段。

| E05 消费状态 | 进入条件 | 离开条件 |
| --- | --- | --- |
| queued | 消息/派生提交成功接纳 | 显式 acknowledge/defer，或成功 claim |
| received | Manager 按 itemId+内容版本显式 acknowledge，正式提交仍待审 | claim/defer；不能自动 settled 正式提交 |
| processing | 精确 claimId/generation 领取一个冻结消息版本，保存消费工作续办点 | resolve、主动 defer；崩溃待核对，不能因 TTL 假定已完成 |
| deferred | 明确原因、下一触发条件、resumeRef、延期次数和本次 receipt | 可核验条件变化或新的有意义 checkpoint；达到延期上限需明确处理/请求人决定 |
| identity-hold | 历史/当前 sender/task/领导验证冲突 | 仅获授权的身份核对决议恢复；不循环重试 |
| settled / superseded / stale | 普通项具体处置已记录；formal按下述决议门禁收束/新提交取代/旧来源失效 | 终态审计保留，不重新抽取 |

正式项的 settle 只接受**精确当前提交**的 approve、rework 或现行状态机支持的合法终态事件。
程序核对 task/round、目标 submitEventId 与审查/决议事件链；仅引用 review 返回 `REVIEW_NOT_FINISHED`。
reviewing、验证阻塞或“已读证据”仍保留可恢复待办，使用 processing/deferred，不算 settled。
新提交已取代目标时用 superseded；不能拿前次批准收束新提交。现行状态机若没有相应取消路径，不能补造 cancel。

正常消息按 `(firstPendingArrivalSeq, itemId)` 稳定 FIFO。未及时 post 的正式提交，在下次锁内补投影时分配 seq；
同批补投影按业务 submit 事件顺序。这是**接纳 FIFO**，不虚构跨文件的真实网络到达顺序。
每次 post 先补投影此前 state 已提交的工作，避免后来的 progress 长期插到它前面。

同 task/sender/binding/step 的未消费 progress 可合并为一个逻辑槽位，保留首次 seq，展示最新摘要；
每次更新正文和 seq 留不可变审计。stage、正式 submission、blocker 不折叠成 progress。
checkpoint 返回 `highWatermark` 和冻结 `payloadRevision/coveredSeq`；claim 消费该冻结版本。
若 checkpoint 后又来 progress，claim 将旧版本领取、新 seq 留为后继槽位，不能吞掉新更新；
若新 submit 已取代旧 formal 项，则 claim 返回 superseded，不领取旧审查。

blocker 是需要判断的报告，不是 Worker 自授紧急优先权；可核验“依赖确实阻断当前工作”后，
Manager 在安全步骤边界决定先协调还是记明确 defer。v1 不接受 Worker `urgent=true`、任意 priority 或用户 override 字段。
立即停止/明确改优先级来自**当前真实用户指令**，走现有宿主用户控制通路；Manager 保存原指令引用、范围及核对声明。
外部 Worker/文档/其他 Agent 说“用户要求”不构成该来源。Runtime 尚不能认证人类指令，声明字段不是新授权 API。
预授权安全停止信号需要可验证来源/条件/范围，列为后续能力；v1 不靠读语义自动夺占，Worker 的危险报告仍保留并提示待判断。

每个新 checkpoint 默认提供3项，最多8项、总响应64 KiB；本轮处理预算另明确，例如最多3项检查，
不要求在一个回合无限清空。纯 progress 不得以最新 head 更新重置队龄。
忙碌型 defer 的下一触发点只能是下一已声明步骤完成/前台恢复，最多连续3个有意义 checkpoint；
依赖型 defer 必须引用依赖状态/所需人类输入，不按轮询次数自动重试。没有条件变化时排除，仍显示 oldest/count/reason。
达到3次的普通有效项需 claim、给出具体等待输入或把优先级冲突交给用户；不能再用“稍后处理”原样延期。
这约束前台协议，不能承诺 Manager idle 时的墙钟处理上限。

## 6. 事实性工作续办点（拟新增）

Manager 的“目前在做什么”不必是假造团队 task。一个活动主工作点可以是：

```json
{
  "schemaVersion": "manager-continuation/v1",
  "work_id": "work-example",
  "kind": "task-review",
  "owner_binding": {"host_id": "local", "thread_id": "manager-thread-example", "binding_revision": 1},
  "team_id": "team-example",
  "task_ref": {"round_id": "round-example", "task_id": "task-example", "submit_event_id": "submit-example-2"},
  "user_work_ref": null,
  "authorization_ref": "confirmed-original-scope-example",
  "step_id": "inspect-permission-changes",
  "phase": "active",
  "next_action": {"kind": "inspect-evidence", "target_ref": "approved-artifact:source-diff"},
  "evidence_refs": ["approved-artifact:checks-v2"],
  "observed_state_version": 81,
  "last_effect": {"operation_ref": "review-start-example", "status": "succeeded", "evidence_ref": "state-event:review-example"},
  "continuation_revision": 4,
  "recovery_generation": 1
}
```

另一个合法形态 `kind=user-work`：`task_ref=null`，`user_work_ref` 指当前真实用户回合/获准文档工作，
保存简短目标、实际当前步骤、下一可执行动作和文件/材料引用。没有团队任务时不写假 task/submission。
不保存思考过程、未发出的推理、完整对话或凭据，不把简短 next_action 当 shell 程序运行。

`activeWorkId` 保护当前主工作；消费 inbox 时保存原工作为 paused，另建/恢复一个 review 工作点，
结束后回到明确 resumeRef。用户新的兼容指令修订它；明确取消/改优先级才用带人类来源的控制记录换主工作，旧点留审计。
revision 由 CAS 更新，recovery_generation 在明确恢复接管时增加；completed 只能记录已有成果/决议引用。
“active”表示上次声明的未完成工作，不证明宿主 busy，不是永久占用锁。
同一真实执行回合发生 compaction 后，保留原 runInstanceId/generation，读取并恢复原工作点，
不递增generation、不要求证明该回合已结束；unknown在途效果仍先对账。只有真正新实例的接管才走control.recover，不能将新实例伪报为原回合。

**v1 单 consumer、单当前 claim，不并行审查。** `consumer` 保存 runInstanceId、generation、currentClaimId 和协议状态；
同团队至多一个有效 consumer，`activeWorkId` 至多指向一个当前工作点。checkpoint 写控制记录时需持有该 consumer；
无 consumer 时首次 checkpoint 以 controlRevision CAS 建立它，第二个调用实例只能读 status 或返回 `CONSUMER_BUSY`。
已有 currentClaimId 时，无论新 claim 指向相同项还是不同项，都不能另领并覆盖续办点；原操作重放只返回原 claim。

claim 必须携带 expected_active_work_id 和安全步骤边界声明：同一原子控制提交将原工作置 paused、
保存 resumeRef，再把 activeWorkId 指向本 claim 的消费工作；不允许 Worker 消息自动切点或嵌套第二个 claim。
结清或显式 defer 后清理当前 claim，先按 resumeRef 恢复原工作，再选择下一项。
尚未结束的 review 若要让位，须先保存精确提交/步骤/下一步、核对没有未知在途副作用并显式 defer；
既有 reviewing 业务状态不回退，也不伪造 completed。已完成的原工作不会因 resumeRef 被再次激活。

实际用户改变优先级可在安全边界通过 checkpoint 的显式 switch 工作转换记录处理；需 expected_active_work_id、
事实修订和真实人类指令引用，先处置当前 claim/intent。未核对的在途效果仍 unknown，不因新目标而消失。
续办 task_ref 与最新业务提交不一致时返回 `CONTINUATION_SUBMISSION_CHANGED`，保留旧点，显式核对后选新目标。
多项 reviewing 可以保留多个 parked 续办点，但没有多个 active 指针；恢复不得从文件时间排序挑一个覆盖当前审查。

执行可能有副作用的动作前保存 `last_effect.status=started` 和稳定 operationRef；返回真实结果后记 succeeded/failed。
压缩/崩溃后仍 started 且无结果就是 unknown：先按精确业务 event/工具 receipt/获准文件证据对账，不能自动重跑命令。
只读复查在原授权范围内可以重做，但需标重读，不能写一个“已完成”来填未知。
恢复点缺失/冲突时：列出真实 reviewing/pending 与已知用户工作引用，给出需要核对项；
不按最近 final、最近文件或已验收封面猜回当前目标。

## 7. 最小拟新增接口与职责

以下均为**拟新增** `team_context.inbox` / `team_context.inbox_status`，当前不可调用。
共同定位：actor_host_id/thread_id、team_id、reason；写动作需 operation_id。actor 是 caller-declared，
仍依赖宿主真实身份/既有协作与文件访问授权；不能把 hash、ready 或本地路径当 ACL。

| 动作 | 输入要点 | 确定性效果/返回 | 权限 |
| --- | --- | --- | --- |
| post | 普通 message，或精确 submit_event_id | 核验并入队，生成 enqueued receipt；不调用宿主，不写业务 stage | 原 ready Worker 自己的既定任务 |
| checkpoint | trigger、run_instance_id、expected_control_revision；可选 continuation_transition=save/switch 及 expected_active_work_id、事实修订、真实用户指令ref；limit | 补正式投影、核对/恢复当前工作，持有或CAS建立单consumer；冻结highWatermark，返回候选与final票据。switch不绕过未决claim/intent | 当前 ready Manager |
| claim | checkpoint_operation_id、item_id、payload_revision、expected_control_revision、run_instance_id、expected_active_work_id、安全边界声明 | 无当前claim才可CAS领取；原子保存原工作/resumeRef并切到消费工作，返回claimId/generation；否则CONSUMER_BUSY | 当前 Manager；run_instance_id 仅操作实例标识，不是 host 活跃证明 |
| start_review | claim_id/generation、精确 submit_event_id、expected_state_version | 对正式项复用规范 notice/plan/evolve；业务 review 是唯一效果真源，按第9节 intent 恢复两文件窗口 | 当前 Manager、有效 claim；旧 reviewing 只返回 resume，不新建 review |
| resolve | claim/receipt、disposition、证据ref、expected_control_revision、expected_active_work_id、后续工作点 | acknowledge/defer/settle/reconcile；formal settle只接受精确当前提交的approve/rework/合法终态，review仅证明开始。defer/settle清当前claim并恢复resumeRef，不能抹掉reviewing待办 | 当前 Manager |
| control | command=init/set_mode/pause_claims/resume_claims/recover/release_consumer，CAS、精确实例与证据（见下） | 只变本团队附加账本控制；不发送、不审批、不启停宿主进程、不改Registry | 当前ready Manager，既有相应人类授权 |
| inbox_status（只读） | 精确 operation/item/work/claim 选择器、可选版本 | 状态/原回执/续办摘要；不补写、不领取、不唤醒、不给发送机会 | 自己消息的 Worker 或当前 Manager；不让 Worker 读取他人正文 |

`checkpoint` 不自动 claim/review/approve，也不调用原生 wait/send。`start_review` 是有意开始审查的动作；
独立证据判断仍由 Manager 执行。批准/返工保留原接口、原 actor 与验证门禁，resolve 只核对并收敛 inbox 投影。
模式门禁：observe仅shadow，post返回shadow-recorded，checkpoint只补/核对投影，不能取得consumer、切走activeWork或改业务；
只有queue_first允许claim/start_review/消费型resolve及续办save/switch，其他模式返回MODE_NOT_CONSUMING，旧协议仍按原接口运行。
操作 namespace 与 E03/E04 分开；结果响应保存完整相关 ID，重放不重新抽取另一批。
CLI 拟增加 `inbox-post/checkpoint/claim/start-review/resolve/control/status` 便于相同核心的本地验证；
CLI 可用已授权文件作为输入，MCP/网页不接受任意文件、命令或替代账本。

### 7.1 最小控制契约（拟新增，不是已实施配置）

所有 control 操作有独立 operation_id/fingerprint，核对当前唯一 ready Manager、可信 team/state、
Registry团队修订、历史领导绑定与已授权范围；除首次 init 外均要求 expected_control_revision，
涉及 consumer/工作点另核对 expected generation/currentClaimId/activeWorkId。
Worker 无 control 权限。失败不修改旧模式、不清 claim 或 unknown；重放不重复变更。

| command | 最小输入/门禁 | 效果 |
| --- | --- | --- |
| init | expected_absent=true、expected_state_version、预期Registry团队修订、授权ref；可信sidecar确实不存在 | 独占创建mode=observe、claimsPaused=true、consumer=null。已有一致init重放回原回执，其他已有文件不覆盖；不迁入raw消息 |
| set_mode | target=legacy/observe/queue_first、CAS、模式授权ref；claims已暂停、无未核对intent、无当前有效claim、无consumer；queue_first另有相关成员新契约加载与E03在途处置ref | 仅改模式；不发送遗留项、不改变业务/传输记录、不自动解除暂停 |
| pause_claims | CAS、原因ref | 停止新claim和首次consumer获取；post/只读status/当前owner保存续办、resolve与对账仍可用。保留在途claim/intent，不能当作宿主已停 |
| resume_claims | CAS、原因ref；无未核对intent或身份冲突、无需要接管的孤立consumer/claim | 恢复合作式新领取；已有本实例有效claim仍保留，其他claim继续BUSY，不释放占用 |
| recover | claims已暂停；精确旧run/generation/claim/work、CAS、旧实例本次执行已结束或可核验隔离及在途效果核对ref | 同一当前Manager显式接管，递增generation、保留原activeWork/claim/审计；不重跑未知效果。未知副作用须先只读对账；不能因idle/TTL/失联放行。旧实例后续写被fence |
| release_consumer | 当前owner+generation、CAS；无当前claim、未决intent、未知在途效果，工作点已事实性完成/暂停并保留next/resume | 清本实例consumer，不删除续办/队列；允许下一获授权前台checkpoint获取。它不声明宿主idle、不发唤醒 |

claimsPaused 时 checkpoint 仍可核对待办；有owner者可存续办，无owner者不得取得新consumer或claim。
恢复读取用 status，不要求先变模式。recover 若无法证实旧实例静止/隔离，仅返回 needs-reconcile；
读过接口/超时/另一个同身份consumer自报“我是新实例”不是接管依据。
锁残留处理沿用归属明确的桥接恢复或显式人工核对，不由上述控制指令删除任意锁。

## 8. Manager 前台消费流程与 final 边界

checkpoint 触发器拟为：当前步骤完成；团队/当前用户回复结束前；已知压缩/前台恢复；
显式用户改变优先级；恢复一项处理中断。它们是**本次前台实际行为节点**，不是固定秒数、后台轮询或定时器。

1. 恢复本人 team context，核对当前真实用户意图和相同工作授权。
2. `checkpoint(trigger=resume/post_compaction/step_complete/before_final)`：程序读 state 与 inbox，返回 activeWork、
   最新 pending/reviewing/blocker、身份 hold、精确版本/watermark。之前有监督读取不替代当前续办核对。
3. 若主工作仍在当前步骤，保持它；只在安全边界选择有授权的候选。狭义问答不被 Worker 报告替换成任意团队工作。
   步骤完成后先给这批有效项明确 acknowledge/claim/defer，保存原工作恢复点；有 review 授权和预算时直接继续审查。
4. 正式项 claim → start_review → 独立检查 → 原 approve/rework（或明确验证阻塞）→ resolve；
   reviewing 项恢复精确当前 submission 的续办点，不接收一份旧通知来倒回 submitted。
5. 回复结束前 checkpoint 取得 final 票据：`controlRevision, stateVersion, arrivalHighWatermark,
   unresolvedItemIds/count, activeWorkId/continuationRevision, capturedAt`。新到消息不能被本轮“已处理”覆盖。
   最多再核对一次新版本差量；还有增长/超过预算时，明确“当前工作结果 + 已收件/仍排队事项 + 下次有意义续办点”，
   不谎称空队列、不无限追赶 producer。需要暂停团队业务的权限/身份错误单列，不能被普通 pending 描述隐藏。

队列收件确认可以只用 durable receipt/status，不为每条消息原生回复 Worker。
formal received/review/approval 仍分别显示；Worker 在 submitted/reviewing 中保留原占用，不因 inbox acknowledge 被释放。

**没有可用宿主 final hook 时**，final 票据只能支撑一个可执行 checkpoint 和 Skill 约束。
Runtime 能拒绝自己的 stale claim/resolve/continuation 写，不能拦截 LLM 直接 final，
也不能堵住“最后检查之后、final之前到达”的物理窗口。新项仍持久留队，下次授权前台恢复优先显示；
无该前台机会/可靠唤醒时不保证自动续办。未来 host hook 若可用，需另行验证能力与时间窗口，不算 v1 前提。

## 9. 原子性、并发、重放与故障处理

一般 post/checkpoint/claim/resolve：锁顺序 Registry → state → E05 sidecar；只用锁内最新 state 与账本，
修改一个 E05 文件后 `atomicWrite`。业务 writer 仍用原 state 锁，Registry 版本改变重新核对。
只有 sidecar 成功落盘才返回成功回执；输出丢失用同 operation_id/完全相同输入读回或重放。
目录替换原子性和 fsync 沿用当前文件系统约定；不承诺断电后的目录落盘或跨主机事务。

`start_review` 需要两个文件，采用**intent → 业务提交 → 可重建投影**，不宣称同时原子写成功：

1. 同三锁内校验 Manager、claim fencing、原 notice/current submission 和 expected_state_version；
   保存不可变 intent（精确 eventId/actor/at/noticeDigest/预期版本）及 operation fingerprint 至 E05。
2. 用既有 `planSubmissionReview/evolve` 生成原 schema2 review 并原子提交业务 state；不嵌套调用会重复取锁的 transact。
3. 更新 E05 intent/continuation 的业务 event 证据。若第3步失败，业务 review 已真实开始，不能退回“未发生”或重收一次。
4. 重放时先核对精确 eventId 和完整效果字段：已有相符业务事件就修复投影；不相符冲突。
   prepared intent 无业务事件、但其他 writer 已推进版本/时间，则返回 needs-reconcile，不盲用旧 timestamp/expectedVersion。
   核实该 intent 确未生效后显式结束它，重新核对后以新操作准备；不因超时假设未生效。

| 场景 | 必须得到的结果 |
| --- | --- |
| 多 Worker 同时 post；Manager 保存续办同时新到消息 | 序号/审计不丢不重复；Worker append 不改变 controlRevision；Manager 不用旧整文件覆盖新到记录 |
| post/claim/resolve 响应丢失、receipt 重放 | 同输入返回原效果/批次/claim，不重复执行业务；改输入拒绝 |
| processing 中崩溃/压缩 | 保留 claim 与事实工作点，操作效果 unknown 先对账；lease 超时不证明原工具已停止 |
| checkpoint 后新到 progress / 新 submit | 冻结旧内容，后继更新留队；旧 formal 被新提交 supersede，不启动旧审查 |
| final 票据后 version 变化 | 自身写入 CAS 拒绝或重读；final 文本无法强制阻止，未覆盖项留下明确 pending 与窗口说明 |
| Worker/领导历史身份变化 | 原消息留审计，单项 hold 或全队权威停止；不借新身份处理旧任务 |
| 两个 Manager 调用实例同时 claim（包括不同项） | 单consumer/currentClaimId门禁只让一个成功，不能覆盖activeWork；不同actor不是当前唯一Manager就拒绝；每个后续动作核对generation |
| 过期 claim 回来提交结果 | 状态先进入需核对，不自动释放；只有control.recover核对旧实例/在途工具后递增generation，之后旧generation写拒绝。不得用idle/TTL发新机会 |
| ENOSPC/权限/损坏/进程退出、业务写成功而投影失败 | 明確阶段与 mutationUnknown；保留业务真源与本地证据，不伪回执、删锁、建替代团队或丢弃队列 |
| 原 E03 ledger 不可读或 denied/unknown | inbox 中传输仍 unknown/受限，不重置历史；必要权限失败停止受影响访问，不用新通道绕过拒绝 |
| 旧 Worker 只 submit/E03；旧 Manager 直接 receive/approve | 由原业务事件补投影/核对既有结果，不生成重复 review；旧 writer 仍可绕过新协作 claim，属于兼容限制，不能宣称 host 独占 |

claim 是协议工作领取，不是 host 活跃锁。可以记录有界 lease 提醒需要核对，但不得自动从过期推出旧执行结束。
同一注册 Manager 的两个实例需要不同 run_instance_id 和 fencing generation；标识仍 caller-declared，
不能防恶意直接改文件/绕过 wrapper。既有 review/approve 的业务阶段/CAS继续防重复有效转移，
不等于能阻止两个 Agent 同时读取文件或执行任意工具。

## 10. 原生注入、quiet wake 与 E03 兼容

| 模式（拟新增、按团队显式选择） | 普通报告 | 可承诺的唤醒性质 |
| --- | --- | --- |
| legacy（缺省） | 当前 E03/原生 stage 回报原样 | 受宿主注入行为影响；没有 E05 不中断保证 |
| observe | 原发送不变，只shadow记录/核对；无E05消费、业务review或主工作切换 | 只验证投影与恢复计划，不能用它宣称少打断 |
| queue_first | 新契约 Worker post 取得 enqueued receipt；普通 progress/stage/submission/blocker **不默认逐条 native send** | Manager 有前台检查点时消费；无可靠 quiet wake 时不自动唤醒 idle |

第一版 queue_first 的选择是：接受 idle 期间延迟收件，由用户进入 Manager/既有获准前台继续处理。
可向用户显示本地待收件计数或 status，但不新建常驻服务、轮询 Agent、heartbeat 或 timer。
`read_thread/wait_threads` 查询到 idle 再 send 有 TOCTOU，既不能证明发出时仍 idle，也不能承诺宿主不插入另一回合。
正常报告不采用这种“看起来安静”的绕法。

如果已有明确获授权的 E03 发送机会，切换 queue_first 不能默默取消或消费它：
发送已 accepted 的保留事实；denied 停止；unknown 先核对，不能换 queue/post/新 notice ID 来绕过同披露限制。
新普通报告在已启用并加载的新契约下直接入队，不调用 E03 prepare，从而没有待记录的发送 attempt；
这是新的协作协议，**本 U12 尚未生效**。
未发送的入队结果只能写 enqueued/not-notified，不能记录 E03 accepted。
为实际 idle 恢复而由用户明确选择发送一次提示时，仍须遵守真实宿主/原 E03许可和不确定历史；
明确告诉用户可能注入当前回合，不能叫 quiet wake。stage 非正式内容也不能伪造 submit 来借 E03。

## 11. 实现切片与文件级计划（全部待后续授权）

| 切片 | 拟改文件 | 最小可执行结果/验收 |
| --- | --- | --- |
| S1：闭合数据与并发契约 | 新 `src/manager-inbox-contract.mjs`、`src/manager-inbox.mjs`；复用 store/registry guard，必要的小范围组合辅助 | 有界 sidecar、身份/task核对、operation/message去重、submit派生、seq/合并、control CAS；fixture 中不丢消息、不写假业务事实 |
| S2：checkpoint/续办/消费闭环 | 同核心模块；`src/submission-notice.mjs` 只提取可复用纯 plan 组合（既有语义不放宽）；`src/supervision.mjs` 增加可选 inbox引用 | 两事故可复现恢复；claim/start_review intent故障恢复；独立approve/rework/resolve；不把checkpoint当审批 |
| S3：最小 CLI/MCP | `src/cli.mjs`；新 `src/manager-inbox-adapter.mjs`；Python新受限 `inbox.py/inbox_tools.py` 与既有工具注册/可信runtime_link | 相同核心、有界桥接/归属锁、明确操作结果；no-send、无任意路径/命令/目标；不为队列启动服务 |
| S4：Skill 与灰度 | 后续改 `skills/manager-session/SKILL.md` 及 references/team-context、operations、completion-notification；docs使用/迁移说明 | 新工作点/检查点/queue_first handoff；正式收件与审查分开；先人工前台、不承诺 final hook/quiet wake |
| S5：现场小范围验证 | 后续新增 Node/Python测试与验证制品；无默认业务团队切换 | 一个获准团队、有界两事故复现实验；实际 Agent/压缩/宿主边界证据；通过后再逐队 opt-in |

不纳入第一版：多主机消息代理、后台服务、自动调度、模型选择、全文会话存储、审批机器人、跨团队批量收件、
自动归档、Dashboard新流程或宿主 hook 安装。没有接口能力时不假造集成。

启用/灰度：先只读规划现有 pending/reviewing、notice attempts 与历史绑定；显式 init 固定 mode=observe，
不导入非提交 raw 会话。当前正式待办补投影保留原 submit/通知/业务结果。
只有当前 Manager、各相关 Worker 的新 handoff/前台契约加载已核对，且 denied/unknown/in-flight机会已处置，
才显式切 queue_first；忙碌的既有 Worker 不因安装而被强行打断，未刷新者标 legacy，不能声称全队不注入。
副本/备份、文件哈希与版本/修订回执留证；sidecar模式也是受限配置变化，不默默修改Registry或全局配置。

回退：显式暂停新 claim，核对在途 intent/claim，不丢掉未处理普通报告与业务待审。
转 legacy 后原业务 state/E03 history保持，遗留 E05 队列可由升级后的只读status导出、授权前台逐项处置；
不用老快照覆盖新 state，不把全部 enqueued 项转为未发送后批量 native send。
旧 writer 不识别 sidecar但仍可提交业务事件，新 reader继续补投影；旧 Manager 不能获得 E05约束，
因此回退后只保留兼容事实，不保证queue-first行为。已有 Agent 上下文不会因改文件自动更新。

## 12. 测试矩阵、事故映射与可操作验收

本设计阶段只核对源码/文档，自检不等于实现测试。此前82/153回归只能作为旧能力基线，
不能证明新队列、实际 Agent 不被打断或自然压缩恢复。

| 测试层 | 输入/故障序列 | 应验结果 |
| --- | --- | --- |
| Runtime R-A（事故A） | 工作点=user-work策划；中途业务submit+post；步骤完成/before_final checkpoint | 原步骤不被自动替换；提交只入队，无review；checkpoint有明确收件/延期或claim，后续start_review一次；不需要用户指出“漏消息”才能从真源找到它 |
| Runtime R-B（事故B） | 权限审查工作点+review目标；记录部分证据后模拟丢失LLM上下文；状态里另有已批准封面 | checkpoint恢复权限task/submission/step/nextAction；旧封面不成为activeWork；已发生review不重复，unknown副作用先对账 |
| Runtime R-C | submit/post间崩溃、重复post、新resubmit/终态、post后身份改变 | 唯一派生项；旧提交superseded/stale，identity-hold，不归新身份；没有fake received/accepted |
| Runtime R-D | 并发producer、control CAS、25+progress合并、watermark后更新、重复receipt | 审计/seq不丢；前后继不吞；同操作不新增效果；同消息改正文拒绝 |
| Runtime R-E | 多次无条件defer、持续新progress、条件未变、达到3次checkpoint | 不反复抽同deferred，不重置队龄；有效项必须有具体处置/输入冲突，未声称idle墙钟保证 |
| Runtime R-F | 两consumer领取不同项；当前review时再claim；defer/resume；expired lease、recover、fenced旧结果；final票据后版本变更 | 单consumer/claim/activeWork不被覆盖；无停止证据不接管；合法recover递增generation，旧写拒绝；没有TTL=宿主停止或final强拦截承诺 |
| Runtime R-G | ENOSPC/损坏；start_review每个提交边界kill/丢响应；旧writer推进业务 | 精确intent/业务真源恢复，最多一个有效review，副作用unknown不盲重跑；旧结果可对账，原notice限制保留 |
| 模拟 host H1/H2 | queue_first新契约adapter +忙碌/idle假host；legacy/in-flight E03 accepted/unknown/denied | 普通post/checkpoint宿主send计数0；不“先查idle后send”；inbox enqueued不变accepted；限制/在途历史不清零。这只证明受测adapter路径 |
| 实际 Agent A1（事故A） | 在获准团队当前Manager文档/讨论步骤中，原Worker明确入队；完整当前步骤后自然checkpoint | 原步骤目标/成果保持；记录明确收件；继续有授权审查，无逐条native发送；保存实际Agent节点/消息/调用证据，不用模拟替代 |
| 实际 Agent A2（事故B） | 审查第二次submit中完成一个真实证据读取、保存续办点，实际发生contextCompaction后继续 | 本人recall+checkpoint恢复同task/submission/nextAction，未回到已批准成果；无用户再提示任务名；记录实际压缩及恢复节点。没发生真实压缩时此项未验证 |
| 实际 host A3 | Manager无前台回合，Worker只post；之后用户明确进入Manager；另测获准提示消息的实际注入 | idle不宣称自动醒；进入后找到持久项。提示若插入忙碌回合如实记录，不能宣称quiet wake；没有权限/能力不伪造该实验 |
| 迁移 M1 | 旧Worker E03、升级Worker queue_first混合；模式回退，仍有pending/intent | 标明legacy覆盖与不能全队不中断；旧业务事实不丢，不重发accepted/unknown/denied；队列普通项有明确保留/导出处置 |
| Runtime R-H（控制/审查边界） | init并发/重放；有claim或未决intent切模式；pause/resume/release/recover错误CAS/actor；formal只引用review或前次approve；blocked有/无submit | 不覆盖初始化；有在途风险拒绝切换/释放，Worker控制拒绝；review与旧决议不能settle当前提交，reviewing/有未决提交的blocked仍续办，其他blocker不伪造formal |

后续实现验收逐项勾选：R-A～R-H和桥接/权限测试通过；H1/H2无意外native调用；
至少一个获准团队A1真实通过、A2实际压缩恢复通过或明确暂不允许扩大灰度；
A3准确显示未通知/无自动唤醒限制；可追溯收件、独立review/approve及续办证据；
M1通过并保留旧传输记录。容量/身份/磁盘失败和旧writer限制要在结果中可见。

待评审决策是：是否接受v1无quiet wake的idle延迟；是否认可附加账本+业务真源派生；
3项/8项与三次有意义checkpoint延期上限是否适合团队；合作式claim/intent边界与旧writer限制是否足够；
何时另行授权实现/现场灰度。本文不替用户批准这些后续工作。
