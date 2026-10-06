# 单团队 Dashboard v2

Node 24+，无前端依赖。`dashboard-serve` 同时指定三个固定配置项，启用总览、任务、指标三视图：

链接 Registry 的台账仍需原 runtime 的 `CODEX_TEAM_CONTEXT_PYTHON` 配置，指向已安装 runtime 的 Python；缺少配置时当前名单核验失败，不能用历史 roster 冒充当前。

```powershell
node src/cli.mjs dashboard-serve <state.json> --team <team-id> --source-manifest <verified-manifest.json> --stats-cache <dedicated-cache-directory> --port 0
```

启动器输出带临时凭据的本机完整链接。页面把凭据保存在当前浏览器会话，立即从 URL 移除；公开 URL query 只保存视图、统计窗、分页、搜索、排序和任务/日期/成员选择。不要把完整启动链接保存到交付制品。三个配置项必须一起提供；HTTP 不接受路径、其他团队、运行时、预算或采集范围参数。保留原有 `/api/view`、`/api/metrics`、`/api/timeline` v1 合同；未配置 v2 时继续原页面行为。旧日报、timeline 启动选项继续只读，并不自动成为 v2 来源。

v2 数据来源使用 [dashboard-stats.md](dashboard-stats.md) 的 `dashboard-sources/v1`，仅收集启动器明确绑定并核验的来源。首轮和后续补采都由请求驱动，采用 U1 字节、墙时、行长、身份、缓存和完成证据限制。无页面请求时没有后台采集。已发出的单次有界采集可能在页面取消之后完成；取消会阻止迟到响应回写页面。

页面可见时，状态每次请求完成后 5 秒核对一次，统计每次完成后 30 秒请求一次。窗口隐藏、暂停、pagehide 会中止在途请求并作废旧 generation；恢复重新读取。暂停期间允许手动刷新。401 停止两条自动通道，提示重新打开启动器完整链接。失败保留最近成功视图并显示陈旧说明。

## API

所有接口为经过 bearer 认证的只读 GET，响应≤1 MiB，任务、成员、步骤分页只支持 20/50。重复/未知字段、非法枚举、无关端点字段和不合法组合返回 400。固定团队不匹配返回 403；未知目标 404；快照过期/逐出 409；预算不足 429；来源失败 503。响应没有来源路径、参数、输出正文或凭据；证据引用转换为 opaque evidenceId。

| 接口 | 用途 |
|---|---|
| `/api/v2/snapshot?refresh=stats` | 单 flight 有界增量读取，冻结来源 baseSnapshotId |
| `/api/v2/overview?mode=current` | 核验当前在册名单、人数和业务状态，独立于统计窗 |
| `/api/v2/overview` | 固定来源窗汇总、分页历史绑定、最近验收 |
| `/api/v2/tasks` | 当前台账搜索、成员/轮次/状态筛选、稳定排序、分页 |
| `/api/v2/task?taskId=...` | 里程碑、负责成员、明确关联贡献摘要、验收状态、独立分页声明阶段 |
| `/api/v2/metrics?dimension=time\|token\|mcp` | 默认耗时任务表或 Token/MCP 每日一行团队表 |
| `/api/v2/timeline?taskId=...&view=members\|steps\|time` | 明确任务的成员泳道与步骤 |
| `/api/v2/locate?targetKind=task\|step\|member&targetId=...` | 同过滤、排序、来源快照定位精确页；调用明细定位使用 view=calls |
| `/api/v2/coverage` | 来源净化元数据分页 |

查询支持 `preset=today|7|30|all|custom`，自定义窗必须同时提供 from/to，北京自然日截至冻结来源 cutoff。统计维度和 view 使用闭合枚举；具体排序、过滤值以服务端校验为准。任务列表不接受统计窗字段，其范围是当前台账。成员过滤包含负责成员以及固定来源中有明确任务关联、有效绑定的贡献成员；阶段 actor 不参与归属推断。

