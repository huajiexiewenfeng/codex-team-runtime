# Team Metrics 使用说明

Team Metrics 从用户明确指定的单个 Codex JSONL 文件导入已观测 Token 用量，再与一份已记录的 Team state 生成 JSON 或离线 HTML 历史快照。v2 在统计之外保留脱敏活动证据，用于定位高消耗片段。它是确定性、按需、只读的观测面：不刷新 Registry，不连接 live workbench，不扫描目录，不执行 `evidenceRef`，也不保存提示、回答、工具正文或源码。不依赖外部 Trace/Eval Runtime、LLM Judge、Hook 或定时器。

## 三条命令

```text
node src/cli.mjs metrics-import <ledger.json> <source.json> <new-ledger.json>
node src/cli.mjs metrics <state.json> <ledger.json> [asOf]
node src/cli.mjs metrics-export <state.json> <ledger.json> <new-output-directory> [asOf]
```

- `metrics-import` 先严格验证已有账本和来源 descriptor，只读取其中明确命名的一个文件，用稳定记录 ID 合并后独占创建新 v2 账本。重复导入同一来源幂等；相同 ID 的内容冲突、同一来源位置被重写后产生不同记录，都会拒绝。不同 `sourceRef` 之间不自动去重，不要给同一日志随意更换来源名。
- `metrics` 只向标准输出打印 JSON。它通过 `readRawState` 读取文件中的历史业务记录，不调用 Registry 子进程。
- `metrics-export` 独占创建新目录，依次写入 `report.json`、`index.html`，最后写 `READY.json`。已有目录拒绝覆盖；没有 READY 的目录不能当作完整导出。

省略 `asOf` 时使用命令执行时的规范 UTC ISO 时间。显式值必须形如 `2026-09-05T01:00:00.000Z`，且不能早于 state 的 `updatedAt`。

## 精确输入格式

用量账本只接受下列字段；初始账本可以为空：

```json
{
  "schemaVersion": 1,
  "teamId": "example-team",
  "records": [],
  "links": [],
  "diagnostics": []
}
```

完整 record 形状如下。每个用量值只能是非负安全整数或 `null`；`null` 是未知，不是零。

```json
{
  "id": "usage-stable-id",
  "hostId": "example-host",
  "threadId": "example-thread",
  "at": "2026-09-05T00:05:30.000Z",
  "turnId": null,
  "model": null,
  "usage": {
    "input": 10,
    "cachedInput": 4,
    "output": 2,
    "reasoningOutput": 1,
    "total": 12
  },
  "source": { "kind": "codex-log", "ref": "bounded-sample" }
}
```

显式任务关联的精确格式是：

```json
{
  "recordId": "usage-stable-id",
  "roundId": "round-1",
  "taskId": "task-1",
  "memberId": "worker-1",
  "operation": "implementation",
  "evidenceRef": "evidence-index-1"
}
```

`operation` 仅可为 `coordination`、`implementation`、`review`、`rework`、`recovery`、`reporting` 或 `unknown`。`evidenceRef` 只作为不可点击的文本索引显示；程序不会读取或执行其目标。

`source.json` 必须恰好包含四个字段：

```json
{
  "path": "synthetic-usage.jsonl",
  "hostId": "fixture-host",
  "threadId": "fixture-thread",
  "sourceRef": "synthetic-metrics-example"
}
```

`path` 相对 `source.json` 所在目录解析。来源必须是普通文件。v2 使用逐行状态机与有界分块读取，**64 MiB 是单行保护上限，不是整个日志的大小上限**。按打开时文件大小固定读取边界，后来追加的内容留到下次导入；未完成的尾行省略并记录诊断，超长行（包括尾行）明确拒绝，不静默截断。每次仍从头读取这个显式文件，不保存增量 cursor；固定字节边界也不等于对正在原地重写的文件提供事务快照。

## v2 活动账本与向后兼容

初始空账本仍可使用上面的 v1 形状。新导入的 v2 账本增加 `observations`，其余字段不变。旧 record ID 不变，v1 账本仍可直接生成 v1 报告；v2 内没有 observation 的旧记录保留为“活动证据未知”，不能反推日志行或假装观察到零次活动。

