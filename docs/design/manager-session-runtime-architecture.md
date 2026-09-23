# Manager Session Runtime 总体架构设计

版本：2026-09-10 · 当前实现架构与后续边界

项目：`codex-team-runtime`；用户入口：`manager-session` Skill。

本文汇总现有实现、已确认的产品原则及本地实测，不提出新的执行授权。基线包含 Registry cutover 增量；该增量已在本地安装并完成一键升级团队迁入，但本次文档编写时相关代码仍有未提交改动，不能将本文视为已发布的 GitHub 版本说明。历史设计和验收文档保留其当时的阶段性结论。

## 1. 定位与北极星

> 构建一个可观察、可评估、可持续改进的原生 Agent 团队运行时，在保持交付质量与人工可参与性的前提下，持续降低协作成本。

北极星于 2026-09-19 更新；下文实现架构仍保留 2026-09-10 基线。后续 Trace + Metrics + 半自动 Eval + 改进 Loop 见 [RSI 设计](team-rsi.md)，不能将规划理解为已上线能力。

这是一个面向 Codex 长期开发任务的轻量协作层，不是模型执行引擎，也不是通用项目管理系统。当前适配重点是 GPT-6 + Codex；具体目标与评估口径见 [North Star](../../NORTHSTAR.md)。

团队可以跨多轮需求、跨数月保留角色与历史。任务结束后不需要模型持续计算：**长期存在的是身份、状态和协作约定，不是永不停机的 Agent 循环。**

解决的核心问题：

- 主窗口同时沟通、编码和协调时，角色职责容易混杂。
- 投递任务后无人持续审查，Worker 的完成声明被当作最终验收。
- 同一 Worker 尚未完成任务1，就收到任务2并被打断。
- 长对话压缩、重启或续接后，成员忘记自己的团队、负责人和交付规则。
- 用户看不到整体进度；无效定时轮询又持续消耗 Token。

节省 Token、费用及质量不下降是待对照实验验证的目标。不能用模型降级、成员增加或一次成功案例直接证明收益。

## 2. 角色与交互模式

| 角色 | 主要责任 | 明确边界 |
| --- | --- | --- |
| 用户 | 目标、范围、重大取舍、权限、必要的人工作业验收 | 可直接查看和询问成员；直接消息仍可能影响正在执行的任务 |
| Manager | 需求确认、拆解与分发、成员登记、依赖协调、监督、返工和独立验收 | 默认把实现交给执行成员；不能代 Worker 提交，不把自报完成当作验收 |
| Liaison | 日常沟通、进度解释、问题讨论、转交已确认决定 | 不派工、不指挥 Worker、不代验收；相关工作关闭后停止普通进度汇报 |
| Worker | 在明确范围和文件所有权内实现、测试、构建或部署，交付证据 | 不扩大授权，不自行更换负责人；交付前恢复角色并向精确 Manager 汇报 |
| 临时 Subagent | 承担有界实现、探索或审查子任务 | 不因继承上下文成为正式成员，不继承父任务的角色身份 |

典型关系是“用户 ↔ Liaison ↔ Manager ↔ Workers”。这是职责分工，不是强制消息总线：用户仍能进入任一独立任务沟通，Manager 也可直接与用户确认决定。

采用独立 Codex 任务的原因是可长期复用、可直接打开交流、可查看宿主公开的过程、工具结果与产物。临时子 Agent 用于短期辅助，二者不应混为一套成员生命周期；宿主可见过程也不意味着能够导出模型的私有内部思维链。

隔离沟通窗口旨在减少干扰，不保证消息绝不打断。Liaison 到 Manager 的持久命令收件箱尚未实现；转交决定必须区分“已发送”“已收到”“已执行”。

## 3. 四层结构

| 层 | 实现 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| 协作契约 | `manager-session` Skill 与 references | 何时召回、如何核对身份、委派、验收及使用其他 Skill | 不常驻、不自动触发工具、不是权限强制层 |
| 身份与角色记忆 | Python Team Context MCP | 当前团队/成员登记、leader、规则、入队确认、确定性召回、迁入协调 | 不调用 LLM、不执行开发、不发送原生消息 |
| 业务运行层 | Node.js CLI 与纯状态机 | 轮次、任务、占用、队列、提交、验收、审计、投影和只读快照 | 不直接拥有 Codex 原生工具，不替代模型判断 |
| 宿主执行与展示 | Codex 任务工具；派生 HTML | 真实创建/读取/发送/等待任务；展示只读工作状态 | 宿主状态不等于业务验收；HTML 不成为控制台或第二份事实 |

