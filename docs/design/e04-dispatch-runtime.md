# E04：确定性派发准备接口（首轮评审修订稿）

设计日期：2026-10-02。实现更新：2026-10-03。代码与隔离测试已推进，验证结果见 `../e04-dispatch-runtime-validation.md`；未更新生产安装、未迁移真实 state、未派工。
评审来源：`E:\ai\claude\e04-dispatch-runtime-review.md`。本稿保留源码核对后的不同意见。

## 1. 目标与范围

把“已选定、已入队任务到可发送”的机械步骤收敛为确定性接口：核实原生状态 → `dispatch.prepare` → 一次已授权的原生发送 → `dispatch.result`。

原生状态证据已具备且仍适用于当前决策时，正常路径为三个调用。材料冻结、入队、原生状态查询、身份恢复和异常对账的成本另行计入全流程，不能隐藏为零。

首版只处理已连接团队、当前 Manager、已完成正式入队且 ready 的 Worker、开放轮次中明确指定的 queued 任务。存在队列时必须是指定 Worker 的 FIFO 队首。保留跨轮次占用、撤权和 handoffHold 门禁。

Manager 负责理解需求、选择 Worker、核实依赖与授权。Runtime 不创建 Worker、不合并 Worker 登记与入队、不拆任务、不批量派发、不选择模型、不调用宿主发送，不增加定时器或调度器。返工、追加需求和普通澄清不在本接口范围。

旧 assign/startTask 创建的在途任务仍走旧恢复入口；新查询可以展示，但返回 `LEGACY_ATTEMPT`，不自动补造 operation 映射。

## 2. 源码事实与开发基线

核对基线是 Git `82bd9107d51b04f51baa84ddd400102422230817` 加当前 E03 工作区实现。这个 Git revision **不包含** E03；不能把它写成完整的 E04 依赖 revision。

E03 本地安装有可追溯快照：

- localPatch：`e03-local-20261002`。
- 安装产物目录：`E:\ai\skills-upgrade\artifacts\e03-local-install-20261002`，含源码快照、wheel、逐文件哈希和验证结果。
- `installed-files.json` SHA-256：`408aadd9281c76dadd6bd6577cac4158ff181144ab8b6330eb6cbcc7c0d95556`。
- wheel SHA-256：`1fbf7ca114b59a64eadab3217fc98302a75ee11449634501c55df22b8a4c007c`。

**E04 编码前置条件：先将 E03 独立提交，核对提交与安装快照的关系，将确切 E03 commit SHA 补入本节。** 2026-10-03 已完成：E03 独立提交为 `7dd69adbbd91ca43c904f4f5ed4ed338155c14b8`；提交前复测 Node 481/481、Python 197/197。安装快照继续保留，基线提交包含后续安装记录，不等于已安装文件的逐字副本。

| 源码 | 已核实行为 | E04 约束 |
| --- | --- | --- |
| `src/scheduling.mjs` | queue/start/plan 分开；plan 不生成发送正文 | 显式选择任务，不替换队首；本地 ready 不等于原生 idle |
| `src/runtime.mjs` | startTask 将 queued 变为 executing 并占用 Worker | 发送未知时不能释放占用或重复启动 |
| `src/delivery-state.mjs` | 初始 attemptId 已是 assign/startTask 事件 ID；attempts 初值 0，claim 才递增 | 首次 prepare 只需 startTask；旧 attempts 是重试 claim 计数 |
| `docs/runtime-usage.md`、Skill `delivery-recovery.md` | 当前指导要求 check→claim 后才发送 | 首次直接发送是 E04 的新契约，不能宣称旧流程已允许任意 start 后直接发 |
| `src/delivery-state.mjs`、`src/runtime.mjs` | 投递事件限初始 executing；观察/提交等阻止负面恢复 | 快速提交后的回执要窄范围补记，不放开重派门禁 |
| `src/store.mjs` | guard 内演算后原子替换单个 state | state 可作为唯一提交点；不声称能原子提交两个可变文件 |
| `runtime.mjs:validate` | 顶层、事件字段封闭，只接受 schema 1/2 | schema2 方案也要评估新增事件/枚举及旧写入器 |
| `runtime.mjs:stoppedCancellation` | cancelStopped 要求 delivered、停止观察、Worker 确认及在途消息核对 | policy-denied 不能直接走 cancelStopped |

