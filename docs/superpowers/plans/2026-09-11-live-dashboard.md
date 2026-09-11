# Live read-only Dashboard implementation plan

> For agentic workers: execute the approved scope with test-driven implementation, bounded independent review, and fresh verification. Do not change a real team's ledger or start Agent automations.

## Outcome and boundaries

Keep the accepted Dashboard design and immutable `dashboard` exports. Add an explicit, foreground `dashboard-serve <state.json> [--port <0..65535>] [--codex-links]` command. A running loopback service provides one latest-workbench entry; the visible browser requests current records every five seconds. Hidden/closed/paused pages stop polling. No LLM, host task API, fs watcher, cron, or background refresh job is involved.

The Manager maintains business events and membership through the existing authorized workflow; Workers submit progress/evidence; Liaison explains the view and may start this read-only service. Automatic display updates do not manufacture missing progress or native Agent execution status.

## Interfaces and safeguards

- `src/dashboard-live.mjs`: dependency-free HTTP service; fixed `127.0.0.1`, explicit port (default 4319), allowlisted GET routes only. Random per-process capability in launcher URL fragment; API requires Bearer credential, exact Host and same-origin request guards. No CORS, no filesystem routes, no mutation endpoints; restrictive CSP and no-store. Restart produces a new launcher credential.
- Request-time `readState` uses current Registry projection for schema 2. Never silently use stale legacy membership on projection failure. A short successful-read cache/single-flight bounds concurrent projection work; no idle reads. Node version and Registry revision both affect the view identity. Independent observation freshness stays visible.
- `src/dashboard-client.mjs`: same-origin fetch, no overlapping requests, request timeout, backoff, visibility/pause/page lifecycle cancellation, failure retains last successful view. Preserve filters, open details, focus and reading position; defer replacement during text selection. One meaningful atomic status announcement, no focus stealing.
- `src/render.mjs`: optional live presentation and stable interaction keys, default static output remains script-free. Shared CSS and existing provenance/unknown-cost semantics stay unchanged.
- CLI, `docs/live-dashboard.md`, runtime usage, Dashboard design and the Manager/Liaison Skill explain latest view versus immutable archive, start/stop ownership and limits. No local installation or push in this task.

## Work and verification

- [x] Add failing service/render/client tests and observe RED.
- [x] Implement the service, live shell/client and CLI. Verify auth/routing, state and Registry-only updates, failure retention, no idle reads, browser request lifecycle, safe escaping and static compatibility.
- [x] Document operational ownership and live/archive boundaries; exercise relevant Skill scenario.
- [x] Run an isolated real-browser smoke: updates, pause/resume, details/filter/focus, narrow viewport and unavailable source. Do not use live firmware team data as the fixture.
- [x] Independent implementation/security review; resolve actionable findings and run fresh affected checks. Hand off limitations and commands without claiming a real team's page was converted.

Result: 77 targeted Node checks passed; Skill validation and six independent behavior scenarios passed. Browser evidence and limits are recorded in `docs/dashboard-validation.md`. Review-driven fixes cover non-task reading anchors, double-column priority, browser scroll adjustment, and BFCache pause/auth preservation. No local install, real-team conversion or Git publication in this task.
