# Watchdog 显式 local queue deployment 候选

日期：2026-11-16。本轮补齐可安装测试候选代码；**未安装、未合并、未向真实团队运行**。自动全链路真实隔离验证由父节点执行，结果必须另据实际证据报告。本说明是本轮最新实现边界；早期候选文档中的空allowlist/无自动对账结论是前一阶段记录。

## 接入接口与信任边界

`loadWatchdogDeployment(<absolute-manifest>)` 读取用户显式本地配置，返回statePaths和adapterFor；`checkWatchdog(statePath,{deployment: adapter})`、`startWatchdogService(statePaths,{deployment: registeredDeployment})`执行该配置。没有manifest默认不发送；不自动扫描、发现或登记业务团队。任意消息对象、JSON safe字段或source.kind不能注册适配能力。

manifest严格闭合schema（不接受safe等额外字段）：

```json
{
  "schemaVersion": 1,
  "kind": "watchdog-local-queue-deployment",
  "teams": [{
    "statePath": "ABSOLUTE_STATE_PATH",
    "teamId": "EXACT_TEAM_ID",
    "manager": {"hostId": "local", "threadId": "EXACT_MANAGER_THREAD"},
    "binary": {
      "path": "ABSOLUTE_CODEX_EXE_PATH",
      "sha256": "83f5c2dd2ac2902e0d96ba5d8ccdd27d513f57df4a9ab73e06a5a518028e9a2f",
      "version": "0.167.0-alpha.4.1"
    },
    "log": {
      "path": "EXACT_NATIVE_JSONL_PATH",
      "hostId": "local", "threadId": "EXACT_MANAGER_THREAD",
      "hostLogVersion": "0.169.0-alpha.11.1",
      "queueClientVersion": "0.167.0-alpha.4.1"
    }
  }]
}
```

代码固定允许此实测pair，manifest只能选精确路径和当前绑定，不能自行扩大版本/host/用途。实际binary hash流式核对、--version参数数组执行；宿主log version仅为注册日志session_meta中的格式/版本声明，**不是当前宿主二进制认证**。显式配置受本机用户控制；没有额外权限认证主张。

Manager必须当前active/bound且与manifest、所有open round历史Manager绑定一致；state/日志均canonical精确路径。manifest被修改、binary hash/version漂移、日志thread/version不符或绑定变化，均故障/pending而非业务失败。只使用queue --thread --message，不使用steer、resume、Worker派发或后台加载。

```text
node src/cli.mjs watchdog-serve <explicit-deployment-manifest.json>
node src/cli.mjs watchdog-check <state.json> --deployment <manifest.json>
```

旧的state-path数组serve仍兼容只读巡检，不自动接入发送。on/off/status命令保持不变。CLI和Skill没有安装、自启动或自动选择3个业务团队的行为。

## 自动链路与不重复语义

1. 独立Watchdog事务锁下，纯程序读取既有台账/通知；明确off直接返回，不验证binary/log。无异常且无未决receipt不做能力探测。
2. 当前待提醒按task/execution分组，每次最多2个异常，统一冷却/频率上限；已经提醒的首任务不会阻挡其他pending任务。正文仅包含有界标识、类型、合成引用和既有授权内判断提示，不沿用隔离测试的“禁止业务”文本。
3. 原子持久化Watchdog intent；receipt prepare使用该稳定Watchdog attempt ID作为operationId，持久随机nonce、完整生成正文/hash和精确目标/context。
4. marker前准备/验证失败明确not-sent，异常保持pending并显示故障/退避；fresh guard拒绝也是确定未发，不永久变成unknown。真正sender再次校验显式开关、当前绑定、业务与通知证据未变，随后wx+fsync send-once marker并execFile queue。
5. marker存在后任何超时、崩溃、不明结果都unknown，不重发、不换通道。CLI整行输出匹配queueId及精确thread且无stderr时只记queued运输接受，绝不推断消费。
6. 后续巡检自动用同receipt核对精确注册日志。consumed/turn-completed/turn-interrupted与业务处理/验收分离。消费和完成分别累计一次历史观察计数；之后重复证据可降unknown，currentReceiptCounts另列当前状态。
7. 对账每轮最多20个attempt，按lastReceiptCheckedAt最旧优先轮转，21项以上不会永久饿死。已完成且log stat与execution未变时复用已核对结果，不重复binary hash/--version；日志变化才重新核对并可降级。
8. receipt完成可解除投递未决，但业务异常仍active；业务fixture被明确approve后才sleep。关闭期间不发送、不读取业务/宿主；重启保留off和去重。正常关闭释放lease。

本地发送意图、宿主queue及业务台账没有共同事务。fresh guard不是业务/宿主绑定原子锁；在核对后立刻发生的并发重绑定不能宣称被完全消除。提醒带精确context，消费方须核对当前任务/执行和开关后按既有授权判断，不自动修改业务。队列不保证exactly-once，现有实现以marker+unknown禁重试避免重复唤醒。

## 长日志读取与legacy

receipt注册和核对采用64KiB流式读取：先校验首行session_meta，保存完整发送前byte baseline、文件identity和完整prefix hash；对账重新流式hash全部前缀，只解析baseline后完整追加段。旧baseline内容作为不可变历史完整性材料，不将其reasoning复制到内存报告或sidecar。测试覆盖发送前超过8MiB的日志；不再因历史总大小8MiB直接不可用。

