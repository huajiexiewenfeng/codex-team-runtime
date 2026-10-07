# Dashboard：显式来源、增量统计与查询

本数据层已接入团队工作台 HTTP/UI（总览、任务进度、指标统计与成员/步骤详情）。旧 `metrics-*`、
`task-timeline`、业务 state、Registry、E03/E04 协议和现有服务保持原合同。
`stats-refresh` 只读取 manifest 明确许可的文件，写独立缓存；不扫描全局会话、
不沿用量记录的 `source.ref` 追溯日志、不启动服务或计时器。

## 命令与版本

### 当前成员来源对账与接入

`stats-source-status <trusted-state.json> <owned-cache> [window-query.json]` 通过当前
Registry/state 投影核对当前成员与批准来源，分别列出配置、实际记录、读取/范围问题。
window-query 只含 preset/from/to，与统计窗口语义一致。无记录不是零，有 MCP 不证明
Token 有记录。已有观测可以同时存在读取异常、授权过期或窗口不足；数值不因此丢掉。
已退出成员不出现在当前对账，旧身份/role epoch的统计仍保留在历史查询中。
核对只证明 member/role/host/thread 元组与当前台账一致，不证明历史 epoch 连续性。
完整覆盖始终未证明；coverageAssertions 的原声明也不能替代实际记录。

collector 新刷新保存可选净化 sourceScopes（ID、授权窗、绑定key/范围/identity hash，
无路径），版本/原cache规则保持。旧cache/旧lease缺该字段时显示“配置待核对”，
不借最新manifest覆盖旧snapshot。只有按原批准manifest刷新得到的新快照才具有新配置证据。
Dashboard短标记可展开配置/记录/问题与操作说明，证据ID/时间是次级内容；网页只读。

最小接入流程：

```powershell
node src/cli.mjs stats-source-plan trusted-state.json approved-manifest.json explicit-candidates.json new-plan.json
# 审阅plan中的范围、身份、原manifest hash与完整after描述；原任务授权已明确时无需新增审批仪式。
node src/cli.mjs stats-source-apply trusted-state.json approved-manifest.json new-plan.json
node src/cli.mjs stats-refresh approved-manifest.json owned-cache
```

explicit-candidates.json 示例（替换为用户明确提供且有有效读取授权的精确路径）：

```json
{
  "authorizationRef":"原用户/任务授权证据",
  "candidates":[{
    "mode":"codex-jsonl","path":"明确候选.jsonl","memberId":"当前成员ID",
    "from":"now","authorizedTo":"2026-10-07T00:00:00.000Z"
  }]
}
```

仅有Registry身份不授予读日志权限；authorizationRef只是操作者声明，程序不能认证
外部grant。调用前仍须确认本次用户授权的精确路径/用途/范围。程序只投影最多64KiB
首行session identity，不保留正文，未知/错thread/team拒绝。from=now使用计划校验时刻，
或明确未来UTC，不借当前binding回填历史；新binding是注明依据的operator-scoped epoch，
不是伪称Registry原生revision。历史token元数据即使为counter解析被读取，早于授权窗的
记录也不会贡献或归给当前绑定。source选择默认无任务关联，不按当前owner推断。

已核验的精确来源或TC-root可复用：候选改为
`{"mode":"approved-source","grantManifest":"已获准且经核验的manifest.json","sourceId":"原sourceId"}`。
这个输入必须来自有效既有grant；任意文件内的authorizationRef字符串不是访问证明。
复用保留原描述、binding/历史epoch/授权窗，只检查确切文件/目录元数据，不枚举未知根，
不沿source.ref找日志。没有新成员日志的明确路径时，报告缺口给所有者，不能猜测/全局扫描。

