# Registry Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development. Execute tasks sequentially with task review and a final integration review. Do not commit or push without a new user request.

**Goal:** Safely adopt legacy teams into MCP identity authority without losing ongoing work.

**Architecture:** Prepared schema fence, immutable runtime link and forward recovery.
Python exports validated identity projections; Node remains the business validator.

**Tech Stack:** Python 3.10+, MCP 2, Node 22+, JSON and local exclusive file locks.

## Global Constraints

- Preserve existing member/thread IDs, task IDs, round bindings, events and ongoing work.
- MCP owns current identity; Node owns business history. No independent shadow roster.
- Lock order is registry, business state, reporting ledger; never steal locks.
- No real team mutation, native messages, hooks, timers, model changes, commit or push in implementation tasks.
- Use TDD, bounded focused tests and independent review; legacy tests must remain passing.
- Native identities and authorization references are caller declarations, not authentication.

## Task 1: Node checked projection and pure migration adapter

Ownership: `src/runtime.mjs`, `src/store.mjs`, `src/reporting-store.mjs`, new
`src/registry-projection.mjs`, new `src/registry-adapter.mjs`, affected Node tests.

Interfaces: `registry-projection.mjs` validates and applies exports, calls the fixed
Python module exporter using CODEX_TEAM_CONTEXT_PYTHON, and supplies cross-store
locking to store/reporting. Export argv contract:
`python -I -X utf8 -m codex_team_context.runtime_link export --registry ABS --team ID`.
The exporter prints JSON only. Nonzero exit/invalid JSON fail closed.

Node `registry` exact fields: registryId, registryPath (absolute), teamId,
migrationId, sourceSha256 (64 lowercase hex), sourceVersion (safe nonnegative int),
phase (prepared|active), teamRevision (nonnegative int), readyMemberIds (unique IDs).
Prepared has teamRevision=0 and empty readyMemberIds. Team ID equals state.team.id.

Exporter exact output fields: registryId, teamId, teamRevision (positive int),
migrationId, statePath (absolute), members (Node-shaped full retained roster),
readyMemberIds. Exact binding/team/link/state-path checks precede projection.
Export validates history on the Python side. Reject disappearance, role or binding
changes to previously cached members; lifecycle may only become exited. Retain all
historical actors. Operational state projection remains read-only until business
transaction writes its ordinary next state.

Pure adapter: `node src/registry-adapter.mjs` reads one JSON stdin request, outputs
one JSON result. No file reads/writes or subprocesses. Exact operations:
`{action:'inspect',state}` -> validated state;
`{action:'prepare',state,registry}` -> validated schema-2 prepared copy;
`{action:'activate',state,projection}` -> active projected state;
`{action:'check_exit',state,memberId}` -> `{allowed:true}` or failure if member
participates in an open round. Adapter failure uses stderr and nonzero exit.

Add event `admitRegistryMember` with caller, roundId, memberId; Manager-only,
active linked state, ready bound active Worker, open round, member not already
present; append exact current member snapshot, never replace old members.
All linked evolve calls reject prepared phase and legacy identity event types.
Actor and leader readiness gate writes; assign/enqueue/startTask additionally check
selected Worker readiness. Existing busy/FIFO/ownership rules remain intact.
Operational reads use projection; ordinary writes hold registry then state locks
and re-read before evolve. Reporting persistence must use the same state guard.

- [ ] RED: add `test/registry-link.test.mjs` (use actual repository test folder if different) asserting prepare rejects ordinary writes, histories unchanged, malformed projection denied, stale registry unavailable denies writes, exited/binding conflicts fail, readiness gates, explicit open-round admission preserves old tasks. Run targeted Node tests and retain the expected failures.
- [ ] GREEN: implement exact contracts above, using fixed argv child execution and no shell. Add snapshot registry revision context without exposing local paths unnecessarily.
- [ ] Verify targeted tests plus full `node --experimental-test-isolation=none --test` once; report actual output and TDD evidence in `artifacts/cutover-task-1-report.md`.
- [ ] Independent task review; fix relevant findings before Task 2.

## Task 2: Python adoption, linked mutations and recovery

