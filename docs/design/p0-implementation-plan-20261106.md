# P0 具体修改方案：稳定闭环，减少 Manager 的日常上下文负担

日期：2026-11-06。状态：待讨论确认。本轮只读核查并保存方案；未修改代码或 Skill，未运行产品测试，未安装、合并、联系团队或启用定时器。

## 1. 本批建议

P0 沿用三个目标：角色与上下文稳定、可靠交接、最小观测。核查后不建议再建提交工具、收件箱或指标系统。先收口现有候选，再做一项主要行为改动：**把 Manager 每次监督读取的规则拆成短核心与按需细节**。交接组合回归和观察记录为这一改动提供证据。

- **P0.1：现有候选收口 + Manager 监督说明拆分。** 保留身份、召回、wait 投影及诊断例外，减少正常监督必须读取的协议细节。
- **P0.2：交接链路复用 + 跨模块回归。** 验证提交、通知失败、待审恢复、审查与返工的组合行为；只修能复现的缺陷。
- **P0.3：复用已有采集，统一观察表。** 按任务和实际版本比较体验、时间、Token、机械调用与质量，不新增在线采集服务。

文档体积下降不等于 Token 或完整交付时间已改善；真实采用与收益仍需观察。

## 2. 本轮核实的基线

源码工作区：`<source-checkout>`。
分支：`codex/coordination-tax-base-main-20261020`，有既有已修改及未跟踪文件，全部保留。

实际 config.toml 指向的 companion：
`<verified-installed-runtime>/companion`。

全局 Skill：`<CODEX_HOME>/skills/manager-session`。

抽查 14 个关键文件：10 个逐字节一致，1 个仅换行不同，3 个有实质差异。这不是全仓一致性审计，也不能证明当前进程或团队已加载。

| 已核实 | 位置 | 对本批的影响 |
| --- | --- | --- |
| Manager 监督说明、召回模板、wait 模板与所查源码一致；监督说明为 10,552 字节 | [监督说明](../../skills/manager-session/references/manager-supervision.md)、[召回模板](../../skills/manager-session/scripts/functions-exec-manager-recall-template.js)、[wait 模板](../../skills/manager-session/scripts/functions-exec-wait-template.js) | 已有修复不重写；可测量日常说明读取量 |
| Manager 操作实现、合同、固定宿主模板一致 | [操作入口](../../src/manager-operations.mjs)、[合同](../../src/manager-operations-contract.mjs)、[宿主模板](../../scripts/manager-operations-functions-exec.js) | 复用 enqueue / receive / record_decision / status，不另造调用层 |
| 监督计划、收件箱、提交恢复、metrics explain 一致 | [监督](../../src/supervision.mjs)、[收件箱](../../src/manager-inbox.mjs)、[恢复](../../src/submission-recovery.mjs)、[指标](../../src/metrics-explain.mjs) | 优先组合验证，不重建基础能力 |
| progress-summary 统一换行后相同 | [progress-summary.mjs](../../src/progress-summary.mjs) 第 15 行 | 不因换行差异同步，不改变不传 task_id 的接口默认值 |
| SKILL.md、structured-submission.md 有 E05 路由、看板说明、身份操作按需阅读等差异 | [入口](../../skills/manager-session/SKILL.md)、[提交规则](../../skills/manager-session/references/structured-submission.md) | 不全量覆盖全局 Skill；不顺带安装 queue_first / v2 看板路由 |
| 时间线解析器有实现差异 | [task-timeline.mjs](../../src/task-timeline.mjs) 约第 59 行 | 记录解析器版本，不顺手升级，不把不同口径直接比较 |

[supervision.mjs](../../src/supervision.mjs) 13–70 行已有 taskChecks、pendingSubmissions、恢复计数及执行中 / 返工的完成发现；74–88 行可读通知证据，明确与业务 state 非原子。[收件箱说明](../manager-inbox.md) 记载漏 post 的正式提交可在后续 checkpoint 补回。**前台能恢复待办，不等于能自动唤醒闲置 Manager。**

本轮未读三团队最新业务日志，实际采用、样本是否充足和收益均不作新判断。

## 3. P0.1：Manager 入口与监督规则

### 3.1 先收口现有候选

核实本次候选的安装差异、回退位置与实际加载证据；已有有效样本就复用，不重复制造任务。磁盘哈希、口头“已读取”和真正采用固定模板分开记录。不自行通知成员刷新。

### 3.2 拟修改文件

| 文件 | 具体改法 | 边界 |
| --- | --- | --- |
| `skills/manager-session/references/manager-supervision.md` | 保留为短核心，目标 ≤3 KiB；保留已有锚点及所有行为约束。将 envelope、枚举、游标预算、functions.wait 等技术解释移出 | 不为体积目标删规则；完整语义放不下就报告实际体积 |
| 新增 `skills/manager-session/references/manager-supervision-reference.md` | 承接协议与兼容细节；首次接入不熟悉宿主、遇到不支持的结果结构或需要核对参数时按需读取 | 不要求每次监督加载；不重复核心正文 |
| `test/manager-session-skill.test.mjs` | 更新入口、引用锚点及核心约束覆盖检查 | 避免以一段原文字面完全相同替代语义验收 |

