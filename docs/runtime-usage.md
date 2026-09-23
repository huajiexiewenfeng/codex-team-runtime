# 最小运行层使用说明

已启动且明确停止的任务撤销：见 [cancel-stopped](cancel-stopped.md)，包含请求结构、兼容与安装边界。

状态：实现切片，SUBMITTED，待父任务验收。Node.js 22+，零第三方依赖，无需安装。

## 离线演示

在仓库根目录运行：

```powershell
node src/cli.mjs demo artifacts/demo
node --experimental-test-isolation=none --test
```

演示产生 `artifacts/demo/state.json` 和 `artifacts/demo/view/{snapshot.json,index.html,READY.json}`。HTML 醒目标记 FIXTURE / 模拟来源，示例 host/thread 使用 `fixture-` 前缀，未认领真实任务。再次运行请选择新的输出目录；已有目录拒绝覆盖。未用浏览器打开或视觉验收，不绕过本地 HTML 访问限制。

`snapshot.json` 是 Liaison 可读取的同一派生快照，HTML 直接由它渲染；两者显示同一源版本、源更新时间、计算时间及 SHA-256 快照标识。`READY.json` 最后写入，缺失时导出不完整。读取历史仅筛选已有状态，不推进任务或恢复汇报；历史成员使用轮次创建时的绑定，汇报栏明确展示团队当前意图。

### 多轮次 HTML 工作台

```powershell
node src/cli.mjs dashboard <state.json> <new-output-directory> [asOf] [--codex-links]
```

一次导出 `index.html` 总览，以及 `round-1.html` 等历史轮次页。每页的“切换轮次”入口只在同一导出目录内导航；无需网页脚本、网络连接或后台服务。各页包含任务筛选、原生展开详情、阶段历时、完整派发审计、验收证据、成员任务定位和绑定身份。

所有页面来自同一次读取的状态和同一个计算时间。轮次从 openedAt 计时，关闭后用 closedAt 冻结；任务用既有 assignedAt / completedAt 计时，两者都包含等待，不能替代模型计算耗时。所选轮次的成员绑定仍是历史身份，汇报栏是导出时团队当前记录。

完整导出包含与各页对应的 `snapshot.json` / `round-N.json`，以及最后写入的 `READY.json`。该标记记录源版本、asOf、页面对应的 roundId / snapshotId、renderOptions 与 HTML / JSON 文件 SHA-256；它证明导出完整性，不证明 Worker 交付质量或宿主状态。移动或分享时应保留整个文件夹；输出含本地任务及证据摘要，请按项目资料保护，不自动发布到公网。

导出必须使用新目录；重复目标拒绝覆盖。离线快照需要新进展时重新运行并选新目录，不会修改原状态、启用报告或唤醒任何任务。需要随记录变化的最新入口，使用下文 `dashboard-serve`；模型 / Token 采集仍未接入。静态本机版本的窄屏、筛选 / 展开 / 键盘与成员正确跳转已由用户确认正常，见 [HTML 验收记录](dashboard-validation.md)；该历史验收不是新服务的测试证据。

成员对话入口默认禁用。可在命令末尾显式添加 `--codex-links`，为非模拟来源、已绑定本机 `local` 且 threadId 为受支持 UUID 的成员生成 `codex://threads/{threadId}` 兼容链接。模拟 / 未知来源、远程、未绑定、创建中、绑定缺失和异常 ID 仍不生成链接。历史页使用历史绑定。

该选项仅改变 HTML 呈现，并记录为 `READY.json` 的 `renderOptions.codexLinks`；不会改写 snapshot 的宿主能力判断或真实状态。重现 HTML 时使用 `render(snapshot, {roundPages: manifest.pages, ...manifest.renderOptions})`。旧清单没有 renderOptions 时仍采用默认禁用。

这是需在使用环境核对的兼容方式：本机客户端按线程 ID 查找，URL 的 `hostId` 参数不能保证主机定位，因此链接不附带该参数；已移动或多主机同 ID 的任务不能靠此入口锁定原主机。当前环境的正确跳转已有用户确认，其他浏览器可能要求确认或不支持该协议；请核对打开后的成员身份。它不是网页调用 Agent 导航工具的 API，也不发送提示词。严格宿主导航仍待接入，详见 [导航核对记录](design/codex-navigation.md)。

### 统一团队工作台：任务进度 / 指标统计

一个入口、两个页签；可选 `--metrics-report` 绑定本团队 `metrics-daily-export` 输出的 `report.json`。指标内部继续分为 Token / MCP 页签，标注独立的数据时间与覆盖缺口；没有文件时明确未接入，不自动扫描日志。详见 [统一工作台](dashboard-portal.md)。

```text
node src/cli.mjs dashboard-serve <state.json> [--port <0..65535>] [--codex-links] [--metrics-report <report.json>] [--timeline-index <index.json> | --timeline-report <report.json>]
```

只监听本机，前台运行，Ctrl+C 停止。使用命令返回的完整启动链接；schema 2 按原 Registry 配置提供本次进程的 `CODEX_TEAM_CONTEXT_PYTHON`。页面可见时约每 5 秒请求当前 Node + Registry 投影，隐藏 / 暂停 / 关闭后停止新请求。无 Agent 唤醒、无后台扫描、无业务写入。断连保留上次成功视图并警告；服务重启需要新的启动链接。默认端口 4319，`--port 0` 可为多团队分配空闲端口。

Manager 与 Worker 仍须按已有契约记录真实进展、提交和验收，Liaison 只读解释；自动刷新不等于原生 Agent 遥测。离线导出保持不变。完整职责、安全边界与验收方法见 [最新工作台与历史快照](live-dashboard.md)。

### Team Metrics 离线历史报告

基础 Metrics 是独立的按需观测面，不接入上述最新工作台的刷新链路：

```text
node src/cli.mjs metrics-import <ledger.json> <source.json> <new-ledger.json>
node src/cli.mjs metrics <state.json> <ledger.json> [asOf]
node src/cli.mjs metrics-export <state.json> <ledger.json> <new-output-directory> [asOf]
```

导入只读取 `source.json` 明确指定的一个普通 JSONL 文件；路径相对 descriptor 目录解析，不做 glob、环境发现或递归扫描。v2 流式读取以打开时大小固定字节边界，忽略后续追加，省略并诊断不完整尾行；64 MiB 是单行保护上限，超长行明确拒绝，不截断。每次仍从头读取指定文件，不保存增量 cursor。相同输入重复合并幂等，新账本与导出目录都拒绝覆盖既有目标。

