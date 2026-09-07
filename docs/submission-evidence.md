# 提交证据

状态：初版提交及后续独立复验记录。日期：2026-09-05。下面“交付/实际验证”保留首轮提交的 14 项测试证据；最新增量见本节。

## 父任务复验与 Skill 增量

### 无定时器提交通知与现场闭环：2026-09-07

- 实现 submission-notice / receive-submission CLI 与模块。从实际 submit 审计生成稳定通知，接收时核对当前/历史角色绑定、完整通知及当前状态版本，仅记录 Manager review；重复、返工后旧通知、阻塞和关闭轮次不重复推进。fixture 不生成真实宿主发送参数。新增 16 项测试；完整回归 126/126 通过、零失败与跳过。
- 复用此前三个独立专用测试任务及原 state，增加一轮受控测试，不创建任务、不改模型/名称、不触碰真实业务工程。先 reports=false；Worker 第一版自行提交并发送标准原生通知，Manager 原派发回合结束后进入新的消息触发回合。接收进入 reviewing，本地重放返回 already-reviewing/changed=false，原版本和哈希不变。
- Manager 独立核对第一版后，按预先约定的测试需求变化记录 rework（不是虚构第一版缺陷），交回原 Worker。第二次 Worker 提交及原生通知再次触发 Manager 新回合；先接收旧通知返回 superseded/changed=false 且版本/哈希不变，再接收新通知、独立核对精确字节和 SHA-256、approve、closeRound。原 state 从 v18 到 v28，两次提交、两次 review，最终任务 approved、轮次 closed，历时 635773 ms。
- 父任务没有在两次提交后手动催办 Manager，也未代写 Worker submit/Manager review；通过原生任务状态与回合 ID、Worker 保存的发送请求/工具回执、Manager 接收证据、真实提交与 review 审计交叉核对。Manager 最终完成消息实际到达父任务。宿主读取部分新回合时 items=[]，且状态展示存在滞后，不能声称拥有完整逐工具追踪或精确触发延迟。
- 独立只读复验检查最终产物、完整阶段顺序、原角色保持 active/bound、历史轮次与绑定完整保留；在内存重构测试前投影得到与原 v18 文件一致的 SHA-256。测试前后原定时器配置与汇报账本各自哈希完全一致，保持 PAUSED；没有创建/恢复任何定时器。历史耗时断言最初误用 PowerShell 展示时省略毫秒的时间格式，定位为 ConvertFrom-Json 转成 DateTime 后的展示差异，修正验收脚本为原始规范字符串后通过；未改业务状态或产品逻辑。
- Liaison 第一次主动查询在执行阶段读取 v21，未联系 Manager/Worker；关闭后的另一回合通过自身 resume/status 读取 v28，两个相差 60 秒的计算时间下任务及各阶段耗时一致。最终查询前后 state/ledger 哈希各自不变，角色保留；reports=false 不阻止用户主动问答。第二次查询的直接证据已保存，第一次查询细节由 Liaison 据自身现成工具输出补记，父任务未获得其原始完整回合明细。
- 当前 Skill 官方 quick_validate 已复用此前私有验证依赖运行通过，无新安装或全局环境修改。源 Skill 未全局安装，未提交、推送或发布。
- 验证边界：这是单 Worker、两阶段、无定时器的受控宿主闭环及手动跨回合恢复，不是并发多 Worker 负载、消息身份认证、恰好一次传输、持久化收件箱、自动重试、崩溃/跨月恢复或最终总结去重的证明。用户控制请求与回执、最终总结去重仍是后续功能；可选定时器的可靠 24 小时到期停止仍未实现，继续默认关闭。

### 已确认 Liaison 解除与重邀：2026-09-07

- 新增正式 detach CLI / session.detach / detachLiaison 事件。仅当前active Manager、精确已确认邀请、无开放轮次、reports=false可操作；保持expectedVersion与原存储锁/原子替换。旧完整邀请及确认归档在解除审计事件，旧绑定清空，之后必须重新双向邀请确认。
- 合成测试先观察缺失能力和缺失CLI失败，再实现。完整回归84/84通过，0失败、0跳过。覆盖旧确认/旧resume拒绝、错误身份/邀请/版本/重复、并发单赢家、开放轮次、退出角色、历史轮次与任务不变、坏导入拒绝。
- 独立审查限定的更换为不同目标流程未发现阻断，独立定向5/5通过。报告两项边界并已写入使用说明：reports=false不证明宿主暂停；同身份重邀不会递增旧账本bindingEpoch，不支持重配对后旧账本复用/迁移。
- 未读取或修改真实试用state，未联系Worker或新Liaison，未创建任务/自动化，未改业务项目、安装、提交、推送或部署。真实纠正由原Manager验证后执行。