共享 SKILL 入口、description、Worker / Liaison 协议、Python Registry、两个固定模板、MCP schema、业务状态机均不预定修改。旧 `#manager-entry-and-recall` 等锚点保留，避免批量改链和覆盖本地定制。

### 3.3 短核心必须保留什么

1. 已确立的 Manager 先按职责处理请求；实施交正式 Worker，用户明确改变分工时按范围执行。
2. 有效身份直接复用；缺失、过期、冲突才在既有节点恢复，不每轮 / 每工具额外读 MCP。
3. 召回使用原模板，完整保留 sharedRules、roleDuties、managerGuidance 和准入限制；不能套用 native 状态过滤器。恢复角色不等于获准派工。
4. 找待办用 taskChecks / pendingSubmissions；具体任务读精确 task_id；省略 task_id 仅用于明确的团队概览。
5. 普通监督和验收不读 Worker 执行对话，依据任务卡、提交、实际 diff / 产物、证据与获授权的验证。
6. native 状态 / wait 用原固定投影；保留准确身份、游标、可验证完成信号，不输出正文。执行中 / rework 的结束发现不取消，不增加等待频率。
7. 保留诊断例外：复验失败、证据矛盾、blocker 证据不足、疑似越界 / 安全问题、用户明确要求调查异常。先读证据，再读最小轮次片段。
8. 精确 Worker 已 ended / idle，但当前任务无提交和有效 blocker，可读最后一轮，不扩展历史。
9. timeout、unknown、旧台账或解析失败本身不授权读正文、重发、重派、释放占用或启用定时器。
10. 机械登记复用已安装 Manager 操作入口；receive 只开始审查，approve / rework 来自独立验收后的明确决定；通知 prompt 暂不改。

### 3.4 验收

- 召回正文完整保留、native 正文仍过滤；用实际模板源码和反例防止两类过滤器混用。
- 宿主 / MCP 调用次数不因拆文档增加；Worker / Liaison 文件、材料、步骤与全局工具目录无新增。
- 比较普通监督的实际读取集合；复杂场景按需展开的总读取量另计，不能只比较小文件。
- 固定模板与现有身份、准入、等待、诊断、验收条件均保留；静态断言不等于模型必然遵守。
- 真实样本观察读取量、机械模型往返、时间、usage 和质量反例。字节不换算成 Token。

## 4. P0.2：可靠交接，只补组合缺口

沿用现有链路：

**Worker 证据与提交 → 当前已启用模式下的通知 / 入箱 → Manager 发现待办 → 独立审查 → approve / rework。**

程序处理校验、编号、格式、关联、幂等与已知状态；LLM 负责需求、拆分、诊断和验收。不会改写回执或审批来源，不承诺原子跨会话发送。

### 4.1 拟修改范围

- 补一个聚焦跨边界的 fixture 套件，拟名 `test/p0-coordination-flow.test.mjs`；复用已有测试工厂、Runtime 函数和固定模板，不重复已覆盖的枚举单测。
- 复用 [supervision](../../src/supervision.mjs)、[submission-recovery](../../src/submission-recovery.mjs)、[manager-inbox](../../src/manager-inbox.mjs)、[manager-operations](../../src/manager-operations.mjs)。这些是验证对象，不是预先批准全部改动的清单。
- 全部通过则生产代码不变。失败时先定位最小修复；涉及默认值、Worker 协议、模式、持久化结构改变时回到方案确认。
- 不在真实团队初始化或切换 legacy / observe / queue_first。

### 4.2 组合回归矩阵

| 场景 | 预期结果 |
| --- | --- |
| 提交成功、通知失败或没有新消息 | durable 提交保留，后续获授权监督可发现待审，不自动批准 |
| 通知 unknown / 已拒绝 | 按原操作与约束对账，不造新 ID 重发 |
| queue_first 漏 post | 原 checkpoint 补回正式项；故障不偷偷走 native send |
| 双 Worker 乱序提交 | 精确关联任务、成员和提交版本；一项异常不污染另一项 |
| ended / idle 且无提交 / blocker | 完成发现保留，最后一轮诊断可用，不把结束当验收 |
| receive 重试、reviewing 恢复 | 不重复 review、不倒退、不跳过审查 |
| 返工后旧通知重现 | 不复活旧提交；决定关联当前提交 |
| 旧绑定、身份冲突、占用未释放 | 原阻断条件保留；native idle 不等于可重新派工 |
| 业务已写、投影失败 | 用原操作对账，保留 partial / committed / unknown，不重复副作用 |
| 召回误用状态过滤、native 结果直接透传 | 回归检出职责丢失或正文泄漏，不靠删断言通过 |

