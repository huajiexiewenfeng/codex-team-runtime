# 显式任务、成员与步骤记录

任务owner、业务阶段声明、步骤记录成员、机器服务调用是不同证据。Dashboard不按时间接近或当前owner回填历史。MCP服务端的毫秒/秒并非Agent工作时长；Token来源也不会因为MCP标签增加覆盖。

## 实际活动 begin/end

### 正式 Worker 的命令步骤

已启用明确持续策略的团队，可在正常交接中携带核验后的 policy 路径和 own taskId，
使用 `stats-managed-step` / `stats-managed-begin` / `stats-managed-end` 自动选择稳定
任务 producer；见 [continuous-metrics.md](continuous-metrics.md)。这些入口不回填忙碌
团队历史，不把审批等待算实施，也不改变 submit/notice/验收协议。
明确授权的原 Worker 返工阶段也可记新命令步骤；相同 receipt 仍不重跑命令。
新尝试只允许 executing/rework，submitted/reviewing/blocked 仍拒绝。

已授权的明确命令步骤优先使用 `stats-step-run`，减少手填完整身份与漏 end。
它是**命令步骤/Worker 声明活动区间**，含该命令内的等待和失败尝试；不是完整 Agent
工作时长，也不是纯工作时间。执行权限仍来自原任务授权，receipt 不授权重跑命令。

step-request.json 只需 `hostId, threadId, taskId, roundId, stepId, evidenceRef`。
用自己已核验的宿主/对话和既定任务，不借用别人的身份；这些字段是调用者声明，
不是宿主认证。当前 Registry 投影校验 active/ready Worker、自有 task/round，
新运行要求任务 executing；批准的同团队 manifest/source 提供唯一匹配的 binding
和 roleEpoch/revision。该 source 必须为明确任务授权的 append-only activity-jsonl。
不自动创建 manifest、不写业务 state、不新增 MCP role-read。

```powershell
node <runtime-root>/src/cli.mjs stats-step-run <trusted-state.json> <approved-manifest.json> <sourceId> <step-request.json> <new-workflow-receipt.json> -- <executable> <args>
node <runtime-root>/src/cli.mjs stats-refresh <approved-manifest.json> <owned-cache-v3>
```

例如把一次已授权的测试/构建作为步骤，传入 Node 可执行文件和测试参数。
命令参数按数组传递，shell:false、windowsHide:true，不拼接 shell 字符串；cwd
继承当前目录。环境及命令参数不写入活动源/Dashboard，receipt 只保存命令/cwd 指纹。
保留原日志。命令非零退出时 CLI 返回失败；活动 end 只证明尝试终止，业务结果见
workflow receipt 的 outcome/businessSuccess 输出，不把 Dashboard 的区间完成当业务成功。

- 新 receipt exclusive claim 后自动 begin；短 append 锁冲突仅有界重试幂等 producer，
  不重试业务命令、不删除 stale lock。并行步骤用不同 receipt；同成员重叠由 collector
  求并集，成员分开，团队区间并集不是各成员人时之和。
- finished 的相同请求/命令/cwd重放核验两端证据，仅回放结果，不执行命令。
  修改上下文/source/命令指纹拒绝。每次明确获准的重试使用新 receipt、新 eventId；
  可沿用 stepId，活动区间不能跨尝试拼接。
- prepared/running 中断无可证 end，保留 pending/duration 未知；拒绝同 receipt
  继续计时或重跑。先确认旧命令已终止、业务副作用及重试授权，再新建 receipt 续跑。
  不把停机/人审空档算活动，不删除旧记录，不承诺 exactly-once 业务执行。
- finishing 保存了真实退出 UTC/outcome；同请求恢复仅将原退出点幂等追加到 source，
  不执行命令，也不把恢复当前时间当 end。恢复时仍检查身份、任务状态和来源；
  binding/任务变化拒绝。若实际退出后、finishing 持久化前崩溃，仍属未知。
- receipt 与低层 `.activity.json` 是本机恢复证据，非防同账户篡改签名。
  异常 producer 锁残留需所有者验证后恢复；工具不猜 PID、不自动清理锁。

跨多次工具调用的 Agent 实施步骤仍可使用下面的显式 begin/end。在已可证活动结束
或暂停前及时 end；未知中断不得用恢复时刻补旧 end，恢复用新 receipt。只围住少量
明确业务步骤，不要求每个工具都记日志；人审等待和完整任务墙钟另有口径。

