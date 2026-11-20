# Watchdog P0 候选实现与验收边界

后续更新（2026-11-16）：已获授权在单独测试聊天完成当前版本 idle/busy 队列、重复提醒和受控任务关联验证，见[宿主验证结果](watchdog-host-validation-20261116.md)。下文“未发送消息/没有真实宿主验证”描述候选初次交付时的历史状态；生产 allowlist 仍为空，未安装、未合并，生产绑定与回执闭环仍未完成。

日期：2026-11-16。代码基线：`f786e95`，候选分支 `codex/watchdog-p0-20261116`。本说明不代表安装、启用生产巡检、安全提醒验收或收益证明。

本轮只在隔离工作区实现并用临时 fixture 验证；没有提交、安装、合并、push、修改宿主配置、联系团队成员或对真实团队运行。最新设计依据为 [watchdog-20261114.md](design/watchdog-20261114.md)。11-11 独立任务队列评审保留历史结论，不覆盖其原文。

## P0 能力矩阵

| P0 项 | 候选实现与离线证据 | 生产状态及缺口 |
| --- | --- | --- |
| 程序巡检 | `readState`、既有通知 ledger；服务只读解析缓存，业务变化后重新解析；schema-2 每次仍做 Registry projection，缓存命中仍校验 dispatch objects | 台账可读取；生产未运行。无完整对话扫描，无业务状态副本 |
| 默认开启、团队管理 | sidecar 初始 enabled=true，独立 config 持久 false；on/off/status/check 命令及薄 Skill；单次检查不覆盖 off | 未安装；默认开关不等于在线监控 |
| 空闲休眠 | 每团队独立 deadline；无业务工作且无未决投递才 sleeping；记录变化只唤醒对应团队，低频扫描兜底 | fs.watch 是尽力信号，候选未做长期现场运行 |
| 结束未提交 | 严格内部宿主摘要契约与 fixture adapter；当前 task/execution/dispatch、历史与当前 Worker binding、turn ID、时间、新鲜度、宽限、发送前复核 | **生产缺失**可信 task/execution↔turn 来源；普通 observation/source.kind/JSON safe 标志不提供认证，默认 unknown |
| 通知未送达 | 既有 `loadLedger` 校验；只匹配当前 round/task/submission；已记录 not-attempted/policy-denied/transient-not-delivered 过阈值后形成提醒 | 证据仍 caller-assessed；缺记录/unknown 不能推断未送达；不接管重试协议 |
| 提交/阻塞未处理 | 当前 submitted 或 block/reportBlocker 超过候选阈值提醒一次，reviewing 不纳入未处理判据；状态变化撤销 active 提醒 | “unhandled”只代表台账仍处于待审/阻塞，无独立已阅读/处理中字段；不判断失职或语义失败 |
| 同轮状态矛盾 | 无自动冲突规则：submitted/reviewing与原生running可同时合法，显式unsupported | **规则缺失且生产宿主未接入**；须先有精确违反既有执行契约的证据，不能用超时或不同状态维度推断矛盾 |
| 监控不可用 | 输入/Registry/notice 错误写独立 fault，逐团队退避至15分钟；状态坏数据 fail-closed | 业务文件和业务锁不写。未监控需看 process/heartbeat，不把故障当业务失败 |
| 去重、意图和合并 | 每团队 transaction lock；stable key=team+task+execution+type；事实 hash 变更才加 revision；发送前持久 intent；重启 intent→unknown；单批20条；同问题不自动再发 | 非共同事务，不承诺 exactly-once。queued/unknown 一律不盲重发；明确没有生产对账/确认入口 |
| 安全提醒 Manager | 有 fixture-only enqueue；有精确二进制 probe、参数数组和有界 queue transport 候选；CLI 成功保持 unknown | **生产未验证且不可启用**：allowlist 为空，运行时默认 unavailable/pending。尚不满足至少一条真实安全提醒链路，不能称完整P0闭环 |
| Token 与基本展示 | 程序代码不调用 LLM；紧凑状态默认最多20条当前异常，不返回历史；checks/detected/attempts/confirmedDelivery/confirmedWakeups；唤醒未知单列 unknown | programModelTokens=0只指程序巡检；提醒触发的模型成本和收益未知，不能用提醒字数估算 |
| 进程与单实例 | 显式前台服务，一个进程多团队；每团队 canonical sidecar lease，重复监控拒绝；owner token+30s心跳+PID；正常SIGINT/SIGTERM共用close清理 | **托管未部署**。无 daemon/autostart；kill/崩溃遗留锁不抢占，过期/错token显示unknown，需要人工核对后另行授权处理 |
| 无 Worker 负担、故障隔离 | 无 Worker 文件、协议、MCP调用或材料改动；fixture校验state/Registry/notice/inbox原字节未变，业务锁存在也能读检 | 未做真实团队长期观察；不宣称遗漏、误报或费用已改善 |