三事件原方案的 baseline 若来自真实核对，并非必然是假证据；问题是首次已有 attempt，无须再创建一轮 check/claim。E04 与 E03 通知账本的 attempt 语义不同，不直接复制通知重试计数和三次上限。

## 3. 接口、材料与准入证据

| 工具 | 动作 | 职责 |
| --- | --- | --- |
| `team_context.dispatch` | prepare / result / cancel | 写入确定性派发准备、投递结果或已授权撤回；不调用宿主 |
| `team_context.dispatch_status` | 无 action | 只读查询；不补写、不清锁、不生成新的发送许可 |

公共定位字段为 `actor_host_id`、`actor_thread_id`、`team_id`、`round_id`、`task_id`、`worker_id`、`reason`。操作绑定当前 Manager 和任务历史 Worker 身份，禁止传入任意 runtime 路径、shell、替代收件人。operation_id 沿用 E03 格式约束，prepare/result/cancel 共用团队内 E04 命名空间；E03 使用独立工具域。

### 3.1 brief 在编写时冻结

在 Manager 原本编写交接材料时，用确定性本地保存入口将已核实正文冻结为内容对象，不新增调度 MCP。该入口只保存和校验材料，不入队、不确认授权、不派发。新入队任务的 `source.ref` 使用 `e04-brief:sha256:<digest>`；prepare 只携带该引用和 enqueue_event_id。

brief 对象包含正文、范围说明、原始材料引用、授权及依赖核对引用、协议版本。正文按原始 UTF-8 保存，最大 64 KiB；对象及单次完整响应各不得超过 1 MiB。引用或哈希不是授权本身，材料判断仍由 Manager 负责。

已有 queued 任务使用旧 source.ref 时，可以显式冻结已核实的原材料副本，并记录 enqueue_event_id 和 originalSourceRef。prepare 必须与实际 enqueue 事件精确比对；不改旧事件、不从任意路径自动读取、不凭任务标题重建正文，也不声称机器验证了语义等价。范围发生变化应先重新评估任务，不能用替换 brief 偷改任务。开始后所有重试使用同一个 brief。

freeze 的 actor、核对声明和证据引用属于 caller-assessed 数据，不是宿主认证。必须记录冻结调用与全文输入成本；只有与原本的材料保存合并时，才能宣称减少一次重复正文输入。

### 3.2 首次 prepare 模板

下列都是示例标识，不能直接作为真实历史证据。输入采用封闭 schema，禁止未知字段及用 null 代替缺省值。

```json
{
  "action": "prepare",
  "actor_host_id": "local",
  "actor_thread_id": "manager-demo",
  "team_id": "team-demo",
  "round_id": "round-demo",
  "task_id": "task-demo",
  "worker_id": "worker-demo",
  "reason": "before_dispatch",
  "operation_id": "dispatch-task-demo-1",
  "enqueue_event_id": "enqueue-task-demo",
  "brief_ref": "e04-brief:sha256:<64位小写十六进制哈希>",
  "admission": {
    "native": {
      "host_id": "local",
      "thread_id": "worker-thread-demo",
      "status": "idle",
      "evidence_ref": "native-check-demo"
    },
    "scope_evidence_ref": "authorized-brief-and-prerequisites-demo"
  },
  "baseline": {
    "outcome": "not-attempted",
    "evidence_ref": "verified-native-send-history-demo"
  }
}
```

- native 身份、idle 声明和 evidence_ref 必填；证据须覆盖该目标的原生状态与未登记工作核对。
- scope_evidence_ref 只在冻结 brief 中的授权/依赖引用不足、需要补充时必填；已有充分引用时省略，不要求重复创建审批文件。
- 首次 baseline 必填，表示已核实此前没有启动原生发送、没有竞争发送者和在途请求。queued、日志空白、本地没有进展都不足以独立得出这个结论。
- 重试用 retry_of_attempt_id 替换 baseline，禁止同时提供；复用原 brief，但需要当前的 native 准入证据。result/cancel 不重复整份 admission。

缺少材料时返回结构化 requiredInput，明确字段路径、类型、可选值和证据范围。例如缺 baseline：

