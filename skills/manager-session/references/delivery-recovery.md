# Same-task delivery recovery

For Worker-to-Manager stage completion and submission, use
[completion notification](completion-notification.md). The assignment claims below
must not track, retry or suppress completion notifications.

Read the trusted checkout's `docs/runtime-usage.md`, section “同一任务的派发恢复”, before using the commands. This reference governs Manager-to-Worker initial assignment delivery only. Worker submission notices and scoped review/amendment messages have separate contracts. No timer, automatic dispatch, host-send transaction, or cancellation of started work is added.

## Reconcile before retrying

1. Recover the verified current Manager identity, original trusted state, task ID, exact Worker host/thread, original brief and authorization. Read `delivery-plan` with current state. Missing or ambiguous identity/evidence stops delivery, not ordinary status reads.
2. Missing delivery history means **unknown**, not “never sent”. If the single original assign/startTask audit is absent, the plan is unavailable; do not fabricate an audit or create a replacement assignment. `supervise`, `held`, and `no-action` never authorize retry.
3. For `reconcile`, inspect the exact original request/attempt through available read-only native evidence. A timeout, a missing visible turn, native idle, an application crash, or the user saying “continue” does not prove non-delivery. Do not send a probe message to the Worker just to check whether the previous message arrived.
4. Record `delivery-check` only for the exact current attemptId, with source and a concise evidence summary. `unknown` retains uncertainty. `delivered` means verified transport acceptance at the intended task, not Worker execution, submission or acceptance of its code. `not-delivered` requires evidence that this exact request was never accepted **and cannot still arrive**, with no competing sender/in-flight request. A failure label alone is insufficient. Source/caller JSON is a declaration, not authentication.
5. Before a genuinely first send immediately after start, the foreground Manager may record non-delivery only when it directly knows no native call has begun and has reconciled other possible senders. A missing log or newly restarted context is insufficient. Older assignments must be reconciled by the same evidence standard.

## One claim, at most one foreground send

Only `ready-to-claim` permits `delivery-claim`, using the current version and exact prior attemptId. It keeps the same task and Worker reservation and creates a new unknown attempt whose ID is the claim event ID. Concurrent claim requests have one CAS winner; version conflict is not permission to retry a write blindly. After an uncertain write result, inspect the event; do not infer that no host send happened.

The foreground caller that has just confirmed its successful claim may make **at most one** already-authorized native send, after rechecking unchanged state/attempt, current formal Worker identity, native idle, original scope and sole-sender coordination. Include task ID and the new attempt ID in the handoff for traceability; they are not host-enforced idempotency keys. If any check changes, do not send and retain unknown until exact evidence resolves it. The Node commands never send and `delivery-plan.hostRequest` is always null.

After the call, record its checked result against the new attempt ID. Unknown cannot be claimed again. Checked non-delivery permits a fresh claim for the **same task**, after renewed checks within existing authorization. Delivered means supervise, never retry. After interruption/restart, do not reuse an old claim as a send permit: reconcile it first, even if the crash may have occurred before sending.

Any task work observation (including `progress:false`) blocks non-delivery/retry. Use delivery-check, not ordinary task observe, for delivery-only uncertainty. Submitted, reviewed, reworked, blocked/resumed or otherwise advanced work belongs to supervision, not initial delivery recovery. Do not erase observations to make a retry pass.

This mechanism cannot release a permanently unresolved Worker reservation, revoke an in-flight native request, guarantee exactly-once host delivery, or intercept direct user/API messages. If safe reconciliation is unavailable, report the unresolved attempt and request direction; do not cancel, requeue, reassign or start a timer as a workaround. Business stage times, queue order, reporting preferences and models remain unchanged.