Ownership: `python/src/codex_team_context/{team_registry,registry_store,server,team_policy}.py`,
new `runtime_link.py` (fixed subprocess bridge/export/linked-state guards),
new `adoption.py` (adoption request/import/recovery only), Python tests.
Keep these responsibilities separate rather than placing all new orchestration
inside the already-large team_registry.py; reuse its authority/history validators.
Consume Task 1 pure adapter and exporter contract; do not invent a second Node
business validator. Add schema-3 explicit adoption with strict operation-history
validation, immutable link, source hash/version, Manager/consent checks, exclusive
backup/fence/import/activation and identical-operation forward recovery.
All linked manage calls hold Registry then state locks and use the pure Node
adapter for state validation/open-round exit checks. Existing schema-2 operations
and read-only behavior remain compatible. Export is read-only with full Registry
validation and no Node recursion. Capsule carries runtime locator/integration and
current onboarding while preserving unknown-null and error distinctions.

Exact adoption request (all fields required):
```json
{"action":"adopt_legacy","operation_id":"migration-1","team_id":"legacy-team","team_name":"Legacy team","member_id":"manager","state_path":"ABSOLUTE_CANONICAL_STATE_PATH","expected_state_version":6,"expected_state_sha256":"64-lowercase-hex","members":[],"authorization_ref":"user-approved-adoption","consent_ref":"verified-existing-liaison-confirmation"}
```
`members` is the complete source state's Node-shaped roster, not only active
members. It is supplied explicitly so the persisted operation can reconstruct the
Registry import without reading a mutable old state. Reject the request unless
state.team id/name and members match exactly, its version/byte hash match, every
binding is bound, Manager is active and equals the declared caller, and the
session invitation is confirmed for the exact Liaison. Authorization and consent
references record external checks; they are not proof themselves. Source strings
that exceed Registry bounds are rejected before any fence, not truncated.
Because the operation ID occurs in a Windows backup filename, adopt_legacy alone
requires `[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}` (no colon). Other operation/member IDs
keep their existing grammar. Reject a filename-unsafe migration ID before writing.

Schema 3 retains the root's five fields. Adopted teams additionally have `runtime`
with exact fields `statePath,migrationId,sourceVersion,sourceSha256`; other teams
retain their schema-2 shape. `adopt_legacy` is a bootstrap alternative at revision
1 with result `{operationId,teamId,teamRevision,memberId,outcome:'adopted'}`.
Import all source members with binding revision 1, original lifecycle and pending
onboarding, shared authorizationRef and Liaison consentRef. Ordered operation
replay reconstructs the complete imported team and immutable runtime link from
the stored request; usual uniqueness and exact-shape checks apply. Schema 2
cannot contain runtime links or adoption operations. New initialization remains
schema 2 until explicit adoption upgrades it. Capsule registrySchemaVersion is
the actual stored version, not an unconditional constant.

Backup is deterministic `${state_path}.${operation_id}.before-registry.json`,
exclusive and byte-identical. Publish it by same-directory temporary write,
flush/fsync, then non-overwriting atomic link, never direct copying to the final
name. A crash before publication leaves an ignorable own temporary file, not a
partial final backup. Verify a matching published backup before any fence.
Do not follow/overwrite existing conflicting backup
or state/Registry aliases. Same-operation recovery verifies the backup's digest,
source schema and exact request before using it. Read current state under locks;
prepared metadata must match this operation, registry identity/path and source.
Build and validate the candidate Registry before fencing so known conflicts leave
both source files unchanged. Commit Registry under its existing lock, activate
Node under its held state lock; if activation fails, retain committed Registry
and prepared state. Identical adoption retry verifies the durable operation and
finishes activation; changed retry fails. Active replay returns original receipt
without reverting subsequent business changes. No automatic rollback or lock theft.
An actual process kill can leave lock files. Identical retry must fail busy until
an operator confirms no surviving writer and explicitly clears the exact locks.
In subprocess-kill tests only, confirm that test-owned child process has exited
before removing its test-owned locks and reopening; do not claim automatic crash
recovery. Exception fault injection normally releases locks and is a separate test.

`TeamRegistry` constructor gains optional trusted `node_executable` and
`runtime_root`; `create_server` and `serve --node-executable --runtime-root` pass
them through. They are required only for linked operations/reads; registry-only
and export paths do not require Node. Values must name operator-configured
absolute executable/root paths. Never accept executables via manage payload.
Run the fixed pure adapter using subprocess argv, bounded timeout and checked
JSON/exit status. The service config pins a stable runtime checkout on install;
do not add package data duplication merely for this task.

For normal manage on a linked team, keep the state lock through Registry commit,
validate active link and original source markers, then apply existing authorization,
revision and receipt rules. Imported pending members can still read/onboard; no
business write is claimed permitted until runtime checks pass. `exit_member` also
uses `check_exit`. Register/confirm changes need not rewrite Node immediately;
the next Node read projects them and the next business write persists the cache.
Registration does not automatically admit a new member into any round.