```json
{
  "code": "HISTORY_REQUIRED",
  "requiredInput": [
    {"path": "baseline.outcome", "type": "string", "const": "not-attempted"},
    {"path": "baseline.evidence_ref", "type": "string", "minLength": 1,
     "description": "精确目标此前无原生发送、竞争发送者或在途请求的核对引用"}
  ]
}
```

Runtime 返回格式要求，不能替 Manager 填写肯定结论。

### 3.3 时间与新鲜度

移除没有实测依据的 60 秒硬 TTL。Skill 要求使用本次派发决策的有效原生观察；中断、目标出现新工作或上下文不确定时重新核对。Runtime 的收到时间不冒充原生观察时间。

native.observed_at 仅在证据源提供真实时间时填写，保留原始带时区 ISO 字符串，校验格式和不在未来；不让 LLM 用当前时间补造。没有源时间时标记 observationAge 为 unknown。它是对象中的证据时间，不是 state 事件的 canonical UTC 时间，不能混用校验器。

不采纳“必须晚于入队时间”：刚查完 idle 再入队同样可能有效。记录观察到 prepare、prepare 到 send 的真实间隔分布后，再评估是否需要硬阈值。现有业务事件时间门禁保持独立，不因删除 admission TTL 而放宽。

## 4. 持久化方案：推荐 D，设置兼容性门槛

| 方案 | 迁移与旧读取器 | 崩溃恢复 | 回退成本 |
| --- | --- | --- | --- |
| A：schema3 内联 metadata/brief | 全部 state 消费者必须升级；旧代码明确拒绝 schema | 单个 state 提交，关系容易校验 | 数据升级后不能简单换回旧程序 |
| B：schema2 + 可变 dispatch ledger | 需独立协议和读写协同 | 要处理 state/ledger 两个提交点，通常需要日志或恢复协议 | 需双份状态一致回退 |
| C：串行封装现有 CLI | 初期代码少，旧语义保持 | 中途失败可留下部分业务事件，无法提供本稿原子 prepare | 正常流程简单，异常恢复负担大 |
| D：schema2 + 确定性事件 ID + 不可变内容对象 | 不增顶层字段；新枚举、事件及晚到回执仍需升级消费者 | 先写对象、state 唯一提交点；未引用对象不代表成功 | 可停止新 prepare，必须保留 E04 读取/恢复能力及对象 |

推荐 D，理由是避免整体 schema 迁移，同时仍能可靠关联完整请求。**不采纳只比对 brief/身份/task 的部分指纹**：同一 operation_id 改 baseline、授权证据、结果等也必须冲突。

### 4.1 对象与引用

Registry 所解析的固定 team 数据根下设置 E04 对象目录。调用者只提供协议引用，不能指定绝对路径或 URL。解析器检查类型、哈希、大小、目录边界，拒绝穿越路径、符号链接/reparse point 跳转。

- brief 对象：`e04-brief:sha256:<digest>`，保存冻结正文和来源。
- operation 对象：`e04-op:sha256:<digest>`，保存完整规范化输入及指纹、原 operation_id、协议版本、scope、身份绑定、brief 引用、事件/attempt ID、结果证据和原始回执元数据。
- 事件 source.kind 使用现有 manual，source.ref 指向 operation 对象；真实证据类型及目标身份在对象内校验。summary 只写可读摘要，遵守 4000 字符限制，不塞 JSON 或整个 brief。

规范化只排序对象键，保留字符串、数组顺序以及缺省和 null 的区别；指纹覆盖 action、actor、定位、baseline、admission、结果和撤回证据等全部输入。生成字段不混入请求指纹。对象采用版本化 canonical JSON，以其 UTF-8 字节计算 SHA-256；依赖图不得循环，读取深度及总字节数有界。

事件 ID 定义为 `e04-` 加 SHA-256，哈希输入为规范化数组 `[协议域, registryId, teamId, operation_id]`。不能把 action 或请求哈希加入 ID，否则同 ID 换输入会绕过去重。对象保存原始 operation_id 并核验，以检测异常碰撞。事件 ID 是索引，完整对象和 state 事件共同构成证据，不能只靠“重复 ID 被拒绝”实现幂等。

### 4.2 唯一提交点

写入顺序：Registry guard → state guard → 验证输入、身份、既有操作及当前状态 → 构造候选事件/回执并检查响应大小 → 写全部不可变依赖对象 → evolve 并原子替换 state → 返回回执。