已有 `activity-sidecar/v1` 只声明活动，不自动埋点所有工具。使用已明确授权、append-only的activity-jsonl source；source selection必须明确task/round，bindings有正确member/host/thread/roleEpoch/bindingRevision和授权时间。不得为了展示自动扩充真实manifest或写其他团队日志。

context.json包含 `teamId, memberId, hostId, threadId, bindingRevision, roleEpoch, role, taskId, roundId, stepId, assurance, evidenceRef`。所有身份/关联都来自已核验任务和步骤执行者证据；assurance仅worker-declared或operator-declared，不能machine-source-reported。选择一个不与manifest/任何来源碰撞的新receipt路径。

```powershell
node <runtime-root>/src/cli.mjs stats-activity-begin <approved-manifest.json> <sourceId> <explicit-context.json> <new-receipt.json>
# 执行这个明确步骤；不等待或编造未发生的动作。
node <runtime-root>/src/cli.mjs stats-activity-end <approved-manifest.json> <receipt.json>
node <runtime-root>/src/cli.mjs stats-refresh <approved-manifest.json> <new-owned-cache-v3>
```

begin产生真实当前UTC和eventID；end使用同一receipt、身份/task/round/step和实际结束UTC。receipt意图先持久化，失败重试相同参数沿用同eventID/时间；append+fsync后保留begin记录的offset/bytes，end有界读回核对，篡改task/step或两端不符拒绝。重复成功begin/end不再追加；崩溃后重复相同事件由collector去重。source授权变化拒绝自动迁移。缺end保留pending和duration未知，不能补造结束。receipt是本机恢复证据，不是抵抗同账户伪造的认证签名。

producer不会写团队业务state或替换Registry；collector再配对begin/end，以步骤事件中的成员binding作为步骤负责人，不用task owner代替。声明活动与machine MCP分别聚合/展示，不相加成完整工时。

## 可选 read 上下文与边界

仅已有必要的角色恢复调用且新工具schema支持时，才可附 `work_context`：

```json
{"scope":"task","team_id":"team","round_id":"round","task_id":"task","step_id":"implementation"}
```

团队级为 `{"scope":"team","team_id":"team"}`。不增加read频率，不把每个tool/步骤的read当完整埋点。旧无参调用仍正常，未知身份仍null。无context时Manager/Liaison共享，Worker缺关联；明确team scope可记录团队共享。task/round/team和当前Registry投影必须匹配，Worker仅关联自己的既定任务；Manager/Liaison的协调关联仍是声明，不能授予派发/写入权。stepId是本次明确步骤标签，不冒称业务步骤台账已存在。

可选context通过Registry已绑定的只读Node校验，记录校验版本/asOf及成员角色/绑定；read返回身份若变化则拒绝产出有效context。无效/越界不归给其他任务。schema2的workContext.associationSource为caller-declared，计时仍machine-source-reported，仅证明MCP服务操作起止。保留旧notice/dispatch原显式taskId；新记录若与其冲突拒绝。API查询支持stepId/roundId/taskId/memberId；步骤详情列出关联与计时证据。

## 升级、回放和运行中版本

双reader严格读取原v1及新增closed v2，未知扩展失败并保留来源诊断/last-good。rules=dashboard-stats-v3、collector=bounded-metadata-v3。旧v2cache/lease返回明确version-mismatch，不原地覆盖，不静默丢历史；只读批准来源回填到新cache：

```powershell
node <runtime-root>/src/cli.mjs stats-refresh <approved-manifest.json> <new-owned-cache-v3>
node <runtime-root>/src/cli.mjs dashboard-serve <state.json> --team <team> --source-manifest <approved-manifest.json> --stats-cache <new-owned-cache-v3> --port 0
```

先安装双reader，再安装producer。现有Dashboard/MCP进程仍持有旧代码，文件就位不等于运行版本已切换；由owner重载其Dashboard并按需最小重连MCP。不重启整个Codex、升级依赖或改Registry/config。只有新发现schema含work_context时才使用它，旧连接继续无context角色恢复。安装证据必须区分这两种事实。

历史固定71条MCP基线仍25任务关联+22团队共享+24缺关联；视频活跃state合法变化只记录版本，不冻结或改写它。新采集隔离fixture用于真实producer写入→collector→按任务/成员/步骤查询与UI，不能称视频团队历史已补齐。原Token显示规则、一天一行/成员modal、缺失未知与native覆盖边界保留。
