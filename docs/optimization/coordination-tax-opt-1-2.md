# Coordination tax 优化 1–2

## 当前状态（2026-10-20）

本批收口已经本地安装并真实采用的结构化提交、阻塞报告、简短摘要与固定宿主流程，形成待审候选提交；不执行安装、模式切换或真实业务。候选集成基线为 `70ed898`，保留其 Dashboard v2、持续指标、workContext 和 Manager inbox/前台续办能力。独立审查、合并和推送由主窗口负责，候选准备完成不等于已合并发布。

2026-10-20 新增的结果优先监督规则单独保留在本地，继续观察，**不纳入本批**。候选 Skill 从该规则之前的真实备份提取基础能力增量，再与最新 main 的 inbox 规则合并；这不是把旧 Skill 整份覆盖到新 main。此文也不要求现有成员重新读取或中断运行。

## 基础能力与实际边界

- `team_context.submit`：原 Worker 持久化结构化证据并进入 submitted。稳定 submission_id 用作幂等键；同 ID 异内容拒绝。锁内检查当前/历史身份、归属与状态。文件、检查和产物是 Worker 声明，Manager 仍检查实际 diff、产物及证据。
- `team_context.report_blocker`：记录原因、需要谁、需要什么及 evidenceRef，不改变 Manager 的 block/unblock 状态。有效范围到后续 submit/unblock/rework/approve/cancellation 检查点；失效不表示外部问题已解决，历史报告保留。managerBlocker 单独展示。
- `team_context.progress_summary`：只读投影任务阶段、最近台账活动及来源、最近提交/审查和阻塞。可选 task_id 精确过滤；不传时 scope 为 all-recorded-team-tasks。实时 Agent 活动仍为 unknown，不从台账时间推断计算活动，不添加轮询。
- 固定宿主流程：仅对已核实 legacy/observe 模式，以一次 `functions.exec` 顺序完成 submit → prepare → 宿主 send → result。Runtime 不代替宿主 API，工具数量不等于模型调用数量，目标每次提交 ≤2 模型调用尚未证实。
- submit、通知准备、宿主接受、Manager 收取、独立审查、批准分别记录。accepted 只表示宿主接受，不是 Manager 已阅读或批准。未知/被拒结果保留原范围，不盲重发，不绕过拒绝，不增加 timer 或闲置唤醒。

## 与最新 main 的兼容

### 读取器与事件

新 Runtime 保留旧自由文本 submit、E03/CLI 接口；旧 submit 无结构化证据时仍拒绝多余 caller。兼容是新读取旧数据的单向承诺。旧 Runtime 的封闭 schema 不认识结构化 submit 的 caller/submission、reportBlocker 等新格式；**真实团队已写入新事件后，不能直接回退旧运行时**。先统一升级持久化读取端/MCP/看板；回退需另行制定兼容方案并核对实际数据，不能覆盖状态或抹掉新事件。

观测保留 schemaVersion=1 和 2；v2 的经校验 workContext 与有界 worker 元数据可共存，禁止退回旧的单版本封闭字段表。目录同时保留 read/manage/startup、notice/notice_status、dispatch/dispatch_status、inbox/inbox_status，加上 submit/report_blocker/progress_summary，共 12 个工具。仅在原有支持 Registry/runtime bridge 的模式注册扩展，旧 index-only 模式不扩大。

### Manager inbox 与固定模板

先按 [Manager inbox](../manager-inbox.md) 核实已安装的有效团队模式。queue_first 由原 Worker durable submit 后 post 精确 submission；post、新工具或桥接失败绝不 fallback 到 E03/native send。observe 为 shadow-only，legacy/observe 保留其原通知路径。已知 queue_first 的模式读取不可用不能当作 legacy。

[固定模板](functions-exec-submit-template.js) 与 `src/host-submit-flow.mjs` 仅适用于已核实 legacy/observe。调用方从现有 inbox 状态核对 notificationMode；模板初始 null，queue_first/未知模式在任何工具调用前停止，转回原 inbox 路由。该声明不是身份认证、自动模式查询或强制宿主权限边界，不启用模式，不改 Runtime `src/submission-notice.mjs` prompt。

填入已核实身份、真实证据、稳定 ID、notice baseline 与既有人类通知授权。工具缺失/重名时停止，不创建替代团队。submit 失败/未知只恢复同 submission ID 和内容；prepare 失败查同 operation ID；prepare replay 不提供新发送机会。发送异常记 unknown；result 失败保存原回复和 unrecordedResult，以同 attempt/result operation ID 对账，不重发。

原生成功响应只接受精确目标的白名单 `{threadId[,hostId]}`，其他/陌生结构保持 unknown；明确拒绝保持 policy-denied。hostRequest 不改写。无网络事务原子性、无 exactly-once，模板 mock 不证明真实连接、授权或成本收益。

## 已安装、真实采用与尚未证明的收益