`metrics` 只打印 JSON；`metrics-export` 生成 `report.json`、无脚本/网络依赖的 `index.html` 及最后落盘的 `READY.json`。两者都用 `readRawState` 读取已记录历史 state，不刷新 Registry、不读取当前宿主状态、不提供 live telemetry，也不写回业务文件。未知值不是零，部分观测明确显示缺失条数，任务关联不冒充 Token 因果。精确 JSON 格式、可复现合成样例和报告读法见 [Team Metrics 使用说明](team-metrics.md)。

v2 报告增加逐计数证据卡和高消耗排行，保留来源行及可用的原生响应 `counter-match`。工具返回字节、压缩附近活动、重复调用/相同可见内容只作为有等级标注的证据或候选，不自动判定无效劳动、给出浪费分数或宣称节省 Token。旧 v1 报告仍可读取，旧记录没有活动证据时明确未知。

## 持久化 CLI

### Registry 接入后的身份边界

下文原有启动/配对/注册示例针对未链接的 schema 1 状态。显式完成
[Registry 迁入](team-registry-cutover.md) 后，schema 2 状态以 MCP 为当前成员身份
权威，Node 读取时检查投影，写入时共同锁定 Registry 和 state。旧身份事件
`bindMember/exitMember/registerWorker/attachInvite/attachConfirm/detachLiaison`
不再允许；成员登记、确认和退出由 Manager 调用 `team_context.manage`。
业务事件、原任务归属及独立提交/验收继续保留，不自动复制或转换历史任务。

linked active 业务写入要求 Manager 与操作者 ready；派工还要求目标 Worker ready，
并通过原有授权、忙碌/FIFO 和投递规则。prepared 阶段不能继续业务操作。
使用 capsule 的同主机 Python 路径作为本次调用的 `CODEX_TEAM_CONTEXT_PYTHON`；
可信 runtime-root 可为 checkout 或稳定安装代码根，不包含另一份业务状态。

新登记 Worker 不自动加入已有轮次。确认 ready 后，可由 Manager 用 `apply` 提交
`admitRegistryMember` 事件，携带通用 id/type/actor/caller/at/source 与 roundId/memberId；
只允许向开放轮次追加当前 active/bound Worker 快照，不改写已有成员或历史轮次。
这不是派工事件；后续仍走 queue/start 和原生投递检查。精确事件基字段见下文表。

### 启动、双向配对、Worker 注册、只读恢复

这些命令操作同一个权威 state 文件，不创建真实任务、自动化或恢复 hook。`caller` 仅接受 `{hostId,threadId}`，是调用方声明而非认证。Skill 必须在当前独立任务上下文核对身份；不能按名称猜测、扫描私人会话日志或使用 `verified:true` 代替验证。协作子 Agent 不得用继承的父任务环境认领父角色。下列 fixture 示例只用于离线试验。

```text
node src/cli.mjs start <request.json> <new-state.json> [UTC-ISO-time]
node src/cli.mjs attach <state.json> <request.json> <expectedVersion>
node src/cli.mjs register-worker <state.json> <request.json> <expectedVersion>
node src/cli.mjs resume <state.json> <caller.json> [asOf] [roundId]
```

`start` request 示例：

```json
{"teamId":"fixture-team","name":"Fixture team","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"source":{"kind":"fixture","ref":"offline-session-test"}}
```

将以上内容保存为 `start.json` 后，离线示例需显式指定起始时间：

```text
node src/cli.mjs start start.json state.json 2026-09-05T00:00:00.000Z
```

本节固定时间只用于离线演示，确保后续邀请、确认与注册时间不倒退。真实调用应使用当前 UTC 时间（邀请到期时间必须晚于发布时刻），不要将默认当前时间初始化的状态与这些历史示例时间混用。

输出版本 0，默认成员 ID `manager` 已绑定、`liaison` 未绑定；无 Worker、轮次或自动化。可选 `managerMemberId`、`liaisonMemberId` 覆盖这两个 ID；省略时兼容旧值，空值、非法值或重复 ID 拒绝。跨团队接入同一 Registry 时，应在首次创建前选择全局唯一成员 ID，例如 `my-team-manager` / `my-team-liaison`。父目录必须存在；已有 state 文件拒绝覆盖，包括同一请求重放，也不会认领不同 Manager。这不是旧状态迁移命令。

Manager 在自己的调用上下文登记邀请（假定当前版本 0）：

```json
{"mode":"invite","id":"invite-1","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"target":{"hostId":"fixture-host","threadId":"fixture-liaison"},"at":"2026-09-05T00:01:00.000Z","expiresAt":"2026-09-05T00:10:00.000Z","source":{"kind":"fixture","ref":"offline-manager-invite"}}
```

`attach state.json invite.json 0` 产生版本 1，但 Liaison 仍未绑定。被邀请者在**自己的独立任务上下文**核对身份后确认：

```json
{"mode":"confirm","id":"confirm-1","caller":{"hostId":"fixture-host","threadId":"fixture-liaison"},"invitationId":"invite-1","invitationVersion":1,"at":"2026-09-05T00:02:00.000Z","source":{"kind":"fixture","ref":"offline-liaison-confirm"}}
```

`attach state.json confirm.json 1` 产生版本 2，双方配对完成。CLI 最后参数是**当前状态版本**，invitationVersion 是**邀请发布版本**，不必永远相同。邀请 ID 同时是事件 ID，不可重用；新邀请替代旧待确认邀请。未邀请、过期（含到期时刻）、错误身份、旧邀请、版本冲突、重复确认、已配对冲突或退出角色均拒绝，原文件不变。本版选择拒绝重放，不做幂等确认。开放轮次期间不能配对或注册新成员。

在无开放轮次时由 Manager 注册已经核对的 Worker（不创建/唤醒真实任务）：

```json
{"id":"register-1","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"memberId":"worker-1","name":"Fixture Worker","binding":{"hostId":"fixture-host","threadId":"fixture-worker"},"at":"2026-09-05T00:03:00.000Z","source":{"kind":"fixture","ref":"offline-worker-registration"}}
```

`register-worker state.json worker.json 2` 产生版本 3。成员 ID 与 host/thread 必须唯一，pending 不可冒充正式身份。会话模式在没有 active/bound Worker 时拒绝 openRound，避免无可执行成员的空轮次；注册后可使用下文 assign → Worker submit → Manager review/approve → closeRound 完整流程。历史 round.members 保持冻结，不在开轮后插入成员。

