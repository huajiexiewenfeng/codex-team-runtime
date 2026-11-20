# Watchdog 后台常驻：安装测试与三团队分级

本轮提供独立后台进程，不替换MCP companion、不改全局MCP配置、不设置Windows登录自启。用户已经授权三团队后台巡检；实际manifest安装与启动由父节点审查执行。进程存活、团队enabled、只读巡检、queue能力、运输接受、原生轮次完成、业务处理/验收分别显示。

## 正式命令

```text
node <runtime>/src/cli.mjs watchdog-background-start <production-manifest.json> <absolute-control-root>
node <runtime>/src/cli.mjs watchdog-background-status <absolute-control-root>
node <runtime>/src/cli.mjs watchdog-background-stop <absolute-control-root>
```

start使用直接argv、windowsHide和独立child；不会启动Codex/daemon、加载聊天、steer或resume。控制服务只监听127.0.0.1随机端口，以本地owner nonce/token校验身份。status通过控制端点确认同一进程，不凭PID复用判断。stop通知本服务正常cancel/close，释放其team leases与control lease；不泛杀node，不删除遗留锁。异常进程/不可达控制端点显示unknown并拒绝抢占，需另行核查。stdout.log/stderr.log位于control-root，仅记录团队id/phase/mode/fault/pending等程序元数据，不含正文或reasoning。

服务按团队并发检查，故障退避独立，heartbeat不等待慢团队的1GB校验；一个团队故障不阻止其他团队的程序检查。默认无异常不查宿主/启动模型；程序Token=0不表示未来提醒模型轮次成本为0。

## 正式manifest与能力分级

kind为`watchdog-production-deployment`，schemaVersion=1，teams每项使用明确statePath/teamId/manager/binary/log，另有mode：

- `queue-profile`：必须有profilePath，且固定CLI hash/version与程序计算的精确Manager/log原生queue profile相符；发送前重新核对profile原始receipt/完整证据、实际binary和绑定。旧session_meta版本只是聊天创建声明，不能单独扩allowlist。
- `observe-only`：没有本团队完整queue proof时只读巡检、持久化新pending并显示pendingReason，不发送、不为了接入额外唤醒，不把unknown当不兼容。不会靠同宿主/相似版本猜能力。

manifest可显式指定pythonExecutable，供schema-2既有Registry只读导出使用；仅child参数，安装不改全局配置。模式变化需要显式修改配置并正常stop/start；既有cutover不会重置。

当前准备分级：固件已有精确profile，可配置queue-profile；发版notLoaded、缺本目标proof，一键当前active且缺proof，两者先observe-only。三团队均可真实后台巡检，不等同三队全部可唤醒。后续当确有新任务异常需要提醒，使用已授权的精确baseline/send-once受控诊断补本目标proof，再改mode；不得为了显示fully-enabled无谓唤醒、强行UI加载或跳过证据。

## 持久cutover

正式manifest强制newtasks-only。第一次有效检查在独立`<state>.watchdog/cutover.json`保存明确round/task集合、sourceVersion、事件前缀数量/hash。既有task（含日后rework/resubmit）永不追补；只接收该前缀之后新登记的task。新task可以在旧round内，不能只靠walltime。现有历史任务如将来要纳入，须另行显式scope；本轮不提供自动扩大入口。

baseline跨重启保留，source/version正常增长不重置；事件前缀被删改、team绑定变化、数据倒退或容量异常时故障并停止该团队新提醒，不覆写baseline。只有Watchdog sidecar被写，原state/Registry/notice/inbox不改。明确off优先，off期间不读取业务或初始化cutover；以后开启时才捕获其起始基线，不追补关闭期间历史。enabled不等于进程在线。

## 证据与限制

长期Manager受控probe及同新事项fixture已经按精确原生metadata区分environment注入与user.text；真实队列轮次可以先有final短答而尚未complete，实测约414694ms才结束，不推断原因。1GB前缀hash是显著I/O成本，并非轻量或P1事件订阅；没有新异常时不执行此核验，stop以协作取消退出finally清锁。

production能力入口不执行自动派工/重派/审批/恢复旧任务；Worker启动、恢复、提交无新增调用。ended-without-submit/业务execution与原生turn认证仍unsupported。unknown/重复证据不重试，off不能撤回已排队消息。队列不是exactly-once。

安装采用新内容hash版本bundle并保留上一3c17ab6f88d1版本与两份Skill入口备份，附hash、安装后离线测试与rollback。回退必须先正常停止本后台进程；只回退代码入口，不恢复任何业务台账或cutover/receipt事实。安装准备不等于实际安装或进程已启动，最终状态以父节点执行结果为准。

## 本轮稳定验证与固定能力边界

完整受影响回归101 tests / 101 passed / 0 failed。能力profile只核对当时已确认的固定byte/line边界、完整prefix hash、精确身份与实际queue终止事件；旧probe之后的全部未来历史不再作为其回执反复解析。新增>8MiB未来追加回归：固定能力证据仍有效，演进中的该条receipt仍因自身追加超限而unknown，不截尾、不放宽8MiB。未来重复不否认“过去已观测到结构能力”这一事实，但该具体投递的当前唯一性仍可降unknown。

后台mode=queue-profile表示已注册计算型证据，status另列registered-unchecked/verified/fault；没有新异常时不做耗时gate，不把该状态写成全部已验证在线。其他两队observe-only显示pendingReason，不能称为三队自动提醒全部就绪。

本次前旧Watchdog bundle只安装未运行。代码回退必须先正常stop本服务并确认control lease已释放，再恢复原双Skill入口、保留旧bundle；保留新cutover/receipt/sidecar事实。旧bundle不应直接读新schema并假称“运行已回退”，回退结果monitoringRestored=false。安装脚本不修改原MCP或manager-session Skill。