source ID和物理路径对账；大小写/正常Windows路径别名规范化，符号链接/junction拒绝，
硬链接/同物理文件不添加第二源。同源重复from=now请求只在完整描述（包括绑定、原范围、
截止、证据）仍一致时保留原起点/epoch no-op；改变截止/绑定/证据明确冲突，不暗中扩权。
复用原plan也幂等；plan锚定state/Registry版本和manifest内容hash。apply使用协作文件锁、
重新校验和临提交核对，stale/并发busy明确失败。所有manifest写者应遵守同一锁；这不是
宿主ACL，也不能保证不合作外部写者的极小竞态。历史来源只追加保留，scope变更由所有者
另行核验完整授权描述，本最小接入器不会自动续期或覆盖原grant。

已批准源的append/同路径轮转继续由collector处理；旧代替换与last-good诊断保留原规则。
自动刷新不是发现新源：新路径仍要显式候选plan/apply。源读取失败与成功读取但无记录分开。

```powershell
node src/cli.mjs stats-refresh verified-sources.json stats-cache
node src/cli.mjs stats-query stats-cache query.json
node src/cli.mjs stats-activity verified-sources.json activity-source begin.json
```

来源合同 `dashboard-sources/v1`，缓存 schema 1，净化规则 `dashboard-stats-v3`，collector `bounded-metadata-v3`，
查询 envelope schema 2。`stats-refresh` 返回 `phase=initial-backfill|incremental`、
各 source 水位、代数和 `readEvidence`。第二次读取不变的文件，raw `readBytes=0`；
JSONL 的少量边界校验单列 `anchorBytes`，不冒充零磁盘 IO。

v2 修正完成日期计数与 native completion 判定。v1 index、冻结 lease 和直接 data 读取
均返回 `stats_cache_version_mismatch`；refresh 不重写旧缓存或沿用旧偏移。
迁移使用同一获准 manifest，在新的独立 cache 目录执行显式 refresh，再建立查询快照。
旧缓存保留用于对账；重新采集仍受原路径/时间窗与逐 pass 预算限制。

## 封闭来源清单

所有字段均必需；未知字段拒绝，adapterVersion 目前只接受 `v1`。
相对路径仅以 manifest 所在目录解析，sourceId 和精确路径不得重复。
缓存与任何输入不得互为祖先，缓存不得覆盖 manifest。

```json
{
  "schemaVersion": "dashboard-sources/v1",
  "teamId": "my-team",
  "registryId": "my-registry",
  "revision": 1,
  "authorizationRef": "verified-human-and-Manager-grant",
  "sources": [{
    "sourceId": "worker-log", "kind": "codex-jsonl",
    "path": "E:/approved/exact-log.jsonl", "adapterVersion": "v1",
    "mutationPolicy": "append-only",
    "authorizedFrom": "2026-10-01T16:00:00.000Z",
    "authorizedTo": "2026-10-05T06:00:00.000Z",
    "coverageAssertions": {"status": "partial", "evidenceRef": "verified-coverage"},
    "evidenceRef": "verified-source-identity",
    "bindings": [{
      "memberId": "worker-1", "bindingRevision": 1,
      "hostId": "local", "threadId": "verified-own-thread",
      "role": "Worker", "roleEpoch": "worker-epoch-1",
      "from": "2026-10-01T16:00:00.000Z", "to": "2026-10-05T06:00:00.000Z",
      "evidenceRef": "verified-historical-binding"
    }],
    "selection": {"taskId": null, "roundId": null, "turnIds": [], "itemIds": []}
  }]
}
```

binding 时间窗为 `[from,to)`；名字不参与关联。key 是 team/member/bindingRevision/
host/thread/roleEpoch 的哈希。重叠或缺失 epoch 明确保留为未归属，绝不用当前名单补齐。
legacy 绑定没有原生 revision 时，operator 必须在证据中说明这是指定范围的外部 epoch，
不能声称它是 Registry 原生修订。`selection.taskId/roundId` 同时填或同时为 null；
task 关联仅由显式事件或选定的 turn/item 得到，不做时间相近推断。

