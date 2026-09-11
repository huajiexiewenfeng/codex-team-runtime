# Dashboard operation and ownership

Use for a user-requested team HTML workbench, its freshness, or a stale existing page. Plain status/history reads do not start a service. Read `<runtime-root>/docs/live-dashboard.md` for exact CLI, credentials, Python projection and shutdown details.

## Choose the surface

- For the current/automatically updating workbench, use `node <runtime-root>/src/cli.mjs dashboard-serve <authoritative-state.json> [--port <0..65535>] [--codex-links]`. Reuse a verified existing service for the exact same team/state when available. Resolve the trusted Runtime and schema-2 Python using the Skill's normal locators; check this installed version actually supports the command. An old companion may still support only static exports; disclose that, do not fabricate a working live link or install implicitly.
- For an explicit offline file, archive or audit snapshot, use `dashboard` (all rounds) or `snapshot` / `render` (one view), always to a new directory. Preserve old exports and their READY manifest; do not overwrite or silently convert old file URLs.
- A request to view the workbench authorizes its local read-only presentation, not new members, messages, business state mutations, public hosting, global installation or Agent timers. Native host and process permissions still apply.

## Maintain records, not hand-written HTML

Manager owns coordination and independently verified review/acceptance events; Workers own authorized task observations/submission evidence and completion notifications. Record actual milestones/blockers/submissions/acceptance through the existing event contracts when they occur, rather than leaving all state in chat. Liaison reads and explains, and may operate the read-only view for the user; it never fills in Manager decisions or invents progress to make the page look fresh. Registry membership writes remain Manager-only.

The deterministic service reads Node state plus current Registry projection. A Registry-only change must not be dismissed because Node's cached version is unchanged. A source/projection error is an error, not permission to use old membership, repair Registry, create a new team or wake a Worker. Sync time, source update time and business observation time are different facts; native execution/Token data remains unknown.

## Lifecycle and handoff

The visible browser requests records every five seconds after the preceding request completes. Hidden, paused or closed pages stop new requests; no Agent is polled/woken, no heartbeat/automation is created, and the service does not scan while idle. This browser display loop is not the Skill's Agent timer route. Do not set a 24-hour Agent timer to maintain HTML.

Keep the known process/terminal identity and original full launcher link with its state/runtime mapping in the working handoff, not Git or public artifacts. Use the same running entry; a new process has a new credential. Only stop the verified process that belongs to this view, never another task or all Node processes. Ctrl+C ends the foreground service; a host that cannot keep the process alive must be reported honestly, with static export offered as fallback.

Closed rounds and completed work do not resume agents, exit roles, or cause reports. A page may remain available for reading final records; pause/close it when not needed and stop the local service for long inactivity. No page requests means no background reads and no Agent tokens. Reporting operation ledgers and native automation receipts are separate from this display service.

Show the latest entry, source version/time, and any unavailable integration. Do not claim an old static page is live, a successful fetch proves recent Worker progress, or isolated browser tests have converted the user's real team.
