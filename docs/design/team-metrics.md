# Team 内建观测与基础评估

状态：基础版已实现，模拟链路、受影响测试与独立审查通过。真实团队数据采样和现有 live dashboard 集成不在本次交付内。

本页保留 v1 基线口径。v2 的流式来源读取、脱敏活动观察和消耗证据卡见 [消耗原因与证据链](team-metrics-explain.md)；当前命令行为以 [使用说明](../team-metrics.md) 为准。受控验证只覆盖用户授权的当前开发任务日志，不等于真实 Team 全员采样。

## 目标与边界

回答团队、角色和业务任务的已观测 Token 消耗、历时、交付与返工情况，并提供可追溯的规则发现。衡量的是相同质量门槛下的交付成本，不是单独压低 Manager 占比。

- 独立、按需、确定性 Node.js 代码；不依赖 PDC、Trace/Eval Runtime、新 MCP、Hook、定时器或 LLM Judge。
- 原团队 state/Registry 是业务权威。观测只读，不能派工、改变成员、验收或自动返工。
- 仅读取用户明确指定的文件，不发现或扫描整个 Codex 目录，不上传。原始提示、回答、思维内容、工具入参和源码不得进入报告。
- 旧业务状态 schema 不变；禁用观测不影响协作。基础版输出 JSON 和离线 HTML 快照，不改现有 live dashboard 的刷新链路。
- 数据版本化、稳定标识、业务计算与存储分开；未来按需增加通用 Runtime 适配，不提前建立插件平台。

## 数据流

显式 Codex JSONL 文件 → 纯解析器 → 用量账本 → Team 状态关联 → Metrics + 规则发现 → JSON / HTML。

既有任务事件继续来自 state.events，不复制成第二套业务状态。用量账本与团队业务文件分开；导出目录必须不存在，READY.json 最后写入。无后台采集；重新导入同一份输入产生相同记录标识，合并相同记录幂等，冲突记录必须报错。

## 用量账本 v1

```json
{
  "schemaVersion": 1,
  "teamId": "example-team",
  "records": [{
    "id": "usage-001", "hostId": "local", "threadId": "example-thread",
    "at": "2026-09-12T01:00:00.000Z", "turnId": null, "model": null,
    "usage": {"input": 100, "cachedInput": 60, "output": 20, "reasoningOutput": 5, "total": 120},
    "source": {"kind": "fixture", "ref": "example-record"}
  }],
  "links": [],
  "diagnostics": []
}
```

所有用量值为非负安全整数或 null，缺失不等于零。cachedInput 是 input 子集，reasoningOutput 是 output 子集，禁止重复相加；total 保留源值，可与 input+output 不同但必须给出诊断。派生 nonCachedInput=input-cachedInput、net=nonCachedInput+output；不是货币账单。聚合每个维度报告已知和、已知记录数、缺失数；没有任何观测时值为 null。

asOf 为规范 UTC ISO，必须不早于 state.updatedAt；晚于 asOf 的用量不进入本次汇总。相同记录的 JSON 键顺序不影响幂等判定。记录级可信度与字段级缺失必须保留，不能以部分已知和值冒充完整总量。

source.kind 仅 fixture 或 codex-log，ref 是不含原文的来源标识。只接受上述白名单字段，不能借由任意 metadata 带入正文。身份是来源关联，不是授权凭证。

## 任务关联与身份

links 是独立、显式输入的关联记录：`{recordId, roundId, taskId, memberId, operation, evidenceRef}`。operation 是 `coordination | implementation | review | rework | recovery | reporting | unknown`。

- 显式关联须匹配真实任务、轮次及该轮次成员快照中的 hostId/threadId；Worker 必须是该任务 Worker。每条用量只能有一个关联，冲突报错。
- 有关联只表示 explicit（有记录的关联），不宣称证明了每个 Token 的因果用途。evidenceRef 是证据索引，不执行、不读取其目标。
- 无显式关联时，只允许对身份匹配、时间落在执行到完成区间的唯一 Worker 任务作 window 推断；边界使用左闭右开，排队不归因，assignedAt=null 不猜测。
- Manager/Liaison 无关联时保留 shared，不能按任务数或时间比例摊给任务。无法根据相关轮次快照唯一确认成员时保留 unknown，不用当前新绑定重写历史。
- 多个候选任务或多重历史身份为 ambiguous/unknown。报告包含分母为“已观测记录”的直接/窗口/共享/未知比例，不声称覆盖全部真实消耗。
- 报告给出按角色、成员、任务、操作的独立汇总；这些是同一批记录的不同视角，禁止相加当作团队总量。
- 每个任务附带角色分解，直接回答“Manager/Worker 在此任务的已关联用量”；共享和未知用量不进入此分解。

