# Manager operations local trial

This local-trial entry provides a Manager-only CLI and fixed host template,
with no MCP tool, Worker instruction or new state schema. Source files alone
do not prove installation. Use the entry only after an approved package has
been installed and its manifest, code hashes and actual entry have been
verified. Installation permission grants no new business dispatch or approval
authority: continue to use the existing human authorization and review rules.

## Entry and contract

```text
node <verified-runtime>/src/cli.mjs manager-request <trusted-state.json> <closed-request.json>
```

Read the JSON `status`, `effects`, `field`, `legal` and `nextAction`; a successful
shell invocation alone is not a business success. File-read and missing-module
errors also return structured JSON. The exported `managerOperationsSchema` in
`src/manager-operations-contract.mjs` is the same definition used by validation.
Inputs are at most 64 KiB; normal replies contain references, never full state.
Manager record time is generated as canonical UTC milliseconds. An `at` input
is rejected. External evidence times and all business strings remain unchanged.

All requests require these fields:

```json
{
  "schemaVersion": 1,
  "action": "enqueue",
  "operationId": "stable-operation-for-this-input",
  "caller": {"hostId": "verified-host", "threadId": "verified-manager"},
  "teamId": "verified-team", "roundId": "verified-round",
  "taskId": "exact-task", "workerId": "assigned-worker",
  "expectedVersion": 42, "mode": "legacy", "reason": "before_dispatch",
  "title": "Original task title", "required": true,
  "briefRef": "e04-brief:sha256:REPLACE_WITH_REAL_FROZEN_BRIEF_DIGEST"
}
```

The example placeholders are not valid requests. Use the actual frozen E04
reference. `mode` must match the existing ledger (`legacy` when absent);
`observe` and `queue_first` require their existing E05 ledger and pass its
original native Registry/leader fence. No operation initializes or changes modes.
Identity is caller-declared, not authentication. Host permission still governs
native sends. Evidence references do not establish truth or create authorization.

`reason` uses the existing E05 contract's `inboxReasons`; an offline assertion
checks it against Python `observations.REASONS`. Legal values are `onboarding`,
`resume`, `post_compaction`, `before_dispatch`, `before_delivery`, `before_review`,
`identity_conflict`, `manual`, `unknown`. Choose the real trigger; errors do not
authorize changing a reason to `manual`.

Add exactly the fields for the selected action:

| Action | Additional fields | Existing effect |
| --- | --- | --- |
| `enqueue` | `title`, `required`, `briefRef` | Original `enqueue` event; remains queued |
| `receive`, legacy/observe | `submissionId`, exact original `notice` | `planSubmissionReview` + original `review` via CAS engine |
| `receive`, queue_first | `submissionId`, `claim` | Original E05 `start_review` intent/business/projection |
| `record_decision` | `submissionId`, `reviewEventId`, `decision`, original `summary`, `evidence`; also `claim` for queue_first | Original `approve` or `rework`; requires current reviewing submission |
| `status` | original `requestFingerprint`; also `submissionId` for a receive/decision | Read-only lookup of exact original effect |

`claim` is the existing `{runId,generation,claimId,itemId}`, copied from the
actual checkpoint/claim flow. The entry does not create, claim or steal work.
Decision checks current owner/claim, exact task-review work, complete leader
binding and known effect state. `approve` needs 1–16 original independent evidence
references; `rework` uses `evidence: []`, because its original event has no evidence
field. Strings retain original contents and are limited by the original 4000
character core limit. Large diffs/briefs stay in the original immutable references;
they are never silently truncated into approved content.

## Stable requests, retries and status

Retain each original request file in the task's existing evidence directory.
Freeze `operationId` once. Returned `requestFingerprint` is SHA256 over the entire
closed input, including actual `expectedVersion`, identity, target and mode.
The event ID uses a 192-bit operation locator plus this full fingerprint within
the existing 128-character ID limit. E05 uses that same ID as its original
operation ID. These are correlation digests, not signatures. No second ledger,
event field, migration or old-writer format was introduced.

A proven exact replay returns the original event reference without another
business event. Changed input with an already committed operation ID is rejected.
CAS conflicts never substitute a newer version. Inspect changes before creating
a corrected request with a new operation ID. Ignored/stale legacy receives have
no new event and explicitly have no durable replay proof.

