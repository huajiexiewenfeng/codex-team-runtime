# Dashboard operation and ownership

Use for either team Dashboard, its identity, freshness or a stale existing page.
Plain status/history reads do not start a service.

For new-member or missing-metric source questions, use the trusted Runtime's
`docs/dashboard-stats.md` source-status/plan/apply workflow. Reconcile current
Registry/state against approved source configuration, actual observations and
read/window problems independently; MCP does not prove Token input, missing is
not zero. Keep historical epochs separate. No exact user-authorized new path means
report the gap, not a global session scan or a source.ref lookup. Approved-grant
reuse requires the original verified grant, not a string in an arbitrary file.
Refresh only approved sources; explicit new paths use reviewed CAS plans. Dashboard
remains read-only, old cache/leases say configuration unverified until a new
approved refresh, and no scope renewal is implicit in member identity.

## Explicit task and step recording

When authorized step-duration recording is requested, follow
`<runtime-root>/docs/task-attribution.md`. Use the existing explicitly approved
activity source and `stats-activity-begin` / `stats-activity-end` receipt commands;
these record worker/operator-declared activity, separately from machine MCP call
timing. Do not manufacture old begin/end events, use a task owner as a step owner,
or promise automatic tracing of every Agent tool. Missing end remains unknown.

For an authorized formal Worker command step, prefer the documented
`stats-step-run` wrapper: current state/Registry scope + approved source + six-field
step request + new receipt + explicit executable/args. It records a **command-step
declared activity interval**, not complete Agent or pure working time. Preserve
ordinary command authorization; the receipt is no permission to execute again.
Use a distinct receipt per concurrent step or authorized retry. Finished replay
never reruns; prepared/running interruption stays unknown and requires a new
attempt after verifying the old process stopped. Finishing recovery uses its saved
actual exit point, never current recovery time. Do not include approval/offline gaps
or replace recording with extra role-read calls. Follow task-attribution.md for
identity/source changes, failure evidence and manual cross-tool begin/end rules.

Only on an already-needed role-recovery `team_context.read`, and only after tool
discovery advertises it, an explicit known `work_context` may label the team or
task/round/step. This remains caller-declared correlation checked against the
recorded scope, not authentication or work authorization. Do not add a read for
each tool or step to create telemetry; activity begin/end is the actual step path.
No-context read remains valid. Team work stays shared; missing Worker task links
remain unassigned. Keep the active work's original Manager ownership and grants.

The attribution-capable reader supports strict event v1/v2 and stats cache v3.
Use a new owned cache when upgrading; old caches/leases fail explicitly rather
than mixing old projections. Installed Python files do not reload an existing
MCP connection. The connection owner may reconnect when the optional schema is
needed; do not kill other services, restart Codex, or edit Registry/config.

## One team entry, explicitly bound v2 views

For an installed runtime supporting v2, use `dashboard-serve <authoritative-state.json>
--team <verified-team-id> --source-manifest <approved-manifest.json>
--stats-cache <owned-cache-directory> --port 0`. The three binding options belong
together. Verify the manifest's exact same-team sources and scope; a team ID alone
does not bind metrics or authorize scanning raw sessions. Read
`<runtime-root>/docs/dashboard-ui-v2.md` and `docs/dashboard-stats.md` for the v2 contract.

| User-facing view | Intent and evidence |
| --- | --- |
| 团队总览 | Current roster/status separately from selected historical member/window metrics |
| 任务进度 | Search/filter/sort, 20/50 rows, frozen task/stage pagination and acceptance |
| 指标统计：任务耗时 / Token / MCP | Windowed task/day/member/step details, independent source/assurance and coverage |

For a bare “dashboard/看板”, hand off this one verified entry and explain its available
views. Preserve base/query snapshot identity when paging or drilling into a day/member;
refresh starts a new base rather than silently mixing old and new detail. Missing
durations, native MCP, unassigned attribution and sourcesPending stay unknown.
Historical native coverage is not a current complete seven-day claim. Keep stateAsOf
and each statistics sourceAsOf separate in the handoff.