追加段仍限制8MiB、50000行、单行1MiB；超界、坏UTF-8/JSONL、末行不完整、替换/截断、前缀改变、未来记录或重复匹配均unknown，不截取部分宣布唯一。流式hash的I/O随注册日志大小增长，这不是事件订阅或P1自适应优化。没有全盘/其他团队日志扫描。

旧Watchdog attempts没有receipt身份，继续legacy unknown，不补造nonce/确认、不自动清理。linked receipts历史保留以核对重复，metadata/receipt容量上限仍会停止新发送；没有用删除未知来恢复。三个业务团队未注册、未读写、未试运行。ended-without-submit和同轮冲突的**生产证据仍unsupported**，此次不造业务execution↔native turn认证。

## 隔离auto-round harness（未由子代理运行）

候选外 `artifacts/watchdog-host-validation-20261116/auto-round/harness.mjs` 只接受 `run`，固定已授权隔离target，生成自己目录内的fixture state和deployment。wx一次性bounded-run marker禁止重跑另发；总时限90秒，finally关闭服务，程序检查间隔在harness中调为1秒，不改变默认60秒。

单命令由父节点执行：

```text
node <absolute-auto-round-harness.mjs> run
```

流程：无异常cycle不发送 → 显式fixture submit过阈值 → 实际程序queue → 自动receipt完成 → repeat不新增attempt → off期间第二个pending fixture不发 → off下明确approve第二fixture → 重启仍off → 启用后原提醒不重发 → 显式approve原fixture → sleep。fixture审批是harness主动业务模拟，不是模型回执带来的验收。

harness通过bodyOverride给隔离目标仅要求短答、禁止读文件/注册/真实业务；生产默认正文则只提示Manager核对当前异常并依既有授权判断。该override来自受审查本地harness，不是外部消息safe声明。结果写auto-results.json，失败写auto-failure.json，均不含受控发送全文或reasoning。

## 当前证据与安装测试范围

离线：Watchdog23项、receipt15项、deployment9项，共47项通过；加入既有supervision/supervision-cli/manager-session-skill联合70项通过，exit0。覆盖多任务独立receipt与统一冷却、21条轮转、off/无manifest/漂移禁发、发送前确定未发恢复、完成后重复降级、重启不重发、业务完成sleep、大日志完整前缀、有界追加段及正文分层。

父节点已执行真实auto-round并独立审查，结果见下节。可安装测试范围仅为显式注册、当前精确pair的local提醒候选；已加载idle/busy有先前隔离证据，notLoaded、用户并发、宿主/CLI升级、断线后exactly-once和长期收益没有泛化保证。此轮不安装、不合并、不接管三个业务团队，不宣称完整P0。

## 父节点独立验收（2026-11-16）

隔离自动闭环通过，实际总耗时12,953毫秒（含测试等待；巡检间隔为测试专用1秒，不能当作生产延迟承诺）。使用真实deployment适配器与服务，程序自动发送并核对原生回执，无手工补发。

| 检查 | 实际结果 |
| --- | --- |
| 无异常巡检 | 0次发送 |
| 台账提交触发提醒 | 1次发送，自动关联原生轮次并确认完成 |
| 重复巡检与服务重启 | 仍为1次发送，无重复提醒 |
| 关闭后新增待办 | 无发送，重启保留关闭状态 |
| fixture显式批准后 | 进入休眠；批准由测试程序模拟，不是Watchdog越权批准 |
| 测试收尾 | 服务已停止，未决投递0，当前unknown回执0 |

父节点独立运行Watchdog、receipt、deployment及既有supervision、supervision-cli、manager-session-skill回归：70项通过，0失败、0跳过。原始证据位于候选外watchdog-host-validation-20261116/auto-round/auto-results.json、fixture-state.json.watchdog/reminder-receipts.json及manager-verification.json；测试日志不提交。

结论：达到**已登记台账异常提醒的受限本地安装测试标准**。安装前仍须对拟接入团队的精确state、Manager绑定、日志路径、CLI版本/hash作预检。仅台账待审、阻塞和通知异常在范围内；Worker已结束但未提交、同执行宿主冲突仍缺可信生产关联，不能宣称完整P0。生产默认提醒正文经过离线验证，此次原生目标只收到隔离短答正文，未验证真实Manager业务处置或长期成本。三个业务团队未接入；本轮未安装、未合并。

## 长期团队安装预检补充（2026-11-16）

安装阶段只读预检发现，实际长期Manager日志首行的cli_version保留创建时版本：固件团队为0.153.4。当前部署pair要求0.169.0-alpha.11.1日志声明，因此尚不能接入该长期会话；这不等于当前Desktop实际使用旧版本。隔离新聊天闭环成功不能替代长期聊天兼容验证。

三个受检团队均有非终态台账，不能从Manager idle推断全团队无在途任务。此次不生成业务部署manifest、不启动生产提醒、不恢复历史待办。后续需验证长期会话的日志格式兼容及当前目标异常范围；本地安装与实际接入分别报告。