每个 observation 对应一个保留的 Token 计数。下面是仅展示形状的合成例子：

```json
{
  "recordId": "usage-stable-id",
  "sourceRef": "bounded-sample",
  "firstLine": 7,
  "usageLine": 12,
  "nativeResponse": {
    "responseId": "resp-example",
    "turnId": "turn-example",
    "line": 10,
    "association": "counter-match"
  },
  "events": [{
    "kind": "context_compaction",
    "line": 8,
    "at": "2026-09-05T00:05:00.000Z",
    "callId": null,
    "tool": null,
    "argumentsHash": null,
    "contentHash": null,
    "bytes": null
  }]
}
```

`kind` 可为 `tool_call`、`tool_result`、`context_compaction` 或 `user_message`。只保留时间、来源行、合法标识、SHA-256 摘要和日志侧 UTF-8 字节数，不保存被摘要的内容。摘要仅支持可见内容的相等比较，不证明版本、执行理由或身份。工具调用与返回按真实 `callId` 对应；无法唯一关联时保留未知。

返回是字符串时，体积为该字符串的 UTF-8 字节；返回是宿主常用的内容块数组时，体积为数组 JSON 序列化后的 UTF-8 字节。后者包含 JSON 结构和可能的图片/引用编码，不能按文本 Token 比例换算。序列化只用于内存中的摘要和计数，不保存原文；其他未识别的返回格式仍为未知。

未完成调用的关联缓存有容量保护。触发保护后，本次解析剩余的返回不再恢复“唯一工具名”关联，但继续保留直接观察到的调用名称、callId、摘要、字节与来源行。未知不会因为旧 ID 被遗忘而重新变成确定关联。

Token 通知有时晚于模型响应及后续工具返回。只有前置原生 `token_usage_record` 与当前线程、已知 turnId 和五项原始计数唯一匹配时，才保留 `nativeResponse`，并以其 `line` 作为活动窗口终点；其后的工具结果留给下一窗口。不匹配或歧义时为 `null`，使用通知行的时间邻近窗口。`counter-match` 不是 Token 级因果证明。原生 usage、turn/thread 累计值不再重复相加；已知可选字段 `cache_write_input_tokens` 校验后不另计一份消耗。

## 可复现的合成样例

在一个新的临时试验目录创建上面的空账本、descriptor，并创建以下 `synthetic-usage.jsonl`。该文件仅含身份与合成计数，不含对话正文：

```jsonl
{"type":"session_meta","payload":{"id":"fixture-thread"}}
{"type":"turn_context","payload":{"turn_id":"fixture-turn","model":"fixture-model"}}
{"timestamp":"2026-09-05T00:05:30.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2,"reasoning_output_tokens":1,"total_tokens":12},"total_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2,"reasoning_output_tokens":1,"total_tokens":12}}}}
```

然后运行：

```text
node src/cli.mjs metrics-import sample/ledger.json sample/source.json sample/ledger-imported.json
node src/cli.mjs metrics sample/state.json sample/ledger-imported.json 2026-09-05T01:00:00.000Z
node src/cli.mjs metrics-export sample/state.json sample/ledger-imported.json sample/metrics-report 2026-09-05T01:00:00.000Z
```

其中 `sample/state.json` 必须是同一 `teamId` 的合法 Team state，且历史轮次成员绑定中的 host/thread 才能支持身份与任务归因。为避免混淆，任何 `fixture` 来源都会在 HTML 顶部显示“模拟数据”横幅。

## 报告读法与边界

`report.json` 与 HTML 使用相同 report。每项指标都包含 `known`、`knownRecords`、`missingRecords`：没有已知记录时显示“未知”；只知道部分记录时显示“已知部分”及缺失条数。`cachedInput` 是 `input` 子集，`reasoningOutput` 是 `output` 子集；`nonCachedInput=input-cachedInput`，`net=nonCachedInput+output`，都不是货币账单。

报告提供团队总量、角色、历史成员身份、任务、任务 × 角色和操作表。它们是同一批记录的不同视角，不能相加。显式关联只表示有记录的映射；唯一 Worker 执行时间窗是推断；未关联的 Manager/Liaison 保留为 shared；歧义保持 unknown。共享与未知用量不会摊到任务。历时包含等待和审查，不是 Agent 活跃计算时间。