Agent 在授权范围内调用 MCP、CLI 和原生工具，将这些层串起来。**模型负责判断，代码负责校验已编码的不变量，宿主负责真实动作。**

### 3.1 模块对应

| 模块 | 主要文件 | 职责 |
| --- | --- | --- |
| Skill | `skills/manager-session/SKILL.md`、`references/*.md` | 分工、召回、忙碌准入、模型策略、投递恢复、定时器规则 |
| MCP 服务 | `python/src/codex_team_context/server.py` | stdio 服务与工具参数入口 |
| Registry | `team_registry.py`、`registry_store.py`、`team_policy.py` | 严格结构、操作历史校验、幂等回执、锁与原子替换、职责与规则版本 |
| 迁入与桥接 | `adoption.py`、`runtime_link.py` | 原状态迁入、恢复、固定 Node 调用、只读 Registry 导出 |
| 业务核心 | `src/runtime.mjs`、`src/store.mjs`、`src/session.mjs` | 状态校验/演进、持久化、legacy 角色与配对 |
| 接入层 | `src/registry-projection.mjs`、`src/registry-adapter.mjs` | 当前身份检查投影、共同锁、纯 JSON 校验/转换 |
| 派发与监督 | `scheduling.mjs`、`delivery*.mjs`、`supervision.mjs`、`submission-notice.mjs` | FIFO、占用、送达对账、监督计划、提交与接收通知 |
| 汇报与看板 | `reporting*.mjs`、`render.mjs`、`dashboard-*.mjs` | 汇报账本与准入、快照正文、离线 HTML 导出 |

Node 运行代码使用标准库；Python 使用官方 MCP SDK。不是每个程序化入口都有 CLI 命令，接口细节以运行说明为准。

## 4. 数据所有权：各类事实只有一个权威

| 数据 | 权威来源 | 其他层如何使用 |
| --- | --- | --- |
| 当前角色、成员、绑定、leader、入队状态 | 已链接团队的 `registry.json` | MCP 返回 capsule；Node 校验后生成当前成员投影 |
| 任务、轮次、队列、提交/验收、历史绑定、汇报偏好 | 原团队 `state.json` | Agent 通过 CLI 操作；看板与汇报读取快照 |
| 自动化操作及观察证据 | 可选 reporting ledger | 协调未决操作，不代表真实调度器当前状态 |
| 原生运行状态、工具送达结果 | Codex 实际工具结果 | 由 Agent 核对并保留证据，不自动转换成验收 |
| 页面计数和可视化 | 不拥有独立权威 | 从同一次快照派生 |

Registry 是可维护的正式成员集合，不是通过聊天或活跃程度临时推测的名单。历史协作者不自动成为成员。只有 Manager 在核对授权后维护登记；退出保留历史，不按闲置时间删除，不自动重绑、改角色或选举新 leader。

当前 Registry 支持多团队，但成员 ID 和 host/thread 绑定的唯一性约束跨 Registry 检查。因此多团队不能机械复用 `manager` 等已被占用的成员 ID；冲突必须在登记前解决，不能为迁入悄悄改旧 ID。

### 4.1 版本不能混用

- `schemaVersion`：文件结构版本；不是任务进展。
- Node `version`：业务事件版本，用于业务写入的乐观并发检查。
- Registry `team.revision`：当前成员管理操作版本。
- `policyRevision`：职责规则版本，影响入队回执有效性。
- reporting ledger：自己的操作版本，不是 Node version。

Registry 从 schema 2 显式迁入后升为 schema 3；被迁入的 Node 状态从 schema 1 升为 schema 2。业务 version 可以不变：迁入不是一次业务开发或验收事件。

### 4.2 当前投影与历史快照