## Codex JSONL 适配器

`parseCodexUsage(text, {hostId, threadId, sourceRef})` 返回 `{records, diagnostics}`。threadId 必须与文件 session_meta.id 一致；出现不同身份直接拒绝。仅识别 session_meta、turn_context 的轮次/模型字段及 event_msg/token_count 的用量字段；其他内容丢弃。

- 优先取每条 token_count 的 last_token_usage；绝不把 total_token_usage 每条累计值再求和。
- 相同且具备充分计数依据的累计画像重复通知不重复计数；空画像或缺少关键累计字段不能作为可靠去重键，须保留独立 last 事件并诊断限制。累计回退明确报告 reset，不跨回退计算负增量。
- 累计计数推进与 last_token_usage 不一致时报告 coverage_gap，只保留能够直接观察的 last 值，不把缺口分配给当前任务。
- 缺少 last、格式无效、非完整末行、缺少累计去重依据等须有不含原文的诊断；未知事件不进入账本。
- 稳定记录 ID 包含宿主、线程、来源标识和事件位置/安全用量字段；可重跑合并同一来源。不承诺自动识别不同来源标识下的重叠日志。
- 基础版读取单个明确文件并重算，暂不做持久 cursor；正确性和幂等优先，增量文件尾读留到后续优化。
- CLI 源文件必须是普通文件，单次最多 64 MiB；读取前与实际读取字节都检查上限，超限拒绝而非截断。只在内存中保留原文供解析，不写出到报告。

## 规则评估 v1

输出带规则版本、证据 ID 和 `info | warning` 的 findings，不输出总体“浪费分数”，不调用模型。

1. 用量缺失、字段合计差异、低直接归因覆盖、来源解析缺口：数据质量发现。
2. submitted/reviewing 未收口：截至 asOf 的流程提醒，不代表超时或失职。
3. task 有 rework：返工事实，不推断原因或负面质量结论。
4. 保留 approved/cancelled/open 任务分类；未完成任务消耗不能直接与完成任务相比。历时包括等待，不是 Agent 活跃计算时间。
5. 真实轮次的角色召回率、重复查询判定、忙 Worker 违规等缺少充分数据时标记未评估，不伪造通过。

## 验收

- 同一导入重复合并不增量，相同 ID 不同内容拒绝；两条相同用量但不同真实事件不被误合并。
- 空数据/缺字段显示未知；缓存、推理子集和源总量差异正确处理；整数溢出拒绝。
- 明确关联、唯一 Worker 窗口、Manager 共享、身份漂移、歧义、排队和历史角色有测试。
- 解析器不带出正文，诊断不含原始无效行；源身份不符拒绝。
- JSON/HTML 匹配、HTML 转义、无网络依赖；失败导出没有 READY；不覆盖已有目录。
- 业务状态读取前后字节一致；原运行时及 dashboard 回归通过；真实使用仍需单独授权的受控采样验证。

## 基础版验收记录（2026-09-12）

- 36 项 Metrics 解析、归因、规则、CLI 与离线导出测试通过；公开 renderer 的恶意嵌套输入与来源诊断丢失均有回归覆盖。
- 独立合成端到端检查通过：重复导入幂等、JSON/HTML 一致、业务输入字节不变、独占导出和正文不留存。
- 1440 px / 390 px 浏览器检查通过，无页面级横向溢出，无远程请求。最终修复后生成 HTML 与已检查页面字节一致。
- 广泛回归按项目 test/ 目录核验；默认递归入口会误收集已有 Python 虚拟环境中的脚本，未为此更改无关测试发现配置。沙箱不允许启动子进程的两项测试，获准单独重跑后通过。
- 独立审查的两项 Important 已修复并复审通过；没有据此宣称真实日志覆盖完整、自然角色召回有效或已节省 Token。

## 后续

真实团队限定范围采样；验证数据源覆盖与模型字段；已有 live dashboard 可选展示；有证据的 turn/任务关联与增量导入；按需 Trace/Eval 适配。以上不是基础版已实现功能。
