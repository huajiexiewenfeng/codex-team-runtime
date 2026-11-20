# 固定派发入口候选（2026-11-16）

本候选仅支持**独立新任务**。未安装、未提交、未合并、未推送。原固定入口已在独立隔离测试真实发送一次；本次宿主兼容修改仅对原operation做status/幂等重入，未新发送，未访问业务团队数据。Manager 审查后才决定采用。不得拿此文的占位信息运行业务派发。

## 宿主边界与固定调用

固定模板：`scripts/manager-operations-functions-exec.js` 中的 `runManagerDispatch`。
将完整模板放入**当前已授权派发的同一 functions.exec 调用**，无需 import、Node、fs、Buffer 或新的 LLM 轮次。程序经 `tools.exec_command` 启动可信 Node bridge；只有模板调用宿主 `tools.mcp__codex_app__send_message_to_thread`。MCP/Node 不直接调用宿主工具。

必须先验证 Node 22+、安装的 Python exporter 路径、Runtime 版本、Registry/身份和宿主发送工具能力。运行源代码不等于安装。现有工具权限与原生授权审核照常生效。

正常输入只填写一份任务决策和已有事实：

```js
text(await runManagerDispatch({
  tools,
  nodeExecutable: 'VERIFIED_ABSOLUTE_NODE.exe',
  pythonExecutable: 'VERIFIED_ABSOLUTE_INSTALLED_PYTHON.exe',
  runtimeRoot: 'VERIFIED_ADOPTED_RUNTIME',
  shellExecutable: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  requestFile: 'ABSOLUTE_NEW_TASK_MATERIAL.json',
  hostExecutionOptions: {sandbox_permissions:'require_escalated',justification:'执行当前已授权任务的固定Manager桥接'},
  hostSendAuthorized: true,
  authorizationRef: 'EXISTING_EXPLICIT_HUMAN_AUTHORIZATION_REF',
  task: {
    statePath: 'ABSOLUTE_TRUSTED_STATE.json',
    hostEvidencePath: 'ABSOLUTE_NEW_NATIVE_RESULT.json',
    operationId: 'ONE_STABLE_OPERATION_FOR_THIS_NEW_TASK',
    caller: {hostId:'VERIFIED_MANAGER_HOST',threadId:'VERIFIED_MANAGER_THREAD'},
    teamId:'TEAM',roundId:'ROUND',workerId:'FORMAL_WORKER',
    expectedVersion:42,mode:'legacy',reason:'before_dispatch',
    title:'Original authorized task title',required:true,
    brief:{
      text:'Original handoff material',
      scope:'Original authorized write scope',
      materialRefs:['EXISTING_MATERIAL_REF'],
      authorizationRef:'EXISTING_AUTHORIZATION_REF',
      dependencyRef:'ACTUAL_PREREQUISITE_CHECK_REF'
    },
    admission:{native:{host_id:'VERIFIED_WORKER_HOST',thread_id:'VERIFIED_WORKER_THREAD',
      status:'idle',evidence_ref:'ACTUAL_NATIVE_ADMISSION_CHECK_REF'}},
    baseline:{outcome:'not-attempted',evidence_ref:'ACTUAL_NO_SEND_OR_INFLIGHT_CHECK_REF'}
  }
}));
```

占位值需替换为真实既有决策/证据；不自动推断 idle、授权、前置条件或历史。路径父目录必须已经存在。保留原触发 reason、当前 mode、真实 caller。原生观察时间可保留在 admission.native.observed_at；程序不制造或刷新它。

taskId 由 SHA256(teamId, operationId, new-task) 派生，prepare operation 由 SHA256(teamId, operationId) 派生；enqueue 使用同一个 operationId。实际 enqueue event、attempt、briefRef、result operation 和事件时间均由既有 Runtime 返回/生成。Manager 不手填它们。同 operation 必须始终表示同一个独立新任务；澄清/返工沿用原任务协议，不能换 operation 自动派发。

原来的高级 `input:{statePath,enqueueInput,brief,prepareInput,hostEvidencePath}` 仍可用于兼容/测试，不作为正常入口。原 `runManagerOperations` 保留兼容；本候选不声称封锁入口外的裸 send 或其他调用。

## 2026-11-17：宿主 shell 兼容与诊断

直接使用原始 `tools`，在同一固定调用中显式选择宿主权限：

```js
hostExecutionOptions: {
  sandbox_permissions: 'require_escalated',
  justification: '执行当前已授权任务的固定Manager桥接；写入范围为该任务材料和台账'
}
```

这只把真实参数交给宿主审核，不批准执行，也不绕过原生发送权限。仅接受 `sandbox_permissions` 和 `justification`，禁止透传 cmd/workdir/shell/prefix_rule 等覆盖项。`require_escalated` 需要一行非空说明（最多1000字符）；`use_default` 不带 justification。省略整个选项保持旧的默认权限模式。shellExecutable 是独立的已验证绝对路径；指定时 login=false。三个入口 runManagerDispatch/runManagerOperations/runManagerReviewStage 均支持上述参数。

