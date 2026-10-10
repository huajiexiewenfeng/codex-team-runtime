# E05 本地收件与续办

源码提供核心、CLI 与受限 Python/MCP 桥接；默认未初始化，初始化为 observe 且暂停领取。
不自动安装、迁移、启用 queue_first、发消息、启动服务或唤醒 Agent。
U12 原设计稿保留验收版本；本文记录可调用契约。实际 Agent/自然 compaction/idle 验证属于后续获准灰度。

## 真实入口

MCP `team_context.inbox` 与只读 `team_context.inbox_status` 各只接受 `request_json` 字符串。
字符串内是封闭 JSON；status 工具只允许 action=status。重复键、Unicode、深度与字节限制在 Node 核心、CLI、Python同样校验。
不向 MCP 传任意 statePath/registryPath/command/target；可信 runtime_link 定位，由 Node guard 再核对当前 ready 与历史身份。

```text
node <runtime>/src/cli.mjs inbox-request <trusted-state.json> <closed-request.json>
node <runtime>/src/cli.mjs inbox-post <trusted-state.json> <closed-post-request.json>
node <runtime>/src/cli.mjs inbox-status <trusted-state.json> <closed-status-request.json>
```

其他 CLI：inbox-checkpoint/claim/start-review/resolve/control。文件内 action 必须匹配；CLI是已有本地文件权限，非公开文件接口。
共同请求字段：action、actor_host_id、actor_thread_id、team_id、reason；写动作需稳定 operation_id。
身份/外部证据仍 caller-declared/caller-assessed；hash/ready不是认证。保存原请求，输出丢失查精确 status 或重放，不盲造新操作。

## 显式启用与回退

1. 授权原Manager核对业务 state、Registry、历史成员与 E03 在途记录；未安装就报告不可用。
2. control(init)：authorization_ref、expected_absent=true、expected_state_version、team_revision。
   独占创建可信state旁的 `.manager-inbox.json`，observe/claimsPaused=true，不覆盖旧文件。
3. observe 的 post/checkpoint 只shadow，不取得consumer、不切activeWork、不写review。
4. 已核对相关 ready Manager/Worker 加载新 handoff 后，control(set_mode)携带 expected_control_revision、authorization_ref、
   mode=queue_first、protocol_loaded=[{member_id,binding_revision,evidence_ref}]。暂停领取且无consumer/未决intent/unknown效果才可切换；E03未决unknown阻止切换。
5. control(resume_claims)显式开启合作式领取，仍只有前台实际检查点，不是 timer。

pause_claims保留在途动作/消息；当前owner可存事实、resolve/对账。resume不清已有claim；
release_consumer须无claim/intent/unknown且当前工作已paused/completed。回退legacy/observe也须暂停并解除未决控制风险，
保留队列、业务与E03记录，不覆盖旧state或批量重发accepted/unknown/denied。旧writer事件可收敛投影；安装不会刷新旧Agent上下文。

## 报告与失败

Worker普通message：kind=progress/stage/blocker、message_id、round_id、task_id、step_id、producer_seq、summary、evidence。
blocker可加精确block_event_id；无则只是报告，不改业务阶段。请求≤16KiB、摘要≤2000字符、证据≤16个/ref≤512字符，不含凭据/整份日志。
message去重键不含step，producer流包含step；同message_id改step/正文冲突，不能换operation_id绕开。
正式报告先原Worker durable submit，再post message={kind:submission,submit_event_id:精确事件}。
漏post/失败的正式项由后续checkpoint从state补回；普通消息失败保留本地获准证据/原请求，核对执行与原操作结果后再处理。

**已知 queue_first 下 post、新工具或桥接失败，绝不偷偷 fallback 到原生 send/E03 prepare。**
保留原提交/证据和明确失败；独立用户模式变更与原有unknown/denied限制须另核对。enqueued/shadow-recorded不是accepted、收件或批准。
FIFO按接纳seq；progress合并展示但审计不可变。旧checkpoint ack/defer只消费冻结版本，后到更新留后继；settle须有效claim。
恢复既看submitted，也联合reviewing/有未决正式项的blocked，不能只查pending-submissions。报告与next_action都是数据，不自动执行。

## 前台续办与有限消费

checkpoint：run_id、expected_control_revision、trigger=resume/post_compaction/step_complete/before_final/user_change，可选limit默认3/最多8。
返回consumer/generation、控制版本、冻结items/payloadSeq、activeWork和finalTicket。实际MCP包装≤64KiB，可少于limit并返回hasMore。
continuation闭合字段见设计例子：work_id、kind、task_ref或user_work_ref、authorization_ref、step_id、phase、next_action、evidence_refs、last_effect、continuation_revision。
save/switch须expected_work_id；switch需真实用户指令ref并先处置claim/intent。无团队task不造假task；不保存思维链，不执行next_action命令。
started/unknown不能reset或换operation。外部真实结果用checkpoint.effect_result={operation_ref,status:succeeded/failed,evidence_ref}，
精确对应原operation和新last_effect；程序自己的review intent先重放原start_review对账，不用外部字段绕过。

claim：run_id/generation、expected_control_revision/work_id、checkpoint_id、item_id、payload_seq、boundary_ref。
单consumer/当前claim，不同item也互斥；原主工作paused/resumeRef，结束或显式defer恢复。
start_review：run/generation/claim_id、expected_state_version，只对精确当前formal启动业务review。
resolve：run/generation、control/work CAS、item_id、claim_id或checkpoint_id、disposition、reason_ref。
ack是收件；defer需{kind:busy/dependency/needs-input,trigger,evidence_ref,condition?}；settle须claim，
formal另需精确当前提交的decision_event_id=approve/rework/合法终态，review不算完成。
dependency条件为task_id/status；needs-input不循环；busy最多3次有意义checkpoint，之后明确处理或等待输入。

同回合compaction保留run/generation。真正新实例才pause后control(recover)，提供旧run/generation/claim/work CAS、
old_execution_ended=true/quiescence_ref及精确effects/no_effect_intents；新run不能复用旧run，不以idle/TTL推断结束。
结果证据由真实宿主与Agent负责，字符串不是认证。原review intent已有精确event时，即使旧writer随后approve也只修回执，不重复review/倒退阶段。

## 恢复与限制

锁顺序Registry→state→E05；start_review为intent→业务提交→投影，不声称两文件事务。业务已写/投影失败查原精确操作，不review第二次。
桥接含status都登记本次token/PID/nonce和三条E05允许锁路径；仅证实执行结束且同归属才清理，不猜PID或删其他锁。
CLI被中断的残留锁需相同归属/人工核对，无全局清锁器。
正式sender从原round/submit构造；Node历史无native revision，初始revision1且精确tuple相符可核对，其余不可证则hold，不能借当前新身份。
E03unknown/denied为hold，实际ledger对账才解除unknown；denied不被任意resolve清零，held输出只给遮蔽摘要/原ref。
16MiB/512未终结项/8192审计动作容量、损坏、磁盘失败明确拒绝，不静默丢弃或TTL删除；原业务submit仍可用原supervision/pending核对。
无可靠quiet wake不自动唤醒idle；查idle再send有TOCTOU。finalTicket不拦截LLM final，后到消息保留到下一获准前台。
确定性/模拟host测试不能证明真实Agent永远遵守或实际不中断。