Without explicit v2 source-manifest/cache bindings, preserve the legacy entry below;
do not silently connect an unbound team to global logs or substitute an old HTML file.

## Legacy v1 fallback: two named tabs

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

- For the unified workbench, use the v2 command above when all bindings are verified. Otherwise use the legacy `node <runtime-root>/src/cli.mjs dashboard-serve <authoritative-state.json> [--port <0..65535>] [--codex-links] [--metrics-report <verified-report.json>]`. Bind only an explicitly verified same-team daily report, not a Token-only HTML. Reuse a verified existing service for the exact same team/state/source bindings when available. Resolve the trusted Runtime and schema-2 Python using the Skill's normal locators; check this installed version actually supports the command. An old companion may still support only static exports; disclose that, do not fabricate a working unified link or install implicitly. Changing source bindings needs a new Dashboard service, not a Codex restart; verify ownership before replacing any process.
- For an explicit offline file, archive or audit snapshot, use `dashboard` (all rounds) or `snapshot` / `render` (one view), always to a new directory. Preserve old exports and their READY manifest; do not overwrite or silently convert old file URLs.
- A request to view the workbench authorizes its local read-only presentation, not new members, messages, business state mutations, public hosting, global installation or Agent timers. Native host and process permissions still apply.

## Maintain records, not hand-written HTML

For an explicitly authorized continuous local policy, follow the runtime's
`docs/continuous-metrics.md`. Bind its fixed managed manifest/cache to this same
entry; normal foreground refresh ensures current registered members and honors
the separate permission expiry/revocation. Carry the verified policy and own task
ID in new handoffs and use `stats-managed-step` or real begin/end boundaries for
actual task work. Existing busy members need no interruption or historical
activity backfill. Read policy permission and the independent MCP recorder
allowlist are separate owner grants. Missing records stay unknown.

Manager owns coordination and independently verified review/acceptance events; Workers own authorized task observations/submission evidence and completion notifications. Record actual milestones/blockers/submissions/acceptance through the existing event contracts when they occur, rather than leaving all state in chat. Liaison reads and explains, and may operate the read-only view for the user; it never fills in Manager decisions or invents progress to make the page look fresh. Registry membership writes remain Manager-only.

The deterministic service reads Node state plus current Registry projection. A Registry-only change must not be dismissed because Node's cached version is unchanged. A source/projection error is an error, not permission to use old membership, repair Registry, create a new team or wake a Worker. Sync time, source update time and business observation time are different facts; native execution/Token data remains unknown.

## Lifecycle and handoff

The visible v2 page reads current state every five seconds and requests bounded
incremental statistics from its fixed manifest every thirty seconds; pause/pagehide
stop its loop. Historical/paged details retain their frozen base until refresh.
The hidden/abort contract is covered by product tests, but a host that cannot produce
actual document.hidden must retain that real-browser validation gap.
In legacy v1, the visible Work tab requests records every five seconds after the
preceding request completes; hidden/paused/closed pages or switching to Metrics stop
Work requests. Legacy Metrics reads its bound report on demand and never regenerates
it. Neither mode polls/wakes Agents, creates heartbeat/automation, or scans while
idle. This browser display loop is not the Skill's Agent timer route. Do not set a
24-hour Agent timer to maintain HTML.

Keep the known process/terminal identity and original full launcher link with its state/runtime mapping in the working handoff, not Git or public artifacts. Use the same running entry; a new process has a new credential. Only stop the verified process that belongs to this view, never another task or all Node processes. Ctrl+C ends the foreground service; a host that cannot keep the process alive must be reported honestly, with static export offered as fallback.

Closed rounds and completed work do not resume agents, exit roles, or cause reports. A page may remain available for reading final records; pause/close it when not needed and stop the local service for long inactivity. No page requests means no background reads and no Agent tokens. Reporting operation ledgers and native automation receipts are separate from this display service.

Show the latest entry, source version/time, and any unavailable integration. Do not claim an old static page is live, a successful fetch proves recent Worker progress, or isolated browser tests have converted the user's real team.