`resume` 的 caller.json 只有 hostId/threadId。输出角色、当前开放轮次、下一动作、历史/当前快照及明确 unknown 的宿主能力。它不写入、不发消息、不启定时器、不重开轮次或复活退出角色。已配对 Liaison 可恢复只读上下文；未确认者仍可用不要求身份的 status 查询。

兼容性：schemaVersion 1 增加可选 session 扩展，邀请/确认复用现有原子锁、版本及事件记录；旧文件不含 session 仍可读，查询不自动补字段或改写。旧已绑定 Manager 可 resume，旧 Liaison 无双向确认则拒绝角色 resume。符合条件的旧状态仅在显式 attach invite 时增加 session。会话模式禁止用 bindMember 单方面修改 Manager/Liaison 绑定。没有退出后重新激活、运行中迁移或自动跨宿主恢复。

### New minimum-team activation

用户明确启用 Manager 时，Skill 默认建立三个独立窗口：当前 Manager + 一个 Liaison + 一个 Worker；已有有效成员复用，不再创建 Manager，也不删除额外成员。这里只定义前台编排组合，CLI / MCP 不直接创建 Codex 窗口，宿主创建权限仍须满足。

全新、尚未登记且没有旧状态或未决创建证据的团队，按以下顺序执行：

1. 核对当前 Manager 身份和安装版本，保存本次启用引用、唯一 team/member IDs、原始 state 路径及创建结果。`start` 使用可选 `managerMemberId` / `liaisonMemberId`，一次创建真实的新 state，不覆盖已有文件。
2. 先按[启动回执与恢复](startup-recovery.md)用 `team_context.startup` 为所有缺少成员 `prepare`，每次新建前 `claim`；只在本次返回 `claimed:true` 后创建一次。通过宿主创建或复用已核实且属于本次团队的独立 Liaison / Worker，按 Skill 命名与模型规则配置；保留 pending 返回，初始消息携带 operation/team/member/role，要求成员自核验并发布启动回执。Manager 从 `plan` 找回候选正式 ID、原生独立核验后 `verify`。初始消息不分派业务开发。
3. Manager `attach invite`，真实 Liaison 从自己的上下文 `attach confirm`；Manager `register-worker` 登记真实 Worker。此时保持零业务轮次、零任务、汇报关闭。
4. 按 [Registry cutover 协议](team-registry-cutover.md) 对**同一份实际 state**调用 `adopt_legacy`，传入最新 version / SHA、完整名册、启用授权与真实配对证据。这个组合不先调用 `bootstrap`，因为已登记的同一团队/身份不能再次导入。
5. 三个成员各自 `team_context.read`，Manager 核对其各自回执并 `confirm_ready`；重新读取验证三成员 ready、同一 leader、runtime connected。`dispatchAllowed:false` 仍表示召回本身不授权派工。只有已有明确业务任务且通过 admission 后才开轮、入队、派发；仅设置团队则待命。

任何阶段中断或返回未知，都保留原路径、操作 ID / 请求和原生创建结果，核对后续接原步骤，不重建团队、复制 state、替成员确认或盲目重发。`start` 重放会拒绝覆盖；`attach` 重放会拒绝，应检查原事件。cutover 恢复遵循其原操作协议。

已有 connected 团队通过 MCP 补齐缺少且支持登记的角色，不再使用 legacy 身份写入。已有 context-only / migration-pending / 错误状态须走恢复分支，不能视作新团队。`bootstrap` 仍仅适用于明确要求的身份登记，不会连接 Node；本组合不是将既有 context-only 团队自动转为 connected 的接口。

完整 Skill 入口见 `skills/manager-session/references/activation.md`。本流程不会安装全局 hook、创建定时器或自动恢复正在运行的任务。

### 显式解除已确认 Liaison 配对

```text
node src/cli.mjs detach <state.json> <detach-request.json> <expectedVersion>
```

请求示例（仅合成数据；真实执行用当前 UTC、当前邀请及状态版本）：

```json
{"id":"detach-1","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"invitationId":"invite-1","invitationVersion":1,"at":"2026-09-05T00:10:00.000Z","summary":"用户明确纠正沟通任务","source":{"kind":"fixture","ref":"offline-detach-example"}}
```

必须由核对身份后的 active/bound Manager 执行，当前 Liaison 也须 active/bound 且配对已确认，无开放轮次，reports.enabled=false。CLI 在原状态锁内重查身份、邀请、版本并原子更新。未确认邀请、错配/重复/过期版本、开放轮次、已退出角色均拒绝，不覆盖原文件。该操作不是角色退出，不会复活已退出成员。

解除后当前 session.invitation=null，Liaison 变为 unbound；旧完整邀请（含目标身份、发布版本、确认ID和时间）保存在 detachLiaison 审计事件的 detachedInvitation 字段。原事件、历史轮次绑定、任务和汇报偏好保留。旧 Liaison 无法再角色 resume，也不能重放旧确认；普通不需身份的历史查询不是权限隔离，本地文件访问权限仍由宿主管理。

随后 Manager 使用上文 attach invite 结构，以新的唯一 id 邀请用户指定的新目标；新 Liaison 自行 attach confirm，invitationVersion 使用新邀请的 issuedVersion，expectedVersion 使用最新 state.version。不要用 bindMember、直接改JSON、重建/复制状态或代替新目标确认。无开放轮次是整个重配对过程的前提。

此操作不停止真实定时器、不迁移独立汇报账本；若曾启用定时器，须先在原所有者绑定下核对暂停，结果不明则停止操作。旧账本保留，不改owner或新建账本绕过未决操作。无自动化的早期配错场景可直接使用本入口。包含 detachLiaison 事件的状态需要本版读取器；旧未解除状态无需迁移，schemaVersion仍为1。旧版本读取新事件将安全拒绝。

注意：解除后重新邀请同一 host/thread 时，现有旧汇报账本的 bindingEpoch 不会自动递增，身份匹配仍可能被接受。本切片不支持重配对后的旧账本复用，不提供永久撤销账本或迁移协议；不能把上述配对作废能力解释为宿主访问权限撤销。

### 忙碌 Worker 与 Manager 侧队列

独立新需求先保存到同一权威 state 中，不发给正在工作的 Worker。每个 Worker 默认只保留一个未验收的在制任务；`executing/submitted/reviewing/rework/blocked` 均占用，跨所有轮次检查。原生窗口 idle 不代表已验收，提交、阻塞也不会释放占用。此限制由 `evolve` 在现有锁与版本检查内执行；Skill 还须在发送前核对原生状态，运行层不能拦截直接调用的宿主消息工具。

