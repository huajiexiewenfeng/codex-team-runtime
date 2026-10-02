# E03：MCP 驱动的确定性提交通知流程

日期：2026-10-01。状态：设计稿完成，待整体审阅；未实现、未安装、未激活。

## 1. 目标与定义

Runtime = 确定性程序 + MCP 接口 + 持久化状态，不包含 LLM。Skill 是 Agent 使用 Runtime 的规则。Codex 宿主提供原生会话、消息发送和权限检查。

E03 将 Worker 已正式提交之后的机械通知编排下沉到 Runtime。业务理解、交付内容、证据判断由 Worker LLM 负责，独立验收由 Manager LLM 负责。Runtime 不调用另一个 LLM，不改写正文、不生成授权、不自动批准。

目标不是所有任务必然三次调用，而是正常路径“准备 MCP → 一次原生发送 → 结果 MCP”。异常路径保留真实未知与恢复。项目管理、交付、送达、验收仍是不同事实。

设计依据：现有 src/submission-notice.mjs、src/submission-recovery.mjs、Python MCP server/runtime_link，以及 2026-10-01 优化台账。两个真实业务样本均已使用 E03a，但仍有旧路径、caller 文件缺失、Python 环境变量缺失导致的准备重试；阶段历时不能当作纯通知耗时或承诺节省量。

## 2. 方案选择和范围

选择“高层 MCP + 复用底层状态机”，不选择仅优化提示模板，也不选择由 Runtime 包办宿主发送。

- 只覆盖 linked、connected、当前身份与入队有效的团队；首版不自动迁移 legacy 团队。
- 正式 submit 保持原入口；E03 不自动提交、不修改业务摘要、不改变验收规则。
- 不改 E04 派发，不增加定时器/Hook、模型、数据库、消息代理或外部 Decisions API。
- 不增加每任务新的批准文件；已有效的协调授权不重复申请。外部宿主的拒绝和权限检查不变。
- Manager 负责设计、协调、只读审查和验收；独立正式 Worker 负责实现和测试。本设计不派工、不安装、不提交推送。

## 3. 职责边界

| 工作 | 所属层 |
| --- | --- |
| 判断业务完成、选择测试、撰写交付内容、解释异常证据 | Worker LLM |
| 核实原生自身身份及有效汇报授权 | Agent 在宿主上下文完成；Runtime 仅校验声明与登记一致性 |
| 可信定位、JSON 组装、版本读取、规则判断、占位和结果记录 | Runtime 确定性程序 |
| 暴露结构化入口、校验参数、返回有界结果 | MCP |
| 真实跨线程发送及权限判断 | Codex 宿主工具，Worker 调用 |
| 交付审查、通过/返工、是否扩大范围 | Manager LLM／必要时用户 |

调用者身份仍标 caller-declared，外部结果证据仍标 caller-assessed。Registry 匹配、哈希和 operationId 都不是身份认证或授权。工具目录存在不代表其他线程有权读取该团队。

## 4. 接口契约

在现有 MCP 服务增加一个工具 team_context.notice，action 枚举 prepare / result / status；不增加三套独立工具描述。因为包含写操作，工具标记不可谎称只读。三个 action 均不调用宿主发送。

公共参数：actor_host_id、actor_thread_id、team_id、task_id、submission_id、reason。reason 沿用现有触发原因枚举，不要求先额外读一次 MCP。恢复身份所需的 read 继续遵守已有规则。

团队/任务/提交标识必须明确，不按标题、最近活动或“最新任务”猜测。禁止用户参数注入 runtime 路径、Python/Node 路径、shell 命令、替代账本路径或 Manager 目标。可信配置及 Registry 决定这些值。

### prepare：准备并领取一次发送占位

附加输入：operation_id；首次无账本时需要 existing-contract 格式的 baseline 证据（只接受已核对的 not-attempted 作为首次发送依据）。证据可引用本轮明确的原生/交付上下文，不要求额外创建证明文件。缺少或不确定则返回 reconcile，不自动补写。

