---
name: manager-session
description: Use when explicitly designating a session as Manager, initializing a codex-team-runtime team, supervising or accepting team work, or recovering established Manager, Liaison and Worker roles; not ordinary coding or one-shot delivery.
---

# Manager Session — early repository companion

Reading this skill does not activate a role. Status/history queries never create, message, or wake a task. This version provides executable local `start`, two-sided `attach`, Worker registration, and read-only `resume`, not an autonomous background team or persistent session hook.

## Manager activation entry

When the user explicitly designates this session as Manager, first follow [activation and initialization routing](references/activation.md). The default requested setup is three independent windows: reuse the current Manager, create or reuse one Liaison and one Worker. Do not create a second Manager or duplicate valid members. Distinguish a new team from recovery, an existing connected team from context-only registration, and pending/failed integration from absence. `read = null` is expected for a first activation; it is not itself a reason to request an old state file. Activation includes minimum-team setup under the user's selected workflow; it does not authorize unrelated development, installation or timers. Host creation permissions still apply. A Skill mention or title alone is not activation.

## Locate the runtime

Obtain the trusted runtime containing `src/cli.mjs`, not the state directory. It may be a user-selected checkout or an explicitly installed companion code bundle. Use verified locators already in context or linked Registry context (`runtime.statePath`, `runtime.runtimeRoot`, `runtime.pythonExecutable`). During explicit activation, missing locators may be recovered read-only from the specifically configured Team Context MCP service metadata; follow activation.md before asking the user for a path. Use the installed Python for the individual Node invocation's `CODEX_TEAM_CONTEXT_PYTHON`, not a global environment change. Unlinked registry context provides no execution locator; legacy locator mode remains read-only. For recovery, ask for the original locator only after these bounded sources fail. For a new team, an old state file is not a prerequisite. Do not guess paths or current task identity from titles, inspect private logs, or create replacement state. A separately installed Skill still needs companion code and Node.js 22+; reading it does not authorize installation or a duplicate team/Registry.

For status, run this skill's absolute script path (quote paths containing spaces):

```text
node <skill-directory>/scripts/status.mjs --runtime-root <trusted-checkout> --state <state.json> [--as-of <UTC-ISO-time>] [--round <roundId>]
```

This prints the canonical runtime snapshot without writing files or invoking host tools. Status needs no current-role identity. Selected history retains historical member bindings and current reporting intent. Report source version/time, task/stage elapsed time, latest effective progress and blockers; distinguish submission from acceptance. Stale observation is not proof of failure. `reporting.actual: unknown` remains unknown.

## Team context recall — all formal members

Before new member creation or pending client-ID recovery, use activation.md's
durable startup receipt flow. `team_context.startup` stores candidates separately
from membership; Manager independently verifies them. Missing task-list entries
or unreadable final replies do not authorize another creation.

Manager, Liaison and Workers share [the team-context contract](references/team-context.md): recover own identity, team, exact leader and role duties, not only a role label. Read that reference for onboarding, foreground continuation/context loss, delivery or acceptance, stale/conflicting context, or membership maintenance. New formal-member handoffs carry this same reference and verified read arguments; reading it in Manager does not load it in other tasks.

Use `team_context.read` with verified **current hostId + threadId**; temporary helpers must not inherit a parent's role identity. Active context does not grant work authorization; null is unregistered, inactive is not a resumable role, and errors are not null. Current work/evidence needs its own verified source. MCP does not call itself or authenticate the caller.

Only Manager maintains the registry, after externally verified bootstrap/member authorization and any required consent. Members read and return onboarding receipts; Manager verifies and records them. Registered is not ready; ready is not dispatch permission or proof of future recall. `dispatchAllowed: false` means a context read never grants or executes dispatch. Unlinked teams remain `not-connected`; linked active teams report `connected` and must still pass Node admission gates. `migration-pending` blocks business operations until recovery. A user-authorized legacy cutover is performed by the original Manager following `<runtime-root>/docs/team-registry-cutover.md`, never by a developer impersonating it. For linked teams, only MCP changes current identities; Node preserves business history and checks its member projection. Legacy locator mode retains Node authority and cannot bypass linked-team errors. Setup and exact APIs: `<runtime-root>/docs/team-context.md`. No global installation, hook or timer is implied.

## Intent routing

Use one **团队工作台 (Team Dashboard)** entry with **任务进度** for tasks, members,
blockers and acceptance, and **指标统计** for daily Token usage and MCP observations.
Read [Dashboard routing](references/dashboard.md) before handing off the entry.
A bare “dashboard/看板” opens this unified entry, not the last HTML file. Explain
the two tabs; missing Metrics input is unbound, never zero or a substitute Token audit.