页面标注 `sourceVersion`、`asOf`、来源种类与记录态范围，使用嵌入式浅色样式，无脚本、CDN、远程字体或远程资源。宽表位于具名、可键盘聚焦的横向滚动区域，以避免窄屏页面溢出。规则发现是可追溯事实或数据质量提示，不是总体“浪费分数”，也不证明因果、完整真实消耗、交付质量或当前宿主状态。

## 如何定位具体消耗

v2 `report.json` 的外层为 `schemaVersion: 2 / rulesVersion: 1`；新增的 `explanation` 自身为 `schemaVersion: 1`。它包含 `coverage`、四种完整 `rankings`、逐计数 `cards`、`repetitionCandidates`、限制和核查建议。排名里的 `rows` 保留全部已知值，`missingRecords` 单独列出；HTML 可以只展示前几名入口，但完整卡片仍可展开。

每张卡片保留原始时间、turn/model、身份、既有业务归属、各项 Token 值和活动。来源位置分开表达：

| 字段 | 含义 |
| --- | --- |
| `source.firstLine` | 本活动窗口起始物理行 |
| `source.usageLine` / `source.lastLine` | 生成本记录的 Token 通知行 |
| `source.activityLastLine` | 活动窗口终点：匹配的原生响应行，否则为通知行 |

`activity.toolCalls.items` 包含逐项 `{line, tool}`；`activity.toolResults.items` 包含 `{line, bytes, callLine, tool}`。`callLine` 只在同 host/thread/source 的调用与返回唯一对应时保留，它可以位于前一张卡片；未能唯一对应时为 null。结果存在和字节已知是不同证据，只有至少一项字节已知才标记观察到返回体积。旧记录没有 observation 时这些来源行和活动计数为 null，不填零。

工具名称缺失或不合法时保留未知，不应阻断整份报告；已观测到的计数、返回体积和可验证的来源位置仍然保留。未知名称不用于推断重复同一工具，也不能为了显示方便填造工具名。

先选明确授权的任务日志和匹配的历史 state，再导入并打开新的离线报告。默认不会收集其他窗口或子 Agent 的独立日志；没有相应来源的数据不能算作已覆盖的 Team 总成本。当前任务未注册成员时应保留未知身份，不能为了报表而补造 Manager 绑定。

1. 查看覆盖诊断，再对比输入、非缓存输入、输出和 `net` 排行。输入总量大但大部分被缓存，与大量非缓存输入不是同一情况；这些仍不是按价格折算的费用。
2. 展开高消耗记录，核对时间、原生 turn/model、业务归属、来源行及计数构成。排行是入口，完整证据卡保留全部记录；旧历史缺证据与已观察到零活动分开表示。
3. 查看该窗口里的工具调用、返回体积和压缩标记。大返回体积是可检查的输入来源线索，但可能经过宿主截断，不能换算为确定的输入 Token。封装工具（如 `exec`）的代码里提到其他工具，不等于那些子调用实际执行了。
4. 若出现重复候选，核对两次调用的来源位置与比较结果；摘要保留在活动账本，报告不重复输出摘要本身。参数相同但结果改变，不能称为重复同一内容；即使内容相同，也应在原始位置核查代码版本、配置、环境、测试选择和执行理由，再决定是否优化。
5. 实施明确的优化后，用相同范围重新采样并对比质量验收与消耗。报告本身不修改模型、验收要求、派工或记忆策略，也不凭一次高消耗宣称节省率。

证据等级含义：

| 等级 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| `observed` | 直接计数、活动条目、字节、摘要相等和来源位置 | 不代表完整模型输入或业务合理性 |
| `temporal` | 活动与计数处于同一来源窗口，可能有原生响应计数匹配 | 不证明该工具占用多少 Token |
| `candidate` | 有可复查的重复或优化线索 | 不等于无效劳动、浪费或确定根因 |

同一记录可以有多个解释标签；这些标签不是新的用量记录，不能再相加。角色自然召回率、忙碌 Worker 违规率、交付质量评分等仍需对应证据，不能由 Token 计数推导。

更详细的数据口径与规则见 [Team 内建观测设计](design/team-metrics.md) 和 [消耗原因与证据链](design/team-metrics-explain.md)。