程序内部按现有规则检查 caller、团队连接/就绪、历史与当前成员绑定、撤权、开放轮次、明确提交、业务状态和通知历史；直接从指定 durable submit 生成原 notice。读取当前版本不等于替换 caller 指定的 submission。

同一临界区内完成必要 track 与 claim，沿用现有账本规则和审计版本计数；在成功落盘前不暴露 hostRequest。已存在记录时使用既有 baseline，不能用新 baseline 覆盖历史。重试仅在原协议已确认终态非送达、冷却到期及次数范围内领取新 attempt；不自动等待或循环。

返回固定短字段：status、reasonCode、teamId/taskId/submissionId、notificationId、attemptId（如有）、sourceVersion、ledgerVersion、runtimeRevision、contentSha256、readOnly、hostActionExecuted=false，以及必要的 nextAction。

仅本次确实新建 claim 的成功响应允许包含 sendNow=true 和原样 hostRequest。它是一次本地发送机会，不是宿主批准，也不是发送事实。

### result：记录精确尝试的真实结果

附加输入：operation_id、attempt_id、result（沿用 outcome + evidence）。Agent 传递可核对的精确宿主结果，Runtime 做格式/状态校验，不从“命令完成”猜测消息已接收。

首版复用 existing outcome：unknown / accepted / policy-denied / transient-not-delivered。后者仍需原协议的 terminal-nonreceipt 证据；timeout、空回复、未见消息、idle 都不足以自动判定未送达。

只写原 attempt，不重新准备、claim 或发送。Manager 已进入 reviewing/approved 时，在身份和原 attempt 仍可验证的前提下允许记录既有发送结果，不倒退业务状态。撤权、重绑定等导致证据无法准入时保留原获准位置的结果并返回待对账，不篡改成员历史。

相同 operation_id 和相同规范化输入重复提交返回既有结果，不增加事件；同 ID 不同输入报 OPERATION_CONFLICT。既有终态不得被不同内容改写。unknown 的后续对账使用新的 result operation_id，并追加观察，不覆盖旧观察。

### status：按 ID 恢复

只读查询明确提交及尝试的当前结果、版本、停止/对账原因和证据引用；无副作用、无领取、无自动发送。允许当前已核对的所属 Worker 或 Manager 查询，Liaison 本轮仍用现有看板/只读路径。

默认不返回正文、完整尝试历史或可重放 hostRequest。明确请求 include_content 时返回完整、原样、带摘要的 notice，并标明仅供读取；超过响应限制明确失败，不能静默截断。status 不返回 sendNow=true。角色召回仍由 team_context.read 承担，notice 不建立第二套角色记忆。

## 5. 原始内容不变与存储控制

权威正文仍是 durable submit 的 summary；E03 从它生成现有 notice，不接受另一份“修改后的 summary”。保持原有协议包装，不在本实验改通知文案。Runtime 添加的元数据与 Worker 正文分别标识，不能把它当作用户或 Worker 新的表达。

- 保持正文字符串精确一致，包括空白、换行、中文、emoji、引号、反斜线与 ISO 字符串。不得 trim、Unicode 规范化、翻译、压缩、修正措辞或截断。
- contentSha256 定义为原 summary 字符串的 UTF-8 字节摘要；JSON 转义/排版可以变化，但解码后字符串及摘要必须一致。禁止非法 Unicode 输入的静默替换。
- 保留原 notificationId 算法和 notice schema；内容摘要不替代原通知匹配或宿主授权。
- 摘要证明传递完整性，不证明交付正确。保证边界到 Runtime 生成的 hostRequest；宿主实际接收内容需原生证据，不能仅凭准备哈希宣称已验证端到端。
- LLM 想改变业务内容须走原有明确的新提交/修订流程；不得为绕过 denied 或 unknown 改内容重试。

首版不新增正文文件库。现有 state 和 ledger 已保存 summary/notice/hostRequest，存在历史兼容副本；此次不做无重复存储的虚假承诺，也不迁移这些副本。每次尝试只增加必要元数据和有界证据，不再创建 caller、fields、request 文件链或正文副本。

prepare/result 的操作指纹与恢复元数据存入同一个通知 ledger 的兼容扩展，必须与对应占位/结果同次原子写入；不新增独立去重数据库造成双写。原始 Registry 和 business state 不因准备/结果登记改变。失败的纯校验不永久写一份调用历史。

