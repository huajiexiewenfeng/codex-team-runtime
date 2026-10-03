# E04 实现与隔离验证

日期：2026-10-03。范围：源码、开发环境和合成 fixture；未部署到当前已安装 Runtime，未修改真实团队数据，未向任何 Worker 发消息。

## 基线与交付

编码前将 E03 独立固定为 `7dd69adbbd91ca43c904f4f5ed4ed338155c14b8`。基线复测 Node 481/481、Python 197/197。
最初一次 Node 480/481 是既有 Windows TEMP 短路径 fixture 比较失败，按 E03 文档使用规范长路径后通过；没有为绕过测试放宽路径校验。

E04 新增：

- `team_context.dispatch` 的 prepare/result/cancel 和只读 dispatch_status；开发版 stdio 共发现 7 个工具。
- brief/完整 operation 内容对象、确定性事件 ID、完整请求指纹、state 唯一提交点；首次 startTask +1，重试 claim +1。
- 晚到 accepted/unknown；policy-denied；显式未送达撤回；矛盾证据持久审计与 Worker 派发 hold。
- 共用 store 的对象完整性检查、Registry/Python 入口验证、旧 API 防绕行、计划与 Dashboard 风险展示。
- `dispatch-freeze` / `dispatch-request` / `dispatch-export`，Skill 路由、脱敏调用观测和使用文档。

仅开发 venv `E:\ai\skills-upgrade\e03-venv` 改为指向当前 checkout 的 editable 安装，未改生产解释器。
已按 E03 安装清单复核 44 个已安装文件，全部与原 after 哈希相符。

## 验证结果

最终 Node 全量 **502/502**，结果见日志 `E:\ai\skills-upgrade\e04-node-full.log`。
Python 全量 **209/209**；E04 专项 **12/12** 包含真实 Node 子进程与 MCP stdio，并包含在全量中，不重复累计。
Python 日志：`E:\ai\skills-upgrade\e04-python-full.log`、`e04-python-dispatch.log`。

| 契约 | 验证内容 |
| --- | --- |
| 首次与幂等 | 只写 startTask、+1；原文保留；结果 +1；完整输入变化冲突；重放不返回 hostRequest |
| 准入与重试 | 明确身份、baseline、native、FIFO、占用、ready；unknown/拒绝不重试；确证非送达后一次 claim |
| 故障提交 | 对象写失败、state 写失败、提交后响应丢失、同 ID 并发；孤立对象不构成提交 |
| 实际进程故障 | Node 在对象完成后或 state 提交后挂起，Python 超时终止进程树；Windows 仅清理归属锁；按原 operation 查询恢复 |
| 晚到回执 | observe/submit/approve/闭轮后 accepted，业务阶段保持；Worker ready 丢失后仍可补记；负面结果不能释放已观察工作 |
| 撤回与冲突 | 缺少明确撤回授权拒绝；拒绝且已证明全部未接收才取消；晚到矛盾回执持久 hold；新启动被阻止 |
| 对象与备份 | 原文大小、引用格式、目录 reparse、缺失/损坏对象拒绝；完整 state+对象导出可离线验证；不覆盖旧导出 |
| 查询与桥接 | 精确选择器、不猜 latest、status 不清锁；参数封闭、显式 null 拒绝、7 工具发现及只读注解；E03 回归 |
| 展示与观测 | 调度计划显示 held；Dashboard 和业务时间线可读；E03 notice 读取同一任务；观测不保留正文/hostRequest |

执行环境与命令：

```powershell
$env:TEMP = 'E:\ai\skills-upgrade\e03-test-temp'
$env:TMP = $env:TEMP
$env:CODEX_TEAM_CONTEXT_PYTHON = 'E:\ai\skills-upgrade\e03-venv\Scripts\python.exe'
$env:CODEX_TEST_NODE = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:PATH = (Split-Path $env:CODEX_TEST_NODE) + ';' + $env:PATH
& $env:CODEX_TEST_NODE --experimental-test-isolation=none --test
& $env:CODEX_TEAM_CONTEXT_PYTHON -m pytest python/tests -q
```

## 旧代码兼容性结论

冻结 E03 commit 中 runtime、delivery-state、worker-revocation 三个模块，测试只改 import 地址，不替换内部逻辑。
LF 规范化哈希已固定在测试中，文件位于 `test/fixtures/e04-legacy-7dd69ad/`。

旧 reader 能读取仅有 E04 startTask 的 schema2 状态；旧 writer 确实可以忽略 E04 对象写入旧式 deliveryCheck。
新版共同入口拒绝该操作。旧 reader 对 policy-denied 和 cancelUndelivered 拒绝。
因此未宣称 schema2 自动兼容，也未把方案 D 的上线门槛省略：正式启用前必须统一升级所有实际写入入口。
当前已安装 E03 保持原状，其团队未产生任何 E04 state，不存在本轮制造的新旧混写。

## 实施边界与后续

- 单对象 1 MiB、正文 64 KiB；读取图最多 8192 个对象、总 canonical 内容 64 MiB，只有 operation→brief 两层依赖，超限显式拒绝。首版无 GC，不以清理历史规避上限。
- 证据是 caller-assessed，Runtime 校验结构、关联和已记录矛盾，不认证宿主是否真实接受或停止。授权撤回不等于撤销已暴露的外部调用能力。
- Windows 进程故障/原子提交边界已测；不承诺掉电、磁盘损坏及所有文件系统的目录持久化语义。未宣称 exactly-once 宿主发送。
- dispatchConflict 没有首版解除入口；保留审计与 Worker hold，解除需要另行评审的恢复协议。
- 回退须停新 prepare、保留 E04-aware 查询/结果/保护；导出不含 Registry，恢复要核对 Registry 路径和身份，不能把副本直接注册为新活动团队。
- 未部署生产安装、未重连当前宿主工具、未采集三项真实同类任务；bodyBytes 中 nativeSend 为计划值，不能当实际 Token 或效率收益。
- 本轮为实现者自测，不称为独立评审或正式团队验收。下一步是代码评审与统一安装预检，再进行有限真实观察。

## 2026-10-03 本地安装更新

以上“未安装”是实现验证完成时的历史状态。本次已将 `a07d754e10fa7ba2bce3f45834672d1960727e23` 的 companion、Python 非 editable 包和 manager-session Skill 统一安装至本机。安装前备份、文件哈希及依赖版本校验完成；安装目录 Node 502/502、Python E03/E04 专项 24/24 通过，新启动 MCP stdio 能发现全部 7 个工具。

当前聊天及已有 MCP 连接仍缓存旧目录，需要在合适的空闲窗口重连并确认两个 dispatch 工具可见。未中断现有团队工作，未进行真实 E04 原生发送，真实收益仍待观察。

安装完成后视频团队通过旧流程推进新任务（state 68→73），只读重建历史的哈希与安装前一致；保留全部并发业务变化。配置并发变更仅涉及 `service_tier`，MCP 配置未变。安装器未写业务状态或配置。完整证据、备份和校验式回退脚本在开发工作区 `E:\ai\skills-upgrade\artifacts\e04-local-install-20261003\README.md`。回退完整性校验已通过；实际回退还要求无在途任务且无 E04 数据。