`baseSnapshotId` 固定来源索引和当前台账投影，`querySnapshotId` 固定具体窗、筛选、排序、每页数。页码与 locate 不改变 query snapshot。跨日表→成员→调用使用同 base，child 的 parentSnapshotId 校验窗口只能收窄并保留父身份/来源等过滤；不能用 all/默认窗偷偷扩大 custom 日期。不同 view 可以创建新 query lease，但不能改用 latest。120 秒到期固定，不因请求延长；过期/逐出显式 409，用户刷新后重新绑定。

Dashboard 的 base/任务 lease 合计最多 32 个、32 MiB，单冻结投影编码≤1 MiB。U3 将内部阶段存为紧凑元组，再用无损 deflate 保存净化投影；按请求解码上限32 MiB，只有返回页展开阶段字段，不删任务或历史。准入在创建磁盘 base 前完成，避免失败留下孤立 lease。U1 磁盘统计 lease 仍最多 32 个，引用不可变净化 chunks，缓存总上限 512 MiB。冻结统计结果另有16项/16 MiB进程缓存，仍先检查原磁盘 lease、版本、查询与到期，不滑动续期。回收由请求触发，空闲不启动计时器。两层任一引用失效都会返回 409。详情打开时自动采集的新 base 暂存，当前详情保持原来源；关闭或显式“刷新详情”才采用新来源。刷新保留目标、筛选、页码和阅读位置；总数下降时页码夹紧。

## 口径与交互

当前人数来自核验 roster，不按历史 binding epochs 计人。名称携带来源、版本与 asOf，仅用 memberId / binding key 连接数据。历史多个绑定分列，不用当前角色重写历史。Token 原生 total 与成员/未归属分别显示，cached input 和 reasoning 是子集；MCP native、Team Context 服务事件和旧报告副本独立。

完成区间、请求响应延迟、首次 yield、完成未知、host duration-only、worker/operator 声明 sidecar 分开。阶段没有 owner 时保持未归属；开放阶段的到 asOf 值只标“进行中声明估算”，不是成员观测工作时长。空档不推断等待，缺端与未采集不显示零。无日报也能读取耗时。

单个原生 dialog 支持 Esc、关闭、返回、焦点循环与关闭后恢复焦点。日期明细可切 Token/MCP，成员名可查看任务与指标；长姓名完整换行。表格沿用已选 12px 字号及 13px/16px 单元格间距，窄屏在表格/弹窗内部滚动。文本选区期间延迟替换，结束选择后应用最新 HTML；刷新保持局部滚动、阅读锚点、焦点和过滤控件。

全局成员及日期成员的步骤查询使用 `/api/v2/metrics?dimension=time&view=steps`，带 memberId、memberBindingKey、parentSnapshotId、baseSnapshotId 及冻结窗口；只有明确选了任务的步骤才使用必须带 taskId 的 timeline。成员名称搜索的跨视图钻取先验证所选 binding 实际属于父结果，不把成员名称误当步骤文本过滤，不改用其他成员/任务。

嵌套请求在完整渲染成功之前是暂定导航。读取期间父内容保留并暂时禁用，返回仍可用；400/404/409 会恢复父标题、来源快照、表格、控件和阅读位置，显示错误并提供“重试目标详情”。重试沿用原目标与来源，过期时需用户显式刷新后重新选择。返回已读父页使用其缓存展示，保留原来源，不因过期自动换 latest。没有成功父视图的首个详情失败则显示明确错误、重试/刷新/关闭，不留下永久加载占位。

`src/dashboard-fixture.mjs` 是显式合成验收生成器，仅写调用者指定的新目录，默认 56 任务、11 成员、每任务 60 步，绝不读取生产来源。生产覆盖和合成容量必须分别报告。U2 验证三视图与 56/11 交互；更广泛的 1000 任务、并发/长运行性能验收由 U3 独立 gate 承担。