链接后的 Node `members`、`registry.teamRevision` 和 `readyMemberIds` 是检查过的缓存，不是可独立编辑的名册。

`readState` 读取原状态后调用 Python exporter，验证 Registry 的完整历史及链接，投影最新成员与 readiness。只读返回最新内存视图，不为了查询改写文件；下一次获授权业务事务才会持久化该视图。

因此磁盘中旧的 ready 列表与当前 MCP capsule 不同，不一定是故障。必须走正式读取入口，而非把裸 JSON 缓存当作当前身份权威。已有轮次成员绑定、任务归属与历史证据不能随当前成员变更重写。

## 5. 长期角色记忆与召回

### 5.1 为什么不只靠 Skill

Skill 是按需加载的规则文本，不是持久数据库，也不能保证上下文压缩后模型仍记得入口。MCP 提供独立、确定性的持久记忆模块，不依赖 AGC，不调用 LLM 解释或改写登记。

它保存的是团队身份和职责相关事实，不是所有聊天、源码或项目知识。任务细节来自原 state、持久 brief 和实际证据；不能把小型角色 capsule 膨胀成全局对话仓库。

### 5.2 精确召回

`team_context.read({host_id, thread_id})` 以当前独立任务的精确身份匹配：

- 未登记返回 JSON `null`，不自动注册、不写访问时间。
- active 返回自己、team、精确 leader、规则版本、角色职责和 onboardingReceipt。
- active Manager 额外得到正式团队名册；普通 Worker/Liaison 不拿完整管理名册。
- inactive 不恢复原角色；丢失、损坏、冲突或旧服务不兼容是错误，不是 null。
- 已链接团队返回同主机的 state/runtime/Python 定位信息。

当前身份必须通过宿主上下文交叉核对。标题、MCP 连接 ID、pending ID 或子 Agent 继承的父任务环境变量都不是充分身份凭据。

### 5.3 召回节点

全体正式成员使用相同触发约定：首次入队、前台续接/上下文丢失、身份或规则冲突、交付/接收/验收前，以及角色相关协调上下文已经过时的时刻。

不在每次文件读写前调用，不定时轮询。Manager 读过并不代表 Worker 读过；成员也不能因曾经 ready 而永远跳过后续召回。

**召回是双层机制：确定性数据返回 + Agent 按 Skill 调用入口。** 当前没有 hook 或强制自动注入机制。MCP 不会自行调用自己，因此只能提高恢复可靠性，不能保证永不遗忘。全局注册的工具名称/描述仍可能进入其他任务的工具目录，null 不代表零 prompt 开销。

## 6. 登记与入队确认

正常成员接入顺序：

1. 用户授权创建或复用正式成员；Manager 保留原生结果并解析正式身份。
2. Manager 调用 `register_member`；Liaison 还需要其本人同意依据。
3. 成员在自己的任务读取同一 Skill/reference，调用自己的 `team_context.read`。
4. 成员返回 receipt 和职责理解，Manager 核对真实回复来源后 `confirm_ready`。
5. 复读当前状态，再进入独立业务准入。

Manager 自己也要 read/确认。回执绑定 Registry、team/member、角色、绑定版本、leader 和 policyRevision；它是确定性声明，不是秘密、身份认证或理解能力证明。旧政策回执需要重新确认，不改写历史记录。

MCP 管理动作包括 `bootstrap`、`register_member`、`confirm_ready`、`exit_member`、`adopt_legacy`。API 请求严格检查字段，操作具有稳定 operation_id 与幂等回执。

三个容易混淆的判断：

- registered 不等于 ready；ready 不等于空闲、工作授权或未来召回成功。
- `executionIntegration=connected` 表示已连接 active 运行状态；`not-connected` 仍是独立身份层；`migration-pending` 不能继续普通业务操作。
- `dispatchAllowed=false` 始终表示“context read 本身不执行或授予派工”，不需要将它翻为 true 才能正常工作。

新 Worker 登记成功不自动加入旧轮次。Manager 在其 ready 后显式执行 `admitRegistryMember`，只向开放轮次追加该成员快照；之后仍须走忙碌/FIFO/原生投递检查。

## 7. 多轮任务闭环

