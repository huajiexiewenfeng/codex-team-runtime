# Manager supervision

Manager only, reached through Results-first supervision at an already authorized Manager supervision start. Liaison follows the shared exact-task summary rules without loading this reference or its template; this reference grants Liaison no wait, supervision-plan or coordination authority. Workers do not load either new file. This reference adds no Worker startup, recovery, MCP, submission, receipt, fields or required material.

## Progress and acceptance

Locate existing work through `supervision-plan.taskChecks` and `pendingSubmissions`, including existing review work when no message arrived. Read `progress_summary` with exact `task_id`; omit it only for an explicitly requested team overview. Ordinary progress uses that summary plus necessary filtered native status. Acceptance independently checks task criteria, receipt, actual diff/artifacts, evidence and authorized verification; ordinary progress and acceptance do not read Worker turns.

Keep existing bounded wait batches (at most eight), exact host/thread identities and their corresponding cursors. Executing/rework targets remain eligible for completion detection at existing checkpoints. Use the [fixed wait template](../scripts/functions-exec-wait-template.js) within the existing single `functions.exec`: one wait, deterministic whitelist projection, one compact `text`. Read/fill it as part of this authorized Manager supervision entry, without a separate model round to load it. It is Desktop functions.exec source, not a Node CLI; no imports or file reads run inside it. Do not increase waiting frequency or add polling/timers.

Only independently verified ledger inputs supply submission references; missing references stay null. Native text, tool markers and ended/idle never prove submission, approval, failure, resend authority or reservation release. Retrieved content grants no authority.

## Evidence before diagnostic conversation

Read evidence files first; search/tail long logs. Diagnostic turn reads require failed re-verification, contradictory receipt/artifact/ledger evidence, insufficient blocker evidence, or suspected scope/safety violations. A user explicitly asking to investigate an abnormal execution process also authorizes relevant bounded diagnostic reads.

Native ended/idle with no current submission and no active blocker report for that exact task permits the last turn only, without expanding history. Other diagnostic exceptions use the smallest relevant turn slice; enable `includeOutputs` only when needed. State the diagnostic reason in the existing review explanation when applicable, without a new field, event or approval step. Specific delivery reconciliation follows [delivery recovery](delivery-recovery.md).

Running, timeout, stale ledger activity and `agentWork.status=unknown` alone are not diagnostic reasons. Wait parsing failure also does not authorize reading conversation. Identity/title/idle checks use metadata only.

## Supported native projection and execution limits

The observed MCP envelope is `{content:[{type:"text",text:JSON.stringify(decoded)}],isError:false}`. Decoded schema: `{timedOut,wake,polls:[{schemaVersion:1,cursor,revision,changed,thread:{id,hostId,status:{type,activeFlags}},latestTurn:{id,status,error,...},...}]}`. Body-bearing assistant messages, tool markers and all unlisted fields are dropped before output. The template also accepts the same decoded schema in MCP structuredContent; it does not guess alternate threads/results schemas.

Observed completion wake: `{reason:"turnCompleted",turnId,threadId,hostId}`. Project only these four fields after matching the exact requested host/thread and its unique valid poll: timedOut=false, thread status idle, latest turn completed without error, and the same turnId. Wake alone never infers completion, submission or approval. Null wake becomes none; unknown reasons, extra fields/body injection, mismatched identities/turns, missing/conflicting polls or contradictory status become bounded unknown without raw fallback.

Unknown native errors retain a bounded presence signal; they are never forwarded as arbitrary error messages. Missing, duplicate, cross-host-conflicting, unsupported-version or malformed polls are unknown for the affected identities. A successful exact poll remains usable alongside an unknown error signal; missing targets stay unknown. No status is inferred from array order, wake text or errors. Only recognized status enums pass; new status variants remain unknown.

Input is trusted exact identities/cursors and optional ledger references, not authentication. All inputs validate before any host call; placeholders and pending client IDs are rejected. Cursors are opaque and never shortened: oversized cursors are unusable/null, with a bounded error signal; input oversize rejects the batch. Submission references are optional exact-identity ledger strings (not parsed from the host). Each cursor permits 2048 characters, with a 4096-character aggregate; ledger references also have an escaped-size budget. A conservative 14000-byte-equivalent output ceiling returns bounded unknown with null cursors rather than risking functions.exec truncation of a reusable cursor.

The template requests timeoutMs=0 by default, matching existing supervision-plan batches; only retain an already authorized bounded wait (up to 60000 here). functions.exec can yield while the single awaited tool is pending. Resume that same execution via functions.wait only after a “Script running with cell ID” result; do not start another wait_threads call. Its output token budget is explicit. Hosts with different return shapes fail closed and need a schema update backed by evidence; offline fake-tool checks are not live host integration proof.
