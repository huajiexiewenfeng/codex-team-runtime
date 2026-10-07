# Continuous local metrics

An explicit local grant enables a managed policy for one registered team. The
policy is independent of the frozen statistics cutoff. Nothing wakes an Agent,
starts a timer, scans every session, or guesses a path from an evidence reference.

## Enable once

The source owner supplies an absolute-path request with `authorizationRef`,
`hostId`, `managedRoot`, `indexPath`, `sessionRoots`, `observationRoot`,
`observationTeams`, `historicalFrom`, `expiresAt`, `legacyManifestPath` (or null)
and `activityManifests` (or []). `historicalFrom` through expiry is at most 366
days; choose an explicit permission window. Paths and permission changes are
local owner operations, never HTTP parameters. The grant must explicitly permit
the selected local thread-index metadata and bounded session metadata/usage reads.

```text
node <runtime>/src/cli.mjs stats-managed-plan <state.json> <authorized-scope.json> <new-plan.json>
node <runtime>/src/cli.mjs stats-managed-apply <reviewed-plan.json>
node <runtime>/src/cli.mjs stats-managed-refresh <managedRoot>/policy.json
```

Planning captures current Registry identity/readiness; stale plans refuse. An
explicit request/authorization reference is caller-declared evidence, not an ACL
or consent generator. Only enable a team already authorized by the user.

Each foreground refresh verifies current team/state/native binding and reads only
the exact registered local ready thread IDs from the read-only SQLite index.
The query selects id/path/creation/update metadata, not titles, previews or
messages. Indexed candidates must be regular files beneath the approved session
roots without symbolic/junction traversal and match the bounded session identity
header. Raw parsing keeps metadata/usage fields, discarding prompts, output and
credentials. Per collection pass: 8 MiB and 1.5 seconds; discovery: 1 MiB total,
256 KiB per candidate. Backfill remains visibly partial until it finishes.
Inherited tool outputs without a call ID are diagnostic-only and cannot prove
completion; they do not stop later independent Token records.

Ready new members enter through exact native admission evidence when available;
old rounds amended with later members do not backdate admission. Rebound or
unproven identities start at first actual verification; departed bindings close
at the last verified active point. Gaps remain unknown. Rotation/index failures
preserve last-good contributions with source diagnostics. No business team state
or Registry membership is changed by collection.

Old explicit manifests/grants remain intact. The new managed manifest can retain
their historical inputs and disjoint authorized native/TC ranges. It never
rewrites an activity producer while a begin receipt is in flight. Existing task
producer history stays available after submission/approval. Policy and collector
locks serialize cooperating readers/revocation; the permission is rechecked
before each source and publication. Expiry/revocation blocks new reads, even with
a historical cutoff, retaining cached values with a stale policy status.

## Two permissions

`stats-managed-revoke <policy.json>` stops new reads/snapshots for that policy.
MCP observation recording has a separate persistent v1 `observedTeams` allowlist.
`stats-managed-observe <existing-allowlist.json> <approved-policy-paths.json>`
adds only active policy teams and preserves existing teams. The configured Python
recorder rereads this bounded file on each call; no reconnect is required.
Revoking a read policy does not revoke recording. Removing a recording grant
requires a separate explicit owner allowlist update. No history is synthesized
for previously unobserved teams, and configured with no records is not zero.

## Existing Dashboard and normal task handoff

Bind `dashboard-serve` to the policy's fixed `manifest.json` and `cache`. Existing
`stats-refresh` and Dashboard refresh recognize its policy reference and run the
same ensure/refresh, including expiry/revocation. The HTTP API cannot receive a
policy path, arbitrary file, command, roster edit or grant. Snapshot pagination
uses the captured source scopes/permission metadata, not tomorrow's grant.

Carry the verified policy path and own task ID in normal Worker handoffs. Set
`CODEX_THREAD_ID` to the verified current caller; this remains caller-declared and
must match Registry, ready role and an executing/rework own Worker task. Submitted,
reviewing and blocked tasks do not admit new command attempts. For real steps:

```text
node <runtime>/src/cli.mjs stats-managed-step <policy.json> <own-taskId> <stepId> <new-receipt.json> -- <executable> [args]
node <runtime>/src/cli.mjs stats-managed-begin <policy.json> <own-taskId> <stepId> <new-receipt.json>
node <runtime>/src/cli.mjs stats-managed-end <policy.json> <own-taskId> <receipt.json>
```

Use the command wrapper for a bounded real operation; begin/end for actual known
work boundaries. Manager/Liaison begin/end can declare their actual task
coordination, while the command runner retains its Worker-only contract. No
retroactive busy-team steps, idle/review wait inflation, guessed ends or full
Agent/CPU-time claims. A durable receipt prevents duplicate command execution;
unknown interrupted outcomes require reconciliation. Submission/notice/receipt/
acceptance protocols remain separate and unchanged.

Overview summarizes all deduped immutable records for the verified current
member/host/thread/role and one binding revision across authorization segments,
before epoch pagination. Token uses the existing rollup and overlapping intervals
use union. Native current revision is captured during managed collection;
unverified multi-revision identity stays unknown. True historical bindings and
their evidence remain separate in the member/history detail views.
