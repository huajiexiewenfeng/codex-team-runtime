# Manager supervision reference

Start with the [core](manager-supervision.md). Open this file for an unfamiliar host, unsupported shape or a parameter/capability question at the existing action.

## Manager reminder and recall contract

`TeamRegistry.read` includes independently revised `managerGuidance` for active Manager reads only, excluding manage/replay, unknown/inactive and Worker/Liaison results. It is a reminder, not host interception or enforcement; policy/onboarding receipts, ready checks and recall timing are unchanged. It points to the fixed wait template rather than embedding it.

The recall template is Desktop source, not a Node CLI. It calls `team_context.read` once, verifies the member binding and that the active Manager matches the active Registry leader, and emits one bounded capsule. Default output omits full roster and onboarding proof; exact targets still come from the authorized workflow. Errors, null or wrong-role results do not recover identity. Connectivity does not validate live status. Worker/Liaison use only the shared contract.

## Wait template placement

Use `scripts/functions-exec-wait-template.js` relative to the installed Manager Skill. Fill it within the existing authorized action. This Desktop source has no imports or file reads inside the invocation. Reuse the already authorized wait frequency and retain bounded unknown without raw fallback.

## Supported native projection and execution limits

The observed MCP envelope is `{content:[{type:"text",text:JSON.stringify(decoded)}],isError:false}`. Decoded schema: `{timedOut,wake,polls:[{schemaVersion:1,cursor,revision,changed,thread:{id,hostId,status:{type,...}},latestTurn:{id,status,error,...},...}]}`. Only active carries activeFlags; idle, notLoaded and systemError are distinct native states. Legacy ended stays informational. Body-bearing assistant messages, tool markers and all unlisted fields are dropped before output. The template also accepts the same decoded schema in MCP structuredContent; it does not guess alternate threads/results schemas.

Observed completion wake: `{reason:"turnCompleted",turnId,threadId,hostId}`. Project only these four fields after matching the exact requested host/thread and its unique valid poll: timedOut=false, thread status idle, latest turn completed without error, and the same turnId. Wake alone never infers completion, submission or approval. Null wake becomes none; unknown reasons, extra fields/body injection, mismatched identities/turns, missing/conflicting polls or contradictory status become bounded unknown without raw fallback.

Unknown native errors retain a bounded presence signal; they are never forwarded as arbitrary error messages. Missing, duplicate, cross-host-conflicting, unsupported-version or malformed polls are unknown for the affected identities. A successful exact poll remains usable alongside an unknown error signal; missing targets stay unknown. No status is inferred from array order, wake text or errors. Only recognized status enums pass; new status variants remain unknown.

Input is trusted exact identities/cursors and optional ledger references, not authentication. All inputs validate before any host call; placeholders and pending client IDs are rejected. Cursors are opaque and never shortened: oversized cursors are unusable/null, with a bounded error signal; input oversize rejects the batch. Submission references are optional exact-identity ledger strings (not parsed from the host). Each cursor permits 2048 characters, with a 4096-character aggregate; ledger references also have an escaped-size budget. A conservative 14000-byte-equivalent output ceiling returns bounded unknown with null cursors rather than risking functions.exec truncation of a reusable cursor.

The template requests timeoutMs=0 by default, matching existing supervision-plan batches; only retain an already authorized bounded wait (up to 60000 here). functions.exec can yield while the single awaited tool is pending. Resume that same execution via functions.wait only after a “Script running with cell ID” result; do not start another wait_threads call. Its output token budget is explicit. Hosts with different return shapes fail closed and need a schema update backed by evidence; offline fake-tool checks are not live host integration proof.


## Manager-only pre-dispatch readiness

Use the [fixed readiness template](../scripts/functions-exec-thread-ready-template.js) in the existing pre-dispatch check for the exact authorized FIFO head and Worker. Fill the verified hostId/threadId, existing dispatch authorization, and (only when independently verified) the current local host identity shared by the Manager, target and focused desktop navigation route. An exact idle with no unfinished turn takes one bounded metadata query. Active, systemError, unknown or conflicting evidence holds.

Only a verified local notLoaded target may use navigate_to_codex_page once. It visibly opens the original chat in the focused main desktop window; it sends no message and starts no turn. A navigation acknowledgement is followed by one immediate exact metadata recheck. Require idle and the same latest terminal turn (or null in both observations); an unseen or changed turn, unfinished turn, contradictory metadata or load still pending holds. Missing capability or unverified local routing is unsupported. Never use threadId-only navigation for remote targets, loop, retry in the same check, or read history. Use the filtered navigation outcome as evidence at the existing checkpoint; add no Worker or Liaison step.

Ready certifies the observed native state only. Preserve task occupancy, FIFO, CAS, delivery claim and the existing pre-send recheck; state can change after any snapshot. A future headless adapter would require an exposed, verified same-host official thread/resume with excludeTurns=true, followed by the same metadata recheck. Do not call a private bridge or launch a separate App Server.

## Manager-only named operations (local trial)

At the existing authorized dispatch, submission-receive and decision-recording checkpoints, after verifying the installed companion has `src/manager-operations.mjs`, `src/manager-inbox.mjs`, `src/manager-inbox-contract.mjs` and the fixed bridge/template, use `<verified-runtime-root>/docs/manager-operations.md` and `<verified-runtime-root>/scripts/manager-operations-functions-exec.js`. Use verified Node/Python/runtime paths; the template passes Python explicitly to each child. Load/fill the fixed template within that existing functions.exec invocation; do not add a model round solely to load it. Dispatch still requires existing human authorization, exact task/Worker identity, native idle and original admission checks. Receive only starts review; record a decision only after independent evidence inspection and an explicit Manager decision.

This route is Manager-only and does not create a supervision checkpoint, send a task, enable inbox/queue_first, change review criteria, or add Worker/Liaison reads. Keep the current mode; unavailable capability or failed/unknown output stops this route and requires exact-operation status/reconciliation. Never fall back to another sender or resend to resolve unknown effects. Code rollback preserves all task/Registry/notification/attempt/review facts.
