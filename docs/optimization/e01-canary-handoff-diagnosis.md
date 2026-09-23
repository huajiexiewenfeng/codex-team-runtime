# E01 合成测试后的交接失败诊断

日期：2026-09-22。状态：**诊断完成，未实施/安装新优化；activeExperiment 仍为 E01**。

## 范围与结论

仅核对原固件升级团队 `e01-synthetic-20260922` 三项已授权微任务的日志窗口、提交/通知记录及实际安装代码。没有唤醒成员、重发消息、修改业务台账或删除 Registry 锁。

这些失败不能统称为“通知没送到”或“安全拒绝”：Worker 的四次命令失败分别是两次通知对象被序列化改写、一次旧版本回执请求、一次文件锁占用。另有一次 Manager 复合命令的最后一步失败，掩盖了前一步关闭轮次成功。

这支持一个共性诊断：**精确协议字段、版本和多步命令由 Agent 临时拼装，会增加出错与恢复往返**。它不证明所有慢任务同因，也不能据此取消身份、授权、版本或去重校验。

## 已核实的原因

| 现象 | 原始证据 | 原因与边界 |
| --- | --- | --- |
| 01 的 notice-plan 匹配失败 | W:8775、8782、8789、8796 | submission-notice 原始 JSON 中 `submittedAt` 为 `.190Z`；PowerShell `ConvertFrom-Json` 自动转为 DateTime，再 `ConvertTo-Json` 成 `.19Z`。瞬时时间相同，但 notice 的严格对象比较不同。改用 Node JSON 原样提取后成功。 |
| 01 的 notice-result 版本冲突 | W:8845；claim 文件；原 state review/approve 事件 | 请求使用 claim 时 `sourceVersion=331`；Manager 已完成 review/approve，Worker 后续读取到 v333。已发送不等于发送时版本仍适用。现有协议允许在验收后补记同一 attempt 的真实结果。 |
| 更新版本后再次匹配失败 | W:8861、8868 | PowerShell 读改回执请求时，又连带重写嵌套 notice 的日期字符串。换回原 notice、使用 v333，保留同一 attempt 后登记成功。不是必须重新发通知。 |
| 03 的 notice-result 出现 EEXIST | W:9030、9046；M:17529；安装版 withStateGuard/withFileLocks | schema-2 操作先获取全局 Registry 锁，再获取 state/sidecar 锁；`open(path,'wx')` 遇占用立即失败，无内部等待。Manager 同时执行接收与验收是强相关线索，但没有锁所有者记录，不能断言具体持锁进程。只读对账后同一 attempt 成功登记，没有重发。 |
| Manager 命令显示 failed，却输出 Applied version 350 | M:17534；state closeRound；W:9046 | 同一 shell 命令先 apply 成功，再 Get-Content 读取尚未生成的 03 回执文件。后一步静默读取失败使整条命令 exit=1；不能据此重放 apply。局部同构命令复现相同退出表现。 |

所有 W/M 行号均对应开发工作区 `artifacts/e01-team-canary-20260922/usage-manifest.json` 中显式授权的 Worker/Manager 日志来源，不是全机扫描。日志原文、对话正文和隐藏推理未复制进本文件。

## 失败到恢复的实际间隔

以下为 UTC、原生工具完成时间之间的墙钟间隔，**不是失败工具运行时间，也不是可承诺节省量**；期间可能包含读取、决策和与 Manager 并行的工作。

| 测试路径 | 首次失败 | 成功恢复 | 间隔 |
| --- | --- | --- | ---: |
| 01 初次 notice-plan 日期问题 | 12:59:10.372 | 12:59:46.816 | 36.444 秒 |
| 01 notice-result 旧版本，随后嵌套日期问题 | 13:02:47.527 | 13:03:50.154 | 62.627 秒 |
| 03 notice-result 锁占用 | 13:13:48.427 | 13:14:23.788 | 35.361 秒 |

不能把这些数直接相加后从用户交付时间扣除；尤其 01 在回执恢复前已经验收通过。

## 最小复现与版本依据

开发工作区：

- 脚本 `artifacts/e01-team-canary-20260922/reproduce-handoff-failures.mjs`。
- 结果 `artifacts/e01-team-canary-20260922/handoff-repro-Wd2FLS/report.json`。
- 原始 notice 对当前已关闭轮次仍通过精确校验，返回 ignore/round-closed。
- PowerShell 7.6.5 将 `.190Z` 转为 `.19Z`；只改这个字段就复现原错误。Node JSON 往返保留原对象。
- 全新本地 fixture 锁被持有时，安装版函数立即 EEXIST；释放后再次获取成功。未操作真实 Registry 锁。
- `成功输出; 读取不存在的文件 -ErrorAction SilentlyContinue` 复现整体 exit=1。