**没有自动提权、重试或正式路径启动 probe**。权限拒绝、空/非JSON输出、丢失会话结果都只返回诊断，不重新执行 save/prepare/send。配置/安装/Worker/MCP 不变。已提交操作仍用原 operation/attempt 对账。

本次无副作用对照发现：同一 shell/cwd 下，默认 Node JSON probe 返回 exit0 + 空输出；默认 PowerShell 自身 stdout/stderr/exit23 正常，而默认 Node 版本/常量输出 probe 无输出、LASTEXITCODE 为空。显式提权对应 Node 输出和 exit19 正常。问题定位到受限宿主的原生子进程执行/结果边界；没有足够证据确定具体 ACL/沙箱内部机制，也不能把空输出直接称为权限拒绝。

原隔离首轮仅留 JSON parse error，没有底层 shell 响应，故本次复现不能冒充原始根因证据。原模板后来在正式提权 wrapper 下真实派发成功（88.913秒）已有父 Manager 独立审查；本次修改不重复发送。当前模板已用原始 tools + 显式参数执行隔离缺失 request 的 status，正确保留 CLI exit1、INVALID_REQUEST/requestFile，无 wrapper、无团队state/prepare/send。原隔离 Manager 已复用原聊天，以原始 tools + 显式 hostExecutionOptions 验证正常 status/同operation重入通过，无新发送，state仍v7，55个原文件字节哈希不变。证据：C:/Users/admin/Documents/New project 2/artifacts/dispatch-host-validation-20261117/shell-compat-recheck/DELIVERY.md（同目录results.json/post-check.json）。默认路径复验仍为空输出，现明确返回SHELL_EMPTY_OUTPUT；不能声称默认执行路径故障已修复。本次没有新增任务首次发送验收。

失败返回的 shellDiagnostic 包含 action、最后帧 exitCode/exitCodeKnown、会话ID、轮询次数、stdout/stderr字符数、有界首尾预览、最多8帧摘要，以及可用的工具错误码。正常成功不回灌 shell 原文或命令正文。完整原始帧保留在宿主工具历史；本次 probe/验证原文还保存于候选外 `dispatch-shell-compat-evidence-20261117`。这不是新的业务台账。

| 情况 | 结果与行动 |
| --- | --- |
| 工具拒绝/异常 | SHELL_TOOL_ERROR，保留可用 causeCode；不提权重试 |
| exit0 但空输出 | SHELL_EMPTY_OUTPUT，不能证明 Node bridge 已运行 |
| 非JSON/错误JSON形状 | SHELL_NON_JSON/SHELL_INVALID_JSON；看有界预览及原工具帧 |
| CLI status:error（包括 exit1） | 保留原 reasonCode/field，附 shell 诊断，强制 sendNow=false |
| 任一帧非零退出但声称成功/prepare | SHELL_EXIT_NONZERO，绝不发送 |
| **终止帧缺exit_code** | SHELL_EXIT_UNKNOWN；不能沿用先前帧 exit0，结构化错误仍保留且禁止send |
| 会话未完成/轮询异常 | 保留原session和已收stdout的诊断，不重新exec；先确认原进程已结束 |
| save 失败 | 先核实材料是否存在及原调用终止；不建议对不存在request执行recover |
| entry_prepare 失败 | 以已保存材料核对原E04 operation；不重放prepare/send |
| entry_result 失败 | 核对原native结果；仅在确切原文已保存时同attempt recover，绝不重发 |

解析器最多累计1 MiB stdout，检测宿主明确的输出截断；超限只停止判定。轮询每次5秒，最多120次，耗尽保持未知、不杀进程。完整原工具历史可能包含原始任务内容，应按原任务权限读取，不能把有界诊断当完整原文。

## 固定流程与持久化

1. save 校验并独占保存原始任务材料；同内容重复保存无新增业务事件。
2. 复用 prepareManagerDispatch → freezeDispatchBrief → managerRequest(enqueue) → dispatchRuntime(prepare)。沿用原 Registry、身份、CAS、FIFO、忙碌 Worker、授权引用与未知投递保护。
3. 同一个 entry_prepare bridge 动作保存 prepare 回执，并在返回宿主前独占写入 attempt 发送领取凭据；只有**本次新鲜 prepare 且新鲜领取**的返回才允许一次原生调用。
4. 原生返回传给 entry_result；Node 根据原始返回判定 accepted/denied/unknown，先独占保存原文，再向既有 E04 result 登记。Manager 不填写 outcome。
5. 普通重复调用遇到已有 prepare，自动尝试恢复已保存原生证据；绝不调用发送器。

传输材料不维护业务任务状态或第二套业务台账：

