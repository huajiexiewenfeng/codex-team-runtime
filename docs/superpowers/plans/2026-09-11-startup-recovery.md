# Durable startup receipts and recovery

**Goal:** Recover a created native member's formal identity when creation returns
only a client ID and task listing or reply delivery omits that member.

**Scope:** Deterministic Python MCP + existing Manager Session references. No live
team writes, native creation/messages, timers, hooks, installation or publishing.
Existing submission-recovery changes remain untouched.

## Contract

- One `team_context.startup` tool in Registry mode with configured trusted runtime.
  Actions: `prepare`, `claim`, `record_creation`, `receipt`, `verify`, `plan`.
- Fixed Registry-adjacent `.startup.json` ledger; tied to Registry ID. Only startup
  records change. Formal roster and original Node state never change via this API.
  Review added independent write-once `.startup-claims/` guards: a lost or old
  sidecar cannot reset the original creation claim. Whole-store tampering/rollback
  and post-claim receipt-history rollback are explicitly outside that guarantee.
- Manager prepares an immutable operation/member slot against the original state.
  A one-shot claim precedes native creation. Replayed claims never grant a second
  create. Missing outcome means reconcile, not retry or a replacement operation.
- An unregistered member may publish its own bounded candidate identity receipt
  for that slot. A receipt is caller-declared data, not registration, consent,
  native authentication, readiness or dispatch permission.
- Manager independently reads the exact native task and verifies a selected
  candidate with evidence. Conflicting candidates do not take over the slot.
- Read-only plans derive next steps from current original state and Registry:
  creation claim/reconciliation, receipt, native verification, real pairing,
  registration, original adoption recovery, own recall/readiness, admission.
- No timers or autonomous native actions; no automatic membership mutation. All
  existing identity, consent, adoption, readiness and dispatch gates remain.

## Implementation / tests

1. Add `python/tests/test_startup_recovery.py` first. Observe absent implementation
   failure, then implement `python/src/codex_team_context/startup.py` and narrow
   server wiring. Reuse trusted Node inspect and existing Registry locking.
2. Exercise temporary client IDs, child-before-create-result race, missing lists,
   restart, one-shot claim, exact replay/conflicts, wrong actor/team/role/host,
   malformed receipts, multiple candidates, stale binding/exit, Registry errors,
   read-only planning and atomic failures. Use real Node fixtures, not live tasks.
3. Cover end-to-end pairing/adoption/readiness and configured MCP stdio transport;
   preserve existing default and legacy tool catalogs and null reads.
4. Update activation and shared onboarding references plus one focused runtime API
   document. Run old/new isolated reference-retrieval scenarios and Skill checks.
5. Run relevant Python Registry/stdio/activation and Node Skill tests, independent
   review and `git diff --check`. Report fresh evidence and remaining limitations.

## Evidence boundary

Host identities and evidence references are externally verified declarations,
matching the existing MCP contract. This feature cannot authenticate a malicious
caller or atomically transact with native task creation. Unknown creation remains
blocked pending evidence; the conservative claim can consume an unsent attempt.

## Progress

- [x] RED: behavior and reference baseline
- [x] GREEN: ledger, transport and end-to-end recovery
- [x] References and retrieval verification
- [x] Review and affected regression checks

Baseline reference test could only wait for a native message or ask a person for
member IDs; no documented durable receipt channel existed. New reference testing
selected receipt -> plan -> exact native read -> verify -> original onboarding,
including a no-operation-ID restart and null Worker context. A sample invented
receipt label exposed a reference gap; docs now require the exact returned hash.

Independent review found a sidecar-loss/preclaim-rollback duplication risk. Five
tests first reproduced it; write-once creation guards address it without changing
formal Registry schema. Review also prompted precise state-lineage limitations
and checking all prepared member slots before recommending adoption.

Final verification: 65 Python tests passed across startup recovery/stdio, fresh
activation, Registry cutover/stdio and legacy stdio; 16 Node tests passed for the
Skill and Registry projection. Skill quick validation and tracked/new-file diff
checks passed. Fresh reference application passed after requiring the actual
returned receipt hash. Independent re-review reported no Critical/Important
remaining issues within the documented evidence boundary.

No live native creation/send or team/Registry mutation was tested; no installation,
commit or push was performed. Candidate capacity remains bounded at 16; there is
no automatic cleanup or unsafe creation-reset API.