下列为维护任务提供的已核实本机观测及业务台账汇总，窗口为 **2026-10-16 至 2026-10-20 UTC**。公开仓库只保留脱敏别名与聚合结果；本地证据索引和逐任务核对记录留在仓库外的交付目录，不上传日志、用户绝对路径、成员身份或业务原文。

| 脱敏团队 | 结构化提交采用 | 成功摘要调用 | 无 taskId 的摘要调用 | 最大摘要响应（字节） |
| --- | --- | ---: | ---: | ---: |
| R（发版） | 37 次 structured submit，覆盖 36 个任务 | 147 | 20 | 280089 |
| F（固件） | 4/4 个观测任务采用 | 8 | 2 | 234982 |
| U（一键升级） | 2/2 个观测任务采用 | 12 | 6 | 73282 |

这些任务有 review/approve 台账，证明基础工具已有真实采用和审查轨迹，**不能证明质量无退化**。37 是提交次数而非任务数；4/4、2/2 为各自已观测样本，不外推全团队历史覆盖。最大响应是字节，不是 Token，不能直接换算成本；无 taskId 调用也不能仅凭数量判定正误。

2026-10-15 首批观察 B0 的三个完整通知样本分别用了 **6、7、7 次模型调用**，未达到 ≤2 目标。另有两个 1 次调用短路径样本，分别为通知被拒和明确只提交不通知，不得算作完整通知闭环成功。首批观察与 10 月 16–20 日扩大后的采用汇总口径不同，不混为一轮完整可比测量。

尚无严格可比的 Token、金额或因果收益结论。后续两轮统一比较未完成，不声称两轮已采集。历史样本复杂度、模型、上下文、通知路径与时间窗不同，不能用调用量或字节数代替 Token 节省比例，也不能因为保留 review/approve 就宣布质量没有变化。

## 测量与验收口径

1. 以 team/task/submission 分组，完整提交窗口从首次提交尝试到通知结果登记，计入纠错、准备、对账和工具等待后的模型回调。MCP 调用、宿主发送、重试和模型调用分列；核心窗口外准备/收尾单列。
2. 普通 status_sync、结构化 blocker、摘要、等待、身份恢复与实质审查分别分类，不通过改分类隐藏进度对话。wait_threads 不自动等于无效协商或向 Worker 追问。
3. 分开记录 cached input、uncached input、output；reasoning 为 output 子集，不重复累计。按真实单次 usage 去重；缺失为 unknown、零分母为 N/A，不估算金额或填零。
4. 保留 submit → review → approve/rework 轨迹和独立检查证据；正式返工与提交前修改分别记录。返工率降低或审批轨迹完整本身都不能证明审查质量提高，不降低原验收标准。
5. 两轮观察使用自然发生、已授权且可比较的任务；某团队缺少任务或证据就保持未观测。版本/模型/设备/范围改变则分组，不强行补齐或宣布采集完成。

## 历史验证与本次收口

2026-10-14 的本地验证属于实现历史：Node 曾 515/515 通过，之后宿主结果投影定向 8/8 通过；Python 首轮完整套件为 245 通过、4 失败（工具发现从 7 变 10 的旧断言），修正后定向 6/6 通过。当时未在修正后重跑 Python 全套，不能把两轮结果拼成一次完整全绿。早期缺 pytest/pywin32 路径等环境问题与业务断言失败分开保留在本地证据中。

2026-10-20 收口对齐已安装模型策略：Worker `gpt-6.1-sol/medium`，Liaison/subagent `gpt-6-sol/medium`，Manager model/effort 均为 null，保持用户选择；modelOrder 只加入同安装策略一致的 `gpt-6.1-sol`。测试覆盖新型号兼容、宿主字段映射及直接父模型上限，保留原越级限制与 effort 行为，不用改断言掩盖未实现能力。

本次在最新 main + 候选增量上重新执行完整 Node/Python 测试；命令、计数、退出码、版本和完整 diff 由仓库外交付回执记录。Python 复用既有独立测试依赖，以独立环境指向候选源码，日志、JUnit、basetemp 均在仓库外；不安装候选全局包、不修改 MCP 或运行团队。测试仅证明对应本地契约，不证明自然 Agent 加载、新监督规则实效或 Token 收益。

## 本批文件边界

包含结构化证据/Worker runtime/adapter、progress summary、固定宿主 flow、state/render 投影、MCP 注册和有界观测/指标读取，以及相关 Node/Python 测试、基础 Skill 指引、模型配置与本文。保留最新 main 的 inbox、workContext、持续指标和看板实现。`src/submission-notice.mjs` 与 main 一致。

不提交 artifacts 日志、测试依赖/缓存、运行 state/registry/ledger、私有测量原文或最新监督规则补丁。最新监督规则的当前三份源文件、独立 patch 和哈希另存本地证据目录，保持可恢复和继续观察。
