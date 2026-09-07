---
name: manager-session
description: Inspect a codex-team-runtime team or explicitly operate its Manager and Liaison roles with the companion runtime. Use for team supervision and acceptance, not ordinary coding or one-shot delivery.
---

# Manager Session — early repository companion

Reading this skill does not activate a role. Status/history queries never create, message, or wake a task. This version provides executable local `start`, two-sided `attach`, Worker registration, and read-only `resume`, not an autonomous background team or persistent session hook.

## Locate the runtime

Obtain the user-selected trusted checkout and state-file path. `runtime-root` is the checkout containing `src/cli.mjs`, not the state directory. Do not guess paths or current task identity from titles or inspect private logs. A separately installed copy still needs the companion checkout and Node.js 22+; do not install globally or duplicate the runtime.

For status, run this skill's absolute script path (quote paths containing spaces):

```text
node <skill-directory>/scripts/status.mjs --runtime-root <trusted-checkout> --state <state.json> [--as-of <UTC-ISO-time>] [--round <roundId>]
```

This prints the canonical runtime snapshot without writing files or invoking host tools. Status needs no current-role identity. Selected history retains historical member bindings and current reporting intent. Report source version/time, task/stage elapsed time, latest effective progress and blockers; distinguish submission from acceptance. Stale observation is not proof of failure. `reporting.actual: unknown` remains unknown.

## Intent routing

Timers are OFF by default. Role activation, new work, "continue", and Worker completion do not authorize creating or resuming a timer. Use completion/blocker messages and user-triggered checks without a polling loop. An explicitly requested timer requires a human-confirmed fixed window of at most 24 hours; renewal requires fresh human confirmation. Before enabling one, read [timer authorization and expiry](references/operations.md#timer-authorization-and-expiry). This policy does not stop Workers or exit roles.

Before continuing role-dependent work or selecting another workflow skill, recover the current role and the same work's existing orchestration owner using [ownership and continuation](references/operations.md#ownership-and-continuation). Manager Session owns team scheduling and acceptance only for its verified assigned scope; PDC can supply project stages without taking that ownership. A skill call is not an ownership transfer. New Worker handoffs must carry the [Worker composition contract](references/operations.md#worker-composition-contract).

Before delegation, read [delegation and model policy](references/operations.md#delegation-and-model-policy). Preserve the user's Manager model/effort; new long-lived members default to Sol/medium. Temporary subagents default to Sol/medium or a suitable lower model, never above their direct parent. These are host-executed Skill rules, not runtime-enforced settings.

Before each new assignment or follow-up to a Worker, apply [busy Worker admission](references/operations.md#busy-worker-admission). Independent new work stays in the Manager-side durable queue while that Worker has unaccepted work. Sending “do this later” still sends a message and is not queueing. Host idle, submission, similar files and urgency do not release the reservation.

For an explicit withdrawal of unstarted work, use [queued cancellation](references/operations.md#queued-cancellation). Cancellation is a retained outcome, not approval, deletion or a command to stop a running Worker.

Before an initial native assignment send or recovery of a failed/uncertain send, read [delivery recovery](references/delivery-recovery.md). Reserve one attempt locally before sending; only checked non-delivery permits a new claim for the same task. Unknown delivery retains the reservation and requires reconciliation, not resend, cancellation or another assignment.

When authorized to create team tasks, apply the naming convention in [operations.md](references/operations.md#team-task-names): `角色-项目简称-任务主题`; long-lived Manager/Liaison omit the theme. Naming does not authorize task creation or renaming existing tasks, and never replaces host/thread identity.

For an explicitly requested correction of a confirmed Liaison pairing, read operations.md and runtime-usage.md for `detach`, then a fresh two-sided `attach`. Only the verified active Manager may detach, with no open rounds and reports disabled. Reconcile any old host automation first; detaching neither stops it nor migrates its ledger. The user chooses the replacement task; this Skill's development task is not implicitly the project's Liaison.

- **Status/history and Liaison:** read snapshots only. Liaison explains evidence and discusses decisions with the user; it does not command Workers or write Manager state. A durable command inbox is not implemented.
- **Explicit activation, pairing, role recovery, Worker registration, supervision, acceptance or exit:** read [references/operations.md](references/operations.md) and the selected checkout's `docs/runtime-usage.md`. `start` creates local role records only; Manager invites and the target Liaison confirms from its own context using `attach`. `resume` matches an injected identity to state and returns guidance without mutation. Missing dependencies or unverifiable current identity stop identity-dependent operations, not ordinary status reads.
- **HTML export:** existing `snapshot`/`render` commands create a new output directory only when requested. They do not start a live server.
- **Manager supervision pass:** use the executable `supervision-plan` in operations.md to select active Worker targets, then invoke available native tools within authorization. A generated plan is not an executed query; raw host results require review, never automatic acceptance.
- **Worker submission / Manager receipt:** read [submission notices](references/operations.md#submission-notices) for the executable `submission-notice` / `receive-submission` flow. It starts review from a verified durable submission, not approval or background monitoring.
- **Reporting coordination records:** read the companion checkout's `docs/reporting-usage.md` for `reporting-init`, `reporting-plan` and `reporting-apply`. These manage a local operation ledger only; they do not create or stop automation. Uncertain outcomes require reconciliation, not repeated creation.
- **Background reports, automatic recovery and webpage navigation:** disclose unsupported integration. Agent tools are not an HTML API. Do not invent deep links, commands, or successful scheduler receipts.

Completion does not exit a long-lived role. Role exit does not cancel or archive Workers. Preserve explicit reporting preferences. This preview is not the finished long-running Skill product.