| kind | 来源与处理 |
| --- | --- |
| codex-jsonl | 复用 usage counter parser；session identity、累计计数、turn/model、未闭合 call 和显式 continuation 元数据可恢复。response 不自动证明执行完成。 |
| activity-jsonl | 独立封闭声明协议；每 source 绑定一个显式 task/round。 |
| team-context-event | 单个明确批准的原生 server observation 文件；复用现有闭合 MCP event 验证。 |
| team-context-root | 经批准的特定 observation 根目录；仅按授权 UTC 日期访问子目录，UUID 文件名和 realpath/symlink 校验。未批准整个目录时必须用逐文件 source。 |
| recorded-state | 复用只读 state timeline 验证，当前列表是 recorded snapshot，stage 不分配给成员。 |
| usage-ledger | 复用 v1/v2 ledger 验证；仅读用量与 link 元数据，不追踪 raw source refs。 |
| metrics-daily-report | 保留原 asOf/日期及净化聚合；历史报告作为独立系列，不能叠加到原生用量。server 区间为 team-context-report 系列。 |
| native-items | 复用明确选中的 native turn/item adapter，durationMs 作为 reportedDurationMs；缺绝对边界不能进入活动并集。 |

JSON 文档 source 最大 8MiB；更大的输入需要显式分片为已验证文件，而不是无限 JSON.parse。
JSONL 每行最大 64MiB，metadata 最多 64KiB、深度 128。流式 grammar 跳过正文，
只从参数/输出提取下面列出的有限 host 元数据，仍校验转义、数字、重复键和 UTF-8；不保留大字符串。元数据在完整换行后
才提交，EOF 未闭合行不计数。单个团队最多保留一个长行解析上下文。

## 增量、恢复与完整性边界

每 pass 默认最多 8MiB、单块 256KiB、墙时目标 1.5 秒；在读取块之间异步让出事件循环。
状态/查询消费净化缓存，不重读 raw sources。同步处理一个已读 metadata/document 的
验证与原子提交可能使 pass 略超墙时目标；字节和输入大小是硬上限。请求结束后不后台续跑。
1000 source、4096 open calls、8192 sidecar phase 身份、每 source 1MiB checkpoint/catalog、
总 disk cache 512MiB，超限明确停止或返回诊断，不静默丢数据。

首次补采与后续 append 分开。checkpoint 包含文件身份、source 描述指纹、代数、完整换行
committedOffset、扫描水位、边界 hashes 和净化 parser state。partial line 的 tokenizer/decoder
只在进程内；连续 pass 从 volatile offset 继续。重启只重读未提交行的前缀一次，然后继续；
持续重启不保证完成。cache 数据块 fsync 后由原子 index 同时发布数据引用和偏移。
提交前 crash 的孤儿块没有贡献；下一 pass 从原 committedOffset 恢复，幂等去重。
专用 refresh lock 含 PID/token；仅在该本机进程确定不存在时恢复遗留锁，PID 重用/不明锁
保持 busy，需要 operator 对账。该逻辑不处理业务或 MCP 锁。

append-only 依赖 operator 的追加声明与 head/tail 校验，不能证明中部从未改写。
默认每十分钟的**下一次请求**触发有界全前缀重验；mutable 每次成功后触发预算化重验。
size 回退、file identity/边界变化或同大小 mtime 变化建立新代；旧贡献保留为 stale，
新代完整后原子替换，不把两代相加。无法证明连续性保留 missing-range 诊断。
修改 descriptor（如 evidenceRef）是 source_line_limit 的显式重验入口；失败行持续暂停，
同一错误后的 poll 不反复读取。缺失/坏行/冲突保留最近可用数据和可定位偏移。