Expose a reusable RegistryStore `locked()` context manager (same canonical
`${registry_path}.lock`, O_EXCL, existing bounded waits) and reuse it inside
`transact`. Linked manage/adoption use `with store.locked():` then the state lock,
holding both through actual `_replace` and any adoption activation. Do not put a
short-lived state-lock context only inside the old transact callback: callback
return occurs before Registry replacement. Python and Node share exact lock-file
paths and exclusive-create semantics. Node itself owns the Registry lock while
running the non-locking export subprocess and until state replacement finishes;
no exporter locks or recursive Node invocation are allowed.

Linked capsule `runtime` returns `statePath,migrationId,phase,teamRevision,runtimeRoot,pythonExecutable` after
validating its state/link. runtimeRoot comes only from trusted service configuration;
pythonExecutable is the running service's `sys.executable`, never member input.
These let a member recover the trusted CLI location and set its per-command
CODEX_TEAM_CONTEXT_PYTHON exporter dependency without inspecting global secrets.
They are local-host locators, not cross-host executable authority.
executionIntegration is `connected` for active or
`migration-pending` for prepared. `dispatchAllowed` stays false: a context read
never runs business/native admission. Missing/corrupt state is an error, never
unregistered/null. Export reads full valid Registry but never inspects the Node
file: Node consumers validate the exact returned link against their loaded state.
Export readyMemberIds includes only active members with current-policy receipts.

Policy revision becomes 2 because the shared rule currently says the entire
Registry is context-only. Replace that rule with: `The registry owns current team
identity; a context read does not dispatch work or bypass runtime admission.`
Keep other duties unchanged. Existing positive policy-1 records remain readable
and their old ready receipts project as pending until explicitly reconfirmed.
Do not rewrite historical confirmations or silently mark anybody ready.

Regression example using actual cross-language runtime:
```python
receipt = registry.manage("fixture-host", "fixture-manager", adoption_request)
assert receipt["outcome"] == "adopted"
assert json.loads(state_path.read_text())["schemaVersion"] == 2
assert json.loads(state_path.read_text())["tasks"] == original["tasks"]
assert registry.read("fixture-host", "fixture-worker")["leader"]["threadId"] == "fixture-manager"
assert registry.manage("fixture-host", "fixture-manager", adoption_request) == receipt
```
Use test-owned temporary paths only. Inject filesystem replacement failures at
the actual write boundary for crash tests, not production test switches. Verify
reopening service after each failure and same-op resume. Test old v1 Node fixture
refuses migrated JSON with unchanged bytes and old v2 Registry refuses v3.

- [ ] Write failure-first tests for exact-source adoption, wrong actor/consent,
  conflict preflight byte stability, imported history and lifecycle, each durable
  crash boundary, idempotent recovery/conflicting retries, schema-2 compatibility,
  linked exits and lock exclusion, all-role recall/readiness and export.
- [ ] Implement explicit request schema and CLI/config boundaries; document exact
  finalized request shape before Task 3. Keep fixed trusted subprocess argv.
- [ ] Run focused Python tests with a fresh GUID basetemp; then full Python suite
  and real cross-language/SDK tests. Report in `artifacts/cutover-task-2-report.md`.
- [ ] Independent task review; close findings before integration.

## Task 3: Skill, documentation, installation and authorized live handoff

Ownership: shared Skill/team-context references, `docs/team-context.md`, runtime
usage and validation report. Explain same-role recall for every member, adoption
preflight, lock/forward-recovery boundary, current roster projection vs history,
onboarding vs dispatch, environment configuration and native reload requirement.

- [ ] Align docs with tested exact APIs and remove obsolete context-only statements
  only where connected implementation proves replacement.
- [ ] Run affected Skill contract tests/validator, integration regression and
  independent whole-increment review; record limitations accurately.
- [ ] Update local installation using stable package/runtime paths and preserve
  unrelated Codex config; verify package/config diffs, SDK startup and read.
- [ ] If native server needs reload, report that boundary without live mutation.
- [ ] Once updated native tools and complete real inventory are verified, hand
  adoption to the exact original Manager, then verify its receipts and all members.

## Routing and baseline

Requested frontier / global owner default; effective full because state migration
is high risk. Existing isolated branch `codex/manager-session-runtime`, base
`c1c790b`. Python baseline: 102 passed. Existing foundation ledger remains done.
