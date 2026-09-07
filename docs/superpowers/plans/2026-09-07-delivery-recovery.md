# Delivery recovery implementation plan

**Goal:** safely resume delivery of the same reserved task after verified non-delivery, while uncertain outcomes require reconciliation.
**Architecture:** append deliveryClaim/deliveryCheck events to the existing state audit under CAS; derive delivery status from those records without creating a second business ledger. No native send, automatic retry, rollback, cancellation or release of a reservation.
**Tech stack:** Node.js ESM standard library, node:test, manager-session companion references.

## Global constraints

- Preserve dirty work, real teams and default-off timers. No live messages, installation, commits or pushes.
- Legacy assignment without delivery evidence starts unknown, never implicitly unsent. Missing assignment audit fails closed.
- A deliveryCheck requires exact current attemptId, Manager caller, outcome (unknown/delivered/not-delivered), reason and source. Provenance is a caller declaration, not host authentication.
- A deliveryClaim requires the latest outcome not-delivered, an unchanged active Worker binding, no task observations/submissions or competing reservation. It creates one new attempt whose outcome is unknown before any host call.
- Unknown remains reserved and cannot be retried. Delivered cannot be retried. Proven non-delivery permits another explicit claim for the same task, not a new assignment.
- All task/stage times, reporting preference, ownership and queue order remain unchanged by delivery events.

## Task 1: Deterministic recovery contract

Files: new src/delivery-state.mjs; modify src/runtime.mjs; new test/delivery-recovery.test.mjs.
Interfaces: deliveryState(state,task) derives attemptId/status/evidenceEventId/attempt count from assignment and delivery audit; evolve accepts deliveryCheck and deliveryClaim.

- [x] Test missing capability, conservative legacy unknown, stale attempt IDs, duplicate claim CAS, missing caller, incorrect target evidence, actual-work guards, and immutable business fields.
- [x] Implement initial unknown -> checked not-delivered -> claim(new attempt, unknown) -> checked delivered or not-delivered. Unknown -> unknown remains uncertain. Reject check after a resolved outcome and invalid imported chains.
- [x] Run targeted tests with `node --experimental-test-isolation=none --test test/delivery-recovery.test.mjs` (11/11).

## Task 2: CLI, Skill and verification

Files: new src/delivery.mjs; src/cli.mjs; Skill operations/SKILL; docs/runtime-usage.md.
Interfaces: checkDelivery(path,request,expectedVersion), claimDelivery(path,request,expectedVersion), planDelivery(state,caller,taskId); CLI delivery-check/delivery-claim/delivery-plan. Plan is read-only, hostRequest:null, executed:false and requires native evidence before use.

- [x] Add CLI/CAS tests and implement the wrappers using the existing transact lock; never send through Node.
- [x] Document the one-authorized-host-call rule after a successful claim, evidence needed for non-delivery, and refusal to adopt legacy unknown as unsent.
- [x] Baseline and six-scenario forward-test Skill reference behavior; independent code review with both findings fixed; full suite 160/160 and Skill validator passed. Outcomes and limitations recorded in docs/busy-worker-evidence.md.
