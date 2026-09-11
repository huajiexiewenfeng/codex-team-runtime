from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from codex_team_context.core import ContextError
from codex_team_context.registry_store import RegistryStore
import codex_team_context.adoption as adoption_module
from codex_team_context.runtime_link import export_registry
from codex_team_context.server import _parser, create_server
from codex_team_context.team_policy import onboarding_receipt
from codex_team_context.team_registry import TeamRegistry, initialize_registry


NODE = Path("C:/Program Files/nodejs/node.exe")
ROOT = Path(__file__).resolve().parents[2]


def legacy_bytes() -> bytes:
    runtime = (ROOT / "src" / "runtime.mjs").as_uri()
    script = f"""
import {{createState,evolve}} from {json.dumps(runtime)};
const source={{kind:'fixture',ref:'python-cutover'}};
const members=[
 {{id:'manager',name:'Manager',role:'Manager',lifecycle:'active',binding:{{status:'bound',hostId:'fixture-host',threadId:'fixture-manager'}}}},
 {{id:'liaison',name:'Liaison',role:'Liaison',lifecycle:'active',binding:{{status:'unbound'}}}},
 {{id:'worker',name:'Worker',role:'Worker',lifecycle:'active',binding:{{status:'bound',hostId:'fixture-host',threadId:'fixture-worker'}}}}
];
let s=createState({{teamId:'legacy-team',name:'Legacy team',source,members}},'2026-01-01T00:00:00.000Z');
s=evolve(s,{{id:'invite-1',type:'attachInvite',actor:'manager',at:'2026-01-01T00:00:01.000Z',source,caller:{{hostId:'fixture-host',threadId:'fixture-manager'}},target:{{hostId:'fixture-host',threadId:'fixture-liaison'}},expiresAt:'2026-01-01T00:10:00.000Z'}},0);
s=evolve(s,{{id:'confirm-1',type:'attachConfirm',actor:'liaison',at:'2026-01-01T00:00:02.000Z',source,caller:{{hostId:'fixture-host',threadId:'fixture-liaison'}},invitationId:'invite-1',invitationVersion:1}},1);
process.stdout.write(JSON.stringify(s)+'\\n');
"""
    result = subprocess.run(
        [NODE, "--input-type=module", "-e", script], capture_output=True, check=True
    )
    return result.stdout


def legacy_with_open_round_bytes() -> bytes:
    runtime = (ROOT / "src" / "runtime.mjs").as_uri()
    script = f"""
import {{createState,evolve}} from {json.dumps(runtime)};
const source={{kind:'fixture',ref:'python-cutover-open'}};
const members=[
 {{id:'manager',name:'Manager',role:'Manager',lifecycle:'active',binding:{{status:'bound',hostId:'fixture-host',threadId:'fixture-manager'}}}},
 {{id:'liaison',name:'Liaison',role:'Liaison',lifecycle:'active',binding:{{status:'unbound'}}}},
 {{id:'worker',name:'Worker',role:'Worker',lifecycle:'active',binding:{{status:'bound',hostId:'fixture-host',threadId:'fixture-worker'}}}}
];
let s=createState({{teamId:'legacy-team',name:'Legacy team',source,members}},'2026-01-01T00:00:00.000Z');
s=evolve(s,{{id:'invite-1',type:'attachInvite',actor:'manager',at:'2026-01-01T00:00:01.000Z',source,caller:{{hostId:'fixture-host',threadId:'fixture-manager'}},target:{{hostId:'fixture-host',threadId:'fixture-liaison'}},expiresAt:'2026-01-01T00:10:00.000Z'}},0);
s=evolve(s,{{id:'confirm-1',type:'attachConfirm',actor:'liaison',at:'2026-01-01T00:00:02.000Z',source,caller:{{hostId:'fixture-host',threadId:'fixture-liaison'}},invitationId:'invite-1',invitationVersion:1}},1);
s=evolve(s,{{id:'round-event',type:'openRound',actor:'manager',at:'2026-01-01T00:00:03.000Z',source,roundId:'round-1',title:'Open'}},2);
process.stdout.write(JSON.stringify(s)+'\\n');
"""
    return subprocess.run(
        [NODE, "--input-type=module", "-e", script], capture_output=True, check=True
    ).stdout