```text
node src/cli.mjs queue-task <state.json> <request.json> <expectedVersion>
node src/cli.mjs dispatch-plan <state.json> <manager-caller.json> <workerId>
node src/cli.mjs start-task <state.json> <request.json> <expectedVersion>
```

以下是独立的 fixture 请求示例，要求目标轮次已开放、Worker 已绑定；使用当前版本和不早于 state.updatedAt 的 UTC 时间。不要把示例身份发送到真实宿主。

`queue-task` 请求（必须由核对身份后的 Manager 执行）：

```json
{"id":"enqueue-t2","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"at":"2026-09-07T00:10:00.000Z","source":{"kind":"fixture","ref":"offline-queue-test"},"roundId":"r1","taskId":"t2","title":"协议字段修正","workerId":"worker-1","required":true}
```

它产生 `enqueue` 事件及 `queued` 任务，`assignedAt:null`，首阶段 startedAt 为入队时间。本命令只保存任务身份和标题，不是完整需求文档仓库。真实入队前须在获授权位置保存完整交接材料，并用 source.ref 引用其持久路径/记录；恢复时从 enqueue 审计引用核对文件范围、验收条件和约束，材料缺失或范围不明则不启动。上例短 ref 仅为 fixture 标签。Worker 不得仅因在快照中看到 queued 任务而开工。队列只存在 Manager 侧，不给 Worker 发“请稍后处理”的消息。

`dispatch-plan` 是只读建议，包含 `sourceVersion`、`reservedTaskIds`、`queuedTaskIds`、`nextTaskId`；`decision` 为 held、ready 或 no-work。始终 `executed:false, hostRequest:null, requiresNativeIdleCheck:true`。ready 仅代表本地可启动，不证明原生任务空闲。所有排队任务按 state.tasks 中原始插入顺序在同一 Worker 下跨轮次 FIFO；不按 ID、标题或回合顺序排序。

确认原生任务可接收新工作且无未登记的用户任务后，Manager 使用 `start-task`：

```json
{"id":"start-t2","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"at":"2026-09-07T00:20:00.000Z","source":{"kind":"fixture","ref":"offline-start-test"},"roundId":"r1","taskId":"t2"}
```

