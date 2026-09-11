# 既有团队迁入 Registry

接入代码已完成隔离集成测试及独立复审，见[验证记录](team-registry-cutover-validation.md)。
真实迁入仍须用户授权、原 Manager 执行，并先核对本地服务实际加载的版本。

## 谁执行、迁移什么

用户明确授权后，由**原 Manager 在自己的任务上下文**执行。开发此 Skill 的
任务、Liaison 和 Worker 都不冒填 Manager 身份。先核对原 runtime、原状态文件、
当前版本与完整正式成员表；旧文档或线程标题不能覆盖最新状态。

迁入保留 team/member/thread/task ID、成员生命周期、配对与解除配对记录、所有
轮次和任务、提交/验收证据、队列、计时和汇报偏好。Node 管业务历史，Registry
成为当前成员身份的唯一来源。Node 当前成员字段只是经检查的缓存；历史轮次
保留当时的成员绑定，不随 Registry 更新而改写。

历史协作者不等于正式成员。未登记的旧任务先保留为待核对事实，不编造成员 ID、
旧轮次、Worker 提交或 Manager 验收来填满台账。新成员的正式登记另行走正常
授权和 onboarding；停止开发的旧任务也不因迁入恢复。

## 依赖与版本

使用同版本的可信 Node 接入代码和 Python 包。开发可用 checkout；长期安装应将
companion 代码置于稳定版本目录，避免依赖可清理的 worktree。代码包保留 package.json、
src、skills/manager-session 与 docs 布局，不复制 Registry、state 或 reporting ledger。
Python 使用该版本的独立非 editable 环境。MCP 启动配置：

```text
<installed-python> -I -X utf8 -m codex_team_context.server serve --registry <registry.json> --node-executable <absolute-node-executable> --runtime-root <trusted-runtime-root>
```

执行路径属于服务操作员配置，不接受通过 `manage` 请求传入任意可执行程序。
未连接的 Registry schema 2 继续支持独立登记；首次成功迁入显式升级 Registry
到 schema 3，Node 状态升到 schema 2。旧服务/旧 Node 不能写这些新格式。
仅安装新文件不证明已运行的 MCP 进程加载了它；核对服务，必要时重启 Codex。
不要重新初始化现有 Registry，也不要恢复整份旧 Codex 配置覆盖其他设置。

## 迁入前核对

- 原 state 必须通过 Node 校验；Manager active/bound 且与当前已核对身份一致。
- 所有待导入成员均有正式 bound 身份；完整 `state.members` 原样保留，含 exited。
- 已有 Liaison 具有与当前绑定一致的、已确认的双向邀请；保留其本人同意依据。
- 使用原文件字节的 SHA-256 和实际 `state.version`，不对格式化后的 JSON 算哈希。
- 核对 Registry 中没有冲突 team/member/host-thread；遇到冲突不悄悄改名或换 ID。
- 状态与 Registry 必须是不同的可信本地文件；不通过别名绕过共同锁。
- 核对未收口工作及原生任务是否有台账之外的用户工作；迁入不等于允许新派工。

有开放任务本身不禁止迁入，但迁入不停止原生计算，也不向 Worker 插入消息。
prepared 阶段会阻止本地业务读写，因此实际迁入应在协调好的短暂写入交接点进行。
迁入后的 active 成员先为 pending；原任务的后续角色操作仍需先完成本人 onboarding。

## 唯一迁入操作

通过 `team_context.manage` 调用 `adopt_legacy`。外层 actor 是已核对的当前 Manager。
以下是请求字段说明，不是可照抄的真实授权或成员资料：

| 字段 | 值的来源 |
| --- | --- |
| action | `adopt_legacy` |
| operation_id | 此次迁移唯一稳定 ID；不确定重试仍用原 ID |
| team_id / team_name | 原 `state.team.id` / `state.team.name` |
| member_id | 原 Manager 的稳定成员 ID |
| state_path | 原状态的绝对、规范路径 |
| expected_state_version | 当前原状态版本，整数 |
| expected_state_sha256 | 原文件字节 SHA-256，小写 64 位十六进制 |
| members | 完整原 `state.members` 数组，不重建或筛掉退出成员 |
| authorization_ref | 本次用户迁入授权的可核对引用 |
| consent_ref | 原 Liaison 本人确认、且仍有效的配对依据 |

服务会在写入前核对实际文件与请求。引用字符串不是身份认证或权限凭据。
迁移 ID 将出现在备份文件名中：字母数字开头，其余仅字母数字、下划线、点和
短横线，最多 128 字符，不含冒号；此限制不改变既有成员或其他操作的 ID。
已知版本/内容/成员/配对/身份冲突在准备阶段前拒绝，不能仅增加版本号盲重试。

