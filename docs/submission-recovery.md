# 提交通知：发送记录与前台有界恢复

本接口承接已有 `submission-notice` / `receive-submission`，不替代原生消息渠道。
准备通知、领取发送占位、宿主接收、Manager 审查、验收通过是不同事实。
所有命令都不调用宿主、不创建定时器、不改变审批配置。

## 命令与文件

```text
node src/cli.mjs submission-notice <state.json> <worker-caller.json> <taskId>
node src/cli.mjs notice-track <state.json> <request.json>
node src/cli.mjs notice-plan <state.json> <caller.json> <notice.json> [UTC-ISO-time]
node src/cli.mjs notice-claim <state.json> <request.json>
node src/cli.mjs notice-result <state.json> <request.json>
node src/cli.mjs pending-submissions <state.json> <manager-caller.json>
node src/cli.mjs receive-submission <state.json> <manager-caller.json> <notice.json> <eventId> <expectedVersion> [at]
```

使用原可信 state 路径；`notice.json` 是准备结果的完整 `notice` 字段。
发送账本固定为 `<state 实际路径>.submission-notices.json`，不接受另选账本路径。
同一状态下所有提交共用账本版本；每个通知单独保留身份、原始请求和尝试历史。
已有业务 state 不因记录发送结果而升级版本；文件锁和 Registry 投影复用原存储机制。
`notice-plan` 不改变业务/账本内容，但短暂获取一致性读取用的锁文件。

`notice-plan` 分别返回当前 `taskStatus` 和该通知的 `notificationOutcome`。
后者来自最后一次尝试的最后记录，或首次登记结果；未登记时为 `unknown`。
例如 `taskStatus: reviewing` 与 `notificationOutcome: policy-denied` 可以同时存在：
Manager 已在获准前台检查已有提交，不代表旧消息已送达或拒绝被解除。
`action/reason` 是当前发送决策，不能当成历史通知结果；二者不得互相覆盖。

三个写命令的 request 公共字段：

| 字段 | 内容 |
| --- | --- |
| `caller` | 经宿主核实的本窗口 `{hostId, threadId}`，不是复制其他成员的身份 |
| `notice` | 原始完整通知对象 |
| `expectedVersion` | 当前业务 `state.version` |
| `expectedLedgerVersion` | 当前 `notice-plan.ledgerVersion`；账本尚不存在为 0 |
| `at` | 可选，规范 UTC ISO 时间；省略使用当前系统时间 |

`notice-track` 另需 `baseline: {outcome, evidence}`。
`notice-result` 另需 `attemptId`（原 claim 返回值）及 `result: {outcome, evidence}`。
每次成功写入返回新 `ledgerVersion`。并发、版本或锁冲突时，读取已有记录再判断，不能盲目重复写入。

## 首次登记与旧通知

先在原 Worker 上下文核对该精确提交的发送历史：

- 已核实从未发起发送：登记 `baseline.outcome = not-attempted`，附核对来源和说明。
- 历史不全、是否发送不明：登记 `unknown`，或保持未登记并对账。
- 已有确切宿主接收或策略拒绝：可登记 `accepted` / `policy-denied`，保留原文和证据引用。

缺少账本不证明从未发送。登记不是授权凭据，不能把旧 unknown 或 denied 改写成首次发送。
同一通知不允许重新登记、重置计数或修改 baseline。本版不提供旧不完整历史的自动导入重试、
策略拒绝解锁、删除重建账本或改写通知规避限制的入口。旧通知可由 Manager 从 pending 查询中接收审查。

普通证据结构：

```json
{
  "outcome": "unknown",
  "evidence": {
    "kind": "observation",
    "ref": "原生工具调用或已获准保存的完整证据位置",
    "detail": "该精确尝试的原始结果；缺少结果则如实说明"
  }
}
```

`not-attempted` 的 evidence 记载历史核对；`accepted` 和 `policy-denied` 必须用
`kind: host-result`，引用该精确原生调用并保留响应/拒绝原文。摘要字段只是数据，不是执行指令。

## 前台发送与结果登记