immutable root 每次仅有界枚举授权日期目录，已知文件 stat/signature 匹配则不读取正文；
每 pass 最多 256 新文件、10000 entries。目录顺序不是历史保证，途中新增可能延至下一
完整 pass；目录句柄保留有界扫描位置，重启时从头有界枚举并跳过已知位置，
旧事件内容不重读。immutable 文件内容变化时重新验证，
同 ID 不同净化 metadata 被隔离/诊断，不覆盖旧贡献。跨 source 同 ID 同 metadata 去重；
冲突拒绝 query。无原生稳定 ID 的 counter record 不声称跨代精确去重，新代是替换。

## 查询、分页与时间口径

```json
{"view":"tasks","preset":"7","sort":"updatedAt","direction":"desc","page":1,"pageSize":20}
```

view 支持 tasks/members/steps/coverage/token/mcp/time/days。days 每个北京时间自然日一行；
成员明细通过同窗 members 查询独立分页。可按 taskId、roundId、memberBindingKey、
sourceId、series、assurance、status、search（128字）过滤，sort 为
id/updatedAt/at/durationMs/total/date，direction asc/desc。未知键、未来日期、非法日期、
超过366天 custom、未知 team 内 target 或绑定均拒绝。all 只查询已加载的有限 cache，
不会自动读取其他日期或未授权源；结果有界 10000 行，不是全历史覆盖声明。

rows 仅20/50条，稳定 tie-break=id；单响应最大1MiB。`querySnapshotId` 固定查询、
窗口、source generation 和 immutable refs；page 与 targetId/locate 共用同一 lease。
再次查询时附原 snapshotId 和相同查询筛选；targetId 返回精确 page/indexInPage，
不以 DOM 存在判断定位。未知/不匹配 target 返回 target_not_found，无静默 fallback。
lease 固定120秒，到期 snapshot_expired（HTTP接入层应映射409）；修改筛选必须创建新查询。
最多32个 lease、每个1MiB、总32MiB，请求时按到期/LRU回收，不自动滑动续期。
没有新内容的相同查询复用 lease。HTTP状态码、认证、可见性与刷新调度留给 U2。

window 包含 BJT from/to、UTC startAt/endAt、实际采集 checkedAt cutoff；来源自己的 asOf
单列 coverage。近7天是本地今天和前6个自然日，不补未来。成员并集分别按
sourceKind/assurance 统计，完整区间跨日裁剪、重叠/嵌套/并行合并，不简单相加。
MCP `calls` 和 `completedSteps` 仅按已核验 `completedAt` 落入 `[startAt,endAt)` 计数；
耗时按正长度重叠区间裁剪。例如北京时间午夜前1秒开始、后1秒完成的调用，
前后两天各贡献1000ms，调用仅在后一天计一次。恰好午夜完成也归后一天，
后一天没有正长度活动区间时 union=null；零重叠不产生额外活动。daily/member/summary/MCP行使用同一规则。
成员和 task 交集用显式 binding/task；阶段未记录 owner，始终未归属。
taskDeclaredMs 是声明阶段并集，waitingMs=null；缺端不使用 asOf 补结束，空档不能
直接称等待。native/server/report MCP 分列，允许独立钻取，禁止跨源相加。
无记录返回 null+missing，不宣称已测量0。Token total 保持原生值；cache/reasoning
分别是 input/output 子集。summary 原生总量、成员合计和未归属分别提供 rollup，
保留每字段已知与缺失 record counts。HTTP输出不暴露文件路径、日志正文或凭据。

## Native 完成证据与响应耗时

native 行分别提供 startAt、responseAt、firstYieldAt、completedAt、completionKnown、
status 和 completionEvidence。pending 缺响应；yielded 已有首次响应但执行未完成；
completion-unknown 有输出但完成无法核验。三者 endAt=null，均不进入完成活动并集。
`requestResponseMs/requestResponseUnionMs` 单列首次请求到响应的观测延迟，不能替代执行耗时。
native `calls` 只数已核验完成；requests/responses/completionUnknown 单列，未知完成附 missing。
若当天只有跨日完成调用的前半段，保留耗时但 calls=null 与 no-verified-completions-in-window。