Team 保留长期成员关系，Round 表达一轮交付范围，Task 表达可独立验收的工作。每个任务保留成员归属、阶段历时、提交次数、进展观察、验收证据与审计事件。

主路径为：

```text
queued → executing → submitted → reviewing → approved
   └→ cancelled                      └→ rework → submitted
```

执行、提交、审查或返工阶段可进入 blocked；解除阻塞按运行层记录恢复，不能随意跳到已验收。

关键不变量：

- 只有原任务 Worker 可以 submit，Manager 不能为了补账代交付。
- submit 只是待审查；Manager 独立检查实际证据后 approve 或 rework。
- approved 与 cancelled 是不同终态；撤回未执行任务不算交付。
- 关闭轮次需其任务都完成验收或明确取消；不能强行关闭来释放占用。
- 完成轮次不退出角色；显式角色退出也不等于停止、取消或归档原生任务。

### 7.1 忙碌 Worker 与 FIFO

任务进入 executing/submitted/reviewing/rework/blocked 后持续占用 Worker，直到验收。原生 idle、最终回答或相同技术领域都不释放这个占用。

独立新任务先存入 Manager 侧持久队列，不发送“做完任务1再做任务2”的消息。后者仍会影响 Worker，不是队列。已有占用解除后，仅 FIFO 队首可进入新的准入检查。

完整派工条件包括：Manager/操作者/目标 readiness、当前授权和 brief、没有其他未验收工作、队首资格、原生任务可接收且无未登记用户工作、CAS 成功和投递核对。某项不确定就保留队列或占用。

当前任务的窄范围澄清/返工可以发送给原 Worker，但不能把独立需求伪装成“补充”。已启动任务的强制抢占、取消和重新分配未实现。

### 7.2 投递、执行和验收分离

Node 记录分配，不等于宿主已收到消息。首次投递/恢复通过 `delivery-plan`、`delivery-check`、`delivery-claim` 核对同一任务与尝试。

只有确认请求未被接受且不可能迟到，才允许重新领取一次发送机会。每次有效 claim 最多一次获授权原生发送；超时、缺少可见回复或重启不能证明未送达。unknown 保留占用并对账，不换 ID、重派、取消或盲重发。

宿主接受消息仍不等于开始执行、已提交或已验收。CLI 与宿主消息不是一个原子事务，不能保证 exactly-once。

## 8. 监督、提交回报与用户进度

Worker 完成自己的持久化 submit 后，使用 `submission-notice` 准备通知，核对精确 Manager，再通过获授权原生消息发送。Manager 用 `receive-submission` 核对现有任务和当前提交，进入审查；重复、过时通知不重复推进状态。

Manager 的监督是前台可恢复的检查过程：读取可信状态 → 选择相关 Worker → 有界原生查询 → 核对实际产物 → 返工/验收。`supervision-plan` 只是工具请求计划，不是已经执行的查询；函数注入宿主适配器也不意味着 Node 自动获得原生工具。

默认推进来源是完成/阻塞通知、用户主动续接和查询，不是后台轮询。若消息失败或 Manager 没有被唤醒，当前系统不能保证自动恢复；保留证据并在下一次授权前台检查处理。

Liaison 平时从可信快照回答进度，不为每次询问唤醒 Manager 或 Worker。没有开放工作时停止普通进度播报，保留历史问答能力。

### 8.1 可选定时汇报

定时器默认关闭；即使长期角色已启用或新轮次开始，也不自动恢复。启用需要人确认固定窗口，最多24小时；续期必须再次人工确认。宿主不能可靠阻止到期后的唤醒时，不启用。

reporting ledger 记录准备、已派发、结果未知及核对回执，防止未知结果后重复创建。`reporting-tick` / `reporting-progress` 检查身份、开放工作、报告意图、账本和自动化对应关系；生成正文不表示已送达，配置 PAUSED/ACTIVE 也不是完整运行证据。

程序化执行器及 heartbeat 请求生成器已存在，但不是常驻服务。无人值守停报、周期送达、最终总结去重和强制期限宿主适配尚未完整交付。

## 9. 跨语言一致性与安全

### 9.1 无递归桥接