Timers are OFF by default. Role activation, new work, "continue", and Worker completion do not authorize creating or resuming a timer. Use completion/blocker messages and user-triggered checks without a polling loop. An explicitly requested timer requires a human-confirmed fixed window of at most 24 hours; renewal requires fresh human confirmation. Before enabling one, read [timer authorization and expiry](references/operations.md#timer-authorization-and-expiry). This policy does not stop Workers or exit roles.

Before continuing role-dependent work or selecting another workflow skill, recover the current role and the same work's existing orchestration owner using [ownership and continuation](references/operations.md#ownership-and-continuation). Manager Session owns team scheduling and acceptance only for its verified assigned scope; PDC can supply project stages without taking that ownership. A skill call is not an ownership transfer. New Worker handoffs must carry the [Worker composition contract](references/operations.md#worker-composition-contract).

Before delegation, read [delegation and model policy](references/operations.md#delegation-and-model-policy). Preserve the user's Manager model/effort; new long-lived members default to Sol/medium. Temporary subagents default to Sol/medium or a suitable lower model, never above their direct parent. These are host-executed Skill rules, not runtime-enforced settings.

Before selecting a Worker for new work, apply [project-aware decomposition and optional PDC integration](references/project-dispatch.md). Use PDC/Base Graph when applicable and available, or requirements/source evidence without them. Select the correct project and an idle suitable Worker, or create an authorized independent Worker when useful, before choosing its queue; the initial Worker is not a team size limit. Then apply [busy Worker admission](references/operations.md#busy-worker-admission) for every assignment/follow-up. Work targeting a reserved Worker stays in the Manager-side durable queue. Sending “do this later” is not queueing. Host idle, submission, similar files and urgency do not release the reservation.

For an explicit withdrawal of unstarted work, use [queued cancellation](references/operations.md#queued-cancellation). Cancellation is a retained outcome, not approval, deletion or a command to stop a running Worker.

For explicitly withdrawn **started but stopped** work, use [stopped-task cancellation](references/operations.md#stopped-task-cancellation). Only initial executing work with verified stop/WIP evidence and resolved delivery is supported; native idle alone cannot release it.

Before an initial native assignment send or recovery of a failed/uncertain send, read [delivery recovery](references/delivery-recovery.md). Reserve one attempt locally before sending; only checked non-delivery permits a new claim for the same task. Unknown delivery retains the reservation and requires reconciliation, not resend, cancellation or another assignment.

Normal team communication within an unchanged valid assignment/report grant needs no extra Skill approval or evidence-formatting step. Use [compact communication evidence](references/communication-evidence.md) only to diagnose missing/conflicting evidence or an approval failure; it cannot grant permission or unlock a denied request.

When authorized to create team tasks, apply the naming convention and acknowledged title finalization in [operations.md](references/operations.md#team-task-names): `角色-项目简称-任务主题`; long-lived Manager/Liaison omit the theme. Naming does not authorize task creation or renaming existing tasks, and never replaces host/thread identity.

For an explicitly requested correction of a confirmed **unlinked legacy** Liaison pairing, read operations.md and runtime-usage.md for `detach`, then a fresh two-sided `attach`. Only the verified active Manager may detach, with no open rounds and reports disabled. Linked teams must not use these legacy identity writes; consult the MCP membership contract and disclose unsupported rebinding instead. Reconcile any old host automation first; detaching neither stops it nor migrates its ledger. The user chooses the replacement task; this Skill's development task is not implicitly the project's Liaison.

- **Status/history and Liaison:** read snapshots only. Liaison explains evidence and discusses decisions with the user; it does not command Workers or write Manager state. A durable command inbox is not implemented.
- **Explicit activation, pairing, role recovery, Worker registration, supervision, acceptance or exit:** read [references/operations.md](references/operations.md) and the selected runtime's `docs/runtime-usage.md`. Unlinked legacy `start` creates local role records only; Manager invites and the target Liaison confirms from its own context using `attach`. Linked membership uses MCP, not these identity commands. Legacy `resume` returns guidance without mutation; linked recall uses the shared team-context contract. Missing dependencies or unverifiable current identity stop identity-dependent operations, not ordinary status reads.
- **团队工作台 / 任务进度 / 指标统计 / stale Dashboard:** follow [Dashboard routing and ownership](references/dashboard.md). `dashboard-serve` is one entry with two tabs; bind a verified same-team daily report using `--metrics-report`. Work auto-sync does not refresh or collect Metrics. Plain status queries do not start services. Manager/Workers maintain authorized records; Liaison explains the view without writing Manager state.
- **Manager supervision pass:** use `supervision-plan` in operations.md to inspect durable `taskChecks` and `pendingSubmissions` as well as bounded native observations. No message or an empty host result is not a reason to skip existing review work. A generated plan is not an executed query or automatic acceptance.
- **Worker stage completion / submission / Manager receipt:** follow [completion notification](references/completion-notification.md): save evidence, proactively notify the exact Manager, then independent pass/rework. Carry existing user authorization and native target evidence in handoffs, without repeated approval for unchanged grants; Registry readiness is not host authentication. Formal submissions use `submission-notice` / `receive-submission`; non-submit stages/blockers are labelled separately. Preparation, submission, delivery, receipt and acceptance are separate facts. Old workarounds do not authorize permanent silence; new notice IDs do not clear a denial of the same disclosure. Host reconsideration is separate and cannot be guaranteed by this Skill.
- **Reporting coordination records:** read the companion checkout's `docs/reporting-usage.md` for `reporting-init`, `reporting-plan` and `reporting-apply`. These manage a local operation ledger only; they do not create or stop automation. Uncertain outcomes require reconciliation, not repeated creation.
- **Background reports, automatic recovery and webpage navigation:** disclose unsupported integration. Agent tools are not an HTML API. Do not invent deep links, commands, or successful scheduler receipts.

Completion does not exit a long-lived role. Role exit does not cancel or archive Workers. Preserve explicit reporting preferences. This preview is not the finished long-running Skill product.
