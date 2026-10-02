# E04 queued-task dispatch

Use only when the configured runtime and every supported writer have been upgraded
to E04 and both `team_context.dispatch` and `team_context.dispatch_status` are
available. A source checkout containing E04 does not upgrade the installed MCP.
Never put E04 state through an older writer; schema2 alone is not compatibility.
For legacy attempts, use [delivery recovery](delivery-recovery.md).

1. Select the authorized queued task and its exact formal Worker. Confirm the
   original scope, prerequisites, current native idle state, unregistered work,
   and sole sender. Do not create or message another task merely to probe it.
2. Freeze the brief when writing the normal handoff material, using the trusted
   checkout's `dispatch-freeze <state.json> <brief.json>`. See `docs/e04-dispatch-runtime-usage.md`
   for the closed JSON format. New enqueue source.ref is the returned briefRef.
   Existing queued tasks need a verified copy bound to enqueueEventId and
   originalSourceRef. Never invent a brief from a title or replace started scope.
3. Call dispatch with action=prepare, a retained operation_id, explicit
   team/round/task/Worker/enqueue IDs and brief_ref. Provide the native evidence
   and verified not-attempted baseline. Missing logs or queued status are not
   baseline proof. Reuse sufficient scope evidence already frozen in the brief.
   Keep original source timestamps if present; never manufacture one or refresh
   it by copying the current time. Refresh evidence after interruption or change.
4. Only a new successful response with sendNow=true permits one native call,
   within existing explicit user authorization and host policy. Recheck that
   authorization, identity and target availability have not changed. Use its exact
   hostRequest. prepare itself only reserves local work; it never sends.
5. Record the exact attempt through action=result with a separate retained
   operation_id. accepted means host acceptance, not execution or business
   acceptance. Unknown keeps the reservation. Terminal nonreceipt requires proof
   that this exact call was never accepted and cannot still arrive. A denial ends
   retries; do not change IDs, recipients or policies to evade it.

After a lost response or interruption, query the original operation/attempt.
Replay and status return no hostRequest and no new send permission. Confirm the
write process ended before treating OPERATION_NOT_FOUND as an uncommitted write.
LatestAttemptId without verified selectors is only a hint. A proven terminal
nonreceipt may be followed by a new prepare with retry_of_attempt_id and renewed
native admission; it keeps the original brief, task and Worker.

Worker progress may precede the receipt: record accepted/unknown against the
original E04 attempt even after submission or closure. Any work observation,
including progress=false, prevents negative retry/cancellation. Never use the
legacy delivery-check/claim commands on an E04 attempt.

Cancellation is exceptional: action=cancel requires explicit task-withdrawal
authorization and references proving all attempts ended unreceived, no Worker
work and no remaining sender/in-flight message. A failure or previous dispatch
authorization does not authorize withdrawal. Missing evidence keeps occupancy.
Do not reuse cancelStopped, which requires delivered and stopped work. Successful
withdrawal does not authorize automatic requeueing or Worker exit.

Contradictory terminal evidence is recorded as dispatchConflict and blocks further
starts for that Worker. Preserve the history and report the conflict; this version
has no automatic or self-service hold release. Do not erase records to clear it.
The caller must never use an old send grant after withdrawal.

For backup use `dispatch-export <state.json> <new-directory>`; preserve state and
all reachable objects together, with the separately managed Registry. Missing
objects are errors, not empty history. Disable new prepare before rollback and
retain E04-aware status/result recovery. No timer or automatic sender is added.
