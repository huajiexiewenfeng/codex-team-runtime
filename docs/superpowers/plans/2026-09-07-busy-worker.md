# Busy Worker admission implementation

Goal: independent new work must not interrupt outstanding assignments.
Architecture: Manager-side FIFO in existing task state; admission enforced by evolve under CAS. Host sends stay separate.
Tech stack: Node.js ESM, node:test, Markdown Skill companion.

## Global constraints

- Preserve dirty work and historical state. No live business messages, timers, global installs, commits or pushes.
- An unaccepted nonqueued task reserves its Worker across rounds, including submitted/reviewing/rework/blocked. Legacy multiple reservations remain readable.
- Queueing never contacts Worker. Native idle is not acceptance; unknown native state does not permit dispatch.
- Explicit start records reservation, not delivery. No automatic preemption or cancellation.

## Tasks

- [x] Runtime: TDD enqueue/startTask/FIFO/busy admission in src/runtime.mjs and test/scheduling-runtime.test.mjs; queued stages use assignedAt null and distinct queue time.
- [x] Integration: src/scheduling.mjs queueTask/startTask/planDispatch; queue-task/start-task/dispatch-plan CLI; caller/version/CAS regression tests.
- [x] Projections: exclude queued-only supervision, label queue stage, clarify resume guidance, retain legacy deduplication coverage.
- [x] Skill: baseline and scenario retest; classify independent work versus amendments; mandatory admission route and unsupported preemption boundaries.
- [x] Verification: 140/140 suite, Skill validator and independent review; no real team mutation. See docs/busy-worker-evidence.md.