对象使用临时文件、sync、原子发布且禁止覆盖；同哈希已存在时验证字节一致。对象中保存的候选版本、事件 ID 等必须与已提交 state 相符。事件时间在锁内由服务端产生。每个成功业务动作提交一个事件、版本 +1。

| 故障位置 | 恢复语义 |
| --- | --- |
| 对象写入失败 | 不写 state，不返回发送许可 |
| 对象完成、state 未提交 | 只留下孤立对象；状态查询显示该 operation 未提交 |
| state 已提交、响应丢失 | 可从事件和对象恢复原回执；重放不再给发送许可 |
| 已提交引用的对象丢失/损坏 | OBJECT_MISSING / OBJECT_CORRUPT；不重建正文、不当空历史、不释放占用 |
| 子进程超时、提交点未知 | 保留 mutationUnknown，停止发送；确认进程结束后只读对账 |

对象存在本身不是提交证明。备份、导出、恢复必须携带 state 引用的完整对象图；这些对象是数据，不是可删缓存。首版不做 GC，未来清理必须考虑历史快照和并发写入者。

文件 sync 与原子 rename 不自动等于所有平台掉电持久性；明确测试的进程崩溃范围，验证目标文件系统上的目录持久化语义后才能扩展承诺。

## 5. prepare：首次只提交 startTask

先检查调用者当前访问权限，再查询确定性 operation ID。已提交且完整输入相同：返回原回执并标记 replay；同 ID 异输入：OPERATION_CONFLICT。精确重放不再要求任务仍 queued 或旧 idle 证据仍新鲜，也不会绕过当前访问控制。

新首次请求在锁内校验：团队 Registry active、当前 Manager 身份、开放轮次、精确 enqueue/task/Worker、当前与历史绑定一致、Worker ready、FIFO、全局未验收占用、撤权/handoffHold/派发冲突门禁、brief 对应关系、baseline 和准入声明完整。

成功只演算一个 startTask，state 版本 +1，attemptId 就是该事件 ID。该事件的 source.ref 指向包含冻结材料的 operation 对象；不合成 not-delivered，不提前创建 deliveryClaim。

全新成功响应包含 `sendNow=true` 和绑定确定 host/thread、冻结正文及固定 wrapperVersion 的 hostRequest。只有这次 E04 prepare 的新提交允许进入一次原生发送；普通旧 startTask 不获得此许可。Skill 与使用文档必须同步修改首次发送契约。

提交后任务为 executing，投递为 unknown。业务占用不是送达证明。保留旧 attempts 计数不变，对新查询明确输出 initialAttemptPresent、retryClaimCount、totalAttemptCount，首次总尝试数为 1、重试数为 0。

**重复调用、恢复查询均返回 sendNow=false，且不返回可直接执行的 hostRequest。** 可按需只读获取 brief 内容，但阅读不构成发送许可。发送超时、调用是否启动不明或原生结果未知时禁止自动再发。

新成功许可只用于当前连续操作中的一次原生调用。发生中断、授权变化、目标新工作或撤回时停止发送并对账。Runtime 无法原子锁住宿主发送，也不能阻止人手复用旧返回值；不承诺 exactly-once 或消除所有宿主竞态。

## 6. result：投递事实与业务进展分开

result 携带公共定位字段、新 operation_id、精确 attempt_id 和 `result: { outcome, evidence_ref, summary }`。证据必须能关联该次原生调用及其目标；不关联的提示不能当回执。完整输入/证据引用冻结在 operation 对象中，state 只保留摘要和引用。

| 公开 outcome | 持久投递状态 | 后续 |
| --- | --- | --- |
| accepted | delivered | 证明宿主接受，不证明 Worker 已开始或已完成 |
| unknown | unknown | 保留占用，需对账；不能自动重发 |
| terminal-not-delivered | not-delivered | 仅在确证该次调用终止且未投递时可准备重试 |
| denied | policy-denied（新增枚举） | 该派发链停止重试；不自动撤回或变更策略绕过拒绝 |

新结果正常追加一条 deliveryCheck，版本 +1；精确重放 +0。终态已有不同操作时不得伪造一次成功提交或覆盖原证据；返回已终结/冲突及原结果引用。unknown 可以后续由有证据的结果收敛。