def adoption_request(state_path: Path, raw: bytes) -> dict:
    state = json.loads(raw)
    manager = next(member for member in state["members"] if member["role"] == "Manager")
    return {
        "action": "adopt_legacy",
        "operation_id": "migration-1",
        "team_id": state["team"]["id"],
        "team_name": state["team"]["name"],
        "member_id": manager["id"],
        "state_path": str(state_path.resolve()),
        "expected_state_version": state["version"],
        "expected_state_sha256": hashlib.sha256(raw).hexdigest(),
        "members": state["members"],
        "authorization_ref": "user-approved-adoption",
        "consent_ref": "verified-existing-liaison-confirmation",
    }


def renamed_legacy(raw: bytes, suffix: str) -> bytes:
    state = json.loads(raw)
    replacements = {
        "legacy-team": f"legacy-team-{suffix}",
        "Legacy team": f"Legacy team {suffix}",
        "manager": f"manager-{suffix}",
        "liaison": f"liaison-{suffix}",
        "worker": f"worker-{suffix}",
        "fixture-host": f"fixture-host-{suffix}",
        "fixture-manager": f"fixture-manager-{suffix}",
        "fixture-liaison": f"fixture-liaison-{suffix}",
        "fixture-worker": f"fixture-worker-{suffix}",
    }

    def replace(value):
        if isinstance(value, dict):
            return {key: replace(item) for key, item in value.items()}
        if isinstance(value, list):
            return [replace(item) for item in value]
        return replacements.get(value, value)

    return (json.dumps(replace(state), separators=(",", ":")) + "\n").encode()


@pytest.fixture
def linked(tmp_path: Path):
    registry_path = tmp_path / "registry.json"
    state_path = tmp_path / "state.json"
    initialize_registry(registry_path)
    raw = legacy_bytes()
    state_path.write_bytes(raw)
    registry = TeamRegistry(
        registry_path=registry_path,
        node_executable=NODE,
        runtime_root=ROOT,
    )
    return registry, registry_path, state_path, raw, adoption_request(state_path, raw)


def assert_error(code: str, call) -> None:
    with pytest.raises(ContextError) as caught:
        call()
    assert caught.value.code == code


def test_registry_store_locked_is_reused_by_transact(tmp_path: Path) -> None:
    path = tmp_path / "registry.json"
    path.write_text('{"value":1}', encoding="utf-8")
    store = RegistryStore(path)
    with store.locked():
        assert Path(f"{path}.lock").exists()
        value = store.read()
        value["value"] = 2
        store._replace(value)
    assert not Path(f"{path}.lock").exists()
    assert store.read() == {"value": 2}


def test_adoption_uses_real_adapter_and_exports_linked_registry(linked) -> None:
    registry, registry_path, state_path, raw, request = linked
    receipt = registry.manage("fixture-host", "fixture-manager", request)
    assert receipt == {
        "operationId": "migration-1", "teamId": "legacy-team", "teamRevision": 1,
        "memberId": "manager", "outcome": "adopted",
    }
    backup = Path(f"{state_path}.migration-1.before-registry.json")
    assert backup.read_bytes() == raw
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["schemaVersion"] == 2
    assert state["version"] == 2 and state["tasks"] == []
    assert state["registry"]["phase"] == "active"
    stored = json.loads(registry_path.read_text(encoding="utf-8"))
    assert stored["schemaVersion"] == 3
    assert stored["teams"][0]["runtime"] == {
        "statePath": str(state_path.resolve()), "migrationId": "migration-1",
        "sourceVersion": 2, "sourceSha256": request["expected_state_sha256"],
    }
    worker = registry.read("fixture-host", "fixture-worker")
    assert worker["leader"]["threadId"] == "fixture-manager"
    assert worker["runtime"]["phase"] == "active"
    assert worker["runtime"]["runtimeRoot"] == str(ROOT.resolve())
    assert worker["executionIntegration"] == "connected"
    assert worker["dispatchAllowed"] is False
    exported = export_registry(registry_path, "legacy-team")
    assert exported["statePath"] == str(state_path.resolve())
    assert exported["members"] == state["members"]
    assert exported["readyMemberIds"] == []
    assert registry.manage("fixture-host", "fixture-manager", request) == receipt
    assert [
        registry.read("fixture-host", thread)["member"]["role"]
        for thread in ("fixture-manager", "fixture-liaison", "fixture-worker")
    ] == ["Manager", "Liaison", "Worker"]


