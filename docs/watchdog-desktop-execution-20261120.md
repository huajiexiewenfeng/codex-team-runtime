# Watchdog 与本地 Desktop 初次 E04 派发的执行关联

候选基于 a9f1369。2026-11-20 的隔离 Desktop 顺序 A/B 测试提供了原生入站信封、记录 ID 和同一轮的开始及完成记录。候选已将这条证据链接入固定派发和正式 Watchdog 检查。实际首次 E04 发送与真实提醒联动仍待隔离验收。

## 显式接线

适用范围为 local Desktop、rollout `session_meta.source=vscode`、`cli_version=0.169.1`。操作者核实日志由本机受信 Desktop 写入，并为隔离团队在规范 state 文件旁创建 `<statePath>.watchdog-execution-logs.json`。各路径采用当前机器 `realpath` 的字面值。

```json
{
  "schemaVersion": 1,
  "kind": "desktop-worker-rollouts",
  "statePath": "C:/isolated/state.json",
  "teamId": "isolated-team",
  "managerThreadId": "verified-manager-thread",
  "workers": [
    {"workerId":"worker","threadId":"verified-worker-thread","path":"C:/trusted/sessions/rollout-verified-worker-thread.jsonl"}
  ]
}
```

注册文件及登记的日志属于受信本地文件。它们需要与业务 state 同等级的写访问保护。文件哈希用来发现替换和改写，无法认证具有同等文件写权限的进程。程序核对活动 Registry、就绪且绑定一致的 Manager 和 Worker、开放 round，以及已入账的 E04 prepare 对象和内容寻址 brief。当前仅支持初次 `startTask`，普通 rework 或另一个派发 attempt 无法复用证明。

固定入口在领取唯一发送权前尝试保留边界。当前 claim 写入成功后才返回原发送许可。缺登记、未知版本、文件变化、超限或边界捕获超时仍走原固定派发。证据字段与原 claim 一起持久化，记录绑定摘要、原文 SHA、文件身份、基线长度、序号、header 和完整前缀 SHA，不在新字段复制 brief 或日志正文。不存在补写旧 claim 的入口。Worker 无需发额外消息或调用。

Watchdog 使用正常 `watchdog-check` 或现有服务路径。以文件身份和同次读取首尾 stat 验证稳定快照。基线最多 8 MiB，增量最多 2 MiB。仅在首次检查、重启或文件 stat 变化时重新哈希有上限的基线，格式解析限 header、边界和发送后增量。不会扫描目录或按最新轮次推断。增量必须有连续原生序号和完整行，精确匹配整份程序派发材料、宿主 namespace/name、原生 `client_authored=false`、发件线程、Worker 线程、信封 ID 和两种原生表示。仅接受该 turn 唯一且按序的 `app_tool_send_message` 开始与 `task_complete`。重复信封、未知证据、多消息合轮、截断和超限降级 unknown。日志边界超过七天后也按 unknown 处理。

现有宽限、当前未提交/未阻塞条件、提醒节流、持久化去重和未知发送保护继续适用。提醒前重新核对业务和原生证据。可在真正的发送调用前缩小竞争窗口，依然存在调用后的并发提交窗口。已有提醒的收据只证明提醒传输。同轮冲突仍 unsupported，普通 submitted + running 可以合法共存。

仓库 Manager 打包器的新包使用 v3，将可选监控模块及原生用户元数据解析依赖带入，独立保留 v1/v2 精确白名单。局部 CLI 仍不带 Watchdog 路由。当前候选无需部署现有 Worker 或安装服务。

## 后续隔离验收

使用全新的隔离 Registry 与 Manager/Worker 两个线程，保留宿主版本和安装字节指纹。以现有队列提醒方式接线时验证 Manager 的独立 queue profile 与发送授权。先建立 Watchdog cutover，再新增测试任务。原有团队或生产台账不用于下述场景。

1. 使用本候选真实固定入口首次派发。隔离 Worker 完成本轮但不提交或报告阻塞。保存实际 claim 中的前缀摘要、原生信封、同轮终止、首次宽限前后检查及同 attempt 提醒收据。满足条件后按现有提醒链路仅发送一次。再巡检及重启后确认同一 anomaly key、同一发送尝试。
2. 新建独立任务，在完成后且提醒前写正常提交。验证无该任务的结束提醒、尝试或 send-once marker。
3. 新建独立任务，在完成后且提醒前通过现有 Worker 路径报告 blocker。验证任务可仍是 executing，且无结束提醒、尝试或 marker。若需要精确验证最后 guard，在独立演练的发送前屏障写回执。
4. 保留原生 `codex_delegation` 记录的两个表示、重复信封和重新绑定负例的投影结果。旧轮、模糊或多消息证据均应降级 unknown。

现有 A/B 回放只验证同一受支持格式的真实信封和生命周期。回放的预期原文由留存信封提取，原始发送与信封原文独立核对见相邻 `watchdog-execution-native-ab-20261120.md`。合成测试使用 E04 业务对象及模拟宿主写入，覆盖固定入口和正式 Watchdog 的检测、宽限、去重与抑制。既有部署测试覆盖提醒发送保护。真实固定派发接真实提醒的共同验收未在本候选执行。

## 验证记录

候选目录为 `C:/Users/admin/Documents/New project 2/artifacts/watchdog-execution-p0-20261120`，分支 `codex/watchdog-execution-p0-20261120`。

- 相关离线回归 97/97 通过。覆盖固定派发、Watchdog、部署保护、证据边界和仓库安装包契约。日志 `watchdog-desktop-execution-final-20261120.log`。
- 随后将同键去重用例改为由独立 Node 进程重新读取 claim、rollout 与 Watchdog sidecar。最后的聚焦回归 8/8 通过。日志 `watchdog-desktop-execution-restart-20261120.log`。两次测试有重叠。
- 两段真实隔离信封回放通过。前缀 Hash 与留存记录相同，两段均无序号缺口。解析器得到预期 turn 与信封 ID，修改原文后两段均拒绝。只保存摘要 `watchdog-desktop-ab-replay-20261120.json`。
- 所有本次动作均在候选源码和隔离证据范围内。候选尚未安装、合并、提交或推送。实际宿主发送与真实提醒联动仍按上面的隔离方案验收。
- 新 sidecar 值 `hostEvidence=desktop` 和 `assurance=desktop-e04-envelope` 可由本候选读取。旧 Watchdog reader 会拒绝新值。未来试用或回退时保留对应 sidecar 和证据，使用兼容 reader 对账，避免重置去重历史。

## 后续隔离宿主验收（2026-11-20）

三例均使用真实 Desktop 聊天、独立台账、固定派发入口和 60 秒宽限期。A 在 Worker 轮次结束 80.6 秒后发现漏提交，提醒被 Manager 的实际轮次消费。进程重启后计数从 10 次检查增至 13 次，仍为同一队列项和一次发送。B 在提醒前补交，C 在提醒前报告阻塞且任务仍在 executing，两例检查时均无漏提交提醒或发送尝试。以上验证覆盖初次派发；同次执行的宿主证据冲突仍待实现。生产部署另需逐队登记受信 Worker 日志。