## 模块与命令

- `src/watchdog-checker.mjs`：纯台账检测与异常生命周期。
- `src/watchdog-input.mjs`：只读输入与进程内解析复用；不缓存整个对话。
- `src/watchdog-store-contract.mjs`：持久化状态、大小、计数、枚举及关联校验。
- `src/watchdog-runtime.mjs`：独立 config/store/lock/lease、检查、发送意图与前台服务。
- `src/watchdog-schedule.mjs`：每团队到期时间和故障退避，支持注入时钟。
- `src/watchdog-host.mjs`：严格内部宿主契约，仅允许注册的 fixture adapter。
- `src/watchdog-adapter.mjs`：默认 unavailable 与 fixture-only sender，任意 JSON 不提升能力。
- `src/watchdog-queue.mjs`：精确二进制只读 probe 和 gated transport，部署allowlist为空。
- `src/cli.mjs`：管理/前台入口；`wireServiceShutdown`复用原通用信号关闭逻辑。
- `skills/watchdog/SKILL.md`：薄管理参考，未安装。

从候选 Runtime 目录使用：

```text
node src/cli.mjs watchdog-on <state.json>
node src/cli.mjs watchdog-off <state.json>
node src/cli.mjs watchdog-status <state.json>
node src/cli.mjs watchdog-status <state.json> --detail
node src/cli.mjs watchdog-check <state.json>
node src/cli.mjs watchdog-serve <explicit-state-paths.json>
```

`explicit-state-paths.json` 为1..100个明确团队state绝对路径的JSON数组；不自动发现真实团队。`serve` 仅在明确授权前台运行时调用。on/off/check默认也返回紧凑结果；JS接口返回详细状态供离线测试，CLI只有status --detail按需显示历史。

每个 canonical `<state.json>.watchdog/` 独立保存 `config.json`、`state.json`、`transaction.lock`、`service.lock`、`heartbeat.json`；不取业务/Registry/notice/inbox写锁，不修改这些文件。sidecar目录重定向被拒绝，不跟随到其他业务目录。

关闭停止后续检查及发送，保留证据。关闭配置写入与一次已进入临界区的检查串行化；不能撤回已经入宿主队列的消息，消费方仍须复核任务/执行轮次、开关和异常有效性。

## 候选参数和有界状态

| 参数 | 初始候选值 | 含义 |
| --- | --- | --- |
| 活跃台账检查 | 60秒/团队 | 不是业务超时判据 |
| 休眠/关闭兜底 | 5分钟/团队 | 程序扫描；关闭不读业务/宿主 |
| 故障退避 | 2、4、8、15分钟，封顶15分钟 | 独立团队，不被其他活跃团队压成1分钟 |
| heartbeat / 新鲜度 | 30秒 / 120秒 | PID存在且token匹配且心跳近期才显示running；过期unknown，不抢锁 |
| 待审/阻塞/通知阈值 | 30分钟 | 已有记录的程序提醒阈值，不代表失职；JS policy可配置并严格校验 |
| 结束宽限 / 摘要新鲜度 | 60秒 / 3分钟 | 仅fixture宿主契约；生产未接通 |
| 提醒冷却 / 上限 | 15分钟 / 每小时4次 | 新revision不自动重发；没有安全adapter就保留pending |
| 批量提醒 | 最多20条 | 只含标识、异常类型、证据引用，不含对话/源码/原始source.ref |
| transport正文上限 | UTF-8 12KB | 不通过shell，不使用--resume，不截断任务卡/证据后冒充完整 |
| 活跃异常 / 所有异常 | 1000 / 2000 | 超限保留旧证据并显示capacityExceeded，新的问题可能无法登记，必须人工处理监控容量 |
| 未决attempt / 历史异常 | 1000 / 最近100条已解除 | 未决intent/queued/unknown绝不按TTL删除；达到attempt上限停止新发送 |
| sidecar状态大小 | 16MiB | 超限或坏状态fail-closed，不能通过清空未知记录恢复 |