### 只读进度正文增量：2026-09-07

- reporting-progress 模块和 CLI 复用 tick 检查，只输出当前开放轮次的结构化进度与中文正文；区分验收、提交、阻塞，保持未知/冻结耗时和观察新鲜度，列出记录中的阻塞原因。
- 模块缺失、CLI 未接入、缺少阻塞原因均先观察失败再实现。测试覆盖只读文件字节、错误身份、用户关闭汇报和历史轮次排除。
- 不调用宿主、不恢复定时器、不投递消息；delivery=not-sent。周期投递与最终总结去重仍未完成。

### 播报前检查与真实配置闭环：2026-09-07

- 新增 reporting-tick 纯只读模块和 CLI：精确 Liaison/自动化绑定、当前开放工作、用户偏好、角色退出、fixture、未决操作和 running 观察检查；返回许可与原因，不调用宿主或修改状态，不授予暂停权限。
- 独立代码审查未发现阻断问题。父任务全套实跑 75/75，通过且无跳过；Skill 官方 quick_validate 通过，git diff --check 退出 0。
- 经授权复用三个独立专用任务，真实创建一项绑定 Liaison 的 heartbeat。原 Worker 自行提交配置证据，Manager 独立验收关闭新轮次，随后 prepare/dispatch/native update/record 暂停同一自动化。父任务另行验证业务版本18、账本版本6、CREATE/PAUSE均CONFIRMED，精确持久配置PAUSED且其余配置字段保留。
- 原生 view 只返回卡片回执，字段由精确配置文件核对；原生任务读取曾滞后，未据此重复创建。没有观察到周期 tick，不将配置状态等同于周期投递或自动完成回调。
- 实测定时器已暂停保留，未删除、全局安装、提交或推送。最终总结去重、自动监督/恢复和长期运行仍未交付。以下各节保留较早阶段的历史证据与当时限制。

### 汇报操作账本增量：2026-09-07

- 新增 reporting.mjs/reporting-store.mjs 与 reporting-init/plan/apply CLI，业务 state 只读，独立账本以版本和原子写入记录准备、发送登记、观察及未决状态。实际宿主调用仍由未来适配器执行。
- 专项覆盖 CREATE/RESUME/PAUSE 建议、PREPARED 过期、DISPATCHED/UNKNOWN 不重复创建、迟到暂停不改新业务意图、精确 owner/automationId、fixture/manual 不提升宿主确认、退出 Manager 不写账本、失败阻断及坏文件原字节保留。
- 独立审查复现损坏导入清空已确认 automationId 后再次建议 CREATE 的 P1；修复共享事件校验并增加持久化拒绝回归。另修复隐藏 dispatch/record 投影与事件历史不一致的同类缺口。新回归先红后绿。
- 既有存储测试曾因真实 Windows 额外重试而产生 calls=9、不等于固定3的失败；仅修正测试将两次注入与实际平台失败分别计数，保留最多21次、持锁、旧内容完整和只写一次事件的断言，未改存储产品策略。
- 父任务修复后独立全套实跑 68/68 通过，0 失败、0 跳过、退出0。Skill 官方 quick_validate 通过。
- 独立复验确认原 NULL/隐藏投影复现均被拒绝，合法 unknown+未知ID仍可保持RECONCILE并以同一操作准确核对；按最终Skill进行CREATE超时场景检查，不重复创建、不猜ID、不另建账本。
- 根据三任务现场测试窄修 Skill：正式创建ID+独立环境ID+原生精确读取的核对路径；新任务列表缺失不重复创建；本任务输出目录放请求/产物，原角色正常审批更新共享状态，审批等待后复核版本与事件ID。不复制私人ID或测试路径到公开说明。
- 没有真实启停自动化、安装hook、最终总结投递、全局安装、Git提交或推送。CLI登记DISPATCHED不代表已经发送，host-observation标签不构成认证；业务reporting.actual仍为unknown。

### 单次监督桥增量：2026-09-05