Node 读取当前身份时调用 Python 的只读 exporter；exporter 只校验 Registry，不回调 Node。Python 需要业务状态校验时调用纯 Node adapter，使用 `inspect/prepare/activate/check_exit`，adapter 只处理 stdin/stdout JSON，不再读取 Registry。

这避免 Python → Node → Python 的递归，也避免两套业务状态校验规则。可执行程序来自可信服务配置，不来自 MCP 请求；使用固定 argv、超时和输出限制，不拼 shell 命令。

### 9.2 锁和提交

已链接写入统一按 Registry → state → 必要时 reporting ledger 的顺序持有文件锁。两种语言在同一规范路径的 `.lock` 上竞争；只读 exporter 不重复获取调用者已持有的锁。

业务 version 与 Registry revision 分别检查；文件使用同目录临时写入和原子替换，避免读到半份 JSON。一般 Registry 管理操作与操作回执一起提交。读取不写访问记录，不能因此宣称跨文件、跨宿主或跨原生 API 的全局事务。

幂等重试仅适用于同一 operation_id、actor 和完整请求。历史回执不是当前状态，仍需复读。崩溃遗留锁不自动抢占；操作员先确认无存活写者，再显式处理。

### 9.3 权限边界

host/thread、actor、授权/同意引用都是需外部核对的声明，不是身份认证机制。拥有同等文件或工具权限的调用者可能伪造声明。真正的访问边界来自宿主审批和文件权限。

规则分三类：代码强制的状态/版本/占用约束，Skill 约定的模型/职责/召回/定时规则，宿主实施的工具权限与真实执行。不能将三者的保证相互替代，也不声称能拦截用户或其他客户端绕开协议的原始调用。

## 10. 旧团队受控迁入

新建独立 Registry 团队可先只做身份召回；它不是自动连接的 Node 团队。当前执行接入通过原 Manager 的显式 `adopt_legacy` 完成，不扫描所有对话自动纳入。

迁入顺序：

1. 核对原 Manager 身份、完整正式名册、Liaison 有效同意、原版本与原字节 SHA-256，以及 Registry 全局冲突。
2. 在同目录生成字节一致的不可覆盖备份：临时写入、flush/fsync 后原子发布。
3. 写 Node prepared，阻止普通业务操作。
4. 提交 Registry 成员、不可变 runtime 链接及迁入回执。
5. 激活 Node 链接，随后所有 active 成员逐个本人 onboarding。

中断后只沿完全相同的操作向前恢复。prepared 必须完整校验，并与经验证备份生成的预期准备态一致，才可提交 Registry。Registry 已提交后不能恢复旧 Node 快照；active 重试不抹掉后续业务变化。schema 3 支持继续迁入其他无冲突团队。

旧程序会拒绝新格式，不能作为错误时的 legacy 旁路。安装了新文件也不证明所有宿主连接已加载新版；应区分真实数据损坏与旧服务不识别 schema。

## 11. 部署与升级

长期使用采用稳定版本目录：非 editable Python 环境 + 同版本 Node companion + Skill/参考文档。开发可用 checkout，但生产角色恢复不能依赖可能被清理的临时 worktree。

Registry、业务 state、可选 reporting ledger 与代码安装目录分开。更新只替换/选择代码版本，保留原数据路径，不为升级复制第二份团队或创建空表。旧安装和配置备份保留，配置只改变所需服务项。

需要核对四个不同结果：文件安装正确、独立 SDK 可启动、目标任务的原生 MCP 已加载新版、真实成员本人恢复成功。前一项不能替代后一项。本地未提交源码安装应记录内容摘要，不冒称 GitHub 发布版本。

## 12. HTML 只读工作台

HTML 是同源 snapshot 的展示，不是 MCP 客户端或可写管理台。信息包括任务交付、轮次历史、成员、阻塞、派发/验收证据、汇报状态及历时。

同一导出中的页面使用同一内存状态和 asOf；`READY.json` 最后生成并记录文件摘要，缺失则导出未完成。历史页按历史轮次身份展示，当前汇报偏好与历史归属分开。

页面不自动刷新、不派工、不发消息、不创建计时器。采用本地字体和原生 HTML/CSS 交互，未知数据不补成零。

