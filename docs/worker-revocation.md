# 明确授权的 Worker 撤权与退出

这是初始未提交工作交接的窄范围路径，不是关闭普通退出保护的开关。
适用：当前 Registry-linked 团队的真实 Manager 已获得用户对精确 Worker、旧任务及接手任务的明确撤销/退出授权，但停止回执缺失。当前版本只支持旧 Worker 的全部未终结任务均处于 queued 或初始 executing、从未提交/返工的情况。submitted/reviewing/blocked 不在本版本支持范围。

授权引用是可审计的声明，不是宿主签名。当前调用身份仍由调用方声明并经宿主核实；本功能不提高模型或文件系统权限。

## 两阶段流程

1. 核验当前 Manager、team、成员精确绑定、全部未终结旧任务和明确选定的 queued 接手任务；读取当前业务版本。保留现有 WIP 清单。
2. `node <runtime>/src/cli.mjs revoke-worker <state.json> <request.json> <expectedVersion>`。成功原子写入 Node 撤权事件，原任务进入 cancelled（撤销、未验收），历史 round.members、派发与观察不删除、不伪造已送达。此时旧 Worker 新写入已被 Node 拒绝，即使 Registry 退出尚未完成。
3. 使用原 MCP `team_context.manage` 的 `exit_member`，由原 Manager 核对新的 `expected_revision`，以单独 operation_id 和同一明确授权引用退出精确成员。无撤权事件时普通开放轮次退出保护保持；有经过校验的撤权事件且无剩余工作时，可保留历史快照并退出。
4. 接手任务仍被执行风险闸门保持 queued。Manager 核实进程停止，或接手工作区/输出/构建缓存等写入资源已隔离后，用 `resolve-revocation` 保存证据。然后按普通 start/delivery 流程处理；本命令不派发、不启动进程。

退出成员不终止 OS 进程、原生对话或在途宿主消息，不能保证旧进程不继续写共享文件。`idle` 或空正文不是停止证据。迟到结果保留原始获准证据供审计，不通过旧任务写入或转写接手任务来接收；不会自动恢复旧任务。

## 请求契约

`id` 为此阶段稳定的 operation ID；使用同一请求精确重试返回 replay，不重复改变任务。`actor/type` 由命令派生，不允许请求提供。

```json
{
  "id": "revoke-old-worker-1",
  "caller": {"hostId":"local", "threadId":"VERIFIED_MANAGER_THREAD"},
  "at": "2026-09-25T00:00:00.000Z",
  "source": {"kind":"manual", "ref":"EXACT_USER_AUTHORIZATION_REFERENCE"},
  "summary": "用户撤销指定成员；WIP保留，后台执行未知，接手暂缓",
  "revocation": {
    "teamId":"TEAM_ID", "memberId":"OLD_WORKER_ID",
    "worker":{"hostId":"local", "threadId":"VERIFIED_OLD_WORKER_THREAD"},
    "taskIds":["OLD_TASK_ID"],
    "handoffTaskIds":["QUEUED_REPLACEMENT_TASK_ID"],
    "authorizationRef":"EXACT_USER_AUTHORIZATION_REFERENCE",
    "intent":"revoke-and-exit", "execution":"unknown",
    "wipRef":"ABSOLUTE_EXISTING_WIP_INVENTORY_OR_EVIDENCE"
  }
}
```

实际 at 必须使用当前规范 UTC 毫秒时间且不早于 state.updatedAt；示例不可原样操作真实团队。taskIds 必须精确覆盖该成员全部当前未终结工作，否则拒绝，不静默批量扩大范围。handoffTaskIds 必须为相关轮次、其他 Worker 的现有 queued 任务。这里只约束声明的接手任务，不能识别未登记的共享文件冲突。

风险解决请求：`id,caller,at,source,summary,revocationId,disposition,evidenceRef`，其中 disposition 仅 `isolated` 或 `stopped`。这记录 Manager 核验结论，不自动探测进程；原撤权事件 execution:unknown 不被篡改。

```text
node <runtime>/src/cli.mjs resolve-revocation <state.json> <resolution.json> <currentVersion>
```

## 失败恢复与兼容安装

- 所有 Node 写入使用既有 Registry→state 锁及业务版本检查；相同 id 不同内容拒绝。
- 阶段1成功、阶段2失败：保持撤权，不恢复旧任务；核对原阶段1回执后重试原 MCP exit_member（版本冲突用新事实与新 operation_id，不篡改历史操作）。阶段1完全相同的请求可用于只读式确认重放，不重复写入。
- 只有实际完成阶段2才能说成员已退出；阶段1仅是业务写入撤权。
- 接手风险尚未解决时不可伪造 stopped，或直接绕过 start/delivery 闸门。
- 新事件需要新版读取方。安装 runtime、adapter、snapshot/render/supervision 与相关命令后，旧长驻 Dashboard 需使用兼容代码重启，才允许写入真实撤权事件；不要将旧页面报错当作状态丢失。
- 本实现复用 Python MCP 的 exit_member 和每次调用启动的 Node adapter，不修改 Python 工具 schema，不需要为此重启 Codex。
- 生产写入新事件后不可简单回退到不识别新事件的旧 Runtime，也不可恢复旧 state/Registry 备份来“撤销撤权”。需要兼容前向修复；安装备份只支持新事件尚未写入时回退代码。

Dashboard 将撤销显示为“已撤权 · 进程状态未知”，不称已停止；supervision-plan 给出接手风险处理项。
