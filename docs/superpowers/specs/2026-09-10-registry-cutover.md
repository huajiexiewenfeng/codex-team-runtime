# Registry cutover increment

Status: implementation authorized by the user's approval to complete migration
integration, then let the existing Manager register the real team. This refines
increment 2 of `2026-09-10-team-registry-design.md`; no live migration has run.

## Boundaries

MCP is the sole current-identity authority after cutover. Node owns business events,
tasks, immutable historical round bindings and reporting preference. No hooks,
timers, new native tasks, role/model changes, commits or pushes are implied.
The actual Manager performs adoption from its own verified context. IDs and caller
claims are not authentication. Worker submissions cannot be fabricated by Manager.

## Protocol

Use one lock order everywhere: registry file lock, then business state file lock,
then (if needed) reporting-ledger lock. Never steal an existing lock. Read-only
projections need no writes; business writes must keep both locks through replacement.
Both languages contend on the canonical target's exact `${path}.lock` using
exclusive file creation. A Node writer owns the Registry lock itself while the
read-only Python exporter runs; the exporter does not acquire that lock again.
Python exposes a RegistryStore lock context so its state-lock scope includes the
actual Registry replacement and Node activation, not only a mutation callback.

Node schema 2 adds a `registry` record. A prepared state refuses ordinary operational
reads/writes; the explicit migration inspector can still report it. Old schema-1
executables reject schema 2 before writing. Historical collections and original
member IDs are not reconstructed or renamed.

Adoption is forward recoverable: validate exact actor/source version/source-byte
SHA-256 and complete bound roster; create an exclusive byte-identical backup;
write prepared fence; atomically import the roster plus immutable runtime link and
operation receipt into Registry; activate Node. Crashes leave either unchanged
legacy state, a prepared fence, or an active linked state.
The backup's final name is published only after same-directory temporary write,
flush/fsync and non-overwriting atomic link; a partial temporary backup never
authorizes fencing. Existing final backup must match exact original bytes.
Resume the same operation
and exact request, never bootstrap a second team or restore a pre-commit snapshot.
An abruptly killed process can leave owned lock files. Forward recovery does not
steal them: first an operator verifies that no writer survives and explicitly
clears only those locks, then retries the same migration. Tests distinguish
write-failure exceptions (normal lock cleanup) from process-kill recovery.
Reject conflicting global member IDs, non-bound members, unconfirmed pairing,
exited Manager, wrong actor, changed source and conflicting link destinations before
fencing. Initial adoption may preserve open work. No closure/approval is inferred.

Registry schema 3 extends the schema-2 authoritative history with an explicit
adoption operation and immutable per-team runtime link. Existing schema-2 data
remain readable; schema upgrade is explicit as part of an authorized adoption,
not a side effect of read. Old services must reject schema 3. Imported lifecycle
and stable IDs are preserved; imported active members start onboarding pending.
All later identity operations for linked teams obey the same locks; exits retain
records and refuse participation in open rounds. Registration never dispatches.

Node schema-2 current `members` is a cache, not a writable roster. Operational
reads obtain a validated Python export and project the latest current members and
readiness; writes do this under both locks. Cache refresh does not manufacture a
business event or alter historical members. Snapshot must disclose registry revision
alongside business version. Python export validates registry history without calling
Node. A separate pure Node stdin adapter validates/transforms business JSON without
reading Registry, avoiding recursive subprocesses.

Trusted executables are operator configuration, never executable paths supplied in
MCP mutation requests. Node uses CODEX_TEAM_CONTEXT_PYTHON to run the installed
Python exporter; MCP uses configured Node executable/runtime root for its fixed
pure adapter. Missing adapters fail closed. No shell command construction.

Legacy identity events are forbidden in linked states. New Worker admission to an
existing open round is an explicit Manager event, appending only that ready Worker's
snapshot. Existing round members, closed rounds and existing tasks remain unchanged.
Actor readiness and Manager readiness gate linked business writes; selected Worker
readiness additionally gates new assignments. Readiness never overrides busy/FIFO,
native-idle, delivery-reconciliation or acceptance gates. Native untracked work
must be reconciled by Manager before new dispatch.

## Deployment and live verification

Test synthetic adoption, all-role read, onboarding, new registration/admission,
busy Worker guards, original submission, crash/resume and corrupt/missing sources.
Use independent review before replacing installed package/Skill. Package/runtime
configuration must use stable trusted paths. Reload native MCP before using new
actions. A successful local/SDK test is not proof the live loaded server is updated.
Real inventory must be returned by Manager; missing inventory or native reload
pauses live cutover, not development. No automatic Worker wakeup during migration.
