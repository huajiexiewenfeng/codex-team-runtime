# MCP Daily Integration Implementation Plan

> For agentic workers: use subagent-driven-development and TDD; preserve the existing uncommitted work. Do not commit, push, install, enable real collection, or scan real session logs.

**Goal:** Import explicitly selected MCP server event files into the existing daily report and show daily counts and per-call evidence in the MCP Tab.

**Architecture:** A bounded explicit-file reader feeds a deterministic event validator/rollup. The daily view gains a versioned server-observation section only when supplied; legacy views and Token data remain unchanged. Server and native-log observations are separate evidence sources, never added together without exact cross-source linkage.

**Tech Stack:** Existing Node >=22, node:test, static authored HTML/JS, no dependencies or Python production changes.

## Global Constraints

- Scope identity by registryId + teamId; mismatch rejects the whole import, not silent filtering. Input teamId must equal daily.teamId; registry is operator-selected, not inferred from the current roster.
- Initial unknown identity/nonallowlist calls were intentionally not collected. No-event days mean no imported observations, not proved zero activity. No recall-coverage ratio or behavioral success inference.
- Reasons remain agent-declared/unknown. matched only means a returned role capsule; metadata is registry-at-call-start, caller-declared identity, not native authentication.
- Preserve Token data, existing unknown-time native section, two Tabs, numeric alignment, no-JS fallback, escaping, and immutable export directories.
- Do not use the browser, localhost, or alternative browser surfaces to work around the prior explicit file-URL policy refusal. Static/DOM tests only; visual verification remains incomplete.

## Task 1: Explicit event import through daily HTML

Ownership: new src/metrics-mcp-events.mjs (validation/dedup/rollup), src/metrics-mcp-input.mjs (bounded selected-file IO), optional src/metrics-mcp-render.mjs (server tables); modify src/metrics-daily-export.mjs and src/cli.mjs, related tests and docs/team-metrics.md/docs/mcp-observations.md only. No old collector, Python, Token rollup, Registry, Skill, installation, or other UI changes.

### Interfaces

```js
// IO only; source paths are resolved relative to options.json's parent.
readMcpObservationManifest(descriptor, baseDirectory)
// => { registryId, teamId, sourceKind, records: [{ event, sourceRefs: [absolutePath] }] }
// Pure. daily is the validated existing daily summary, including its dates.
buildServerMcpReport(input, daily)
validateServerMcpReport(report, daily)
// Existing callers omit the fourth argument and get the exact old view shape.
buildDailyView(state, ledger, options, serverInput = null)
```

CLI retains the existing command arities. Add one optional options.json field:

```json
{
  "from": "2026-09-12", "to": "2026-09-13", "asOf": "2026-09-13T12:00:00.000Z",
  "mcpObservations": {
    "registryId": "registry-demo", "teamId": "demo-team", "sourceKind": "fixture",
    "files": ["observations/one.json", "observations/two.json"]
  }
}
```

CLI strips only mcpObservations before calling old daily options validation. Omitted field is old behavior; supplied null/invalid descriptor is rejected. sourceKind accepts only fixture or mcp-server (operator declaration, not authenticated evidence). No implicit directory scanning or glob expansion. Empty files array is allowed and explicitly produces an empty imported observation set.

### Validation and data contract

Use the exact schemaVersion=1 fields emitted by python/src/codex_team_context/observations.py. Reject extra fields (especially prompt/request/capsule), noncanonical UTC millisecond timestamps, malformed UUID eventId, invalid bounded identifiers, unsafe/noninteger duration or policy revision, unsupported role/status/tool/outcome/reason, invalid reasonSource/runtimeRevisionSource relationships. Safe error codes follow Python's uppercase bounded pattern, nullable only according to the actual outcome. For read: matched/inactive/unmatched/error/unexpected_error; manage/startup: success/error/unexpected_error. Do not equate wall-clock span with monotonic duration or reject solely because wall clock moved backward. runtimeRevision is nullable or the producer's bounded valid operator declaration; all displayed text escaped.