def test_adoption_wrong_actor_and_changed_source_leave_both_files_unchanged(linked) -> None:
    registry, registry_path, state_path, _, request = linked
    before = registry_path.read_bytes(), state_path.read_bytes()
    assert_error(
        "MANAGER_REQUIRED",
        lambda: registry.manage("fixture-host", "fixture-worker", request),
    )
    assert (registry_path.read_bytes(), state_path.read_bytes()) == before
    changed = dict(request, expected_state_sha256="0" * 64)
    assert_error(
        "SOURCE_MISMATCH",
        lambda: registry.manage("fixture-host", "fixture-manager", changed),
    )
    assert (registry_path.read_bytes(), state_path.read_bytes()) == before


def test_schema2_policy1_ready_projects_pending_after_policy_upgrade(tmp_path: Path) -> None:
    path = tmp_path / "registry.json"
    initialize_registry(path)
    registry = TeamRegistry(registry_path=path)
    registry.manage("h", "manager-thread", {
        "action": "bootstrap", "operation_id": "boot", "team_id": "team",
        "team_name": "Team", "member_id": "manager", "name": "Manager",
        "authorization_ref": "approved",
    })
    value = json.loads(path.read_text(encoding="utf-8"))
    team = value["teams"][0]
    manager = team["members"][0]
    old_receipt = onboarding_receipt(value["registryId"], team, manager, manager, 1)
    value["teams"][0]["members"][0]["onboarding"] = {
        "status": "ready", "evidenceRef": "old", "confirmedReceipt": old_receipt
    }
    value["operations"].append({
        "operationId": "ready", "actor": {"hostId": "h", "threadId": "manager-thread"},
        "request": {"action": "confirm_ready", "operation_id": "ready", "team_id": "team",
                    "expected_revision": 1, "member_id": "manager",
                    "receipt": old_receipt, "evidence_ref": "old"},
        "result": {"operationId": "ready", "teamId": "team", "teamRevision": 2,
                   "memberId": "manager", "outcome": "ready"},
    })
    value["teams"][0]["revision"] = 2
    path.write_text(json.dumps(value), encoding="utf-8")
    current = TeamRegistry(registry_path=path).read("h", "manager-thread")
    assert current["policyRevision"] == 2
    assert current["onboarding"] == {"status": "pending", "evidenceRef": None}


def test_registry_commit_failure_recovers_from_prepared_state(linked, monkeypatch) -> None:
    registry, registry_path, state_path, _, request = linked
    real_replace = registry._store._replace
    monkeypatch.setattr(
        registry._store, "_replace",
        lambda value: (_ for _ in ()).throw(ContextError("REGISTRY_WRITE_FAILED", "injected")),
    )
    assert_error(
        "REGISTRY_WRITE_FAILED",
        lambda: registry.manage("fixture-host", "fixture-manager", request),
    )
    assert json.loads(registry_path.read_text(encoding="utf-8"))["schemaVersion"] == 2
    assert json.loads(state_path.read_text(encoding="utf-8"))["registry"]["phase"] == "prepared"
    monkeypatch.setattr(registry._store, "_replace", real_replace)
    reopened = TeamRegistry(registry_path=registry_path, node_executable=NODE, runtime_root=ROOT)
    assert reopened.manage("fixture-host", "fixture-manager", request)["outcome"] == "adopted"
    assert json.loads(state_path.read_text(encoding="utf-8"))["registry"]["phase"] == "active"


