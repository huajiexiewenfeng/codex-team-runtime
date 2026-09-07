# Busy Worker admission — 2026-09-07

## Verified scope

Independent new tasks are queued in the Manager's existing state. A Worker remains reserved across rounds until acceptance, including submitted/reviewing/rework/blocked. FIFO start and legacy direct assign admission are checked inside evolve under CAS. Queue-only work produces no supervision targets or message request. Old overlapping state stays readable.

New enqueue/startTask events require a matching Manager caller declaration. All admission checks reject pending Worker identities. Queue elapsed time is distinct from execution elapsed. Existing demo/test fixtures now give concurrent tasks distinct Workers; a dedicated imported legacy-overlap fixture retains read compatibility coverage.

## Evidence

- Runtime TDD baseline: 7/7 failed (missing busy guard/new events); initial implementation 7/7 passed.
- Wrapper/CLI baseline: 4/4 failed (missing scheduling module/commands); implementation 4/4 passed.
- Projection regression first failed on missing queued label; final suite covers render, resume and reporting queue time.
- Independent review found pending Worker admission and optional caller on new raw events. Added regression baseline: 7 passed, 2 failed; after correction runtime scheduling 9/9 passed. Reviewer rechecked both fixes with no remaining blocking findings.
- Final command: `node --experimental-test-isolation=none --test` → 140 tests, 140 passed, 0 failed, exit 0.
- Skill quick_validate → `Skill is valid!`.
- `git diff --check` found no tracked whitespace errors; current src/tests/Skill files were already untracked work before this change, so this is not a complete new-file lint claim.

## Skill behavior check

Read-only baseline with the previous Skill suggested sending T2 to the active Worker with “finish T1 first, then T2”; it also allowed new work while T1 was submitted but unaccepted. That reproduced the missing admission rule without touching a real Worker.

After the update, one independent seven-scenario walkthrough chose Manager-side queueing for active T1, submitted T1, and independent work in the same file; scoped amendments retained the original task; unsupported urgent preemption stayed queued; unknown native state prevented start; uncertain send preserved the reservation without blind retry. This is a behavioral walkthrough, not repeated statistical testing or proof of host enforcement.

## Boundaries at initial busy-Worker delivery

No real business task/state, timer, global installation, commit or push was changed by this fix. Updating repository files does not automatically reload another running Manager.

No automatic message dispatch, queue cancellation/reordering, pause/preemption, delivery ledger, host authentication or atomic host-send transaction is implemented. Native idle checks and authorized sends remain foreground Skill responsibilities. Caller values remain declarations. Direct host messages cannot be intercepted by the local runtime. Full task briefs must be durably stored and referenced by enqueue source.ref for recovery; the runtime stores task identity/title, not the full brief.

## Follow-up: queued-only cancellation

Implemented `cancel-queued` / `cancelQueued` for explicitly withdrawn, unstarted queued tasks. The Manager identity declaration, nonempty reason, original task/round and expectedVersion are checked under the existing lock. Cancellation preserves task and audit history, freezes queue time, leaves assignedAt null, and never counts as approval. It neither sends host messages nor stops executing work. Remaining FIFO order and reservations are preserved. A separate round closure permits approved/cancelled tasks; all-cancelled closure means requirements withdrawn, not delivered.

Evidence:

- Seven initial cancellation tests failed on missing capability before implementation; progress projection failed on missing cancellation count before that change.
- Final full command `node --experimental-test-isolation=none --test`: **149/149 passed**, 0 failed, exit 0 (nine additional tests relative to the previous 140 baseline).
- Tests cover T1 executing / T2 cancelled / T3 queued preservation, six started-task states rejecting cancellation, exact caller/reason/version, retained audit validation, immutable terminal state, FIFO, all-cancelled closure, frozen waiting, and concurrent start-versus-cancel.
- Independent review found no Critical/Important blockers. Its Minor test-quality finding was corrected: terminal mutation tests now use event-valid fields and specifically assert the immutable-state error.
- Skill baseline could not remove withdrawn queued work through supported commands. After reference updates, a read-only three-scenario walkthrough correctly used local cancellation, rejected cancellation after start with uncertain delivery, and distinguished all-cancelled closure from acceptance. This is reference validation, not a live host test.
- Skill validator: `Skill is valid!`. Tracked `git diff --check` passed; this does not lint all preexisting untracked files.

No real team, automation or global installation was changed. Queue reordering, cancellation of started work, automatic dispatch, and uncertain-delivery recovery remain unsupported. Updating this checkout does not automatically reload another task's Skill context.

## Follow-up: same-task delivery recovery (2026-09-07)

The previous boundary was narrowed by local `delivery-check`, `delivery-claim`, and read-only `delivery-plan`. Assignment history without delivery records remains unknown. Exact checked non-delivery permits a new CAS claim for the same task; the claim starts unknown before any host call. Business stages, reservations, queue order, models and reporting preferences are unchanged. Unknown or delivered cannot be claimed again.

- Initial nine tests failed for missing events/API, then passed after implementation.
- Independent review reproduced two gaps: legacy work observations without audit could contradict an imported claim; block/unblock planning incorrectly offered a claim that execution rejected. Two regression tests reproduced both and passed after fixes, including later/same-time legitimate observations.
- Final full command `node --experimental-test-isolation=none --test`: **160/160 passed**, 0 failed, exit 0 (11 new tests beyond 149). Targeted recovery tests: **11/11 passed**.
- Companion Skill `quick_validate.py`: `Skill is valid!`, exit 0. Tracked `git diff --check`: exit 0, only existing Windows line-ending conversion warnings; this does not cover untracked files.
- Independent follow-up review confirmed both findings closed and no new blocking findings. No host-send or exactly-once guarantee is inferred from local tests.

The pre-update Skill walkthrough found conservative hold/reconciliation guidance but no durable executable same-task retry claim. An independent updated-reference walkthrough covered six cases: timeout + continue, exact non-delivery, claim + crash, accepted transport before work completion, progress:false observation, and fresh start before send. It selected conservative reconciliation, checked claim then at most one send, and supervision as appropriate. A minor old usage paragraph was clarified to explicitly require check → claim. These are behavioral walkthroughs, not live host tests or a statistical guarantee of agent compliance.

No real team, automation, global Skill installation, commit or push was changed. Permanently unresolved delivery still retains its reservation; automatic release, preemption, reassignment and host-send atomicity remain unsupported. This checkout update does not automatically refresh existing Manager contexts.