- requestFile：闭合原输入，brief.text 原文保留；brief 另由 E04 对象存储保存。
- requestFile.prepared.json：本次 prepare 的真实回执，只供对账，磁盘缓存不授予发送权。
- canonicalStatePath.dispatch-send-SHA256(attemptId).json：业务 attempt 唯一发送领取。与 requestFile 无关，更换路径不创造领取机会。
- hostEvidencePath：原始 native envelope、实际 attempt 与输入 fingerprint，及从原文派生的 transport outcome。
- requestFile.entry.lock：短期材料锁；Registry/state 仍取既有锁。异常退出留下锁时禁止自动删除，先确认原执行已终止并人工对账。

发送领取先于原生调用。即使 shell stdout 丢失、原生调用前崩溃，也不会重新发放领取。独立 claim_send 已删除，模板不含 fallback。现有 E04 replay/status 不重新授予发送权。

## 断点恢复边界

在同一模板内，以原 requestFile、Runtime/Node/Python 路径调用：

```js
text(await runManagerDispatch({...verifiedPaths, tools, phase:'status'}));
text(await runManagerDispatch({...verifiedPaths, tools, phase:'recover'}));
```

status/recover 不调用发送器，不需要新派发授权。仍检查原 Manager/Registry，不能冒充身份。不要用另一个 requestFile 规避原有结果。

| 断点 | 支持的恢复 | 禁止行为 |
| --- | --- | --- |
| save 前字段无效 | 修正字段后原 operation 重试；不保存无效材料 | 为绕过错误变更业务身份 |
| save 完成、enqueue 未提交 | 原输入继续；CAS 错误经复核可显式修复 | 猜测提交成功 |
| enqueue 成功、响应丢失/prepare 未成功 | 原 enqueue operation 幂等恢复，仍只有一个任务 | 新建第二个 task |
| prepare 已提交，但 prepare 回执写失败 | 从 E04 status 对账，同 attempt 保持占用 | 重放 prepare 并发送 |
| prepare 回执存在，领取尚未写入 | PREPARED_UNCLAIMED，能准确对账；**不支持恢复首次发送权** | 从缓存/status 重新 claim |
| 领取已写、宿主尚未调用/结果丢失 | NATIVE_RESULT_UNKNOWN；保留占用，检查原宿主调用事实 | 自动首次发送或重发 |
| 原生成功、原文尚未落盘/落盘失败 | 原生工具原结果是唯一进一步依据，人工对账；不猜成功 | 换 ID、改目标或裸 send |
| 原文已保存，result 失败/响应丢失 | recover 用同 attempt、同原文、同 result operation 幂等补登记 | 重新发送 |
| unknown/denied/结果缺字段 | 如实登记 transport 结果，保留原有占用/拒绝保护 | 猜 accepted 或自动重试 |

重要限制：即便能证明本入口还没写领取，也不能因此推断入口外未发送。E04 当前不提供恢复首次发送许可的契约，本候选不扩大它。prepare 与领取合并已减少一个跨进程断点，但不是原子文件/网络事务，不承诺 exactly-once、整机断电恢复或原生投递成功。

字段修复：schema 错误在保存前返回具体错误。已保存输入默认不可变；对确定失败的 CAS/准入字段，在确认原执行结束后，用返回的 `stages.material.inputFingerprint` 作为 `repairFingerprint`，提供修正后的同份 task/input 再调用。业务 operation、task、Manager、Worker、路径不变。enqueue 已提交后，其完整输入和 brief 不可改，只能修复尚未提交 prepare 的准入字段；prepare/started 后拒绝修复。此参数是输入 CAS，不增加审批。

## 能力、验证与交付限制

- 新入口 Windows shell command 限 24000 字符（含 base64、路径）；超限在 shell 前停止。正文大时用已有材料引用。巨型 native 原文若超此界限不能自动保存，需对账；不截断成功结果、不重发。
- accepted 仅指宿主返回符合已验证的严格 envelope（isError=false，精确 threadId/可选 hostId）。新增未知字段/返回形状视为 unknown；原模板已由父Manager在隔离聊天验证一次真实返回；本次shell修改未重复真实发送，不外推其他返回形状。
- Node/Python/shell 的安装、配置、MCP、真实 Registry 和业务 state 完全未改。测试只创建临时合成 Registry。真实壳层链路与已安装 Python exporter 已离线验证，发送器明确为假；原模板已有父Manager审查的隔离真实投递证据；当前修改已在原隔离聊天完成原始tools的status/同operation重入复验，无新投递；默认路径仍为空输出。
- 新模块只由 Manager bridge 懒加载。未改 Worker 启动、恢复、read/ready、正常提交/通知调用、Liaison 及 Watchdog 原生结束检测；没有新子代理、守护进程、定时器或 LLM 轮次。
- 未修改/运行安装器；未来安装包需显式包含新模块并独立审核。本候选不构成已安装能力，也不承诺旧安装包自动包含新入口。
- 结果登记不等于 Worker 收到、开始、提交或 Manager 验收。最终审查仍归父 Manager。

测试命令及实际汇总保存在候选外的 delivery report / 日志。覆盖三个纯合成团队的完整成功、重复/并发、跨 requestFile 同 operation、不同内容、忙碌/身份/绑定/Registry/授权拒绝、unknown/缺字段、原始证据恢复与各断点。
