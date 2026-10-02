# E03 源码实现与验证

日期：2026-10-02。基线：`82bd9107d51b04f51baa84ddd400102422230817`，加两轮已确认设计修订。
本记录前半部描述源码开发及合成测试；2026-10-02 后续已获用户授权本地安装，安装结果见文末。不代表真实原生发送或团队独立验收。

## 实现

- `team_context.notice`：prepare/result；`team_context.notice_status`：只读恢复。只接收身份、团队/任务/提交及 operation/attempt 等业务参数，路径来自可信 Registry/runtime 配置。
- Node 复用现有 notice、审核门禁和恢复状态机。在同一组锁内构造首次 track+claim 并单次原子写盘；首次逻辑版本 +2，其后 claim/observation +1，重放 +0。
- 团队账本 v1 顶层 `e03` 保存完整规范化请求、指纹及 operation 映射。重放不能获得新 hostRequest；result 保留原回执版本。损坏映射/回执拒绝，旧无映射终态不伪造 operation。
- 保持原始 notice 和 hostRequest，unknown 不解锁重发；Worker/Manager 按既有归属补记精确 attempt。
- Python → 固定 Node adapter → 同一解释器的 Registry exporter。Windows Job 管理子进程树；7 秒工作截止、3 秒 exporter、10 秒桥接与额外 3 秒回收预算，锁竞争立即 BUSY。
- Windows 遗留锁按本次 token/nonce/路径/内容确认，通过同一文件句柄校验并删除。未知、替换、旧空锁保留；status 不清锁。写盘开始后的失败保留 mutationUnknown。
- 接收端精确匹配失败输出结构化 NOTICE_MISMATCH，原错误消息、拒绝及非零退出保留。
- 最小 Skill 路由、既有授权范围内的可选观测、MCP 日报及显式通知账本时间线接入。观测不保存正文、prompt 或证据内容。未采集的宿主耗时/匹配次数保持未知。

## 验证命令与结果

环境：Windows，隔离 Python venv，项目声明的 MCP 2.x（本次 2.2.0），使用 Codex bundled Node。
测试临时目录使用规范长路径，以避免原有 Windows 短路径 fixture 比较失败。

```powershell
$env:TEMP = 'E:\ai\skills-upgrade\e03-test-temp'
$env:TMP = $env:TEMP
$env:CODEX_TEAM_CONTEXT_PYTHON = 'E:\ai\skills-upgrade\e03-venv\Scripts\python.exe'
$env:CODEX_TEST_NODE = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:PATH = (Split-Path $env:CODEX_TEST_NODE) + ';' + $env:PATH
& $env:CODEX_TEST_NODE --experimental-test-isolation=none --test
& $env:CODEX_TEAM_CONTEXT_PYTHON -m pytest python/tests -q
& $env:CODEX_TEAM_CONTEXT_PYTHON -m pytest python/tests/test_notice.py -q
```

当前结果：Node 全量 **481/481**；Python 全量 **196/196**，后续桥接补强及新增异常退出用例的 E03 专项 **12/12**。专项用例包含已在全量中跑过的用例，不能相加为总测试数。
冻结旧模块后的 Node E03 专项 **22/22**，原始日志 `E:\ai\skills-upgrade\e03-legacy-compat-tests.log`。
原始日志位于本次开发工作区：`E:\ai\skills-upgrade\e03-node-tests.log`、`e03-python-tests.log`、`e03-python-notice-tests.log`。

| 契约 | 本地证据 |
| --- | --- |
| T1–T3 | 正文/摘要原样往返、真实落盘、首次 +2、result +1、幂等 +0、并发、写失败和落盘后回执丢失 |
| T4 | 身份/归属、baseline 缺失、指定 submission、reviewing 后补记、unknown/拒绝、冷却、三次上限；既有门禁回归保留 |
| T5 | 真实三层调用、坏 JSON/重复键/非法 Unicode/超限、Windows 进程树终止、rename 后超时、已知锁回收/未知锁保留、只读不清锁、异常退出不暴露发送许可 |
| T6 | 真实 MCP stdio 工具发现、参数拒绝、只读注解、无 Registry/business state 修改；无真实宿主发送 |
| T7 | 冻结 82bd910 恢复模块与新 prepare/result/status 交错；旧 claim、新 result、旧 writer 追加后原 result 回执重放、readNoticeEvidence 可读 |
| T8 | 原 operation 精确恢复、概况线索标记、选择器、ID/键顺序/证据字符差异及损坏持久回执拒绝 |
| T9 | 精确 mismatch 与身份失败区分、CLI 结构化输出和非零退出、pendingSubmissions 不改变 unknown、选定原生记录的错误码观测与时间线展示 |

T7 的冻结模块为 `test/fixtures/e03-legacy-recovery-82bd910.txt`，LF 规范化 SHA-256：
`ec9a3bce18d1b03b12935700e2938ae9b58355a02e7d04ca6169688686657e4e`。
测试只重定向相对 import 到当前共享依赖，不替换旧模块的读写逻辑。这证明该基线恢复模块的兼容性，不代表所有历史安装包均兼容；安装版 acc7172 仍需单独预检。

## 安装与试用边界

- 未改当前已安装 runtime、全局 Skill、MCP 配置或任何真实团队 state/ledger；未推送。
- stdio SDK 注解/发现已验证，Codex 宿主实际审批、重连后的发现行为仍需安装阶段实测。
- Windows 的受控进程树/锁回收已测试；POSIX 保守保留无法安全按句柄删除的锁，返回 cleanupStatus=required。没有跨平台自动清锁保证。
- 超时测试覆盖子进程树、归属报告后及模拟原子 rename 后终止；不宣称覆盖所有操作系统崩溃、断电或磁盘故障窗口。
- MCP 2.x 的闭合参数模型使用隔离的 SDK 私有集成点；升级 SDK 必须保留 stdio 契约回归。
- 本轮是当前会话的实现与自测，未建立正式 Worker/Manager 验收流程，不能把自测写成独立验收。
- E03a 真实样本基线和至少三项同类任务观察尚未采集；不报告收益比例，不变更 activeExperiment。安装与有限团队试用仍按设计单独确认。

## 2026-10-02 后续本地安装

用户明确要求“本地安装”。已更新既有 companion、非 editable Python 包及已安装 Skill 的通知路由；依赖版本和 MCP 配置保留。新安装进程发现 read/manage/startup/notice/notice_status 五个工具；使用安装中的解释器、Python 包和 Node companion 执行 E03 专项 **12/12** 通过。Registry、当前登记团队 state/通知账本及 config.toml 的前后 SHA-256 相同。

当前会话原有工具目录仍为三个工具，需要重新连接 MCP 后核实实际加载。未通过真实宿主发送、未建立新团队、未启用 Hook 或定时器，不将本次安装视为已证明效率收益。

备份、文件哈希、安装轮包、验证日志、回退检查与后续任务台账保存在 `E:\ai\skills-upgrade\artifacts\e03-local-install-20261002/`。源码回归中的冻结旧 writer 已与本机安装前版本按 LF 规范化逐字核对一致。