Worker 可能先 observe、submit、review、approve，甚至轮次已关闭，Manager 才登记 accepted。E04 必须允许原 attempt 的 accepted/unknown 晚到补记：保持当前 Manager 访问门禁，核验原任务/attempt/历史目标，不依赖 Worker 仍 ready，不改变业务阶段、不重开轮次、不重新占用、不替换 brief。

实现需同时细化 evolve 的轮次/任务终态门禁、deliveryState 审计验证和投影逻辑，例外仅限带有效 E04 对象关联的传输记录。旧事件不自动获得宽松解释。负面结果、claim 和 cancel 在任何工作观察或业务推进后仍拒绝，progress=false 也不等于可以重派。

晚到证据与已终结结果矛盾时，不能覆盖旧事实。采用一条新的 `dispatchConflict` 审计事件保存精确 attempt 和矛盾证据引用；版本 +1，精确重放 +0，返回 DELIVERY_CONFLICT 及 recorded=true。这是异常路径，不是普通 deliveryCheck 的状态覆盖。

dispatchConflict 从审计派生 Worker 派发 hold。所有受支持的启动入口（包括普通 start/assign/claim）均检查该 hold；不取消已经派出的其他工作，而是提示 Manager 对账。首版不提供自动解除或“再试一次”按钮，该 Worker 的后续派发保持阻塞；解除需要另行设计、审查并明确授权的恢复流程，不能删事件或换任务 ID 消除。此限制计入首版验收及运维文档。

## 7. status 与有证据的重试

dispatch_status 使用上述定位字段，可选 operation_id 或 attempt_id 精确查询。若同时提供，必须属于同一操作链。无选择器时只返回 latestAttemptId 提示，标记 correlationVerified=false，不能把最近 attempt 自动当本次调用。

状态返回业务阶段、投递状态、原事件版本、当前 state 版本、brief 引用、精确关联的证据/错误和 allowedNextAction。includeContent 可只读查看冻结材料；无论是否包含正文，都不提供新 hostRequest 或 sendNow=true。

状态损坏、权限错误、对象丢失和进程仍在执行不得表示为“未发送”。只有写进程已终止且 state 中确实无对应事件，才能使用原 operation_id 重试未提交操作；孤立对象不能改变这个判断。

确证非送达恢复分两次提交：result 记录 not-delivered（+1），新的 prepare 带新 operation_id 和 retry_of_attempt_id，仅提交 deliveryClaim（+1）。若结果已登记，prepare 不重复写 check。claim 以其事件 ID 成为新 attempt，冻结 brief/任务/Worker 不变，重新核验当前准入，不再次 startTask、不释放 Worker。

unknown、policy-denied、任何工作观察、进展或矛盾 hold 均禁止 claim。每次重试都需要上一尝试已终止且确证未送达；因此不另设机械次数上限，也不套用 E03 的三次上限。没有自动重试循环。

## 8. policy-denied 后的显式撤回与占用释放

拒绝回执只能证明它所关联的调用，不当然证明整条历史没有其他调用、在途消息或已经开始的工作。单纯本地没有进度、目标目前 idle 都不足以释放占用。

新增 `dispatch.cancel`，对应新事件 `cancelUndelivered`；它只负责用户已授权撤回且证明确未送达的 E04 初始任务。输入为公共定位字段、新 operation_id、attempt_id 及：

```json
{
  "cancellation": {
    "authorization_ref": "explicit-task-withdrawal-demo",
    "reason": "withdraw-undelivered-task",
    "nonreceipt_evidence_ref": "all-attempts-terminal-and-not-received-demo",
    "execution_evidence_ref": "no-active-or-in-flight-send-and-no-worker-work-demo"
  }
}
```

该授权明确覆盖当前任务撤回；先前“允许派发”或工具拒绝本身不等于撤回授权。缺少时返回 CANCELLATION_AUTH_REQUIRED，不替用户决定撤回。此处是所设计产品流程的授权要求，不是本轮修改文档需要新增审批。

锁内门禁：

1. 当前 Manager、精确 E04 原任务和 Worker；任务仍初始 executing，历史阶段只有 queued/executing，没有任何观察、提交或业务推进。
2. 最新 attempt 为 not-delivered，或 policy-denied 且有完整非接收证明；全部历史 attempt 已终止且可证明未接收。任何 accepted、unknown、竞争调用或在途请求都拒绝。
3. 证据覆盖真实 Worker 未开始该任务，以及不存在仍能发送的在执行 prepare/native 操作；不能用缺日志推导事实。发送者必须遵守撤回后不使用旧许可的契约，Runtime 不声称能撤销外部任意调用。
4. 无待处理撤权、handoffHold、dispatchConflict 等身份/交接风险；已有撤权恢复仍走其专门协议。

