# 撤销已启动、已停止的任务

`cancel-stopped` 是 Manager 的本地审计入口，不发送停止指令、不终止进程、不删除 WIP，也不代表验收。不得由维护任务代替业务 Manager 执行。

## 使用前提

- 用户明确撤销这项工作，保留真实授权引用及时间；普通 idle、变更优先级、等待时间长都不等于撤销。
- 当前及轮次内 Manager/Worker 绑定精确一致；linked state 仍需通过 Registry readiness/投影检查。
- 仅 `executing`，`submissions=0`，历史阶段仅 queued/executing。queued 用原 `cancel-queued`；submitted/reviewing/rework/blocked 不在本版范围。
- 派发台账最后状态为 `delivered`，attemptId 精确匹配。unknown、没有台账或 non-delivery 不可借此释放；先按原交付核对流程解决，不伪造 delivered。
- 原 Worker 已给出停止回执，最近一条任务 observation 是对应 Worker 的 `host-observation`、progress=false，且观察时间不早于用户撤销授权。
- Manager 独立核实：原生 Worker idle，后台执行已停止、没有可能继续执行旧工作的在途消息。两项检查距操作时间不超过五分钟，并晚于停止观察。idle 本身不足以证明后台构建已停止。
- WIP 明确选择 none / retained / handed-off，保存清单、交接路径及理由。命令不会删除文件或执行交接；有 WIP 时不能写 none。

字段、状态锁与引用不是宿主身份认证；本 CLI 不读取引用内容，也不能证明外部进程真实停止。调用者必须通过获准的原生结果与实际证据核验，不能为通过校验而填写假值。Manager 是协调唯一写者；本地锁和 CAS 不能阻止用户直接向 Worker 发消息，遇到并发新工作或停止状态不确定就暂停撤销并核对。

## 命令和 schema

```text
node <runtime-root>/src/cli.mjs cancel-stopped <state.json> <request.json> <expectedVersion>
```

以下完全是示例，不是生产授权或可直接执行的真实请求。替换为真实身份、时间及证据后，由原 Manager 在自身获准的请求目录准备。

```json
{
  "id": "withdraw-example",
  "caller": {"hostId": "fixture", "threadId": "manager"},
  "at": "2026-09-15T00:07:00.000Z",
  "source": {"kind": "fixture", "ref": "synthetic-user-withdrawal"},
  "roundId": "r",
  "taskId": "task",
  "summary": "用户撤销该需求，保留 WIP，不计验收",
  "cancellation": {
    "worker": {"hostId": "fixture", "threadId": "worker"},
    "authorizationRef": "synthetic-user-withdrawal",
    "authorizedAt": "2026-09-15T00:04:00.000Z",
    "stopObservationId": "e3",
    "workerAcknowledgementRef": "synthetic-worker-ack",
    "idle": {
      "status": "idle",
      "checkedAt": "2026-09-15T00:06:00.000Z",
      "ref": "synthetic-native-idle"
    },
    "execution": {
      "status": "stopped",
      "checkedAt": "2026-09-15T00:06:00.000Z",
      "inFlightMessages": "none",
      "ref": "synthetic-process-and-message-check"
    },
    "deliveryAttemptId": "e1",
    "wip": {
      "disposition": "retained",
      "ref": "synthetic-wip-inventory",
      "summary": "两项未完成测试保留，不删除"
    }
  }
}
```

source.ref 与 cancellation.authorizationRef 必须一致。全部时间采用带毫秒的 canonical UTC ISO。
授权时间指实际用户撤销/停止旧工作的时间，不是编写请求的时间，禁止倒填。若授权后又有新工作，重新核验和获取对应停止回执，不复用旧观察。

事务沿用 `transact` → Registry/state guard → 独占锁 → 期望版本 → 原子替换；不会自动破锁。冲突/不确定结果先读取事件 ID 与新版本，不盲目重放。

成功后：追加 `cancelStopped`，保存 caller 与完整 cancellation 证据引用；关闭 executing 阶段并追加 cancelled，冻结 completedAt，保留原 assignedAt、observations、submissions=0、acceptance=null、派发记录。任务不可恢复。只解除该任务的 reservation，其他未验收任务仍占用 Worker。新派工仍需队列/FIFO、独立 native idle 检查和 admission；不自动 closeRound、派发、计为验收或重启定时器。

## 兼容与本地安装

旧 state 输入继续可读；`cancelQueued` 行为不变。新 audit 类型是单向读取能力扩展：**旧版 runtime 无法读取包含 cancelStopped 的 state**，不能在写入后单独回滚旧代码或混用旧 Dashboard/CLI。

安装前检查目标 companion、源码差异和 active writers，备份待替换文件及其哈希；先在隔离目录验证完整候选 bundle，再在无在途 CLI 写入时更新。需要同步的执行文件至少为：

- src/runtime.mjs
- src/delivery-state.mjs
- src/scheduling.mjs
- src/cli.mjs
- src/render.mjs

同时更新 docs/cancel-stopped.md、docs/runtime-usage.md、skills/manager-session/SKILL.md、references/operations.md（独立 Skill 安装与 companion Skill 两份）。安装脚本应校验完整 bundle 依赖及目标版本，不把本清单当成不经检查的批量覆盖命令。仓库其他未提交修改需要单独核对，不自动安装。

Registry/MCP 配置及协议不变；若有常驻加载旧 Node 模块的 Dashboard，需由其拥有者更新/重启服务以加载新校验器；不是要求重启所有 Codex。已运行的 Agent 需在下一次获准操作前读取新规则。

本交付不直接执行安装或真实团队撤销。原 Manager 应在安装验收后，重新核对实时停止证据、WIP 与版本，再自行执行。