MCP/桥接 JSON 请求与响应的 E03 应用上限固定为 1 MiB（UTF-8，含包装，低于当前桥接 4 MiB 输出保护）；这不是宿主发送额度。prepare 在 claim 前检查完整响应大小，超限返回 PAYLOAD_TOO_LARGE，不截断、不消耗 attempt。宿主更低限制导致发送失败仍按真实结果处理。大日志/产物继续引用已有文件，Runtime 不自动读取任意 evidence.ref 的内容。

不复制完整聊天、隐藏推理、源码或大构建日志。不自动删除未知/在途记录；首版无自动归档/GC，封闭通知的长期去重信息保留。观测账本字节、条目数和读写历时，证实增长瓶颈后另立归档设计，不夹带存储重构。

## 6. 并发、中断与重放

| 情况 | 必须行为 |
| --- | --- |
| 首次已核对未发送 | 原子登记并领取一次，返回一次待发送请求 |
| 无记录、历史不明 | reconcile；不推断 not-attempted |
| 同 prepare operation 重放 | 返回已存在尝试及需对账状态；不再返回可发送许可 |
| 两个并发 prepare、不同 operation | 同一通知至多一个新 claim；另一个看到 unknown/已有占位 |
| 落盘后响应丢失，或 claim 后崩溃 | attempt 保持 unknown，不能重发旧 hostRequest |
| 宿主接收后 result 丢失 | 查询原尝试，依据原宿主证据补记；不再次发送 |
| result 成功但响应丢失 | 相同请求安全重放，不重复追加 |
| 明确拒绝 | 停止自动发送，保留原始证据，不生成新 ID 绕过 |
| 无关任务推进导致全局版本变化 | 临界区重读并校验本提交，不要求 LLM 手工抄版本 |
| 提交替换/身份变化/撤权 | 结构化停止或冲突，不自动改成新目标/新提交 |
| Manager 已开始审查 | 不领取新发送；允许符合原身份边界的已有结果登记 |
| 锁忙/存储损坏/桥接超时 | 有界失败；超时可能发生落盘，标明 mutation 结果未知并通过 status 恢复 |

锁顺序复用 Registry/state/notice 的既有顺序。Python 桥接不能持 Registry 锁等待一个再次获取同锁的 Node 子进程；Node 在既有 guard 内做最终校验。禁止简单在外层锁内嵌套调用旧公开 track/claim 导致死锁，应提取复用内部纯转换与单次持久化路径。

不在锁内调用宿主、等待 LLM 或网络；锁等待与子进程执行采用现有有界超时。不得用后台无限重试掩盖冲突。

本地落盘与宿主发送不是原子事务；Runtime 不保证 exactly-once，也不能阻止 Agent 绕开入口直接发送。自动 MCP 重试最多变成无新发送许可的恢复响应，不能重放消息。

## 7. Python MCP 与 Node 的实现边界

沿用现有 Python MCP 服务与 Node Runtime，不复制两套业务状态机。Python 负责严格 action 参数、可信 Registry 定位、受控桥接、MCP 返回及现有观测；Node 负责通知规则、锁、账本、幂等和结构化结果。

固定 adapter 路径，参数经 stdin JSON 传递，shell=False；无任意命令执行入口。Node 可执行文件和 Runtime 根来自安装配置，Python 路径由服务的已验证运行环境/绑定提供，单次进程环境注入，不改全局环境。绑定与安装冲突报错，不搜索历史路径或全盘寻找替代文件。

CLI 保留为兼容、诊断和测试入口，同一核心逻辑，不是正常 Worker 流程的必经步骤。MCP 不可用时先报告入口问题；不默认让 LLM重新拼整套命令，也不新建团队。

## 8. 返回与观测

