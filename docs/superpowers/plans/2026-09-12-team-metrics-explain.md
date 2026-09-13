# Team Metrics Explain Implementation Plan

> **For agentic workers:** Use subagent-driven-development task-by-task, regression-first tests and independent review. No commits, push, installation or live-team operations in this work.

**Goal:** 补齐从高消耗计数到可观察操作和来源证据的原因定位，不缩小用户完整目标。

**Architecture:** 在已有纯解析器上保留安全活动元数据；v2 账本向后兼容；纯原因投影通过原 CLI 与 HTML 输出。三个独立测试/审查单元按顺序集成，不重做状态机。

**Tech Stack:** Node.js >=22, ESM, node:test；零新增外部依赖。

## Global Constraints

- 不接外部 Trace/Eval Runtime、不调用 LLM Judge、不新增 MCP/Hook/定时器，不修改模型、团队权限、派工或验收门禁。
- 不扫描无关任务、不留存参数/命令/Prompt/回答/思维/文件/工具结果原文；只取显式文件。
- 计数事件绝不冒充请求/工具调用数；日志侧字节不冒充模型输入 Token；时间邻近不冒充因果。
- 未知不是零；重复理由未知不判浪费；共享/未知消耗不强行摊入任务。
- 保持 v1 兼容、稳定 record ID、幂等合并、新文件独占写及 READY-last；保留所有无关未提交修改。
- 不提交、推送、安装或操作真实团队；用户已授权仅当前开发任务本地日志的受控验证，不扫描其他任务、不保留正文。

## Task 1: 脱敏活动观察与账本 v2

Files: modify `src/metrics-usage.mjs`; create `src/metrics-observations.mjs`, `test/metrics-observations.test.mjs`; focused existing regression `test/metrics-usage.test.mjs`.

Interfaces:

```js
parseCodexUsage(text, {hostId, threadId, sourceRef}) // existing {records, diagnostics}, unchanged
parseCodexUsageWithObservations(text, options) // {records, diagnostics, observations}
createCodexUsageParser(options, {observations:false} = {}) // {push(line), finish({incompleteFinalLine:false}={})}; bounded raw-memory state machine
mergeUsage(ledger, records, diagnostics = [], observations) // optional 4th argument; explicit observations upgrades to v2
validateUsage(ledger) // strict v1 OR v2
```

Observation exact shape:

```js
{recordId, sourceRef, firstLine, usageLine, nativeResponse, events:[{
  kind, line, at, callId, tool, argumentsHash, contentHash, bytes
}]}
// kind: tool_call | tool_result | context_compaction | user_message
// line/firstLine/usageLine: positive safe integers; firstLine <= line <= usageLine
// at: canonical UTC or null; callId/tool: bounded safe identifier or null
// argumentsHash/contentHash: SHA256 hex or null; bytes: nonnegative safe integer or null
// nativeResponse: null | {responseId, turnId, line, association:'counter-match'}
```

- [x] RED: detailed import missing; assert stable old record IDs, correct source lines, linked call/result metadata, repeated import idempotence, no raw sentinel, v1/v2 compatibility.
- [x] Implement one shared usage parse path capturing line positions only for accepted records, and a focused observation collector. Recognize response_item function_call/custom_tool_call and corresponding outputs, event_msg user_message and actual compaction markers. Do not evaluate wrappers. Duplicate/ambiguous call IDs must not silently bind the wrong tool. Tail/unmatched events never acquire fabricated usage.
- [x] Validate strict whitelists, record references/source refs, integer/range constraints, hashes and conflict merges. Reject different record IDs at the same host/thread/sourceRef/usageLine to avoid counting rewritten source positions twice. Old merge calls preserve existing v2 observations; new optional observations promotes v1 to v2. Hashes are only equality evidence.
- [x] GREEN: `node --experimental-test-isolation=none --test test/metrics-usage.test.mjs test/metrics-observations.test.mjs`; syntax check; independent task review.

Confirmed actual-host extension: match a UNIQUE preceding unmatched root token_usage_record by source thread, compatible known turnId and all five original usage counters. Do not require equal timestamps or add native counters to totals. Use matched native line as consumed activity boundary, leave subsequent tool results pending for next response, and label counter-match. Ambiguous/no match stays null. Test native response -> tool result -> late token_count ordering explicitly.