def test_activation_failure_keeps_registry_and_retry_finishes(linked, monkeypatch) -> None:
    registry, registry_path, state_path, _, request = linked
    real_replace = adoption_module.replace_json
    calls = 0

    def fail_activation(path, value):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ContextError("STATE_WRITE_FAILED", "injected activation failure")
        return real_replace(path, value)

    monkeypatch.setattr(adoption_module, "replace_json", fail_activation)
    assert_error(
        "STATE_WRITE_FAILED",
        lambda: registry.manage("fixture-host", "fixture-manager", request),
    )
    assert json.loads(registry_path.read_text(encoding="utf-8"))["schemaVersion"] == 3
    assert json.loads(state_path.read_text(encoding="utf-8"))["registry"]["phase"] == "prepared"
    monkeypatch.setattr(adoption_module, "replace_json", real_replace)
    reopened = TeamRegistry(registry_path=registry_path, node_executable=NODE, runtime_root=ROOT)
    assert reopened.read("fixture-host", "fixture-worker")["executionIntegration"] == "migration-pending"
    assert reopened.manage("fixture-host", "fixture-manager", request)["outcome"] == "adopted"
    assert reopened.read("fixture-host", "fixture-worker")["executionIntegration"] == "connected"


def test_linked_exit_checks_real_open_round_and_preserves_both_files(tmp_path: Path) -> None:
    registry_path = tmp_path / "registry.json"
    state_path = tmp_path / "state.json"
    initialize_registry(registry_path)
    raw = legacy_with_open_round_bytes()
    state_path.write_bytes(raw)
    registry = TeamRegistry(registry_path=registry_path, node_executable=NODE, runtime_root=ROOT)
    request = adoption_request(state_path, raw)
    registry.manage("fixture-host", "fixture-manager", request)
    before = registry_path.read_bytes(), state_path.read_bytes()
    assert_error("RUNTIME_REJECTED", lambda: registry.manage(
        "fixture-host", "fixture-manager",
        {"action": "exit_member", "operation_id": "exit-worker", "team_id": "legacy-team",
         "expected_revision": 1, "member_id": "worker", "authorization_ref": "approved"},
    ))
    assert (registry_path.read_bytes(), state_path.read_bytes()) == before


@pytest.mark.parametrize("operation_id", ["bad:name", "bad/name", "bad\\name"])
def test_adoption_operation_id_is_filename_safe_before_backup(linked, operation_id) -> None:
    registry, registry_path, state_path, _, request = linked
    request = dict(request, operation_id=operation_id)
    before = registry_path.read_bytes(), state_path.read_bytes()
    assert_error("INVALID_REQUEST", lambda: registry.manage(
        "fixture-host", "fixture-manager", request
    ))
    assert (registry_path.read_bytes(), state_path.read_bytes()) == before
    assert not list(state_path.parent.glob("*.before-registry.json"))


def test_server_accepts_trusted_runtime_configuration(tmp_path: Path) -> None:
    registry_path = tmp_path / "registry.json"
    initialize_registry(registry_path)
    assert create_server(
        registry_path=registry_path, node_executable=NODE, runtime_root=ROOT
    ) is not None
    parsed = _parser().parse_args([
        "serve", "--registry", str(registry_path),
        "--node-executable", str(NODE), "--runtime-root", str(ROOT),
    ])
    assert Path(parsed.node_executable) == NODE
    assert Path(parsed.runtime_root) == ROOT