初次运行被沙箱限制子进程启动（EPERM）；获准启动本机 PowerShell 后上述四项断言完成，exit=0。这不是业务 Runtime 故障。

实际安装源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| src/submission-notice.mjs | 972d3c5dcf461e185084055b4c65e638a7b731d613e7c8882b71667ceaefa078 |
| src/submission-recovery.mjs | ec9a3bce18d1b03b12935700e2938ae9b58355a02e7d04ca6169688686657e4e |
| src/registry-projection.mjs | f1daab7ffafd232eb4e0c3de5a0d6040643cec2bedfe81dd2f8237f18e9a794d |

前后两个文件与开发源字节哈希不同，但已核对仅 CRLF/LF 差异；中间文件完全相同。以上机制不是 E01 新加入的行为；E01 仅改变成功通知后的退出措辞。本次不据此判断机制最早在哪次提交引入。

## 下一项候选：E03a 无损传递协议 JSON

从 E03 的高层命令方向中拆出更小的前置候选，**尚未激活**：让确定性 Runtime 提取/保存原 notice，或按原字段生成请求，避免 Agent 通过 PowerShell DateTime 往返重写协议对象。不要在接收端放宽精确匹配，也不要通过重算摘要来接受被改写的数据。

- 单一改动：JSON 交接的无损生成/提取；不合并通知流程、不改变通知次数、模型、验收标准或锁策略。
- 必须保留：原 notificationId、submittedAt、身份、提交摘要及 attempt 关联；原生宿主发送与真实结果证据独立。
- 回归：`.190Z`、`.100Z`、`.000Z`、中文与引号、嵌套 notice；同一输入输出深度相等；被改写的通知仍被现有校验拒绝。
- 观测：每项任务的序列化匹配失败数、参数修正往返次数、提交至通知/回执历时，同时观察 Token 和交付完整性。
- 激活时机：E01 先记录检查点/保留或回退决定，再单独启用。当前可准备局部验证，但不可把混合版本样本算作 E01 单因素结果。
- 回退：只撤销新增交接入口/提示，保留原始提交与通知账本；不迁移或重写历史 notice。

版本冲突后的确定性对账、短暂锁占用的有界等待、复合命令退出码分别保留为独立后续议题。锁等待应区分活锁/残留锁，不能删锁强行继续；结果登记失败更不能触发已成功消息的重发。

## 决策

保持 E01 与现有安装不变，继续收集真实业务可比样本。此次只完成根因诊断、局部复现和下一项候选定义；没有节省率、费用下降或全部流程已修复的结论。

## 后续实施记录（2026-09-22，源码候选）

用户同意继续后，按本节边界实现 E03a；上面的诊断时状态保留，不覆盖历史。

- 活跃范围：`src/cli.mjs` 两个序列化入口、submission notice/recovery 相关测试及使用说明。
- 排除范围：安装目录、成员会话、业务台账、Registry、版本/锁机制、模型、原生发送及 Skill 文案。没有开启第二个实验。
- `submission-notice ... --notice-out <new-notice.json>`：通过原有准备校验后，由 Node 直接保存 notice；原 stdout 完全兼容。
- `notice-request <notice.json> <fields.json> <new-request.json>`：把原 notice 嵌入其他请求字段，拒绝 notice 覆盖及未知顶层字段。仅组装，不替代后续真实校验；不修复已经改写的输入。
- 输出使用现有原子新文件写入，已有文件（包括输入/状态路径）拒绝覆盖。没有自动重试、发送或接受结果。

验证：先新增回归测试，旧代码 17 项通过、5 项因缺失入口失败；实现后 `node test/submission-notice.test.mjs` 22/22，通过尾零时间戳、中文/引号/换行、完整对象与旧 stdout 等价、错误身份、覆盖保护、嵌套字段、额外字段拒绝、变造 notice 仍拒绝。`node test/submission-recovery.test.mjs` 19/19，含新入口贯通 track/claim/result 的本地文件/账本集成，保留原有去重/未知/拒绝/并发边界。

Node v22.17.1 不支持尝试的 `--test-isolation=none`；实际验证改为直接运行上述 `node:test` 文件，退出码均为 0，不把无效参数运行计作通过。

限制：这证明候选入口的 JSON 交接与兼容性，不证明 Agent 会自动选择入口，也不证明真实 Token/历时下降。共享安装未变、未修改 Skill、未提交推送。下一步在 E01 检查点后单独决定是否启用 E03a，并按相同口径采样；实际启用前还需将入口使用方式接入该次受控工作指令。