For `status`, keep the original `operationId` and fingerprint, supply the exact
original task/round/Worker and (for reviews/decisions) submission. Do not hash the
status request itself. Output is bound to the original event/E05 claim, so another
existing task cannot relabel a recorded effect. A missing task or absent operation
is `unknown`, not proof that an interrupted writer had no effect. Confirm original
execution ended before deciding how to proceed; never blindly resend.

Effects have separate meanings: `none` means no effect by the current validated
operation, `partial` means an existing E05 intent is durable, `committed` proves a
business event (or finished E05 operation), `unknown` needs reconciliation. An
error can report `committed` with projection pending. A recorded decision does not
mean inbox resolve, native receipt, deployment, or business verification succeeded.

## Fixed functions.exec host path

The directly pasteable template is
[`manager-operations-functions-exec.js`](../scripts/manager-operations-functions-exec.js).
It uses only `tools.exec_command`, `tools.write_stdin` and the actual native send
tool. It requires no Node import/fs in `functions.exec`. A trusted Node bridge
runs the original Runtime code through the existing shell tool. No new global
tool is registered. The environment must already expose those host capabilities.
Supply the **verified absolute installed Python exporter executable** separately
as `pythonExecutable`. An ordinary shell does not inherit the MCP launcher's
exporter configuration. The template passes this path as an argument to the
current Node child; the bridge validates that file and supplies `options.python`
to the existing Registry exporter. It does not set `CODEX_TEAM_CONTEXT_PYTHON`,
change global environment/configuration, scan for Python, or install anything.
Missing/relative paths are rejected before tools run; nonexistent files return a
bounded `CAPABILITY_UNKNOWN` with `field: pythonExecutable` from the actual bridge.
An existing but unsuitable exporter retains its concrete process failure message.

Save an immutable dispatch input in the task's existing evidence directory:

```json
{
  "statePath": "ABSOLUTE_TRUSTED_STATE",
  "enqueueInput": {
    "schemaVersion": 1, "action": "enqueue", "operationId": "stable-enqueue",
    "caller": {"hostId": "VERIFIED_HOST", "threadId": "VERIFIED_MANAGER"},
    "teamId": "TEAM", "roundId": "ROUND", "taskId": "TASK", "workerId": "WORKER",
    "expectedVersion": 42, "mode": "legacy", "reason": "before_dispatch",
    "title": "Original title", "required": true
  },
  "brief": {
    "schemaVersion": 1, "teamId": "TEAM", "roundId": "ROUND", "taskId": "TASK",
    "actor": {"hostId": "VERIFIED_HOST", "threadId": "VERIFIED_MANAGER"},
    "text": "Original authorized brief", "scope": "Original write scope",
    "materialRefs": ["REAL_MATERIAL_REF"], "authorizationRef": "EXISTING_AUTHORIZATION",
    "dependencyRef": "ACTUAL_PREREQUISITE_CHECK"
  },
  "prepareInput": {
    "operation_id": "stable-e04-prepare", "reason": "before_dispatch",
    "admission": {"native": {"host_id": "VERIFIED_WORKER_HOST", "thread_id": "VERIFIED_WORKER_THREAD", "status": "idle", "evidence_ref": "ACTUAL_NATIVE_IDLE_CHECK"}},
    "baseline": {"outcome": "not-attempted", "evidence_ref": "ACTUAL_NO_SEND_OR_INFLIGHT_CHECK"}
  },
  "hostEvidencePath": "NEW_ABSOLUTE_TASK_EVIDENCE_FILE"
}
```

Do not invent idle, dependency, authorization or no-send evidence. These remain
Manager/host checks; Runtime carries their original references and preserves its
busy/FIFO guards. The template defaults to no send permission. Set the preflight
only after existing explicit human authorization, and retain its real reference.
This declaration does not bypass the native tool's own authorization boundary.

After pasting the complete template, execute:

```js
text(await runManagerOperations({tools,
  nodeExecutable: 'C:/Program Files/nodejs/node.exe',
  pythonExecutable: 'VERIFIED_ABSOLUTE_INSTALLED_VENV_PYTHON.exe',
  runtimeRoot: 'VERIFIED_CANDIDATE_RUNTIME',
  requestFile: 'EXISTING_IMMUTABLE_DISPATCH_INPUT.json',
  hostSendAuthorized: false, authorizationRef: null
}));
```