任务和阶段历时包含等待、排队及审查，不等于模型计算耗时；并行任务不能简单相加工时。Token/费用未实现自动采集。可选 Codex 链接是本机兼容入口，不保证跨主机定位，也不是网页调用 Agent 工具的能力。

## 13. 模型策略与其他 Skill 的组合

Manager 的模型和强度始终由用户指定。新正式 Liaison/Worker 默认 Sol / medium；临时子 Agent 默认 Sol / medium，或按任务选用 Terra/Luna，不超过直接父 Agent 的等级。复用成员不擅自改模型。

这是团队配置策略，不是运行层的模型性能排行或硬性校验器。具体值、宿主支持和有效配置需要核对；名称约定只帮助识别，绑定始终使用精确 host/thread。

组合原则不是简单的全局“manager-session > PDC > task-dispatch”优先级，而是**同一工作只有一个调度与最终验收所有者**：

- manager-session 管受管工作的分工、队列、回报与验收。
- PDC 可提供项目知识、开发阶段和交付方法，但不接管既有团队。
- task-dispatch 保留投递即止语义；project-task-dispatch 有自己的控制状态，不隐式触发来创建第二个 Manager。
- 这两个 dispatch 工作流在本契约下需用户明确选择；显式调用遇到已有所有者时，先确认非重叠范围或交接，不等于已经实现跨运行层自动迁移。

本项目不依赖修改其他 Skill 来强制全局优先级，也不能保证外部 Skill 自动遵守本契约。Worker handoff 必须带齐角色、负责人、原状态/任务、范围、验收、模型约束和回报路径。

## 14. 已验证范围与下一阶段

截至本文基线：Node 项目测试196项通过及相关修复回归；Python 最终133项通过；迁入安全问题经独立审查、失败用例修复及复审关闭。迁入验证记录位于本地 `docs/team-registry-cutover-validation.md`，尚未随本次文档提交发布。这些是历史执行证据，本次文档编辑没有重跑全部测试。

2026-09-10 一键升级团队的真实迁入与两成员本人 onboarding 已完成：原 Manager 执行，Registry revision3，两成员 ready；独立只读检查确认备份原哈希、全部原业务字段和最新身份投影。没有登记历史 Worker、恢复旧开发或启用定时器。该现场结果补充了此前验证文档中“尚无真实迁入”的阶段性边界；个人机器路径和完整回执保留在本地交接记录，不嵌入通用架构配置。

现场还发现本开发窗口存在旧 MCP 连接，而成员任务已能使用新版。不能把一个窗口的成功外推为所有连接已刷新，也不能为解决旧连接错误重复迁入。

后续重点是验证而非无限增层：

1. 新版链接团队的真实 Worker 新任务、提交、返工和独立验收完整闭环；不把旧版本实测直接等同于新版全链路通过。
2. 前台续接、重启、压缩、规则更新后的自然召回率及人工纠偏成本。
3. 不同任务集下的团队总 Token/费用与相同质量门槛的对照测试。
4. 旧服务连接识别、版本可观测性和升级体验；未知结果时的可靠证据回传。
5. 只有用户确需定时能力时，再完成可强制到期的宿主接入及自动停报验证。

不在当前保证范围：永不遗忘、无限自治、所有消息恰好一次送达、跨主机锁、断电级全事务、强身份认证、后台自动任务收件箱或 Token 节省比例。

## 15. 详细设计索引

- [产品角色与交互原始设计](manager-session.md)
- [Node 运行与事件接口](../runtime-usage.md)
- [MCP 身份与召回接口](../team-context.md)
- 迁入和恢复操作协议：本地 `docs/team-registry-cutover.md`，尚未随本次文档提交发布
- [汇报账本与宿主边界](../reporting-usage.md)
- [只读工作台设计](dashboard.md)
- [现行 Skill](../../skills/manager-session/SKILL.md)
- [组合、身份、模型及忙碌准入](../../skills/manager-session/references/operations.md)
- [投递恢复规则](../../skills/manager-session/references/delivery-recovery.md)

本文是横向架构入口；精确请求字段以对应接口文档和校验代码为准。若后续改变身份权威、生命周期或宿主权限边界，应同步更新本文，不能仅更新某一段提示词。