def test_linked_onboarding_and_real_node_python_export_projection(linked) -> None:
    registry, _, state_path, _, request = linked
    registry.manage("fixture-host", "fixture-manager", request)
    manager = registry.read("fixture-host", "fixture-manager")
    registry.manage("fixture-host", "fixture-manager", {
        "action": "confirm_ready", "operation_id": "ready-manager",
        "team_id": "legacy-team", "expected_revision": 1, "member_id": "manager",
        "receipt": manager["onboardingReceipt"], "evidence_ref": "reply:manager",
    })
    worker = registry.read("fixture-host", "fixture-worker")
    registry.manage("fixture-host", "fixture-manager", {
        "action": "confirm_ready", "operation_id": "ready-worker",
        "team_id": "legacy-team", "expected_revision": 2, "member_id": "worker",
        "receipt": worker["onboardingReceipt"], "evidence_ref": "reply:worker",
    })
    registry.manage("fixture-host", "fixture-manager", {
        "action": "register_member", "operation_id": "register-new",
        "team_id": "legacy-team", "expected_revision": 3, "member_id": "new-worker",
        "name": "New Worker", "role": "Worker", "target_host_id": "fixture-host",
        "target_thread_id": "fixture-new-worker", "authorization_ref": "approved:new",
    })
    runtime = (ROOT / "src" / "registry-projection.mjs").as_uri()
    python = ROOT / "artifacts" / "team-context-venv" / "Scripts" / "python.exe"
    script = f"""
import fs from 'node:fs';
import {{projectRegistryState}} from {json.dumps(runtime)};
const path={json.dumps(str(state_path.resolve()))};
const state=JSON.parse(fs.readFileSync(path,'utf8'));
const projected=await projectRegistryState(state,path,{{python:{json.dumps(str(python.resolve()))}}});
process.stdout.write(JSON.stringify(projected.registry.readyMemberIds));
"""
    completed = subprocess.run(
        [NODE, "--input-type=module", "-e", script],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == ["manager", "worker"]
    projected_script = script.replace(
        "process.stdout.write(JSON.stringify(projected.registry.readyMemberIds));",
        "process.stdout.write(JSON.stringify(projected.members.map(member=>member.id)));",
    )
    projected = subprocess.run(
        [NODE, "--input-type=module", "-e", projected_script],
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    assert json.loads(projected.stdout) == ["manager", "liaison", "worker", "new-worker"]


def test_adoption_conflict_preflight_and_changed_retry_are_byte_stable(linked) -> None:
    registry, registry_path, state_path, _, request = linked
    receipt = registry.manage("fixture-host", "fixture-manager", request)
    before = registry_path.read_bytes(), state_path.read_bytes()
    changed = dict(request, authorization_ref="changed-authorization")
    assert_error("OPERATION_CONFLICT", lambda: registry.manage(
        "fixture-host", "fixture-manager", changed
    ))
    assert (registry_path.read_bytes(), state_path.read_bytes()) == before
    assert registry.manage("fixture-host", "fixture-manager", request) == receipt


def test_duplicate_member_conflict_is_detected_before_backup_or_fence(tmp_path: Path) -> None:
    registry_path = tmp_path / "registry.json"
    state_path = tmp_path / "state.json"
    initialize_registry(registry_path)
    registry = TeamRegistry(registry_path=registry_path, node_executable=NODE, runtime_root=ROOT)
    registry.manage("other-host", "other-thread", {
        "action": "bootstrap", "operation_id": "boot", "team_id": "existing",
        "team_name": "Existing", "member_id": "worker", "name": "Existing worker",
        "authorization_ref": "approved",
    })
    raw = legacy_bytes()
    state_path.write_bytes(raw)
    request = adoption_request(state_path, raw)
    before = registry_path.read_bytes(), state_path.read_bytes()
    assert_error("MEMBER_CONFLICT", lambda: registry.manage(
        "fixture-host", "fixture-manager", request
    ))
    assert (registry_path.read_bytes(), state_path.read_bytes()) == before
    assert not Path(f"{state_path}.migration-1.before-registry.json").exists()


def test_backup_publish_and_prepare_failures_are_forward_retryable(linked, monkeypatch) -> None:
    registry, registry_path, state_path, _, request = linked
    before = registry_path.read_bytes(), state_path.read_bytes()
    real_link = adoption_module.os.link
    monkeypatch.setattr(
        adoption_module.os, "link",
        lambda source, target: (_ for _ in ()).throw(OSError("injected link failure")),
    )
    assert_error("BACKUP_FAILED", lambda: registry.manage(
        "fixture-host", "fixture-manager", request
    ))
    assert (registry_path.read_bytes(), state_path.read_bytes()) == before
    assert not Path(f"{state_path}.migration-1.before-registry.json").exists()
    monkeypatch.setattr(adoption_module.os, "link", real_link)

    real_replace = adoption_module.replace_json
    monkeypatch.setattr(
        adoption_module, "replace_json",
        lambda path, value: (_ for _ in ()).throw(ContextError("STATE_WRITE_FAILED", "injected")),
    )
    assert_error("STATE_WRITE_FAILED", lambda: registry.manage(
        "fixture-host", "fixture-manager", request
    ))
    assert (registry_path.read_bytes(), state_path.read_bytes()) == before
    assert Path(f"{state_path}.migration-1.before-registry.json").read_bytes() == before[1]
    monkeypatch.setattr(adoption_module, "replace_json", real_replace)
    assert registry.manage("fixture-host", "fixture-manager", request)["outcome"] == "adopted"


def test_schema2_rejects_adoption_history_and_schema3_replays_exactly(linked) -> None:
    registry, registry_path, _, _, request = linked
    registry.manage("fixture-host", "fixture-manager", request)
    value = json.loads(registry_path.read_text(encoding="utf-8"))
    broken = json.loads(json.dumps(value))
    broken["schemaVersion"] = 2
    del broken["teams"][0]["runtime"]
    registry_path.write_text(json.dumps(broken), encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: TeamRegistry(registry_path=registry_path).read(
        "fixture-host", "fixture-manager"
    ))
    broken = json.loads(json.dumps(value))
    broken["operations"][0]["request"]["members"][2]["name"] = "Tampered"
    registry_path.write_text(json.dumps(broken), encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: TeamRegistry(registry_path=registry_path).read(
        "fixture-host", "fixture-manager"
    ))


def test_linked_exit_updates_registry_but_preserves_node_history(linked) -> None:
    registry, _, state_path, _, request = linked
    registry.manage("fixture-host", "fixture-manager", request)
    original = json.loads(state_path.read_text(encoding="utf-8"))
    result = registry.manage("fixture-host", "fixture-manager", {
        "action": "exit_member", "operation_id": "exit-worker", "team_id": "legacy-team",
        "expected_revision": 1, "member_id": "worker", "authorization_ref": "approved",
    })
    assert result["outcome"] == "exited"
    assert registry.read("fixture-host", "fixture-worker")["status"] == "inactive"
    current = json.loads(state_path.read_text(encoding="utf-8"))
    assert current["events"] == original["events"] and current["tasks"] == original["tasks"]
    assert export_registry(registry.registry_path, "legacy-team")["members"][2]["lifecycle"] == "exited"


def test_real_process_kill_leaves_locks_for_explicit_operator_clear(linked) -> None:
    registry, registry_path, state_path, _, request = linked
    registry_lock = Path(f"{registry_path}.lock")
    state_lock = Path(f"{state_path}.lock")
    projection = (ROOT / "src" / "registry-projection.mjs").as_uri()
    script = f"""
import {{withFileLocks}} from {json.dumps(projection)};
await withFileLocks(
 {json.dumps([str(registry_lock), str(state_lock)])},
 async()=>{{process.stdout.write('ready\\n');await new Promise(()=>{{}});}}
);
"""
    child = subprocess.Popen(
        [NODE, "--input-type=module", "-e", script],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8",
    )
    try:
        assert child.stdout is not None and child.stdout.readline().strip() == "ready"
        child.kill()
        assert child.wait(timeout=10) != 0
        assert registry_lock.exists() and state_lock.exists()
        assert_error("REGISTRY_BUSY", lambda: registry.manage(
            "fixture-host", "fixture-manager", request
        ))
        registry_lock.unlink()
        assert_error("STATE_BUSY", lambda: registry.manage(
            "fixture-host", "fixture-manager", request
        ))
        state_lock.unlink()
        assert registry.manage("fixture-host", "fixture-manager", request)["outcome"] == "adopted"
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        for lock in (registry_lock, state_lock):
            if lock.exists():
                lock.unlink()


def test_adoption_history_requires_exact_source_manager_actor(linked) -> None:
    registry, registry_path, _, _, request = linked
    registry.manage("fixture-host", "fixture-manager", request)
    value = json.loads(registry_path.read_text(encoding="utf-8"))
    value["operations"][0]["actor"] = {
        "hostId": "fixture-host", "threadId": "fixture-worker"
    }
    registry_path.write_text(json.dumps(value), encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: TeamRegistry(registry_path=registry_path).read(
        "fixture-host", "fixture-manager"
    ))


def test_linked_read_rejects_state_revision_ahead_of_registry(linked) -> None:
    registry, _, state_path, _, request = linked
    registry.manage("fixture-host", "fixture-manager", request)
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["registry"]["teamRevision"] = 99
    state_path.write_text(json.dumps(state), encoding="utf-8")
    assert_error("RUNTIME_LINK_MISMATCH", lambda: registry.read(
        "fixture-host", "fixture-worker"
    ))


@pytest.mark.parametrize(
    "kwargs",
    [
        {"node_executable": "node", "runtime_root": ROOT},
        {"node_executable": NODE, "runtime_root": "runtime"},
        {"node_executable": NODE},
        {"runtime_root": ROOT},
    ],
)
def test_operator_runtime_configuration_is_paired_and_absolute(tmp_path: Path, kwargs) -> None:
    path = tmp_path / "registry.json"
    initialize_registry(path)
    assert_error("INVALID_RUNTIME_CONFIG", lambda: TeamRegistry(registry_path=path, **kwargs))


def test_real_stdio_sdk_adopts_and_reads_linked_team(tmp_path: Path) -> None:
    registry_path = tmp_path / "registry.json"
    state_path = tmp_path / "state.json"
    initialize_registry(registry_path)
    raw = legacy_bytes()
    state_path.write_bytes(raw)
    request = adoption_request(state_path, raw)
    params = StdioServerParameters(command=sys.executable, args=[
        "-m", "codex_team_context.server", "serve", "--registry", str(registry_path),
        "--node-executable", str(NODE), "--runtime-root", str(ROOT),
    ])

    async def exercise() -> None:
        async with Client(params, mode="legacy") as client:
            adopted = await client.call_tool("team_context.manage", {
                "actor_host_id": "fixture-host", "actor_thread_id": "fixture-manager",
                "request": request,
            })
            assert adopted.is_error is False
            receipt = json.loads(adopted.content[0].text)
            assert receipt["outcome"] == "adopted"
            recalled = await client.call_tool("team_context.read", {
                "host_id": "fixture-host", "thread_id": "fixture-worker",
            })
            assert recalled.is_error is False
            capsule = json.loads(recalled.content[0].text)
            assert capsule["registrySchemaVersion"] == 3
            assert capsule["executionIntegration"] == "connected"

    asyncio.run(exercise())


def test_second_independent_team_can_adopt_into_schema3_registry(linked) -> None:
    registry, registry_path, state_path, raw, first_request = linked
    registry.manage("fixture-host", "fixture-manager", first_request)
    second_path = state_path.with_name("state-second.json")
    second_raw = renamed_legacy(raw, "second")
    second_path.write_bytes(second_raw)
    second_request = adoption_request(second_path, second_raw)
    second_request["operation_id"] = "migration-2"
    receipt = registry.manage("fixture-host-second", "fixture-manager-second", second_request)
    assert receipt["outcome"] == "adopted"
    stored = json.loads(registry_path.read_text(encoding="utf-8"))
    assert stored["schemaVersion"] == 3
    assert [team["id"] for team in stored["teams"]] == [
        "legacy-team", "legacy-team-second"
    ]
    assert registry.read("fixture-host-second", "fixture-worker-second")["team"]["id"] == (
        "legacy-team-second"
    )


@pytest.mark.parametrize("mutation", ["corrupt", "valid_but_changed"])
def test_prepared_retry_validates_expected_business_state_before_registry_commit(
    linked, monkeypatch, mutation
) -> None:
    registry, registry_path, state_path, _, request = linked
    real_replace = registry._store._replace
    monkeypatch.setattr(
        registry._store, "_replace",
        lambda value: (_ for _ in ()).throw(ContextError("REGISTRY_WRITE_FAILED", "injected")),
    )
    assert_error("REGISTRY_WRITE_FAILED", lambda: registry.manage(
        "fixture-host", "fixture-manager", request
    ))
    monkeypatch.setattr(registry._store, "_replace", real_replace)
    prepared = json.loads(state_path.read_text(encoding="utf-8"))
    if mutation == "corrupt":
        prepared["events"] = []
    else:
        prepared["team"]["source"]["ref"] = "valid-but-not-the-backed-up-source"
    state_path.write_text(json.dumps(prepared), encoding="utf-8")
    registry_before = registry_path.read_bytes()
    state_before = state_path.read_bytes()
    with pytest.raises(ContextError):
        registry.manage("fixture-host", "fixture-manager", request)
    assert registry_path.read_bytes() == registry_before
    assert state_path.read_bytes() == state_before
    assert json.loads(registry_path.read_text(encoding="utf-8"))["schemaVersion"] == 2


def test_registry_store_canonicalizes_once_for_read_lock_and_replace(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "canonical-registry.json"
    alias = tmp_path / "operator-alias.json"
    target.write_text('{"value":1}', encoding="utf-8")
    actual_resolve = Path.resolve

    def controlled_resolve(path, *args, **kwargs):
        if path.absolute() == alias.absolute():
            return actual_resolve(target, *args, **kwargs)
        return actual_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", controlled_resolve)
    store = RegistryStore(alias)
    assert store.path == target.resolve()
    with store.locked():
        assert Path(f"{target}.lock").exists()
        assert not Path(f"{alias}.lock").exists()
        value = store.read()
        value["value"] = 2
        store._replace(value)
    assert store.read() == {"value": 2}
    assert json.loads(target.read_text(encoding="utf-8")) == {"value": 2}
    assert not alias.exists()


def test_team_registry_exposes_the_store_canonical_target(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "canonical-registry.json"
    alias = tmp_path / "operator-alias.json"
    initialize_registry(target)
    actual_resolve = Path.resolve

    def controlled_resolve(path, *args, **kwargs):
        if path.absolute() == alias.absolute():
            return actual_resolve(target, *args, **kwargs)
        return actual_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", controlled_resolve)
    registry = TeamRegistry(registry_path=alias)
    assert registry.registry_path == target.resolve()
    registry.manage("host", "thread", {
        "action": "bootstrap", "operation_id": "boot", "team_id": "team",
        "team_name": "Team", "member_id": "manager", "name": "Manager",
        "authorization_ref": "approved",
    })
    assert json.loads(target.read_text(encoding="utf-8"))["teams"][0]["id"] == "team"
    assert not alias.exists()


def test_active_adoption_replay_after_later_registry_change_never_restores_backup(linked) -> None:
    registry, _, state_path, _, request = linked
    original_receipt = registry.manage("fixture-host", "fixture-manager", request)
    registry.manage("fixture-host", "fixture-manager", {
        "action": "register_member", "operation_id": "later-member",
        "team_id": "legacy-team", "expected_revision": 1, "member_id": "later-worker",
        "name": "Later Worker", "role": "Worker", "target_host_id": "later-host",
        "target_thread_id": "later-thread", "authorization_ref": "approved:later",
    })
    active_before = state_path.read_bytes()
    assert registry.manage("fixture-host", "fixture-manager", request) == original_receipt
    assert state_path.read_bytes() == active_before
    assert json.loads(state_path.read_text(encoding="utf-8"))["registry"]["teamRevision"] == 1
