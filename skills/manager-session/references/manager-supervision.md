# Manager supervision

Manager only, at existing authorized pre-dispatch, supervision, acceptance or recovery checkpoints. For normal supervision read this guide only, plus the fixed template when its existing action calls for it. Consult the [reference](manager-supervision-reference.md) for an unfamiliar host, unsupported result shape or parameter/capability question; no separate model round just to load a file. No Worker/Liaison reads, calls, fields or steps; Liaison retains shared exact-task summary only.

## Manager entry and recall

Apply the established Manager role first. Continue/start/fix within that role: delegate implementation to a formal Worker via authorized runtime; no direct business implementation or temporary subagents. Questions alone do not start dispatch, review or contact. Read-only work and authorized acceptance stay available; honor explicit changes of role or allocation within scope.

Reuse valid identity/team/duties; recover missing, stale or conflicting context only at existing checkpoints, never per turn/tool. Keep identity/team/duty boundary/recovery ref in the existing handoff; after recall check existing work and trusted access per shared continuation.

Use the [fixed recall template](../scripts/functions-exec-manager-recall-template.js) in the existing single `functions.exec` with verified own host/thread and truthful reason; require the active Manager to match the active leader binding. Preserve `sharedRules`, `roleDuties`, `managerGuidance`; never apply the native filter here. Invalid/inactive/mismatched or incomplete/over-budget recall leaves role unresolved: hold affected work and follow shared recovery. Recovery/readiness is no dispatch authority or admission bypass.

## Progress and acceptance

Find work via `supervision-plan.taskChecks` and `pendingSubmissions`, including silent review work. Use exact `task_id` with `progress_summary`; omit only for an explicit team overview. Ordinary supervision/review uses task criteria, receipt, actual diff/artifacts, evidence and authorized verification, without Worker turns.

Use the catalog `reason` that matches the actual trigger: e.g. `before_review` for a pre-review summary, `before_dispatch` for the dispatch checkpoint, and `resume` or `post_compaction` for that recovery. Within the same dispatch checkpoint keep its trigger when recording the native result; record the actual delivery result in `result.outcome`. Use `manual` for an ad hoc call and `unknown` only when uncertain. A field error does not change the trigger or authorize an automatic retry.

## Supported native projection and execution limits

At the existing authorized pre-dispatch idle check, use the Manager-only [fixed readiness template](../scripts/functions-exec-thread-ready-template.js). Only verified same-local-host notLoaded permits one visible open and one exact recheck; all non-ready results hold. Existing admission and pre-send checks still apply.

For native supervision, use the [existing plan and filtered wait entry](operations.md#executable-supervision-plan). Reuse its exact target/cursor batch in one `functions.exec` with the [fixed wait template](../scripts/functions-exec-wait-template.js). Execute the prefilled source when the plan supplies it. One bounded native wait per authorized batch (≤8); filter before model output. Keep executing/rework completion discovery at existing checkpoints. Submission refs only from verified ledger, else null. Ended/idle, text and tool markers prove no business result or authority. If the host lacks this capability, record native wait as unavailable and continue with ledger evidence; do not make a direct native call or infer a task/thread status.

## Evidence before diagnostic conversation

Read evidence first; search/tail long logs. Read the smallest turn slice only for failed re-verification, conflicting evidence, insufficient blocker evidence, suspected scope/safety violation or explicit user request to investigate abnormal execution. For exact ended/idle with neither current submission nor active blocker, last turn only. Include outputs only as needed; explain in the existing review. Running, timeout, unknown, stale ledger or parse failure alone grants no body read, resend, redispatch, release, polling or timers. Use [delivery recovery](delivery-recovery.md) for reconciliation.

## Manager-only named operations (local trial)

At existing authorized checkpoints use verified installed `docs/manager-operations.md` and `scripts/manager-operations-functions-exec.js` (see [capability checks](manager-supervision-reference.md#manager-only-named-operations-local-trial) if needed), keeping mode and admission unchanged. Receive starts review only; approve/rework follows independent acceptance and an explicit Manager decision.

For formal submissions on this verified installation, this is the normal Manager entry: use `runManagerReviewStage` with `phase: 'receive'` for the existing `receive` request. After independent review, use a separate invocation with `phase: 'decision'` and `managerDecisionConfirmed: true` for `record_decision`, tied to the exact submission and review event returned by receipt (or recovered from the existing review). Give the program the verified request inputs; it handles UTC, event IDs and references, CAS and idempotency. Do not hand-build business events or use manual event + apply for normal receipt or decision.

The older Manager receipt instructions in [operations.md](operations.md#submission-notices), including `receive-submission`, are for verified older installations under their existing mode and authority. Keep the original compatible status/recovery entry for the exact original operation. Missing/failed/unknown capability, unknown outcome, partial effect or conflict: stop and reconcile the exact operation. Never automatically fall back to the old write path, redo receipt/decision, use an alternate sender or resend. Rollback preserves business and audit facts.
