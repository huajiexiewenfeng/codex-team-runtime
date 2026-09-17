# Dashboard operation and ownership

Use for either team Dashboard, its identity, freshness or a stale existing page.
Plain status/history reads do not start a service.

## One team entry, two named tabs

| User-facing name | Intent and evidence | Entry |
| --- | --- | --- |
| 任务进度 (Work tab) | Tasks, stages, members, blockers, submissions, acceptance; team state plus Registry projection | The team's verified `dashboard-serve` entry, default tab |
| 指标统计 (Metrics tab) | Daily Token by role/member and MCP calls/reasons/outcomes; explicit usage ledger and selected observation files | Same entry, Metrics tab; bind a verified same-team `metrics-daily-export` report.json with `--metrics-report` |

Route “工作情况/进度/还有哪些任务/验收” to Work; “Token/成本/MCP/召回/指标统计”
to Metrics. For plain “dashboard/看板”, provide the one verified team entry and explain
its two tabs; do not ask the user to choose between URLs or substitute the latest HTML.
Both views retain their own evidence and freshness, despite sharing one entry.

For each entry use this compact handoff record: **name/type · exact teamId · verified
URL (or unavailable) · work source time · metrics report absolute path (or unbound)
· statistics window/timezone · member/data coverage**. Keep one entry record with
separate Work and Metrics metadata in the existing local working handoff; preserve
the credential/privacy rules below.
Do not invent a URL, persist service credentials in Git, or treat an old handoff link
as proof the service still runs.

A standalone legacy Token audit is labelled “历史 Token 审计（非完整指标看板）”.
It cannot replace the requested Token + MCP view. If a Metrics snapshot is missing,
leave the unified entry available and report Metrics as unbound, never zero. For Metrics generation/import
read `<runtime-root>/docs/team-metrics.md` and its daily-report section; for service
event inputs read `docs/mcp-observations.md`. Import only authorized exact sources.
Verify the current roster and attribution window against report coverage; a historical
three-member report is not automatically whole-team after new Workers join. Missing
MCP input is “未导入/覆盖未知”, not zero calls. A live Work page does not make Metrics
live, and a metrics request does not authorize global log scanning or timers.

For Work service CLI, credentials, Python projection and shutdown details read
`<runtime-root>/docs/live-dashboard.md`.

## Choose the surface

- For the unified workbench, use `node <runtime-root>/src/cli.mjs dashboard-serve <authoritative-state.json> [--port <0..65535>] [--codex-links] [--metrics-report <verified-report.json>]`. Bind only an explicitly verified same-team daily report, not a Token-only HTML. Reuse a verified existing service for the exact same team/state/report when available. Resolve the trusted Runtime and schema-2 Python using the Skill's normal locators; check this installed version actually supports the command. An old companion may still support only static exports; disclose that, do not fabricate a working unified link or install implicitly. Changing the report binding needs a new Dashboard service, not a Codex restart; verify ownership before replacing any process.
- For an explicit offline file, archive or audit snapshot, use `dashboard` (all rounds) or `snapshot` / `render` (one view), always to a new directory. Preserve old exports and their READY manifest; do not overwrite or silently convert old file URLs.
- A request to view the workbench authorizes its local read-only presentation, not new members, messages, business state mutations, public hosting, global installation or Agent timers. Native host and process permissions still apply.

## Maintain records, not hand-written HTML

Manager owns coordination and independently verified review/acceptance events; Workers own authorized task observations/submission evidence and completion notifications. Record actual milestones/blockers/submissions/acceptance through the existing event contracts when they occur, rather than leaving all state in chat. Liaison reads and explains, and may operate the read-only view for the user; it never fills in Manager decisions or invents progress to make the page look fresh. Registry membership writes remain Manager-only.

The deterministic service reads Node state plus current Registry projection. A Registry-only change must not be dismissed because Node's cached version is unchanged. A source/projection error is an error, not permission to use old membership, repair Registry, create a new team or wake a Worker. Sync time, source update time and business observation time are different facts; native execution/Token data remains unknown.

## Lifecycle and handoff

The visible Work tab requests records every five seconds after the preceding request completes. Hidden, paused or closed pages and switching to Metrics stop Work requests. Metrics reads its bound report when selected or explicitly refreshed; it never collects or regenerates statistics. No Agent is polled/woken, no heartbeat/automation is created, and the service does not scan while idle. This browser display loop is not the Skill's Agent timer route. Do not set a 24-hour Agent timer to maintain HTML.

Keep the known process/terminal identity and original full launcher link with its state/runtime mapping in the working handoff, not Git or public artifacts. Use the same running entry; a new process has a new credential. Only stop the verified process that belongs to this view, never another task or all Node processes. Ctrl+C ends the foreground service; a host that cannot keep the process alive must be reported honestly, with static export offered as fallback.

Closed rounds and completed work do not resume agents, exit roles, or cause reports. A page may remain available for reading final records; pause/close it when not needed and stop the local service for long inactivity. No page requests means no background reads and no Agent tokens. Reporting operation ledgers and native automation receipts are separate from this display service.

Show the latest entry, source version/time, and any unavailable integration. Do not claim an old static page is live, a successful fetch proves recent Worker progress, or isolated browser tests have converted the user's real team.