## Task 2: 确定性原因投影与证据卡

Files: modify `src/metrics.mjs`; create `src/metrics-explain.mjs`, `test/metrics-explain.test.mjs`; existing regression `test/metrics.test.mjs`.

Consumes Task 1 v1/v2 ledger. Produces v2 report only for v2 ledger, with `explanation` containing complete per-record evidence rows and sorted IDs, observed composition summaries, tool-call counts separately, repeated-call/content candidates and limitations. Pure builder consumes precomputed per-record metric values from existing metrics normalizer to avoid divergent arithmetic. Existing v1 report remains valid.

- [x] RED controlled fixtures for distinct rankings by input/net/output, explicit historical task/role association, tool-result byte evidence temporal only, identical arguments+same/different result comparisons, compaction association, missing evidence and no raw text.
- [x] Build all per-record evidence cards with metric values and source location (null when v1-history metadata unavailable). Stable deterministic sorts must include all rows; rendering may show top lists with explicit total counts and full drill-down.
- [x] Observed drivers describe arithmetic (input/cache/noncached/output/reasoning subsets). Nearby tools and compaction are temporal evidence, not exact token causes. Duplicate same arguments alone is a repeated-call candidate; only matching visible result hash may say repeat_same_content. Neither implies waste or unnecessary tests without code/config/reason evidence.
- [x] Preserve explicit/window/shared/unknown business attribution from core, no alternate task inference. Evidence refs and safe recommendations identify what to verify next. Advanced model/input visibility limitations remain explicit.
- [x] GREEN: `node --experimental-test-isolation=none --test test/metrics.test.mjs test/metrics-explain.test.mjs`; syntax check; independent task review.

## Task 3: 原有命令与 HTML 的原因下钻

Files: modify `src/cli.mjs`, `src/metrics-export.mjs`, `test/metrics-cli.test.mjs`, `docs/team-metrics.md`, `docs/runtime-usage.md`, `README.md`; create `src/metrics-input.mjs` and `test/metrics-input.test.mjs`; additional surface test if needed `test/metrics-explain-export.test.mjs`.

- [x] RED: metrics-import writes a new v2 ledger with observations without changing old input; metrics/export support both versions and surface source positions, rankings, candidate labels and limits.
- [x] Import uses the streaming parser; keep exact command signatures, regular-file checks and bounded memory. Current authorized task is ~160 MiB, so replace total-file 64 MiB limit with a 64 MiB per-line guard and fixed opened-file byte boundary. Read in bounded chunks, do not retain all raw text, ignore post-open appended bytes, and report incomplete-tail diagnostics; an oversized line fails before output. Export validator accepts precisely supported report versions/fields and validates all new nested values before creating directory. No executable source/evidence links.
- [x] Render concise cause overview, selectable/linkable in-page high-consumption rows and complete evidence details. Unknown and confidence levels explicit; sourceRef:line is plain text. Reuse existing offline styles, no network/script requirement or external dependency.
- [x] Document exact v2 shapes and safe sample, mixed-history behavior, capability limits and how to use evidence to decide a concrete optimization. Do not claim tokens saved without measurements.
- [x] GREEN: targeted combined metrics + existing export regression (80/80), main end-to-end controlled cases, desktop/mobile browser checks and independent task review.
- [x] Independent final feature integration review and completion audit. Final unknown-tool contract finding fixed, three added regressions and 30 focused checks passed; independent final re-review approved with no open findings. Same sanitized snapshot re-export preserved JSON and browser-verified HTML; no raw-log reread, commit, push or installation.

## Completion audit

Baseline statistics were progress, not the complete goal. Complete only after source→ledger→explanation→HTML evidence proves requirements 1–6 in design. Record unknown host compatibility and real sampling status separately; keep original goal active while material requested behavior lacks evidence.

2026-09-12：六项功能验收均有受控证据；当前宿主实际日志链路、独立任务归因 fixture、严格输入与向后兼容、完整证据下钻和离线浏览器检查通过。完成的是 Team 内部按需观测/基础规则/原因证据版本，不是全 Team 自动采集或逐工具精确因果分析。