Read only declared regular files. Max 10000 files, each <=65536 bytes, total <=67108864 bytes. Use bounded read rather than unbounded readFile after a stale stat; reject invalid UTF-8/JSON and return no partial report. No filesystem writes in readers. No output directory on validation failure.

Canonical dedup uses eventId within the exact registry/team scope: identical field content (independent of JSON key order) merges sourceRefs sorted/unique; conflicting content rejects before date filtering. Different eventId retries remain separate, even if all other fields match. Validate all input records before filtering. Sort selected events by completedAt then eventId, deterministic regardless of file enumeration.

Enriched top-level view has schemaVersion:2, the four existing fields daily/mcpCalls/observationCoverage/sourceKinds, and serverMcp. Legacy four-field views remain accepted. Existing daily.schemaVersion/rulesVersion and Token data are unchanged. serverMcp is schemaVersion:1, registryId, teamId, sourceKind, events (dedup records), days and coverage:'unverified'. Each day in daily.days has date, observedCalls (number of imported matching completed events), byRole (Manager/Liaison/Worker), byReason (all producer reasons) and byOutcome (all producer outcomes). Use one documented uniform count representation (objects keyed by enums are sufficient). Filter by completedAt <= daily.asOf and localDate(completedAt) within daily.from/to using existing IANA localDate; retain original timestamps in events. Validate rendered/imported report consistency by recomputing derived daily counts rather than trusting edited numbers. Unknown health/recall coverage stays unknown; 0 observedCalls is explicitly an import count, not true calls.

### Rendering

MCP Tab: server-side daily table (date, Manager/Liaison/Worker, total observed, read matched, inactive, unmatched, errors including unexpected), plus per-call table (completion time, member/role, tool, reason with source, outcome/errorCode, duration, evidence). Add expandable metadata for eventId/host/thread/memberStatus/policyRevision/runtimeRevision and its declared source if not all fit. Show original identifiers alongside understandable Chinese labels. Numeric th/td both right aligned, wide tables container-scroll and long values wrap. Use existing style and static tab script, no new network or dynamic-user-script injection.

Label server input as independently imported files, state selected registry/team and sourceKind. If fixture source is present, prominently retain fixture warning even if Token sources are not fixture. Native logs keep a separately labelled table and counts. Explicitly state the two sources may overlap and cannot be summed. No-source legacy view says server observations not imported; empty supplied source says no server events observed in imported files, coverage unverified. No changed Token values. Do not claim full recall effectiveness or auto-refresh.

### TDD / review steps

- [x] RED: tests missing feature through planned interfaces; avoid relying solely on missing-module collection errors, first scaffold minimal exports returning wrong results if necessary.
- [x] Validate/dedup/group: key-order duplicate; duplicate conflict even outside date range; separate retry UUID; wrong registry/team; all result categories; midnight completion; future cutoff; blank dates; readonly inputs; malformed/private extra fields; deterministic ordering; renderer rejects tampered counts.
- [x] IO/CLI: explicit relative file paths, no scan, empty set, UTF-8/JSON/size/count errors, duplicate paths, legacy arities/options, invalid descriptor fails before export, real JSON event shape, preserved old view, no source mutation.
- [x] UI: both source sections distinct, exact labels/counts, fixture warning, missing vs empty source, XSS input never reaches script, Tab/numeric regression.
- [x] GREEN: run affected tests then all test/metrics*.test.mjs once. Use node --experimental-test-isolation=none --test --test-reporter=tap; no dependency installs.
- [x] Independent spec/quality review, fixes and covering tests, then final integration review and new demo snapshot. Leave commit/install to user request.

## Next phase (not this task)

Authorized real-team collection activation and ingestion, independent recall opportunity/behavior evidence, actual price configuration and historical version comparisons. This task does not derive causal effectiveness from call counts.
