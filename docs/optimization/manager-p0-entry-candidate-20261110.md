# Manager P0：监督入口和 reason 契约候选（2026-11-10）

## 状态更新（2026-11-14）

按用户授权，将本地已安装试用的候选整理提交主线。本次只同步源码，不再次安装、不修改团队状态。下文为 11 月 10 日候选审查时的历史记录，其中“未安装、未提交”和待验证状态仅描述当时。

- 安装记录：11 月 10 日入口与 reason 契约已同步到本地 Skill/companion，另有 inactiveStatus 修复及独立回退清单；原始日志与回退文件不提交仓库。
- 后续修复：仅当原生返回精确身份、非超时的 inactiveStatus/notLoaded，且前一轮正常完成时，允许既有单次加载及同轮复核；失败、打断及未知状态不据此放行。此项没有实现新的后台派发或队列机制。
- 本次独立回归：58 项 Node 测试、14 项 Python 测试通过，git diff --check 通过。修正一处过时的文案断言，保留固定入口、输出白名单和禁止原始正文回退的检查。
- 没有新增 Worker 启动、恢复调用或必读材料。Watchdog 与独立新任务队列仍是讨论/设计，不作为本批实现。
- 本次没有重采真实团队样本，不据此宣称自然采用或 Token、耗时收益已证明。

## 历史候选记录（2026-11-10）

状态：本地候选，Manager 已完成代码与离线回归审查；真实宿主集成仍待验证。分支 `codex/manager-p0-entry-20261110`，基线 `8a5eca8cb6d00d629ac8cb18b421617d16ab0d4b`。未提交、安装、加载、合并或推送。

## 问题依据和宿主能力

- 现场 Manager 读过 `functions-exec-wait-template.js` 后仍直接调用原生 `wait_threads`。候选基线的监督核心要求在 `functions.exec` 内过滤，`operations.md` 的可执行计划却写成直接执行原生批次。
- 已发现的 `progress_summary`、`dispatch`、`dispatch_status` 工具目录把 `reason` 声明为普通字符串，实际只接受后台 `REASONS`。`reason` 表示调用触发原因，原生派发的结果属于 `result.outcome`。错误后改成 `manual` 会丢失原因。
- 一次空闲目标 Manager 探测中，目标声明 `functions.exec`、`text`、`tools.mcp__codex_app__wait_threads` 可用。原生记录可见模板读取成功；纯模拟投影 smoke 的执行和输出是目标自报，原始执行证据未完整暴露。探测没有执行完整模板、没有调用真实 wait。另两个 `notLoaded` Manager 未发送、未唤醒。真实宿主 wait 与过滤的联动仍未验证。

## 候选改动

- 正常监督由已有 `supervision-plan` 找到待审工作和精确原生批次，在同一授权检查点通过固定模板做一次有界 wait，先过滤再输出。原计划的角色、任务、版本、游标、队列和通知查询不变。Manager 仍须核对当前版本、目标身份及实际来源；fixture 仅供离线测试。
- 在同一条计划命令中可传 `--wait-batch=N`（从 1 开始，位于 `--notifications` 前）。计划返回 `waitSource.source`，填入所选批次的完整原始请求，保留目标顺序、精确身份、原样游标及超时。该命令只生成源码。将解码后的源码原样粘入一个 `functions.exec` 调用，无需重抄参数。不带此选项时，计划输出结构不变；可把已获批次整体交给同一个已核验模板，无须再运行计划。源不可用或没有所选批次时保留账本结果。
- `functions.exec` 里没有 Node 文件访问，也未验证按路径加载脚本的宿主接口；完整源码仍须进入工具调用。缺少执行器或可调用的 wait 时，记录能力不可用（模板对缺工具返回 `capability_unavailable`，没有线程结果），继续按账本处理。禁止直接 wait 回退、正文回退、额外轮询。宿主有响应但响应不受支持时，沿用既有有界 unknown 投影。任务状态只取可信账本；输出的提交引用仍只允许已核实账本数据，预填来源默认不提供引用。
- 三个 Python 工具的公开 `reason` schema 来自各自原后台枚举，含触发原因说明和示例。现有合法枚举不变；`progress_summary` 省略时仍是 `manual`，两个 dispatch 工具仍必填。非法枚举值给出 `reason`、合法值及示例，未新增重试或修改历史观测。已知检查点使用实际原因（例如 `before_review` 或 `before_dispatch`），原生结果写入 `result.outcome`。
- 无新 Worker/Liaison 入口、调用、必读文件、回执或参数。Manager 计划继续校验当前绑定 Manager；Worker 提交/阻塞 schema、默认值和请求路径不变。共享 Python 注册文件的变更仅适用于 `progress_summary`；既有 submit/report_blocker 分支不变。角色读取、启动/恢复文件、通知正文、派发权限、CAS、幂等及状态机不改。