状态区分 ready_to_send / already_accepted / reconcile / wait / stopped / recorded / error。reasonCode 至少覆盖 UNREGISTERED、TEAM_NOT_CONNECTED、IDENTITY_CONFLICT、SUBMISSION_CHANGED、HISTORY_REQUIRED、DELIVERY_UNKNOWN、POLICY_DENIED、ALREADY_REVIEWING、OPERATION_CONFLICT、BUSY、PAYLOAD_TOO_LARGE、RUNTIME_UNAVAILABLE。映射沿用底层真实原因，不把 stopped 误记为发送失败。

正常响应只含该动作必要字段，不输出完整 Registry、账本或历史。错误提供“失败步骤、原因、下一步”，不能把缺失数据填零。

复用现有观测配置及授权范围，关闭观测不影响通知操作。持久化观测仅记录 team/task/submission/attempt/operation ID、工具/action、起止 UTC、单次单调时钟耗时、结果码、版本、字节数，不记录正文/提示或隐藏推理。业务 ledger 是恢复权威，不依赖指标落盘成功。

接入现有时间线，明确区分：

- prepare 调用耗时（程序实测），含锁/桥接；可细分但嵌套时长不重复相加。
- durable submit → claim 持久化：声明事件与系统时间的间隔，保留时钟修复标记。
- claim → result 登记：包含 Agent 调度、原生发送和记录间隔，不叫纯网络耗时。
- 宿主发送耗时：仅有原生工具来源时显示，否则缺失。
- Manager 接收/审查/通过：来自已有业务记录，不能由 accepted 推断。
- 准备工具往返、错误/重试次数、账本增长；Token 只使用明确覆盖的现有采集，不由调用数估算。

## 9. 验收、安装与回退

必须测试：

1. 原始正文往返（中文、emoji、CRLF/LF、空格、转义、日期、小数秒、长文本）、notice 完全匹配与摘要一致；无静默截断/修正。
2. 单次 prepare → 模拟宿主结果 → result → status；真实持久化与跨进程恢复，不能只测内存 mock。
3. 同 ID 重放、同 ID 不同输入、不同 ID 并发、track/claim 写失败、落盘后响应丢失、result 重放和 unknown 后对账。
4. 当前/历史身份差异、错团队、撤权、未就绪、替换提交、关闭轮次、reviewing 竞态、未知/拒绝/终态非送达/冷却/尝试上限。
5. Python→Node stdio 契约：缺配置、非法路径参数、shell 字符输入、超时、超限、死锁回归、子进程异常与坏 JSON。
6. 正常路径不创建中间文件链，不修改 Registry/business state，无宿主自动发送或 LLM 调用；原始 E03a CLI、canary 和通知恢复用例继续通过。
7. 旧 reader/writer 与新幂等扩展混用：不能丢失元数据、重置尝试或误判发送；不兼容时必须版本门禁，不得宣称可透明回退。

安装单独确认，备份完整受影响文件、版本/哈希和回退检查；MCP 增加工具是否需重连/重启以实际发现结果为准，不承诺热加载。先本地合成回归，再指定团队有限试用，不自动升级所有团队。

回退只回退代码/Skill 路由，不还原旧 state/ledger。已有 E03 unknown 尝试保留对账责任；回退版本必须保留读取新元数据的能力。若兼容测试未证明，禁用新入口并保留恢复代码，不能强行安装旧包。

与 E01/E03a 基线固定比较，不同时改模型、验收标准、并发或 E04。至少 3 项同类真实任务作初步观察，保留失败样本；主指标是机械往返和准备错误减少，质量护栏是无新增重复发送、丢通知、错误目标或不实结果。Token、整体交付历时证据不足则结论不足，不承诺节省比例。

## 10. 开发交接顺序与自审

设计确认后，由独立正式 Worker 实现：先核心原子准备/结果幂等及故障回归，再 MCP 固定桥接及契约测试，再最小 Skill/观测适配。Manager 只读审查实际 diff、原始测试与异常证据，决定通过或返工。开发完成不等于获准安装和真实团队试用。

自审取舍：复用现有正文/账本而非新增正文库；不改变通知包装而同时混入 E02；首次发送仍需原有历史核对，不能靠代码伪造确定性；status 可召回但不能重放发送；结果证据和宿主权限不因 MCP 封装升级为可信认证。未引入第二个调度器、自动归档或模型服务。