只允许没有其他未验收在制任务的 Worker 启动其队首。新事件关闭 queued 阶段，进入 executing，assignedAt 为本次事件时间。这个写入代表占用，不代表消息已经发送或 Worker 已实际开始计算。Manager 在发送前必须按[同一任务的派发恢复](#同一任务的派发恢复)核实未送达并完成 delivery-check → delivery-claim，再按 Skill 交接契约复核后至多发送一次获授权的原生消息；版本冲突、原生状态变化或发送结果不明时保留记录并核对，不重放、不假报送达、不假验收来释放占用。写状态与原生消息不是原子操作。

旧 `apply assign` 仍可用于无占用、无排队任务的 Worker，但现在拒绝重复占用及绕过队列。底层 `enqueue` 事件采用 assign 字段，assignedAt 必须为 null；`startTask` 采用 roundId/taskId。两个新事件与高层 queue-task/start-task 均要求 caller，在锁内核对 Manager；仅旧 assign 保留可选 caller 的兼容接口，若提供仍须匹配。所有新调度均拒绝 pending Worker 身份。调用方声明并不等于宿主认证。

queued 不允许 submit、review、block、observe，也阻止 closeRound。待审查不等于空闲；批准旧任务后，Manager 在获授权的前台继续流程中重新检查队首，而不是自动发送或启动定时器。`supervision-plan` 排除只有排队工作的 Worker；队列本身不需要宿主轮询。

快照中排队任务的 elapsedMs 为 null（尚未分派），phaseElapsedMs 表示排队历时。启动后 elapsedMs 从 assignedAt 开始，后续审查/返工/阻塞等待计入任务历时，入队前等待单独保留在 queued 阶段；这些不是模型计算耗时。HTML 与进度文本使用“排队中”标签。

兼容性：schemaVersion 仍为 1，新增 queued / enqueue / startTask。旧文件无需迁移或读时改写，旧版本读取这些新记录会拒绝。历史上同一个 Worker 有多个未验收任务的文件仍可读取，但新派发继续拒绝，直到已有占用解决。旧直接 assign 的未知 assignedAt:null 仍保留。

边界：支持下文 queued-only 取消，不支持已经启动的任务取消、重排、暂停、抢占、迁移或自动派发；不要编辑原始 JSON 绕过队列。独立新需求与当前任务澄清须按 Skill 的 busy Worker admission 分类。紧急新需求不能默认为允许打断；未经支持的 checkpoint/暂停交接流程，应保留原工作并向用户说明。现有 Manager 需要前台重新读取更新后的 Skill 和运行层，新规则不会自动注入其他已经运行的任务。

### 取消尚未启动的排队任务

```text
node src/cli.mjs cancel-queued <state.json> <request.json> <expectedVersion>
```

用户明确撤回指定需求后，由核对身份的 Manager 执行。请求示例仅为合成数据，真实 source.ref 应引用用户撤回决定，不据此取消任何真实任务：

```json
{"id":"cancel-t2","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"at":"2026-09-07T00:15:00.000Z","source":{"kind":"fixture","ref":"explicit-withdrawal-example"},"roundId":"r1","taskId":"t2","summary":"用户撤回尚未启动的协议字段需求"}
```

本地原子事务要求 active/bound Manager 的 caller 匹配、当前版本匹配、目标仍 queued、原因非空。新 `cancelQueued` 事件保留 actor/时间/原因/来源，任务转为 `cancelled`，不删除记录。它不调用宿主工具、不通知或停止 Worker、不触碰其他在制工作，不自动启动下一项、关闭轮次或改变汇报偏好。

取消后 assignedAt 仍 null、submissions 为 0、acceptance 为 null；completedAt 表示取消结束时间，不代表验收。queued 阶段时间冻结，执行 elapsedMs 仍 null，cancelled 终态的 phaseElapsedMs 为 0。快照/HTML/汇报保留取消标签，进度 counts.cancelled 单列，不增加 approved。取消项不再占用 Worker，不参与 supervision-plan；余下 queued 项按原顺序处理。

只要 startTask 已成功，即使原生发送失败或结果不明，也不能用此入口回滚。executing/submitted/reviewing/rework/blocked/approved/cancelled 均拒绝。启动与取消争抢同一版本，最多一个写入成功；另一方必须重新核对，不能盲重试。缺少当前身份、版本冲突、错误任务/轮次、重复取消均不修改原状态。

当轮次所有任务都 approved 或 cancelled 时，Manager 可另行 closeRound（仍须有至少一个 required 任务）。仅取消部分项不能关闭仍有在制工作的轮次。全取消轮次是撤回收口，不是全部验收通过；本地 stopped 仍不是宿主调度已暂停的证明。

schemaVersion 保持 1，新增 cancelled 状态/cancelQueued 事件；旧状态仍可读取，不自动迁移。新状态需要更新后的读取器。取消记录不可恢复为 queued、复用任务 ID 或删除历史；重新提出需求须重新获授权并使用新任务 ID。

### 单次宿主监督查询计划（命令）

```text
node src/cli.mjs supervision-plan <state.json> <caller.json> [cursors.json] [--notifications]
```

仅匹配 active/bound Manager，按所有开放轮次未验收任务的历史 Worker 绑定去重，生成每批最多 8 个目标、timeoutMs=0 的原生 wait_threads 参数。没有开放待验收工作时不生成查询。caller 仍是声明，Skill 需另行验证当前任务身份；cursors 是精确 `{hostId,threadId,afterCursor}` 数组，不接受错配或重复记录。

命令只打印计划，不连接宿主、不写状态、不唤醒任务。Desktop 中由 Agent 核对版本和真实目标后调用原生工具，不能把 fixture 示例发送给真实宿主。模块 `runSupervision(state,caller,waitThreads,cursors)` 可通过注入函数执行一轮批次并保留原始结果；它不是 Node 到 Desktop 的隐藏 API。错误不自动重试，返回信息需 Manager 审查，宿主完成不自动更改任务业务状态。

### 无定时器提交通知与接收

`supervision-plan` 同时返回 `taskChecks`（业务状态及下一步检查）和
`pendingSubmissions.notices`（权威 state 中待审提交）。原生查询失败或没有收到消息不清空这些待审事项。
Manager 在已授权前台监督中检查 submitted / reviewing / blocked；接收、检查和验收仍为独立动作。
`recoverySummary` 汇总有效任务的 pendingReview / reviewing / blocked，并将身份异常单列 identityBlocked。
任务级 Worker 绑定异常只隔离该行：`nextAction: reconcile-identity`、worker=null，不产生原生目标或可接收 notice；被隔离的提交列在 `pendingSubmissions.blockedTaskIds`。其他有效任务继续返回。
团队 Manager 权威冲突、状态完整性失败和 Registry 投影失败仍终止整次计划；接收、派发和验收写入规则没有放宽。
默认不读取通知账本，`notificationStatus: unknown`、`notificationSource: not-read` 不能解释成发送失败。
可选 `--notifications` 只读取真实 state 路径对应的现有 `.submission-notices.json`，核对团队、路径和最新提交后合并记录结果。
`notice-ledger` 表示已读记录；`not-recorded` 表示没有该次提交的记录，状态仍 unknown；`read-error` 会保留待审清单并在 `notificationRead` 报告错误。身份隔离行保持 not-read。
记录中的 accepted 只表示传输接受，不等于 Manager 已接收、审查或验收。两份文件不是原子快照，行动前需重新核对版本。
该选项不创建账本、不发送、不启动原生查询；重试决策仍用原 `notice-plan`，非正式阶段使用原获准保存的结果证据。
该功能不保证自动唤醒，不新增计时器、不放宽任何宿主权限，也不允许绕过拒绝搬运受限内容。

```text
node src/cli.mjs submission-notice <state.json> <worker-caller.json> <taskId> [--notice-out <new-notice.json>]
node src/cli.mjs notice-request <notice.json> <fields.json> <new-request.json>
node src/cli.mjs receive-submission <state.json> <manager-caller.json> <notice.json> <eventId> <expectedVersion> [at]
```

Worker 先在自己的已核对身份和写入授权下，用现有 `apply` 记录 `submit`；summary 包含交付物路径/版本、实际验证结果及未完成项。随后 `submission-notice` 从原状态文件的提交审计事件生成通知，要求任务仍在开放轮次的 submitted 阶段，当前与历史 Manager/Worker 绑定一致。输出只读计划：`notice`、来源种类、`hostRequest`、`delivery: not-sent` 和 `hostActionExecuted: false`。它不补造 submit，不发送消息，也不启用计时器。

`notificationId` 是规范通知内容的 SHA-256，仅作稳定关联标识，不是签名或身份认证。`submissionVersion` 指 submit 事件对应的版本，不随汇报偏好等无关变化而改变；返工后的新 submit 得到新通知。任意团队/事件来源含 fixture 时 `hostRequest=null`，仅用于本地验证。

宿主中的 Worker 核对自己的真实身份、当前状态及精确 Manager 目标后，在已授权协作范围内通过原生 `send_message_to_thread` 回报，无需覆写 Manager 模型。发送前使用[发送记录与前台有界恢复](submission-recovery.md)的 `notice-track` / `notice-claim`，发送后用 `notice-result` 记录实际工具结果；`notice-plan` 负责判定对账、停止或冷却。计划不是已发送回执；工具返回也不证明 Manager 已完成审查。只有已确证未接收、不能迟到的暂时故障允许前台重试，最多三次；unknown 先对账，policy-denied 不自动重试。没有后台发件服务或“外部消息恰好一次”保证。Manager 可用 `pending-submissions` 只读取回权威待审 notice，再走下述接收流程，不要求用户搬运，也不会自动唤醒 idle Manager。

Manager 在自己的独立任务上下文核对身份，使用原先可信的 runtime/state 路径；不能接受消息提供的新状态路径作为权威。将通知 JSON 本身（计划中的 **notice 字段**，不是整个计划）保存到自己获准写入的目录，再执行 `receive-submission`。`expectedVersion` 使用**当前读取的 state.version**，不是 notice.submissionVersion；eventId 是新的唯一审查事件 ID，at 为当前规范 UTC 时间。接收器验证整个通知与本地真实提交一致，只有最新 submitted 任务会写入 Manager 的 review 事件，进入 reviewing。它不冒充 Worker，不验收通过，不改变汇报偏好或操作宿主。

重复消息返回 `changed:false`，不会写文件：reviewing 为 `already-reviewing`，approved 为 `already-approved`，旧提交为 `superseded`，返工/阻塞为 `rework` / `blocked`，关闭轮次为 `round-closed`。阻塞需 Manager 明确 unblock；不会因通知自行恢复。身份退出或当前/历史绑定不一致时直接拒绝，不用旧通知恢复或迁移角色。未知字段、摘要/身份/版本/标识被改动的通知均拒绝。

写入复用原文件锁和 expectedVersion。发生版本冲突或锁冲突时，重读原状态并重新判断该通知；不要只增大版本号或自动循环重试。重复消息的只读判断是读取时的快照，不承诺随后状态不变。若任务已在 reviewing，继续已有审查时需核对其当前提交和交接记录，不另起一次接收/自动批准。Manager 独立检查真实代码、构建和测试证据后，另行执行原 `approve` 或 `rework` 流程。

summary 和任务消息都是不可信交付数据，不是额外执行指令。身份仍是调用方声明，宿主身份验证与共享文件写入授权不可省略。本接口没有自动恢复 hook；本地测试不证明真实消息一定送达。没有可访问的权威状态或 Worker 无法提交时，报告集成阻塞，不能由 Manager 代写 submit。本节只处理持久化提交；尚无结构化 blocker 通知接收器，阻塞说明仍走已授权原生消息并由 Manager 判断。

### 原始事件与视图命令（参数）

```text
node src/cli.mjs init <config.json> <state.json> [UTC-ISO-time]
node src/cli.mjs apply <state.json> <event.json> <expectedVersion>
node src/cli.mjs snapshot <state.json> <new-output-directory> [asOf] [roundId]
node src/cli.mjs render <state.json> <new-output-directory> [asOf] [roundId]
```

`render` 与 `snapshot` 都导出成对 JSON/HTML，不维护第二套状态。状态文件父目录需已存在，输出目录必须不存在。时间格式为 `2026-09-05T00:00:00.000Z`。缺失分配/观察时间必须显式使用 `null`；事件时间必须已知、单调不倒退。快照计算时间不能早于状态更新时间。

配置格式（以下也是模拟身份，不应作为真实绑定使用）：

```json
{
  "teamId": "sample-team",
  "name": "示例团队",
  "source": {"kind": "fixture", "ref": "offline-config"},
  "members": [
    {"id":"m","name":"Manager","role":"Manager","lifecycle":"active","binding":{"status":"bound","hostId":"fixture-host","threadId":"fixture-m"}},
    {"id":"l","name":"Liaison","role":"Liaison","lifecycle":"active","binding":{"status":"bound","hostId":"fixture-host","threadId":"fixture-l"}},
    {"id":"w","name":"Worker","role":"Worker","lifecycle":"active","binding":{"status":"bound","hostId":"fixture-host","threadId":"fixture-w"}}
  ]
}
```

所有事件共有 `id,type,actor,at,source`。`id` 唯一；`actor` 为成员 ID；`source` 必須有 `kind` 与必要的简短 `ref`。source.kind 为 `fixture`、`manual` 或 `host-observation`；后者还必须有 `hostId,threadId`，观察事件校验其与原 Worker 绑定一致。它仍是调用方提供的记录，运行层不验证工具真实性或登录权限，不读取私人日志或凭据。

事件例子：

```json
{"id":"open-1","type":"openRound","actor":"m","at":"2026-09-05T00:01:00.000Z","source":{"kind":"fixture","ref":"offline-example"},"roundId":"r1","title":"最小验证"}
```

| type | 专属字段 | 规则 |
| --- | --- | --- |
| openRound | roundId,title | Manager 显式开启；保存原成员绑定 |
| assign | roundId,taskId,title,workerId,required,assignedAt | Manager 分配；Worker 必须已绑定 |
| submit | roundId,taskId,summary | 仅原 Worker；执行或返工 → 提交 |
| review | roundId,taskId | Manager；提交 → 审查 |
| rework | roundId,taskId,summary | Manager；审查 → 返工；再提交、再审查才可批准 |
| approve | roundId,taskId,summary,evidence | Manager；审查 → 验收；非空证据字符串数组 |
| block / unblock | roundId,taskId,summary | Manager；阻塞后恢复原阶段 |
| observe | roundId,taskId,observedAt,summary,progress | Manager 或原 Worker；progress 是已记录的有效进展标记 |
| cancelQueued | roundId, taskId, caller, summary | Manager；用户明确撤回且任务仍 queued，保留取消历史；不停止 Worker |
| closeRound | roundId | Manager；至少一项必需任务，且该轮所有任务已验收或明确取消后关闭；取消不算验收 |
| reports | enabled | Manager；保存用户汇报偏好，开启新轮不覆盖主动关闭 |
| reportReceipt | intentVersion,actual | Manager；actual 为 running/stopped/failed，仅离线回执 |
| bindMember | memberId,binding | Manager；该成员不参与开放轮次时才可改绑定 |
| exitMember | memberId | Manager；该成员不参与开放轮次时才可显式退出 |
| registerWorker | caller,memberId,name,binding | Manager 身份匹配；无开放轮次；binding 为 hostId/threadId |
| attachInvite | caller,target,expiresAt | Manager 身份匹配；邀请目标 Liaison 尚未绑定 |
| attachConfirm | caller,invitationId,invitationVersion | 目标 Liaison 自身确认；唯一允许的配对写入 |

稳定成员 ID 不依赖显示名称；绑定区分 `bound`、`missing`（保留 hostId/threadId）、`unbound`、`creating`（仅 pendingId）。pendingId 不当成 threadId。轮次完成不退出角色。当前切片没有恢复已退出角色的命令，也不做运行中换绑/成员迁移。

## 计时、来源与写入边界

任务历时从显式 assignedAt 起算，包含阻塞、待审查等等待。每次阶段转换保留起止时间；已验收任务用 completedAt 冻结所有计时。未知时间显示未知。默认超过 15 分钟的最后已知观察标陈旧；时间未知的导入仍显示在详情记录中，不覆盖最后已知观察或有效进展。不声称测量模型计算耗时。已验收任务和已关闭轮次拒绝后续业务修改。

状态 schemaVersion 与递增 version 分离。写入先完整校验当前文件和新状态，再写同目录临时文件、fsync、原子替换。以独占 `.lock` 文件防止并发写入，expectedVersion 拒绝旧写者。坏 JSON、非法状态、版本冲突不覆盖原文件。初次初始化使用独占链接，防止覆盖已有状态。

Windows 的替换遇到 EPERM/EBUSY 时，在持锁期间仅重试同一次 rename，最多 20 次 100ms 延迟；不删除原文件、不重放业务事件、不修改权限。持续拒绝仍报错并保留旧状态；EACCES 立即失败。此措施处理本机观察到的瞬态替换拒绝，不保证任意文件系统可写。

进程异常可能留下锁或临时文件；本版不自动抢锁。由操作员确认没有活跃写者后处理残留。仅验证本地文件系统行为，未验证网络盘、断电目录持久性或跨主机锁；源文件不是防篡改数据库，CLI actor/source 也不是认证层。没有宿主 ACL 时需协调同一时刻唯一获授权写者；Liaison 只有自身邀请确认这一配对写入，其他操作只读，Worker 自己提交需明确写者交接。

## 同一任务的派发恢复

此入口只记录 Manager→Worker 首次任务交接的发送证据和尝试，不执行原生发送、不释放 Worker、不重新分配或取消已启动任务。先阅读配套 Skill 的 `references/delivery-recovery.md`。已有 assign/startTask 但无发送记录时默认为 unknown；缺失唯一原始分配审计时不可恢复，不能把旧记录缺失解释成从未发送。

```text
node src/cli.mjs delivery-plan <state.json> <manager-caller.json> <taskId>
node src/cli.mjs delivery-check <state.json> <check.json> <expectedVersion>
node src/cli.mjs delivery-claim <state.json> <claim.json> <expectedVersion>
```

`delivery-plan` 只读，输出源版本/时间、delivery 状态及 decision；`hostRequest:null`、`executed:false`。`reconcile` 要求核查；只有 `ready-to-claim` 才可登记新尝试；`supervise`、`held`、`unavailable`、`no-action` 均不是发送许可。caller 仍只是声明，必须由前台 Skill 核对身份。

以下是**离线结构示例**，不是可直接套用的真实证据；假设任务 t2 的原始 startTask 事件 ID 是 start-t2，当前轮次 r、Worker 绑定已经确认。时间、版本、ID、来源须使用原状态真实值，不能使用示例覆盖它们。

`check.json`：

```json
{"id":"check-t2-0","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"at":"2026-09-07T00:03:00.000Z","source":{"kind":"fixture","ref":"offline-confirmed-no-request"},"roundId":"r","taskId":"t2","attemptId":"start-t2","outcome":"not-delivered","summary":"离线模拟：已确认该请求从未被接收且不存在仍可到达的在途请求"}
```

outcome 仅接受 `unknown/not-delivered/delivered`。必须关联当前 attemptId；已解析的结果不能改判。宿主来源 `host-observation` 还须包含原 Worker 的精确 hostId/threadId；CLI 仅校验结构/绑定，不能认证证据真伪。超时、空白对话、idle、重启都不构成 not-delivered 证据。delivered 仅表示核实传输接收，不表示开发完成或验收通过。

在核查成功后的**新版本**上提交 `claim.json`：

```json
{"id":"attempt-t2-1","caller":{"hostId":"fixture-host","threadId":"fixture-manager"},"at":"2026-09-07T00:04:00.000Z","source":{"kind":"fixture","ref":"offline-authorized-attempt"},"roundId":"r","taskId":"t2","attemptId":"start-t2","summary":"为同一任务登记一次获授权的发送尝试"}
```

claim 的事件 ID `attempt-t2-1` 成为新 attemptId，状态立即为 unknown。原任务、assignedAt、阶段计时、占用、队列顺序、汇报偏好均不变；快照新增派生 `task.delivery`，包括 status/attemptId/evidenceEventId/attempts（attempts 是已登记 claim 数，不是宿主实际发送次数）。并发 claim 由原有锁/CAS 限制为一个成功；旧版本写入拒绝且原文件保持不变。

只有刚确认 claim 成功的前台发送方，在再次核对原生 idle、身份、状态及授权后，才能发至多一次原生消息。之后新 check 必须填写 `attemptId:"attempt-t2-1"`。重启后发现旧 claim 不代表还可发送，必须先核查。确定该次未送达可再 claim；unknown/delivered 都不能重复 claim。任何已记录工作观察（含 progress:false）阻止认定未送达或重试；已进入提交/审查/返工/阻塞后不再使用首次派发恢复。派发结果应写 delivery-check，不要伪装成工作 observe。

这些事件保存在同一审计中，没有第二个业务账本；schemaVersion 仍为 1，无新事件的旧状态只读兼容，旧读取器会拒绝新事件。离线测试覆盖故障与并发，真实宿主发送恢复、跨进程唯一发送方和原生在途请求核查仍须现场验证。没有原子宿主发送或 exactly-once 保证；无法证实未送达时必须保留占用并报告阻塞，不能自动释放或重派。

## 需宿主现场验证

- 精确身份与共享状态访问：实际 Manager/Liaison/Worker 的 hostId/threadId、权限及唯一写者约束。
- 观察适配器：从宿主工具提取必要摘要和原始时间戳，验证来源，处理缺失/不可达。
- 网页导航：独立 HTML 的官方稳定导航契约尚未确认；默认禁用，显式 `--codex-links` 的本机兼容入口已有当前环境用户验收，严格跨主机定位仍不保证。
- 汇报调度：期望与实际确认分离；本版 `reporting.actual` 固定 unknown，任何 reportReceipt 都标离线。没有自动化创建/暂停动作，也没有宿主暂停成功声明。
- 新旧轮次并发、实际定时重入、退出/恢复、长期运行，以及浏览器视觉/交互与可访问性均需后续受控验证。

本版对所有已分配任务采用保守收口规则；可选任务也不能静默丢弃或跳过。仅尚未启动的 queued 任务支持有来源、有原因的明确取消，已启动任务不支持取消。完整长期 Team 产品、hook、服务器、协议注册和 PDC 组合均未交付。

## 早期 Skill 查询入口

仓库中的 `skills/manager-session/SKILL.md` 可作为显式引用的配套 Skill；尚未安装到全局技能目录。

```text
node skills/manager-session/scripts/status.mjs --runtime-root <trusted-checkout> --state <state.json> [--as-of <UTC-ISO-time>] [--round <roundId>]
```

在当前 shell 中正确引用含空格路径。status 脚本只读取状态并打印同源快照，不创建输出文件、不发送消息、不启定时器，无需当前角色身份。start/attach/register-worker/resume 是已实现的本地角色入口；实际身份适配、自动恢复 hook、后台监督与真实汇报启停仍未实现，不能把本地记录当作现场能力证明。
## 只读任务时间线（M1 基础版）

现有工作台在「指标统计」内并列提供「Token 使用量」「MCP 调用情况」「任务时间线」三个 Tab，独立读取：

```powershell
node src/cli.mjs dashboard-serve state.json --timeline-report timeline-output/report.json
```

可重复传入 `--timeline-report <report.json>`，最多 32 份，每个任务只能绑定一份报告。任务卡的“查看时间线”会打开指标页并精确选择该任务；也可用任务下拉框切换。未绑定任务不会回退到其他任务的报告。单份文件不可用会显示数量提示；重复绑定同一任务则拒绝展示，避免猜测版本。切换任务只读已有报告，不重新加载 Token/MCP 日报，不采集日志。

推荐用索引实现按需加载，替代旧入口的逐文件扫描及 32 份上限：

```powershell
node src/cli.mjs dashboard-serve state.json --timeline-index timeline-index.json
```

```json
{"schemaVersion":1,"teamId":"example-team","reports":[{"taskId":"task-1","path":"reports/task-1.json"}]}
```

`path` 相对索引文件目录解析；索引来自启动配置，HTTP 不接受路径。索引最大 4 MiB / 10000 条，单份报告最大 16 MiB。索引与 `--timeline-report` 互斥，错团队/重复任务索引拒绝读取。导航只显示绑定事实，报告内容是否可用在选中后验证；`checkedReports` 表示本次实际核对报告数，而不是全队报告健康度。

- **重新读取历史报告**：读取原有文件，不生成新采样，也不覆盖原快照。
- **更新阶段数据**：认证 GET `/api/timeline?task=<id>&refresh=state`，绕过短期状态缓存，从最新台账确定性重建所选任务的阶段，仅用于本次展示，不写入报告或业务台账。没有历史报告也可以更新阶段；损坏/身份不匹配的报告不用于工具观测，错误单独显示。
- 阶段展示台账版本、台账更新时间、本次生成时间；工具观测保留原采样窗口及最后观测事件（不是完整覆盖截止），未采集保持未知。更新阶段不更新 Token/MCP、不扫原生日志、不调用 LLM、不唤醒 Agent。
- 任务切换保持当前历史/阶段更新模式；点击「重新读取历史报告」返回历史模式。页面重新打开默认历史模式，按需点击更新。

时间线清单可选 `nativeSources`，用于导入宿主 `read_thread` 返回中的明确内部调用证据。先保存白名单元数据（`schemaVersion`、`thread.id/hostId`、`turns[].id/items[]`；item 仅保留 `id/type/status/durationMs/exitCode/tool`），不要保存对话、命令、参数或输出正文。再指定：

```json
{"nativeSources":[{"path":"native-metadata.json","sourceRef":"native-worker","hostId":"local","threadId":"worker-thread","role":"Worker","turnId":"selected-turn","itemIds":["selected-command-item"]}]}
```

该片段需合入已有含 teamId、taskId、sources 的清单。身份和角色必须匹配一个显式日志来源；条目选择是分析者给出的任务关联，不代表自动识别或完整覆盖。文件来源真实性仍需核验，哈希仅保证可复现。导入后，“宿主内部调用报告”独立显示报告耗时，不虚构起止时间、不与外层调用相加。旧报告兼容，不需要给 Worker 增加汇报动作。

### 时间线的半自动评估（只读候选）

```powershell
node src/cli.mjs task-eval timeline-output/report.json evaluation-output
```

输入是既有 v2/v3 时间线报告（最大 32 MiB），输出目录必须不存在。生成 `evaluation.json`、`evaluation.md` 与最后写入的 `READY.json`，保留输入 SHA256，不修改输入。确定性筛选每类最多 3 项较长声明阶段/未归因间隔，保留证据引用、假设、目标与护栏、单一差异、验证和处置框架。空档不等于模型思考或浪费，阶段和工具不可相加。无候选不等于高效；单样本不计算节省或宣布改善。此命令不联网、不发消息、不改 Skill、不启用实验；人工根因判断及跨样本效果比较尚待完成。当前评估输出为 JSON/Markdown，尚未绑定工作台。

页面选择任务时间线或点击「重新读取历史报告」时读取已绑定文件；点击「更新阶段数据」时只重建最新台账阶段，不采集原始日志。服务验证团队与任务身份，复用原有本机认证；读取失败不影响业务任务。报告业务状态版本落后时提示历史快照。支持任务卡直达、多任务选择、业务阶段、观测事件、外层调用、脚本续接、报告耗时及未知间隔；每表展示最多 300 条，完整历史数据见 JSON。尚未自动采集新的原生日志，也未自动持久化本次阶段展示。

```powershell
node src/cli.mjs task-timeline timeline-manifest.json new-output-directory
```

显式清单示例（相对路径基于清单文件目录；不扫描其他日志）：

```json
{
  "teamId": "example-team",
  "taskId": "example-task",
  "timeZone": "Asia/Shanghai",
  "sources": [{
    "path": "worker.jsonl",
    "sourceRef": "worker",
    "hostId": "local",
    "threadId": "actual-thread-id",
    "role": "Worker",
    "from": "2026-09-18T00:00:00.000Z",
    "to": "2026-09-19T00:00:00.000Z"
  }]
}
```

可选 `milestones.request` / `milestones.delivery` 使用 `{ "sourceRef": "worker", "line": 123 }` 引用已核对的物理日志行；缺少任一端不计算端到端耗时。角色与任务关联由清单人工圈定，不能作为 Registry 身份认证。输出 `report.json`、`timeline.md`，最后写入 `READY.json`；目录必须不存在，不覆盖旧报告。

仅保存元数据，不保存对话正文、工具参数、工具正文或隐藏推理。v2 支持明确 cell ID 的脚本续接，以及结构化工具返回中的报告耗时；脚本结束不等于内部进程结束，报告耗时不与外层跨度相加。报告始终标为部分覆盖：尚未支持内部进程完整起止关联和 Dashboard 展示。采集不是业务必经步骤，不会发送消息、唤醒 Agent、启动定时器或修改团队状态。

可选业务状态来源（v3）：在清单顶层增加 `"stateSource": {"path": "state.json", "roundId": "round-1"}`。只读原始状态文件（最大 16 MiB），不刷新 Registry；校验 team/round/task 一致，导出完整任务的阶段与事件元数据，不导出任务标题、报告正文、产物路径或验收证据内容。业务时间放在 `businessTimeline`，标记 `declaredAt`，与日志 `observedAt` 分列。任务状态历史不受日志采样时间窗裁剪，不能因此声称日志完整覆盖。缺失阶段端点为 null；approved/cancelled 是终态点，不显示零耗时。报告保留状态版本、字节边界及 SHA-256，便于复核。