- 新增 supervision-plan CLI 和 planSupervision/runSupervision 模块：精确历史绑定去重、每批至多 8 个目标、游标身份校验、Manager 边界、零工作零查询。注入式执行保留原始结果，错误不重试，不写业务状态或将宿主完成当验收。
- 7 项模块测试与 2 项 CLI 测试均先观察红测再实现。父任务完整复验 53/53 通过，0 失败、0 跳过、退出 0；最终 Skill 官方格式校验通过。
- 独立行为复验使用 11 个 Worker、12 项任务，输出 8/3 两批且共享 Worker 不重复。模拟 terminal 返回不改变 submitted/acceptance，Liaison 监督请求和错配游标被拒绝；普通 status 正常，文件字节不变。未发现阻断问题。
- 同步操作说明，明确 CLI 输出只是计划，Node 不自动获得 Desktop 工具，fixture 不能发给真实宿主。普通 Liaison 查询不联系 Worker。
- 宿主汇报设计审查明确本地锁无法撤回已发出的旧暂停；最小接入契约见 [宿主汇报接入](host-reporting-contract.md)。尚未实施自动化账本或实际创建/暂停、最终总结去重。
- 本轮未创建或绑定真实双窗口、未启用定时器、未安装/提交/推送。真实现场验证需明确所使用的独立任务。

### 角色操作增量：2026-09-05 最新复验

- 新增可执行 start、双向 attach、register-worker、只读 resume；配对复用同一 state、事件、版本与锁。旧状态查询不静默迁移。身份仍为调用方声明，不是宿主认证。
- 新增 13 项角色行为测试。独立审查发现首次启动无 Worker 注册通道、空轮次无法收口，先复现再补注册入口与无 Worker 开轮保护；注册→分配→提交→审查→验收→关闭的本地流程已覆盖。
- 父任务首次完整复跑 40 项为 37 通过、3 失败，发现 Windows rename 瞬态拒绝。后续隔离观察确认同一路径可在约 0.4–1.2 秒后恢复，未归因具体扫描器。新增 4 项存储回归，Win32 EPERM/EBUSY 仅重试同一次替换，最多 20 次 100ms 延迟；始终持锁，不删除目标、不重放事务、不改权限。永久拒绝保留旧状态并失败，EACCES 不重试。
- 修复后父任务独立连续两次执行 `node --experimental-test-isolation=none --test`，均为 44 项通过、0 失败、0 跳过、退出 0（约 4.0 秒 / 7.3 秒）。通过正常审批执行 CLI 子进程测试，未跳过失败用例。该结果不是长期或跨平台可靠性保证。
- 独立说明驱动测试从使用文档提取 fixture 示例，走通 start→invite→confirm→register-worker→双角色 resume→status；版本 3、三类成员、零任务，查询前后原字节不变，宿主能力和实际汇报状态保持 unknown。
- 官方 `quick_validate.py` 对最终 Skill 入口输出 `Skill is valid!`、退出 0。仅在父任务私有 artifacts 中安装 PyYAML 校验依赖并以 UTF-8 模式执行，未修改产品零第三方依赖约束，也未全局安装 Skill。下方旧记录中的缺依赖阻塞是历史结果，现已解除。
- README、Skill、操作参考与使用文档同步。没有创建真实团队或定时器、安装恢复 hook、提交 Git、合并或推送；HTML 暂停扩展。下一阶段仍需真实宿主身份与观察适配、双窗口验证、后台监督、周期汇报和实际停报闭环。

### 之前的 27 项切片复验（历史）

- 父任务先独立重跑原 14 项测试，全部通过；随后复现状态导入身份不一致、未来回执时间两个缺口。
- 修复新增 8 项回归，覆盖历史绑定与坏文件不覆盖；父任务独立重跑 22/22 通过。
- 新增仓库配套 `skills/manager-session/SKILL.md`、操作参考、只读 status 脚本和 5 项行为测试。
- 独立行为检查实测只读查询不改状态，并核对查询不激活、停报未知不冒充确认、缺失当前身份不写入；发现并修正首次初始化需要不存在成员记录的文字矛盾。
- 最终父任务独立执行 `node --experimental-test-isolation=none --test`：27 项通过，0 失败，0 跳过，退出 0。子进程 CLI 测试通过正常提权审批后执行，没有跳过。
- 父任务独立核对演示快照散列、READY 标记、JSON/HTML 同源、模拟来源与未知宿主状态，全部通过。
- Skill 官方 quick_validate 无法运行：现有 Python 缺少 PyYAML；没有将此项标为通过，也未安装依赖。入口名称、frontmatter 子集和相对引用另做静态检查，不等同官方校验。
- 本次只批准早期离线功能继续开发，不是完整 Skill、自动运行、网页导航、宿主暂停或浏览器视觉验收。未全局安装，未提交 Git、合并或推送。