## 验证

- `node --experimental-test-isolation=none --test test/supervision-cli.test.mjs test/manager-wait-template.test.mjs test/supervision.test.mjs`：35 通过。新增用例在改动前因选项缺失失败。整段生成源码通过离线替身运行，验证一次 wait、原样游标、正文不外泄、能力不足、账本保留和 Manager 权限。其余覆盖未知响应、身份冲突、完成判定和游标预算。这些用例不是目标宿主集成验证。
- Python stdio 新断言先在改动前复现目录无 `enum`（2 项失败）。候选导入路径通过 `PYTHONPATH=<candidate>/python/src` 验证；使用已有独立测试解释器，未安装依赖。使用 `python.exe -m pytest -q -p no:cacheprovider --basetemp <evidence>/python-green-tmp python/tests/test_dispatch.py python/tests/test_worker_tools_unittest.py python/tests/test_observation_stdio.py python/tests/test_startup_stdio.py`：18 通过（167.20 秒）。真实本地 MCP stdio 验证目录枚举、合法和非法触发值、原默认值和 Worker schema；派发、观测和启动仍通过原有回归。
- `git diff --check` 通过。Git 定向对照显示启动、召回、Worker 运行时、共享交付/通知文档和观测文件无变化。工作区 diff 保留供审查；原始测试日志留在候选外的同名 `-evidence` 目录。
- 默认 shell 的 bundled PowerShell 缺 `pwsh.dll`，普通沙箱 PowerShell 无法读取候选 Python。按本次授权使用原生 Windows PowerShell 路径与审批模式读取明文、执行 Git 和运行测试；未改安全软件、加密、权限或运行配置。

候选收敛了 Manager Skill 入口。范围外的通用 `docs/runtime-usage.md` 仍描述 Agent 执行原生查询及通用注入适配器；它未纳入本次所有权，后续同步时应指向 Manager 的过滤入口。

本次证据仅支持本地候选与离线测试。目标宿主完整链路、实际加载、自然采用和 token/耗时收益均未测。

## Manager 独立审查

- 已检查全部实现差异：等待生成复用原计划、数据按 JSON 编码，不修改目标、游标或等待频率；原生过滤算法保留。能力不足不产生伪造线程状态或原生正文回退。
- 独立 Node 回归：supervision-cli、manager-wait-template、manager-thread-ready-template、supervision 共 47 项通过，0 失败/跳过。
- 独立 Python 回归：test_dispatch、test_worker_tools_unittest 共 14 项通过，使用独立测试目录解释器并显式导入候选。首次运行 8 通过/6 setup error，原因为系统 pytest 临时目录权限；改用本次专属新目录后 14 项全部通过，未改系统权限，失败日志保留。Worker 的扩展观测/启动回归共 18 项通过，与这 14 项有重叠，不累加。
- 相关 5 份已安装文件哈希未变；主线保持 8a5eca8。启动、恢复、Worker 运行时与共享交付文件相对基线未改。仅候选分支保留未提交差异。
- 本次解决入口与参数契约；仍由调用方选择真实 reason，未增加自动语义分类或统一改写 manual。完整脚本仍需进入调用，不能据此保证 Token 降低。目标自报能力、离线替身成功、真实宿主集成和自然采用分别记录。