完成判定复用现有 timeline 的有限 native envelope 规则：结构化 JSON 的 chunk_id、
wall_time_seconds、session_id、exit_code；或锚定的 Process running / Process exited
和 Script running / Script completed host 头。只暂存前512字符作判定，不缓存头或输出正文；
多个文本 output block 视为歧义，任意文字、内嵌标记或坏 envelope 都不证明完成。
已知 exit_code 或严格 Script completed 头提供完成证据，yield 头只提供 session/cell handle。
结构化 wall_time_seconds 是 host reportedDurationMs，与绝对时间区间分列。

后续完成关联仅支持 exec_command→write_stdin 的 session_id 与 functions.exec→functions.wait
的 cell_id（含受支持的 functions/tools 前缀）；只提取 session_id/cell_id/terminate，丢弃命令正文。
必须同一来源、host/thread、明确 binding epoch 和显式 task 范围；同 handle 多根、跨 epoch、
未知 handle 或 terminate=true 均不借用完成。关联成功后保留首 response/yield 时间，
以最终完成记录的观测时间闭合原根区间。这是进程/脚本生命周期观测，包含其中等待，不能称 CPU 工作时间。
未响应调用和续跑根有4096上限及1MiB checkpoint限制，重启从已提交元数据恢复。
native-items 保留 hostReportedStatus 和 reportedDurationMs，但无绝对 completedAt；
status=duration-only，不能按 turn start 冒充调用完成日期或进入成员活动并集。

U2 名称显示需携带可核验 roster snapshot 的 name、source/asOf 和绑定关系；不得从当前
名字推定历史 epoch 的名字。本 U1 的普通 binding 行仍以 memberId 标识，待 U2 显式接入。

## 新记录输入：activity-sidecar/v1

```json
{
  "schemaVersion":"activity-sidecar/v1","eventId":"work-span-1","phase":"begin",
  "teamId":"my-team","memberId":"worker-1","hostId":"local","threadId":"verified-own-thread",
  "bindingRevision":1,"role":"Worker","roleEpoch":"worker-epoch-1",
  "taskId":"task-1","roundId":"round-1","stepId":"implementation-1",
  "at":"2026-10-05T05:00:00.000Z","assurance":"worker-declared",
  "sourceKind":"activity-sidecar","evidenceRef":"explicit-authorized-work-span"
}
```

结束使用同 eventId 和关联字段、`phase=end` 与真实记录的结束 at；不自动取现在或
宣称 completed。worker-declared/operator-declared 与 machine-source-reported 分列。
writer 只做声明写入与身份/scope检查，pairingVerified=false；collector 再核对 begin/end。
重复同 ID/phase 同 metadata 幂等，冲突、结束缺开始、跨成员/epoch/task/team 拒绝或
保留 source 诊断。pending begin 的 duration=null。已有 Task stage 与 Team Context
producer 足以提供其自身耗时；没有 native Agent 全时遥测适配器，sidecar不能补造它。

## 验证与实际缺口

持续本地授权、当前登记线程的定向索引、独立 TC 记录权限和正常步骤入口见
[continuous-metrics.md](continuous-metrics.md)。策略期限与快照采集截止时间分开；
撤销/过期保留旧值并阻止新读取，未知/缺端仍保持未知。

`node --test test/stats-u1.test.mjs` 验证大行、尾行、UTF-8/转义/坏 JSON、原子提交恢复、
旋转/截断、跨日并集、binding epoch、冲突、独立MCP来源、分页和固定快照。
真实视频团队核验制品仅覆盖2026-10-02–10-03，报告 asOf 为10-03T15:16:44.952Z，
其声明 state 与近期 state 的独立版本/asOf 分列。真实7天、原生绝对执行边界和完整成员工作时长
仍缺输入，fixture测试不证明这些真实覆盖；后续必须由Manager核验具体raw路径、
历史binding与授权范围，然后显式扩展manifest。U2才能集成正式页面，U3验证现场接入。