## 交付

- `src/runtime.mjs`：严格状态校验、来源事件、角色/轮次/成员/任务、提交审查返工批准、计时与不可变快照。
- `src/store.mjs`：独占初始化、锁、版本冲突检查、同目录原子替换。
- `src/render.mjs`：同源只读 HTML；浅色任务主区、团队侧栏、关键动态、待决策、完成摘要、任务详情；所有成员导航禁用并解释原因。
- `src/cli.mjs`：init、apply、snapshot、render、demo。
- `src/demo.mjs`：明确标记来源的离线夹具。
- `test/runtime.test.mjs`：14 项测试。
- `package.json`、`.gitignore`、`docs/minimal-runtime-plan.md`、`docs/runtime-usage.md`、本文；更新 README、V1 scope 及设计文档状态说明。

没有提交、推送、合并、发布、安装依赖、创建其他任务或自动化。没有写原仓库或源草图。

## 实际验证

Node.js 22.17.1。最终命令：

```powershell
node --experimental-test-isolation=none --test
node src/cli.mjs demo artifacts/submitted-demo
git diff --check
```

实际测试输出末尾：

```text
1..14
# tests 14
# suites 0
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 199.5832
```

演示命令输出 FIXTURE / 模拟来源，产生 `artifacts/submitted-demo/view/index.html`、`snapshot.json` 和 `READY.json`，以及上级目录的 `state.json`。快照 ID：`0c2d2bc846eafe181dc2d9bc4f0674e247990f832199259b49617916657e6cbe`。

`git diff --check` 退出 0；Git 提示三个既有 Markdown 文件未来会按配置将 LF 转换为 CRLF，无空白错误。

默认 `node --test` 最初因沙箱派生子进程 `spawn EPERM` 失败。使用 Node 自带无子进程隔离模式执行全部测试，没有提升权限。测试先于实现创建；缺失模块失败已观察。之后还通过红绿回归发现并修复未来状态时间戳、伪造阶段路径和提交次数校验缺口。

| 验收项 | 实际覆盖 |
| --- | --- |
| 坏输入/坏状态不覆盖 | 非法 JSON、语义坏 JSON、未知字段、版本冲突、重复初始化、重复写入、并发竞争 |
| 绑定缺失 | unbound/creating/missing 拒绝分配，轮次保存原绑定，后续换绑不覆盖历史 |
| 提交与批准/返工复验 | Worker 提交不能关闭轮次或自批；返工后重新提交、审查、证据批准 |
| 等待/阶段/完成冻结 | 阻塞包含在总历时，阶段计算，完成后固定，缺少分配时间为 null |
| 未知与陈旧观察 | 无观察、缺少观察时间、过期观察、延迟旧观察不覆盖最后有效进展 |
| 新旧轮次隔离 | 旧轮关闭不停止新轮，拒绝重复关闭，历史读取不改状态，用户停报偏好保留 |
| 停报语义 | desired 与 actual 分离，离线回执 actual 不晋升为宿主实际状态，旧意图回执拒绝 |
| 页面安全与一致性 | 转义注入文本、无脚本/deep-link、禁用导航及精确绑定、JSON 与 HTML 内容一致、渲染不改源状态 |
| CLI 链路 | init/apply 持久化、demo 导出、snapshot 只读、新目录保护 |

## 验证限制

仅本地静态与离线测试；源草图代码可读，但没有浏览器视觉验收，不声称视觉完全一致。未绕过先前浏览器本地文件限制。

没有真实成员绑定/观察适配器、宿主共享权限验证、网页导航、汇报自动化、实际暂停确认、长期恢复或跨宿主验证。HTML 不自动刷新；用户需重新导出。宿主待验证接口与操作员锁恢复边界详见使用说明。

状态文件是受信任写者维护的本地记录；actor/source 字段不构成宿主认证或证据真实性证明。锁与原子替换只验证本地文件系统，不外推为断电或网络盘保证。首版保守要求轮次内所有已分配任务完成后收口，未实现取消/跳过或运行中成员迁移。

本报告不将最小运行层等同于完整长期 Team 产品，Worker 最终回答也不构成父任务验收通过。
