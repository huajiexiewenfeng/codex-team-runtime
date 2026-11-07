# 原生 notLoaded 过滤与 Manager 派发前就绪候选

2026-11-06；离线候选，未安装。

原过滤器把 activeFlags 设为所有状态的必填字段，状态枚举也缺少 notLoaded、systemError。基线 f673659 已有这个缺陷；P0 的监督文档拆分没有改变它。原测试把 active 改为 idle 后仍保留 activeFlags，掩盖了真实 idle 形状。候选按状态校验，只在 active 接受协议 flags；notLoaded、systemError 保留原义，既有 ended 仍只是观察。只有身份、游标、状态和轮次均匹配的 idle/completed 观察可以确认原生完成 wake；完成 wake 不代表提交或验收。

协议依据是 [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。真实宿主观察来自同批 Manager 任务卡的已核实原因（本地证据，不入仓库）：现有 navigate_to_codex_page 打开同一 local 会话后，状态从 notLoaded 到 idle，最近轮次 ID 不变，未发送消息或启动模型轮次。这是 Manager 先前的观察；Worker 没有复跑真实会话或调用真实 App Server。候选的导航和复核分支均由 fake tools 验证。

在现有派发前检查点，Manager 对已授权、精确绑定的 FIFO Worker 取一次有界快照。idle 不导航；只有 独立核实过的 local 路由和 notLoaded 才可通过 navigate_to_codex_page 打开原会话一次。此动作可见，会切换最近获得焦点的桌面主窗口。导航成功后只做一次同 hostId/threadId 快照；只接受 idle、最新终态轮次元数据不变（或两次均无轮次）且 revision 未回退。仍未加载、身份不符、快照异常、新轮次或在途轮次等均 hold；无已验证的同宿主能力返回 unsupported，远端不会被 threadId-only 工具打开。

准备模板只输出过滤后的证据，没有发送、模型轮次、Worker 正文或历史读取、台账写入、计时器或循环。它只确认某次观察，不能保证后续仍 idle。任务占用、FIFO、CAS、原有投递 claim 和发送前复核继续生效。Worker 和 Liaison 启动/恢复流程不增加步骤、读取或字段。当前没有独立的官方同宿主 resume 工具；未来可在有受支持工具后适配 thread/resume({threadId,excludeTurns:true})，保留同样的复核。此候选没有私有桥，也不会启动独立 App Server。

离线用例覆盖原生状态、wake、身份与游标、正文过滤、导航次数及禁止调用、异步未就绪、拒绝、系统错误与并发轮次；命令、结果与限制见同批 Worker 交付证据（本地保存，不入仓库）。未验证真实客户端异步加载时延和窗口路由；当路由不能核实、首次快照缺少历史轮次且复核才出现轮次、或复核仍未就绪时，由原准入流程继续保持队列，不在本次检查自动重试。

本次未安装，无运行时回退动作。若以后试用需撤回 UI 路径，在现有派发检查点恢复纯只读等待，遇 notLoaded 保持排队；停止使用 readiness 模板并撤回该入口。保留已修正的等待协议与输入/输出过滤、原准入及既有业务审计记录。

## 安装后回归修复候选

现场脱敏记录显示，`wait_threads` 可为精确匹配的 `idle + interrupted` 轮次返回 `turnCompleted` wake，独立 `read_thread` 确认状态。旧就绪模板只接受 `completed` wake，因此把安全的空闲状态误判为 `contradictory_wake`。旧测试的 `interrupted/failed` 路径没有同时携带合法终止 wake，未覆盖该组合。

就绪模板现在按原生终止语义匹配 `completed`、`interrupted`、`failed`，保留各自原状态和过滤后的错误标记。此处只确认线程空闲，业务完成、验收和任务占用仍由原规则决定；普通等待模板的完成投影语义不变。身份、wake 形状、并发轮次、修订校验及调用次数不变。此次修复仅为候选，使用 fake tools 离线验证；结果和现场复现见同批 回归交付证据（本地保存，不入仓库）。