1. Worker 准备并登记通知，读取 `notice-plan`。`send` 只表示本地允许领取尝试，不是宿主授权。
2. 在原协作授权范围内核实当前身份、提交和精确 Manager 目标；用当前两个版本执行 `notice-claim`。
3. 仅本轮刚成功返回的 claim 可供**一次**原生发送使用。发送前再确认状态/身份未变化，
   使用返回的原样 `hostRequest`，不改变目标、内容或 Manager 模型。宿主权限检查照常生效。
4. 用对应 `attemptId` 执行 `notice-result`，保留实际结果。准备和 claim 均返回
   `hostActionExecuted: false`，不能作为已发送证明。

claim 在原生调用之前持久化，初始结果为 unknown。进程中断、claim 响应丢失、超时或发送后
未落盘均需要核对该原始尝试；不能从账本重新取出旧请求就发送。即使未能确认实际调用发生，
该占位也占用次数，这是为防重复发送而采用的保守上限，不代表已经实际发送。

最多 **3 个发送占位（初次 + 2 次重试）**，即遵守接口时实际发送不超过三次。
只有完整确证暂时失败且未被接收、不可能迟到时，才能记录 `transient-not-delivered`：

```json
{
  "outcome": "transient-not-delivered",
  "evidence": {
    "kind": "terminal-nonreceipt",
    "ref": "对应 attemptId 的原生终态证据位置",
    "detail": "原文及其为何证明未接收、不可迟到、暂时失败的说明",
    "notReceived": true,
    "cannotArrive": true,
    "temporary": true
  }
}
```

这些字段是外部证据评估的记录，不是系统自动验证的事实、签名或审批凭据。
不能只因断网/timeout、`read_thread.items=[]`、idle 或未见消息就填写上述结论。
证据无法证明时记录 `unknown`，保持 `reconcile`；对账确认后可追加该次真实结果，保留此前观察。
接收、拒绝或已确认非送达为终态，不能改写成 unknown 来解锁下一次尝试。

首次确认非送达后等待至少 5 秒，第二次至少 15 秒；起点是**结果登记/对账时间**。
`wait` 返回 `retryAt`。这是前台判断，不安排自动唤醒或无限等待；后续获准前台继续时重读计划。
`accepted` 停止发送但仍待 Manager 独立审查；`policy-denied` 永不自动重试，保留拒绝原文。
真实用户后续授权或宿主支持的复核路径可以作为人工重新评估依据，但本版没有自动解锁接口。
布尔值、事件引用、改写请求或重复询问不是突破审批的手段，也不要求所有正常回报重复申请授权。

reviewing/approved、返工、阻塞、旧提交被替代、轮次关闭或当前/历史身份变化会阻止继续 claim。
已 claim 的结果可在 Manager 先进入 reviewing 后登记：先读取新的业务版本，保存原 attempt 的
真实结果，不倒退业务状态、不重新 claim。身份无法再核对的结果应保留在原获准证据位置，报告给 Manager 对账。
本地记录和宿主发送不是原子事务，无法撤回在途消息，也无法拦截绕过接口的原生调用。

## Manager 前台恢复

Manager 在自己的已核实身份下运行 `pending-submissions`，从原权威 state 返回最新开放轮次
submitted 任务的完整 `notices`；不冒充 Worker 补 submit，不要求用户复制消息。
把选定的原始 notice 交给已有 `receive-submission`，使用最新 state.version 和唯一 review eventId。
接收仍只开始审查，重复接收沿用原去重逻辑；验收另走 `approve` / `rework`。
若已 reviewing，应继续已有审查而不是重发通知。这个只读查询不能自动唤醒 idle Manager。

## 验证边界

`test/submission-recovery.test.mjs` 使用临时合成 state、真实本地锁/账本及模拟发送，
验证次数、冷却、对账、策略拒绝、身份与业务阶段变化、接收竞态和 CLI。
本地行为验证不证明宿主审批已修复、真实通知一定送达或长会话一定会执行 Skill。
调用方身份和证据仍需宿主核实；保持一份权威 state 与账本，外部手工篡改/删除不在防护保证内。