成功回执包含 `operationId,teamId,teamRevision,memberId,outcome`，其中 outcome
为 `adopted`。回执不是派工许可，也不证明成员已召回。成功后重新读取原 state
与 Registry，检查链接、成员和业务历史；不要只看到一条工具成功就继续派工。

## 备份、中断与恢复

备份路径为 `<state_path>.<operation_id>.before-registry.json`。先写同目录临时
文件、flush/fsync，再以不可覆盖的原子发布得到完整备份；备份未经核对不设 fence。
之后顺序为：Node prepared → Registry 导入及操作回执原子提交 → Node active。
全程按 Registry → state 的共同文件锁顺序执行。

| 观察到的状态 | 处理 |
| --- | --- |
| 仍是原 schema 1，Registry 无该操作 | 核对原请求与源文件，再重试同一迁移 |
| Node prepared，Registry 尚无该操作 | 从匹配的完整备份核对并继续原迁移，不建第二个团队 |
| Registry 已提交，Node 仍 prepared | 重试完全相同的 actor/request，完成剩余激活 |
| Node 已 active，收到原操作重试回执 | 重新读取当前状态；不回写旧快照、不撤销后续业务 |
| 任一链接、备份、请求或身份不匹配 | 停止受影响动作，保留证据，核对冲突 |

不要在 Registry 提交后用旧备份直接覆盖 Node，否则会恢复第二份可写身份表。
同 ID 改请求会冲突，换 ID 不是恢复办法。直接杀进程可能遗留锁文件；服务不抢锁。
需操作员先确认没有存活写者，明确处理对应锁后，再重试原迁移。恢复流程不是
无人值守自动修复，也不保证断电、网络文件系统或跨主机事务。

## 全员恢复与后续操作

每个正式成员在自己的任务里用已核对的 `hostId + threadId` 读取 `team_context.read`。
检查 own role/member、team、精确 leader、职责及 onboardingReceipt；Manager 读取
一次不代表其他成员已读取。成员在获授权的既有沟通中返回自己的回执，Manager
核对回复来源再 `confirm_ready`。迁入、登记或生成回执都不会发送原生消息。

已链接的 capsule 提供本地主机上的 `runtime.statePath`、`runtime.runtimeRoot`、
`runtime.pythonExecutable` 以及 phase/revision。从可信服务恢复这些定位后，Node
调用的 `CODEX_TEAM_CONTEXT_PYTHON` 指向该安装环境；只配置此次调用，不写全局
prompt、hook 或系统环境。不同主机的路径不能当成本机执行授权。

`executionIntegration: connected` 表示状态已激活并链接，`migration-pending`
表示仍在迁移中。`dispatchAllowed` 保持 false：**一次 context read 不执行派工
检查，也不授予派工许可**。未链接团队为 `not-connected`，不能据 Registry ready
操作 live Node 团队。已链接团队也必须通过 Node readiness、授权、busy/FIFO、
原生 idle 和投递检查；普通 read 或旧操作回执不会绕过它们。

已链接团队不再使用 Node `bindMember/exitMember/registerWorker/attach*` 等旧身份
写入；登记、确认和退出由 Manager 调用 MCP。加入 Worker 不自动加入已有轮次。
需要在某个开放轮次使用新 Worker 时，确认其 ready 后由 Manager 显式提交
`admitRegistryMember` 事件（caller、roundId、memberId），只追加该轮成员快照。
随后再按既有队列和派发流程处理，绝不将已忙碌 Worker 的新任务提前发出去。

Worker 保留原任务 ID，自行持久化 submit，按原 submission-notice 流程通知精确
Manager；Manager 独立审查后 approve/rework。Liaison 继续只读解释，工作关闭后
停止普通进度汇报。完成不退出角色，登记也不启用定时器。

## 隔离验证入口

在可信 checkout 中测试，不把测试请求发往真实 Registry 或原生成员。Windows
下显式枚举项目 Node 测试，避免裸扫描误收 `artifacts` 中虚拟环境的第三方脚本：

```powershell
$cutoverNodeTests = Get-ChildItem -LiteralPath 'test' -Filter '*.test.mjs' -File |
    Sort-Object Name | ForEach-Object { $_.FullName }
node --experimental-test-isolation=none --test $cutoverNodeTests
```

Python 使用安装了本项目测试依赖的隔离环境及新的测试目录：

```powershell
$cutoverPyTemp = Join-Path $PWD ('artifacts/cutover-check-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $cutoverPyTemp) { throw 'Refusing reused test directory' }
& '<test-environment-python>' -m pytest python/tests -q -p no:cacheprovider --basetemp $cutoverPyTemp
```

故障注入、跨进程锁与 SDK 测试只证明相应的确定性边界；不等于实际用户任务已
迁入、原生消息已送达或跨月自然召回已达标。
