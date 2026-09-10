# Team Registry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Persist all-member identity/team/leader and Manager-owned onboarding in the optional MCP.

**Architecture:** Explicit v2 context-only registry separate from legacy v1 locator mode. One atomic JSON transaction owns members and operation receipts. Node cutover is a separately gated increment.

**Tech Stack:** Python 3.10+, existing MCP 2.x, pytest; existing Node runtime unchanged.

## Global Constraints

- No AGC dependency, hook, global prompt changes, timer or host messaging.
- Host/thread IDs are caller-declared, not host-authenticated.
- Only the exact active team Manager writes membership/readiness; explicit external authorization for bootstrap.
- No existing team adoption, global install, commits or pushes.
- V2 capsules always have `executionIntegration: not-connected`, `dispatchAllowed: false`.
- Preserve dirty-worktree changes and Node historical ownership/consent/busy-worker guards.
- Implementation and review helpers use Sol / medium under the user's GPT-6 Astra parent.

## Task 1: Deterministic registry core

**Ownership:** new `python/src/codex_team_context/team_registry.py`, optional focused `registry_store.py` / `team_policy.py`, and `python/tests/test_team_registry.py`. No edits to old core, transport, docs, skill or Node.

**Interfaces:**

```python
def initialize_registry(path) -> None: ...
class TeamRegistry:
    def __init__(self, *, registry_path): ...
    def read(self, host_id: str, thread_id: str) -> dict | None: ...
    def manage(self, actor_host_id: str, actor_thread_id: str, request: dict) -> dict: ...
```

Consume existing `.core.ContextError`. Exact requests and invariants are in the
design's Core API/Capsule sections. Report actual output field shapes for Task 2.

- [x] RED: test unknown read is null and registry bytes unchanged; bootstrap yields pending Manager with self/team/leader and disconnected barrier.

```python
request = dict(action='bootstrap', operation_id='boot-1', team_id='team-1',
               team_name='Example', member_id='manager', name='Manager',
               authorization_ref='fixture:user-approved')
registry.manage('local', 'manager-task', request)
capsule = registry.read('local', 'manager-task')
assert capsule['member']['role'] == 'Manager'
assert capsule['dispatchAllowed'] is False
```

- [x] RED: denied Worker/cross-team writes, required Liaison consent, pending IDs,
  exited identity retention, exact retry/payload conflict, foreign/stale receipts,
  additions not staling receipts, restart persistence and concurrent CAS.
- [x] GREEN: implement strict loaded-data/request validation, bounded lock and
  atomic replacement, deterministic capsule and Manager mutation protocol.
- [x] Run focused tests and self-review. Record RED/GREEN commands, output shapes
  and concerns in `artifacts/team-registry-task-1-report.md`, without committing.

PowerShell test pattern, unique basetemp each run:

```powershell
$registryTestDir = Join-Path $PWD ('artifacts/registry-core-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $registryTestDir) { throw 'Refusing reused test directory' }
& 'artifacts/team-context-venv/Scripts/python.exe' -m pytest python/tests/test_team_registry.py -q --basetemp $registryTestDir
```

## Task 2: MCP mode boundary

**Ownership:** `server.py`, `test_stdio.py`, new `test_registry_stdio.py` under
existing Python directories. Parent owns documentation. Consume Task 1 API.

**Interface:** `create_server(*, registry_path=None, index_path=None, state_roots=None)`;
exactly one mode. CLI `init --registry <new.json>` / `serve --registry <json>`.
Legacy `--index` remains init/read-only serve with state roots; never auto-convert.

- [x] RED: real SDK stdio lists read/manage for v2, only read for legacy; no server
  instructions; readOnlyHint true only for read.
- [x] RED: bootstrap, Manager read, register Worker, Worker read, Worker manage
  denial, Manager confirm receipt, ready reread, all disconnected; invalid request,
  null/error JSON and overwrite refusal. Retain process-teardown verification.
- [x] GREEN: wrap Task 1 with JSON success/known ContextError output, preserving SDK-native top-level validation errors. Seed legacy
  fixtures through old Python API; remove old unscoped registration MCP tool.
- [x] Run affected tests; write `artifacts/team-registry-task-2-report.md`.

## Task 3: Shared skill reference and acceptance

**Ownership:** parent: `skills/manager-session/SKILL.md`, new
`references/team-context.md`, `docs/team-context.md`, validation evidence, README.

- [x] Route all-member recall and Manager-owned registration via a compact shared
  reference. Preserve current model, ownership, notice, busy-worker and timer rules.
- [x] Document context-only v2 vs read-only legacy, no live adoption, and separate
  Node cutover. A ready receipt is not native authentication or dispatch permission.
- [x] Independent task and integrated review; resolve important findings with
  affected tests. Preserve reports for recovery.
- [x] Combined Python verification with fresh basetemp; affected skill/Node tests;
  UTF-8 skill format validation. Record actual results and unverified behavior.

## Deferred cutover

Foundation accepted 2026-09-10: final parent Python 102 passed, affected Node/Skill
23 passed, Skill format valid, independent integrated review PASS. See
`docs/team-registry-validation.md`. No commit, push, global install, or live adoption.

Explicit legacy adoption, Node projection/authority gates, cross-store recovery,
onboarding-gated real dispatch and open-round recruitment are not completion
checkboxes for this foundation. Foundation completion is not end-to-end completion.