既有相关测试包括 manager-operations、supervision、submission-recovery、manager-inbox，以及 manager-recall-template / manager-wait-template。按改动和组合场景选择运行，不机械重跑全部测试。

## 5. P0.3：最小观测，不增加 Worker 采集动作

已有 [时间线入口](../../src/task-timeline-input.mjs) 支持明确来源与范围，已有 [task-eval](../../src/task-eval.mjs) 筛选阶段和间隔，Metrics 可提供 usage。task-eval 仍是单任务辅助报告，不能直接当作 Token / 质量对照结论。

### 5.1 拟新增一份观察模板

新增 `docs/optimization/p0-observation-template.md`，在 `docs/optimization/README.md` 加入口。分析会话根据现有导出填写；不由 Worker 汇报，不改变 state 或 Registry。

| 字段组 | 记录内容 |
| --- | --- |
| 身份与版本 | team / task / attempt、角色、源码 / 安装哈希、实际加载证据、采用时间、解析器与分类版本 |
| 时间 | 完整交付、可确定的提交到审查等待、审查到决定、执行区间、用户等待、未知间隔 |
| 成本 | 按角色与既有 trigger 分类的调用和 usage；cached / uncached input、output 分开 |
| 规则采用 | 普通正文读取、诊断理由、召回正文保留、固定模板使用、重复纠错、核心 / 参考实际读取集合 |
| 人与质量 | 催问、转发、纠偏、漏报、重复派发、错任务、跳过验收、真实返工原因 |
| 去留 | 体验、数据、反例、覆盖缺口及保留 / 收窄 / 修正 / 观察 / 回退建议 |

数据限于已授权的精确任务与时间范围，保存引用与必要计数。没有来源写 unknown，不填 0，不均摊无法归属的 usage，不把字节换算 Token。声明时间和观测时间不随意相减；并行 / 重叠区间不相加；不把所有间隔归因 Runtime。

不新增 Worker 阶段标记、MCP 调用、心跳、必读文件或周期汇报，不复制整套对话、源码、密钥或隐藏推理。

### 5.2 轻量判断

- 两轮自然完整任务用于初筛，两周是回看节点，不是定时任务。失败、返工和中断保留。
- 跨团队样本增强判断；没样本的团队标 unknown，既不能外推收益，也不强求齐全后才作个人使用决定。
- 沿用同类完整任务总 Token 增幅 30% 的初始观察上限，有可靠基线才计算，超过交给用户判断。
- 每轮一个主要假设；优化会话成本单列，不新增预算审批或严格 A/B 基础设施。
- 现有 task-eval 的“至少 3 个任务”等历史提示不作为本计划门槛，以当前轻量 RSI 为准。本批不顺手重做评估器或新增报告 schema。

## 6. 批次与文件清单

| 批次 | 动作 / 文件 | 性质 |
| --- | --- | --- |
| A：现有候选收口 | 安装差异、回退位置、加载与自然采用证据 | 只读准备，先不改版本 |
| B：短核心候选 | manager-supervision.md；新增 manager-supervision-reference.md；调整 manager-session-skill 测试 | 唯一预定行为改动 |
| B 的质量证据 | 复用 recall / wait 模板测试，必要时加跨过滤器反例 | 不改模板逻辑和全局工具 |
| C：交接组合验证 | 新增 / 扩展 p0-coordination-flow fixture；相关原有链路测试 | 只有复现缺陷才提出局部生产修复 |
| 从 A 开始：观察记录 | p0-observation-template.md、优化索引 | 分析配套，不是在线控制器 |

A / B / C 不捆绑成全仓安装。先对现有候选作去留判断；下一轮只试用经过审查的规则拆分或明确缺陷修复，分别说明影响与假设。

## 7. 执行与停止条件

1. 用户确认后在候选工作区由正式 Worker 实施，Manager 审查；不重置 dirty 分支，不顺带带入 E05、v2 看板或解析器差异。
2. 仅运行相关检查和隔离 fixture，测试日志本地保留；本轮未运行产品测试。
3. 候选交付实际差异、边界覆盖、Worker / Liaison 契约差分、普通 / 复杂场景读取量、备份与可审查回退方法。
4. 用户另行确认安装后只替换本批清单。在途任务不切协议，不启用 queue_first，不自动刷新忙碌 Worker。
5. 职责丢失、结束发现遗漏、错投、重复副作用、跳过审查或 Worker 新负担，均阻止安装。试用后发现共同约束破坏，按影响暂停新路径，保留在途事实；回退由用户确认。
6. 样本少或时间 / Token 未改善就保留分歧，不承诺固定节省比例。质量问题不能被主观提速抵消。

P0 完成意味着：已有角色与交接能力通过针对性验证，一个真实优化假设有明确去留结论，且没有把成本转嫁给 Worker。P1 看门狗、自动唤醒、定时器、全局 Hook、权限引擎、自动会话轮换与新的模型策略不在本批。
