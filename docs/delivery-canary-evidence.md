# Same-task delivery recovery: controlled live canary

Date: 2026-09-07. This summarizes a completed test using an existing dedicated Manager and Worker, not a business team. Raw local state, conversation identifiers and machine-specific artifacts are not included in the repository.

## Verified result

- Fresh offline suite before publication: `node --experimental-test-isolation=none --test`, 160 passed, zero failed, exit 0.
- The original test state progressed from version 28 to 40. One task was queued and started once. A first claim was persisted before any native call, then the Manager turn ended at a controlled checkpoint with delivery unknown and the Worker reservation retained.
- A later Manager turn reconciled the precise unused claim as not delivered, registered a new claim for the same task, and made one actual initial assignment send. The old claim was not reused as a send permit and the task was not reassigned.
- The Worker initially paused at the delivered-audit visibility barrier. After the Manager recorded delivery, one same-task coordination message continued the work. Total Manager-to-Worker messages were **one initial assignment plus one coordination message**, not one message overall.
- The original Worker submitted once and sent one standard submission notice. The Manager independently inspected the artifact, received the notice into review, approved the task and closed the round.
- The development task's separate read-only verifier passed at the checkpoint and final state. It checked unchanged prior history/bindings, one enqueue/start/submission, two claims, final approved/delivered/closed states, and reporting disabled. Its intermediate final-mode assertion correctly rejected submitted work before approval.
- The artifact was exactly UTF-8 without BOM `Delivery recovery verified` plus one LF: 27 bytes, SHA-256 `90830ca36aab97f12ac0b0adbc23cdafbea417db7d596238e19ab96187722233`.

No new user-visible tasks, model changes, timers, global installation, business-code changes or older-artifact changes were made by this test.

## Remaining boundaries

This is a controlled stop-before-host-call and cross-turn recovery test, not an actual application crash, network timeout or late-request test. Offline fault cases do not establish host exactly-once behavior, atomic state-plus-send, authentication or cross-month reliability.

Native task retrieval exposed completion status but empty detailed turn items during the test. Saved acting-agent receipts and durable state supported delivery/submission assertions; missing trace details were not reconstructed. Status retrieval and file observations also lagged execution, so intermediate absence was not treated as proof of failure.

The delivered-audit visibility race remains an integration friction: a Worker can receive the assignment before the Manager's receipt write is visible. The bounded same-task coordination path worked, but adds latency and a message. This test did not add a deterministic host acknowledgment barrier or change production behavior.