The fixed path freezes the brief, uses its real returned reference for enqueue,
then uses the real enqueue event for E04 prepare. Only a fresh, non-replayed
`sendNow: true` invokes one native send. The actual attempt is passed to result;
raw native output is saved exclusively as task evidence. Only the exact observed
native receipt shape proves host acceptance; unexpected shape/exception is unknown.
Denied, unknown, missing output, queue failure or replay never triggers another
send or native fallback. A result error leaves the prepared attempt for status
and exact result reconciliation. No cross-system atomicity is claimed.
Prepare errors retain the top-level `reasonCode`, `field`, bounded `message` and
completed stage references, including when the inner `stages` object is empty.
The template does not turn a concrete exporter error into an empty stopped result.

For direct shell diagnostics the bridge syntax is:

```text
node <runtime>/scripts/manager-operations-bridge.mjs <prepare|result|status|receive|decision> <request.json> <base64-UTF8-payload> <verified-absolute-python-executable>
```

Use `e30=` for an empty payload `{}`. CLI calls require the explicit exporter
argument and never fall back to an inherited environment variable. Do not run
prepare again to recover lost stdout; use status with the original request.

For receive, save `{statePath,request}` with a validated `receive` request, then
call `runManagerReviewStage({...paths,tools,phase:'receive'})` in an invocation
containing the template. This **only starts review**. Inspect original evidence
and perform authorized independent checks separately. Only after an explicit
Manager decision save `{statePath,request,resolveRequest}` and call
`runManagerReviewStage({...paths,tools,phase:'decision',managerDecisionConfirmed:true})`.
`resolveRequest` is optional for legacy/observe and required to finish a
queue_first claim; provide actual current E05 control/work revisions. The bridge
passes the actual decision event to E05 resolve. A resolve failure returns
`resolve-pending` and preserves the decision; it does not repeat approval.
Here `paths` includes `nodeExecutable`, `pythonExecutable`, `runtimeRoot` and
`requestFile`; receive and decision use the same explicit per-child exporter.

The dedicated `test/manager-operations-shell.test.mjs` uses a real PowerShell
process, Node bridge and installed Python package against a validated, linked
temporary Registry. It intentionally removes the inherited exporter environment;
only the native sender is fake. Run it with a verified `MANAGER_OPS_TEST_PYTHON`
test locator. Without that explicit locator, or off Windows, the shell integration
tests skip rather than scan or install dependencies. This is not a Worker step.

## Compatibility and rollback

All new imports are inside the `manager-request` route or Manager-only scripts.
Existing Worker/Liaison startup, recovery, read/ready, receipts and required files
are unchanged. Old CLI writes remain readable: only already-valid original
events and original E04/E05 records are used. Stopping this entry does not require
restoring old state. Preserve any unknown attempt and E05 review intent; use the
original compatible status/recovery entry, never reset state or retry a send.

The inspected installed companion contains E04 and lacks the two E05 modules.
The code-only trial package adds these two exact dependencies alongside the
three Manager modules, bridge and fixed template. Merely installing their code
does not initialize an inbox, switch mode or register an MCP tool. Existing
shared modules, including the different installed Worker runtime, are retained
byte for byte. Missing Manager dependencies return `CAPABILITY_UNKNOWN`.

## Local trial package and adoption

The reviewable local package is under
`artifacts/manager-operations-install-readiness-20261029/package-final` in the candidate
workspace. `manifest.json` pins every payload file, the installer, the actual
installed baseline and Node/Python capability identities. `SHA256SUMS` is a
readable inventory; use the independently reviewed manifest hash in the delivery
report as the trust root. Do not substitute a newly calculated hash for a failed
check. The package has no dependency installation step.

The only changed existing product files are:

- Companion `src/cli.mjs`: installed original plus the lazy `manager-request`
  route, without the source `inbox-*` CLI routes.
- Global `manager-session/references/manager-supervision.md`: installed original
  plus one short Manager-only route. Existing recall/wait guidance is retained.