## 每日离线观测

每日视图要求显式提供日期范围和数据截止时间，不会自动补当前时间：

```text
node src/cli.mjs metrics-daily state.json ledger.json options.json
node src/cli.mjs metrics-daily-export state.json ledger.json options.json new-daily-report
```

`options.json` 接受 `from`、`to`、`asOf`，以及可省略且当前只能为 `Asia/Shanghai` 的 `timeZone`。还可显式选择 MCP 服务端事件文件：

```json
{
  "from": "2026-09-05",
  "to": "2026-09-11",
  "asOf": "2026-09-11T15:59:59.000Z",
  "mcpObservations": {
    "registryId": "registry-demo",
    "teamId": "demo-team",
    "sourceKind": "fixture",
    "files": ["observations/one.json", "observations/two.json"]
  }
}
```

文件路径只按 `options.json` 所在目录解析；不会扫描目录或展开 glob。`sourceKind` 只能由操作员声明为 `fixture` 或 `mcp-server`。空 `files` 明确表示导入了一个空集合；省略 `mcpObservations` 则保持旧版四字段 view。读取上限为 10000 个普通文件、单文件 65536 字节、合计 67108864 字节，任何描述符、UTF-8、JSON、事件 schema 或 registry/team 范围错误都会使整次导入失败，导出目录不会创建。

JSON 与 HTML 来自同一 `buildDailyView`。导出目录必须不存在，成功后包含 `report.json`、`index.html` 和最后写入的 `READY.json`。页面按北京时间自然日展示逐日趋势，以及每一天的角色、成员和模型明细；没有记录的日期显示未知，不按零填充。输入、缓存输入、输出和总量沿用累计报告口径，缓存输入包含在输入内，推理输出包含在输出内，不能横向相加。

MCP 表只统计 observation 中名称精确匹配的直接 Team Context 调用。封装在 `functions.exec` 等外层工具中的调用可能无法识别，因此“未观测到直接调用”不等于零触发。调用时间为空时单列为“未知时间调用（不计入所选日期）”，与所选日期内的表格和次数分开；有时间时按事件自身的 Asia/Shanghai 日期归档，不使用关联 usage 记录时间猜测。原因、返回结果和后续行为在第一阶段均保持未知或未评估，不能依据 `tool_result` 或 Token 总量推断成功。

`observationCoverage` 是所选日期范围内“用量记录附带观察比例”，不是全团队采集覆盖率或角色召回覆盖率。v1 账本没有 observation，明确标为未采集。事件成员和角色继承关联用量记录的既有归因，并标记 `usage-record-attribution`；这不是对工具事件时刻身份的独立验证。长期角色召回效果的分母、命中和行为证据尚未采集，页面不显示伪造的零或比率。

页面始终标明离线、数据截止时间、统计规则版本和历史 Runtime 版本未知。只要来源含 `fixture`，还会显示“含模拟身份/数据，请勿当作真实团队完整成本”。

日报页面分为“Token 使用量”和“MCP 调用情况”两个语义 Tab。默认选中 Token；可以点击，或在 Tab 上使用左右方向键、Home、End 切换。脚本只包含固定作者代码，不拼接报告字段，不使用 `innerHTML`，也不发起网络请求。若 JavaScript 未运行，两块内容仍按顺序显示，不会永久隐藏。

所有数值表头和数据单元格均右对齐并使用等宽数字。角色、成员、模型三种明细表共享固定列定义；首列允许长名称换行，数值列保持不换行。MCP 工具名和证据位置允许长文本换行；宽表由可聚焦容器横向滚动，页面本身不产生横向溢出。

另已实现默认关闭、按团队显式启用的 [MCP 服务端最小事件采集](mcp-observations.md)，可补足外层封装造成的调用盲区。显式选择的事件会以 `serverMcp.schemaVersion: 1` 接入顶层 `schemaVersion: 2` 日报；按 `eventId` 去重、按完成时刻和北京时间筛选，并为每个日期给出角色、原因和结果的完整枚举计数。服务端事件与原生日志观察是两类独立证据，可能重叠，不能直接相加；`matched` 只说明读取返回角色 capsule，不能推导完整覆盖率、召回有效性或后续行为符合职责。