没有生产确认/对账入口，因此 queued/unknown 会持续保留，业务完成后 phase=reconciling，不假装已交付或完全休眠。1000个未决attempt后停止新发送是候选停止条件，**长期无人值守尚有缺口**。本轮不新增手动“我已收到”或任意JSON证据升级入口；后续需绑定可信回执协议再设计。

检测只保存事件ID、任务/执行标识、枚举、时间与合成引用 `ledger:event:<id>` / `notice:<id>` / `host-turn:<id>`。不复制原始 source.ref、summary、观察正文、源码、完整日志或对话。通知台账保留其既有caller-assessed属性。

## 宿主契约与安装阻碍

生产宿主集成必须提供同一受支持宿主上的精确task/execution→dispatch→Worker→turn关联，以及可信摘要的来源、时间和当前有效性。`source.kind='host-observation'`本身是台账声明，不是认证。现有 `task-timeline-native.mjs` 是analyst-selected-items，不足以提供此绑定。本候选没有把传入JSON或fixture标成生产事实。

fixture契约要求当前execution ID与dispatchEventId一致、当前/历史binding一致、精确turnId、startedAt不早于执行事件、completedAt不早于开始且不晚于observedAt、观察不超前且不超3分钟。notLoaded、unknown、过期、旧执行事件都不等同失败。缺可信证据就unknown。宿主查询失败只置监控故障。

本轮仅执行只读帮助核查：当前 `C:/Users/admin/AppData/Local/OpenAI/Codex/bin/9e1da79431da526b/codex.exe` 为 `codex-cli 0.167.0-alpha.4.1`，其queue帮助包含--thread/--message/--resume，并明确resume失败仍可成功退出。PATH中的codex返回顶层帮助；历史`5449c1...`二进制已不存在。未执行queue发送、resume、daemon或认证读取。

11-10旧版本实验只证明当时已加载idle/busy的观察；不同queue ID/相同正文可能重复轮次，notLoaded可保持排队。不能据此外推当前alpha.4.1具有全状态安全与幂等。本候选allowlist为空；下一阶段需受支持的同宿主路径、当前精确构建、授权隔离聊天，验证并发busy/idle、重复、断线、结果登记失败、用户并发、消费和退出。真实安全提醒至少通过一条明确状态链路前，不安装、不宣称完整自动闭环。

## 本轮验证

```text
C:/Program Files/nodejs/node.exe --test test/watchdog.test.mjs
23 tests; 23 passed; 0 failed; 0 skipped
```

覆盖默认关闭持久化、无工作休眠、无异常不发送、合并、去重、并发、重启intent→unknown、未知不重试、当前通知关联/旧提交忽略、fixture禁止对生产发送、业务四类文件字节不变、单实例、多团队独立调度、完整15分钟退避、关闭/睡眠不查宿主、精确fixture执行轮次、完成业务后未决投递不丢、状态/时间/policy/容量校验、心跳错token和过期、正常信号调用close、紧凑状态、原始source.ref不泄漏、submitted/reviewing与原生running共存不误报。

信号测试以EventEmitter触发实际CLI共享信号接线并调用真实前台service.close；未用Windows强制终止冒充优雅关闭。fixture服务均在临时目录创建并在用例结束close，无持续生产进程。没有真实宿主安全验证、生产安装、真实团队试用或收益数据。

## 2026-11-16 受控回执候选补充

独立新增[发送关联与回执核对](watchdog-receipts-candidate-20261116.md)：prepare发送前持久intent、完整受控发送正文/hash、唯一nonce和精确target/context；只读注册原生日志核对唯一user metadata及queue触发的原生turn。独立receipt用例14项、联合60项离线通过。完整生成正文仅存在专用receipt ledger用于精确匹配，不复制外部对话或reasoning。

本批不迁移、不自动清理、不确认旧Watchdog attempts；生产allowlist仍为空。当前模块与隔离harness不等于生产回执通道；真实一次发送由父节点执行并另存证据。`current`是caller-declared，受控完整文本关联不代表认证，reminder的turn-completed不代表业务处理/验收。

## 2026-11-16 自动接入候选（最新）

最新实现与安装测试范围见[显式local queue deployment候选](watchdog-deployment-candidate-20261116.md)。已新增精确manifest/当前Manager/binary hash+client version+host log version验证，程序发送前intent与send-once marker、自动receipt及生命周期计数，legacy unknown保留，47项相关/70项联合离线通过。历史阶段的“allowlist为空/无自动对账”描述不再代表本轮实现；新版只允许代码中固定的实测local提醒pair，不是全宿主保证。真实auto-round由父节点随后执行，本说明不提前宣称成功。