New companion files are the five Manager/E05 modules listed above,
`scripts/manager-operations-bridge.mjs`,
`scripts/manager-operations-functions-exec.js`, and this Runtime document.
The installer never writes Python, MCP/config/model settings, shared SKILL.md,
structured-submission.md, Worker/Liaison rules, notification prompts or data.
Tests, synthetic fixtures, benchmarks and verification scripts are not payload
dependencies. Global effect is limited to Managers that use this one installed
Skill/companion; no registered team is changed by installation.

Run the package's `install.mjs` using verified Node. Commands are `preflight`,
`install`, `verify`, `rollback` and `recover`; each requires
`--manifest-sha256 <reviewed-hash>`. Install/rollback/recover additionally require
`--receipt <new-or-original-absolute-receipt-directory>` under this delivery's
`receipts/`. A real destination mutation additionally requires the explicit
`--apply-real-install` flag; it is not authorized by preparing this package.
The delivery report provides fully resolved commands. For rehearsals,
`--sandbox-root <delivery-evidence-root>/sandboxes/<unique-name>` selects only
that copy's `companion` and `manager-session` directories. No arbitrary target
override is accepted.

Preflight rejects changed/missing baseline files, occupied new payload paths,
package hash mismatch, symlink paths, unsupported/drifted Node/Python and an
incomplete prior installation. It probes Python imports/signatures/code hashes
without opening any Registry. Backups contain only the two original code files;
the receipt records expected before/after hashes. Each replacement is a staged
rename, with a durable journal and an installation lock. Stop concurrent use of
the new entry during this brief multi-file code update: this is not a live
multi-file atomic swap. Ordinary exceptions attempt code compensation. Abrupt
process death leaves an explicit pending lock/receipt: use `recover` with that
same receipt after the original installer has exited; do not force another
install. A preparation-only failure before the first receipt cannot have
changed a target file, and any partial backup directory is retained.

Application order is new dependencies/template/document first, CLI activation
second, Manager-only Skill route last; rollback reverses that order. The target
hash is checked again after any awaited hook and immediately before replacement.
A detected concurrent code edit is preserved and reports `ROLLBACK_PENDING`
rather than restoring a backup over it. The package lock coordinates this
installer's own invocations; hash-check plus rename cannot eliminate every OS
race with unrelated writers. Coordinate other code editors/installers for the
short installation/rollback window. No business process or data needs resetting.

Rollback prechecks all destination and backup hashes before restoring code.
Parallel changes cause refusal, with the installed code and evidence preserved.
New files are unlinked individually only when their exact paths and hashes match
this batch. There is no recursive deletion. Unknown attempts, new submissions,
review intents, notification receipts and all task/Registry facts survive both
normal rollback and interrupted-install recovery. Do not restore a state snapshot
or resend a task as a rollback action. If an E05 review is in progress, reconcile
it before rollback or retain this package's pinned Manager module for exact
operation inspection; the old installation has no E05 CLI. Reinstalling the
same reviewed code is a separate code action, never a request to reset facts.

No Codex restart is required by the verified call chain: the fixed template
starts a new Node bridge process per phase, CLI runs in a new process, and the
installed Python `runtime_link.invoke_adapter` starts Node with `subprocess.run`.
Python/MCP configuration and long-running server code are unchanged. Existing
conversations do not magically reread Skill text. At the next already authorized
Manager supervision/dispatch checkpoint, reload the installed
`references/manager-supervision.md` once as part of the existing invocation,
then read this document and load/fill the fixed template within that invocation.
Do not add a supervision cycle, Worker instruction or standalone loading round.
Verify installed files first; preserve the team's current mode. Receive and
decision remain separate, with independent review in between. The direct
`manager-request` CLI retains the existing per-child exporter environment
contract; the preferred fixed bridge passes the absolute Python argument
explicitly, without environment dependency.

The user starts real trial work. Retain only the task/operation/attempt IDs,
current mode and task category, actual tool/model call counts if available,
send count/outcome, queue/busy/CAS/error branches, review/decision references and
whether recovery was needed. Unknown Token/cost data stays unknown. Compare
with a comparable existing workflow without creating extra business samples.
Stop adopting this route on duplicate send, identity/claim/CAS inconsistency,
missing evidence, unknown/partial effect, capability drift or added Worker steps;
inspect the exact existing operation and evidence before choosing recovery.
Stopping adoption does not mean resending through the old path. Natural adoption,
real host delivery, model calls/Token/fees and field effects remain unverified.
