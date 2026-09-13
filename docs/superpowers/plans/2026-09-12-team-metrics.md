# Team Metrics Foundation Implementation Plan

> **For agentic workers:** Use subagent-driven-development task-by-task; use test-driven-development and independent review. This request does not include commits, push, installation, live-team collection or configuration changes.

**Goal:** 交付可独立运行的 Team 用量、归因与规则评估基础版。

**Architecture:** 纯 JSONL 解析与账本归一化，纯 Team Metrics 投影与规则评估，薄 CLI 和独立离线导出。业务 state/Registry 只读。

**Tech Stack:** Node.js >=22、ESM、node:test；零新增外部依赖。

## Global Constraints

- 按 `docs/design/team-metrics.md` 的 v1 数据口径实现。
- 不依赖 PDC、Trace/Eval Runtime、新 MCP、Hook、定时器或 LLM Judge。
- 不改业务状态 schema、Registry 或 live dashboard 控制链路。
- 不扫描日志目录、不保存提示/回答/工具正文、不执行 evidenceRef。
- 重复采集幂等，未知不是零，任务归因不冒充因果事实，显式区分 fixture。
- 不提交、推送、安装；不触碰现有 build/。

## Task 1: 内建采集、归因与确定性评估核心

**Files:** Create `src/metrics-usage.mjs`, `src/metrics.mjs`, `test/metrics-usage.test.mjs`, `test/metrics.test.mjs`。

**Interfaces:**

```js
export function parseCodexUsage(text, {hostId, threadId, sourceRef}) {} // {records, diagnostics}
export function mergeUsage(ledger, records, diagnostics = []) {} // normalized new ledger, no mutations
export function validateUsage(ledger) {} // validate and return ledger; no mutations
export function buildMetrics(state, ledger, asOf) {} // JSON-only deterministic report
```

Report includes schemaVersion, rulesVersion, teamId, sourceVersion, asOf, sourceKinds, readOnly, totals, attribution, byRole, byMember, byTask, byOperation, findings, limitations. Each metric is `{known, knownRecords, missingRecords}`; known=null when no known records. All rollups reuse the same normalizer. Task rows include taskId, roundId, status, elapsedMs, submissions, reworkCount, metrics and byRole (`{role, metrics}` rows for task×role). Include sanitized record assignments for evidence drill-down, without full source objects or raw text.

- [x] Write tests for empty/missing and subset arithmetic. Example: input=100,cached=60,output=20,reasoning=5,total=120 gives nonCachedInput=40,net=60,total=120.
- [x] Write tests for duplicate/conflicting IDs, repeated cumulative notices, distinct equal last values, reset, gap, malformed/partial log and identity mismatch; confirm failures before adding implementations.
- [x] Write tests using createState/evolve fixtures for explicit mapping, Worker interval, shared Manager, unknown/historical identity, queues, ambiguity, rules and unchanged inputs.
- [x] Implement the four pure entry points, keeping the two modules focused. Reject invalid structures, unsafe numbers, unknown fields and conflicting mappings with safe errors.
- [x] Run `node --experimental-test-isolation=none --test test/metrics-usage.test.mjs test/metrics.test.mjs`; self-review then independent task review.

## Task 2: CLI、离线报告与使用文档

**Files:** Modify `src/cli.mjs`, `docs/runtime-usage.md`, `README.md`; create `src/metrics-export.mjs`, `test/metrics-cli.test.mjs`, `docs/team-metrics.md`。

**Interfaces:**

```js
export function renderMetrics(report) {} // escaped, standalone HTML string
export async function exportMetrics(report, directory) {} // new dir, report.json + index.html + READY.json last
```

CLI signatures:

```text
metrics-import <ledger.json> <source.json> <new-ledger.json>
metrics <state.json> <ledger.json> [asOf]
metrics-export <state.json> <ledger.json> <new-output-directory> [asOf]
```

source.json is exactly `{path,hostId,threadId,sourceRef}`; source path is resolved relative to descriptor directory. Caller explicitly supplies file; no glob, env-discovery or recursive scan. `metrics-import` validates existing ledger, reads one source, combines via mergeUsage and writes a new nonexisting file exclusively. `metrics` only prints JSON. Both metrics commands use `readRawState` (historical recorded state; no Registry subprocess) and label this source scope. All input validation/rendering must happen before output directory creation.

- [x] Write integration tests for import repeat, bad source/ID, CLI arity, unknown fields, source state bytes unchanged, existing output refusal and READY completeness.
- [x] Implement thin CLI branches using dynamic imports; update help without changing other commands.
- [x] Render an accessible offline report with Chinese labels, asOf/source freshness, fixture banner, metric explanations, shared/unknown counts, role/task tables and rules evidence. Reuse the workbench color tokens; no scripts/CDN/remote assets or live claims.
- [x] Document exact JSON formats, example commands, boundaries and reproducible synthetic sample. Keep actual source file paths out of tracked docs.
- [x] Run focused tests plus existing CLI/dashboard/runtime regressions; do final integration review and record actual results.

## Progress

- Design: approved direction captured; detailed assumptions above.
- Task 1: implemented; 25/25 focused tests and independent spec/quality re-review passed. Empty/partial-counter dedup and ambiguous-history window regressions fixed.
- Task 2: complete; CLI/export/docs. Final combined Metrics tests 36/36 passed; original broader project test/ scope 270 tests passed across sandbox and two approved subprocess-specific retries. Root recursive discovery additionally picks up unrelated existing virtualenv scripts and is not claimed green.
- Integration acceptance: final independent spec/quality/integration PASS after nested renderer validation/escaping and parser coverage-warning fixes. Synthetic end-to-end and 1440/390 px browser checks passed, zero remote requests. No commits, installation or real data collection performed.
- Real-team pilot, existing live dashboard integration, external Runtime integration: not in this delivery.