成功只追加 cancelUndelivered（+1），任务变 cancelled，从该任务释放占用；保留 assignedAt、attempt 和全部来源，不伪装完成/验收。重放 +0，不退出 Worker、不自动重新入队、不换任务 ID 绕过 policy-denied。后续新任务仍需独立的用户意图和宿主允许。

不复用 cancelStopped：它要求 delivered 以及已停止执行的证据，和此处未送达撤回的前提相反。不得为了复用伪造 delivered 或停止确认。

证据不足则继续占用，这是未知发送保护。撤回后收到精确关联的 accepted，或发现历史实际已执行，按 §6 记录 dispatchConflict 并派生 Worker hold；不能静默忽略回执、自动复活任务或自动停止其他工作。重复矛盾报告按 operation 幂等处理。

## 9. 兼容性、桥接与回退

schema2 不等于旧程序全兼容：旧读取器可能接受仅含 startTask 的初始 E04 state，却忽略对象引用；新增 policy-denied、cancelUndelivered、dispatchConflict 和推进后 deliveryCheck 可能使旧验证器拒绝。更危险的是旧写入器可能对尚未出现新事件的 state 继续写入。

因此方案 D 的上线前置条件是：盘点并升级所有受支持的实际写入口，包含 Node CLI、安装 companion、Python/MCP；为 E04 标记事件提供共同的对象关联验证及准入门禁。同步验证 Registry exporter、E03 notice、工作台、独立展示副本、备份/恢复与离线投影。未升级只读副本必须明确显示不支持，不能错误报告空闲或可重试。

运行时配置只能控制受支持入口，不能保证任意旧可执行文件或手工编辑 state 会拒绝写入。必须在隔离 fixture 上验证旧读取/写入行为。如果实际部署无法约束旧写入器，**方案 D 不满足上线条件，回到 A 的显式 schema 升级，或暂不启用 E04**；不得默默迁移真实数据。

桥接复用已固定 E03 版本的 Python→Node→Registry exporter、严格 JSON、载荷上限、进程树回收和归属锁清理；新增对象写入、state 提交及超时之间的故障点仍需独立验证。status 不因查询触发修复或清锁。

回退先停用新的 prepare 和 Skill 新派发路径，保留 E04-aware 查询、结果登记、撤回/冲突保护能力及完整对象图。不能直接换回旧二进制、删除对象，或用旧 state 覆盖已发生的业务进展。设计修改不等于本地安装更新。

## 10. 正常与异常示例

初始 state.version=40，任务 queued，材料和准入已核实：

1. 全新 prepare 提交 startTask，sourceVersion=41、attemptId=该事件 ID、sendNow=true。
2. Manager 对固定目标执行一次原生发送。
3. accepted result 提交 deliveryCheck，无其他并发写入时版本为 42；若 Worker 已提交，结果提交在实际当前版本基础上 +1，业务阶段保持原状。

prepare 成功但响应丢失：精确查询/重放能确认版本 41 的原提交，但 sendNow=false；无法证明宿主没有调用时停在 unknown。确认没有调用且没有在途请求后，用真实证据登记 terminal-not-delivered，再走新 prepare 的 claim。

宿主返回 denied：记录 policy-denied，任务仍占用。具备明确撤回授权和全部非接收证明时 cancelUndelivered 释放；否则保留占用。不得把“拒绝”自动转成“撤回并重新入队”。

## 11. 验收与观测

| 组 | 必测内容 |
| --- | --- |
| T1 准入 | 身份/历史绑定/Registry/ready/轮次/FIFO/跨轮占用/撤权/hold；失败无 state 变化 |
| T2 首次 | 只有 startTask、版本 +1、attemptId 对应、总次数 1/重试 0；未伪造 check/claim |
| T3 提交与故障 | 对象前后、state rename 前后、响应丢失、超时、并发同 ID/不同 ID；孤立对象不算提交 |
| T4 幂等 | 同 ID 同完整输入重放；改变 actor/action/baseline/admission/result 任一字段冲突；重放无发送许可 |
| T5 材料 | 冻结/旧 enqueue 对应、原文哈希、边界/大小/损坏对象、路径/reparse 防护；无时间时 unknown，不猜时间 |
| T6 晚到结果 | observe/submit/approve/闭轮后的 accepted/unknown；不改变业务阶段，负面/重试仍拒绝；矛盾结果持久审计和所有启动入口 hold |
| T7 恢复 | unknown 禁重试；terminal 非送达后一次 claim；policy-denied 禁重试；不对齐时拒绝、不使用 latest 代替关联 |
| T8 撤回 | 完整授权和各 attempt 非接收证明才释放；有观察/进展/在途/未知时拒绝；不复用 cancelStopped；撤回后矛盾回执持久 hold |
| T9 兼容与回退 | 旧/新 Node、Python、exporter、E03、展示、备份恢复矩阵；旧写入风险；停用 prepare 后可继续读取与保护 |
| T10 桥接 | 非 JSON/超大载荷/进程崩溃/进程树回收/归属锁清理；不能将 mutationUnknown 当发送许可 |

冲突 hold 首版没有解除入口，应验收“持久阻塞且说明原因”，不能用修改 fixture 历史作为产品恢复方案。实际启用前必须接受此限制；需要自助解除时另开受审查的恢复设计。

观测分别记录：

- prepare 输入、hostRequest 输出、原生发送三处正文的 UTF-8 字节数；另记冻结阶段全文输入及调用数。只有实际可获 token usage 时才报告 token，不能用字节数冒充精确 token。
- `需求到入队`、`已入队到获得新发送许可`、`原生调用`、`结果登记` 四段时间及调用数；异常恢复另列，固定相同起止定义。
- requiredInput 的字段及补齐次数；观察到 prepare、prepare 到 send 的间隔，源时间缺失率；首次成功、精确重放、unknown、拒绝、冲突及取消计数。
- 写对象和 state 提交耗时、额外存储、失败阶段；不把保存正文前移后的成本排除在总成本之外。

开发验证先用隔离 fixture；实测至少三次同类型任务比较旧流程与 E04，并与 E03 真实闭环样本分开记录。样本小只报告观察值，不声称统计显著或已证明收益。

## 12. 评审修订记录

| 编号 | 处理 | 理由与落点 |
| --- | --- | --- |
| 1 首次三事件 | 采纳简化，修正事实描述 | 首次 startTask 已有 attempt，改 +1；当前文档实际上要求 check→claim，E04 要显式引入新首次发送契约，见 §2、§5 |
| 2 schema3 替代 | 部分采纳 | 推荐 D，对比四方案；保留完整输入指纹，写入不可变 operation 对象，不能只比几个锚点；旧写入器约束是上线门槛，见 §4、§9 |
| 3 正文搬运 | 采纳 | 冻结前移至原本材料编写/保存，prepare 引用；完整计入冻结与三处正文成本，见 §3、§11 |
| 4 新鲜度 | 部分采纳 | 删除无实测依据的 60 秒硬门槛；源时间可选且不编造；不要求晚于入队，见 §3.3 |
| 5 admission | 采纳并精简 | 给出完整模板与 requiredInput；授权/依赖引用充分时不重复填 scope_evidence_ref，见 §3 |
| 6 拒绝后释放 | 采纳缺口，不采纳 cancelStopped 复用 | 源码要求 delivered，与拒绝矛盾；新增显式授权且确证未送达的 cancelUndelivered，不自动重新入队；矛盾证据持久 hold，见 §6、§8 |
| 7 E03 基线 | 采纳为开发前置条件 | 记录已有可追溯安装快照；先独立提交 E03 并补 SHA，再开始 E04 编码。现已独立提交 E03，见 §2 |
| 8 示例/重试/关联 | 采纳 | 40→41；每次确证非送达才重试，不套用通知次数上限；latest 仅为未验证关联提示，见 §7、§10 |

实现记录：E03 基线已固定；方案 D 的对象提交、旧写入器行为、晚到回执及恢复路径由隔离测试验证。旧 writer 可绕过初始 E04 标记，因此正式启用仍以统一升级全部受支持入口为前提。见使用与验证文档；真实任务、生产安装与效率试用未执行。
