import copy
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from codex_team_context.core import ContextError, ContextRegistry, initialize_index


def state(*, host="host-a", thread="thread-a", role="Manager", member_id="manager"):
    member = {"id": member_id, "name": role, "role": role, "lifecycle": "active",
              "binding": {"status": "bound", "hostId": host, "threadId": thread}}
    manager = member if role == "Manager" else {"id": "manager", "name": "Manager", "role": "Manager",
        "lifecycle": "active", "binding": {"status": "bound", "hostId": "manager-host",
        "threadId": "manager-thread"}}
    liaison = member if role == "Liaison" else {"id": "liaison", "name": "Liaison", "role": "Liaison",
        "lifecycle": "active", "binding": {"status": "unbound"}}
    value = {
        "schemaVersion": 1, "version": 0, "updatedAt": "2026-09-10T00:00:00.000Z",
        "team": {"id": "team-a", "name": "A", "source": {"kind": "manual", "ref": "test"}},
        "members": [manager, liaison] + ([member] if role == "Worker" else []),
        "rounds": [], "tasks": [], "events": [],
        "reporting": {"enabled": True, "desired": "stopped", "actual": "unknown",
                      "intentVersion": 0, "offlineReceipt": None},
        "session": {"invitation": None},
    }
    if role == "Liaison":
        value["version"] = 2
        value["updatedAt"] = "2026-09-10T00:02:00.000Z"
        value["events"] = [
            {"id": "invite-1", "type": "attachInvite", "actor": "manager",
             "at": "2026-09-10T00:01:00.000Z", "source": {"kind": "manual", "ref": "test"}},
            {"id": "confirm-1", "type": "attachConfirm", "actor": member_id,
             "at": "2026-09-10T00:02:00.000Z", "source": {"kind": "manual", "ref": "test"}},
        ]
        value["session"] = {"invitation": {"id": "invite-1", "issuedVersion": 1,
            "managerId": "manager", "liaisonId": member_id,
            "target": {"hostId": host, "threadId": thread},
            "expiresAt": "2026-09-11T00:00:00.000Z", "confirmedAt": "2026-09-10T00:02:00.000Z",
            "confirmationId": "confirm-1"}}
    return value


@pytest.fixture
def registry(tmp_path):
    states = tmp_path / "states"
    states.mkdir()
    index = tmp_path / "index.json"
    initialize_index(index)
    return ContextRegistry(index_path=index, state_roots=[states]), states, index


def write_state(states: Path, value: dict, name="team.json") -> Path:
    path = states / name
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def assert_error(code, fn):
    with pytest.raises(ContextError) as caught:
        fn()
    assert caught.value.code == code


def test_unknown_exact_identity_returns_none_without_writes(registry):
    store, _, index = registry
    before = (index.read_bytes(), index.stat().st_mtime_ns)
    assert store.read("host-a", "thread-a") is None
    assert (index.read_bytes(), index.stat().st_mtime_ns) == before


def test_register_persists_pointer_and_read_derives_bounded_capsule(registry):
    store, states, index = registry
    source = write_state(states, state())
    registered = store.register("host-a", "thread-a", source, "manager")
    capsule = ContextRegistry(index_path=index, state_roots=[states]).read("host-a", "thread-a")
    assert registered == capsule
    assert capsule == {"status": "active", "role": "Manager", "memberId": "manager",
        "teamId": "team-a", "sourceVersion": 0, "statePath": str(source.resolve()),
        "policyVersion": 1, "identityAssurance": "caller-declared",
        "boundaries": ["Delegate implementation; independently review and accept evidence.",
                       "Coordinate the team; do not impersonate another member.",
                       "Verify host identity and action authorization separately."]}
    entry = json.loads(index.read_text(encoding="utf-8"))["entries"][0]
    assert set(entry) == {"hostId", "threadId", "statePath", "teamId", "memberId",
                          "sourceSchemaVersion"}
    assert "role" not in entry


def test_similar_thread_and_other_host_do_not_cross_match(registry):
    store, states, _ = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    assert store.read("host-a", "thread") is None
    assert store.read("host-b", "thread-a") is None


def test_canonical_state_changes_are_visible_without_reregister(registry):
    store, states, _ = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    changed = state()
    changed["version"] = 1
    changed["updatedAt"] = "2026-09-10T00:01:00.000Z"
    changed["events"] = [{"id": "reports-1", "type": "reports", "actor": "manager",
        "at": changed["updatedAt"], "source": {"kind": "manual", "ref": "test"}}]
    changed["reporting"].update(enabled=False, intentVersion=1)
    source.write_text(json.dumps(changed), encoding="utf-8")
    assert store.read("host-a", "thread-a")["sourceVersion"] == 1


@pytest.mark.parametrize(("mutation", "reason"), [
    (lambda s: s["members"][0].update(lifecycle="exited"), "exited"),
    (lambda s: s["members"][0].update(binding={"status": "unbound"}), "unbound"),
])
def test_exit_or_unbind_is_reported_inactive(registry, mutation, reason):
    store, states, _ = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    changed = state()
    mutation(changed)
    source.write_text(json.dumps(changed), encoding="utf-8")
    capsule = store.read("host-a", "thread-a")
    assert capsule["status"] == "inactive"
    assert capsule["reason"] == reason


def test_liaison_requires_bidirectionally_confirmed_current_pairing(registry):
    store, states, _ = registry
    good = state(role="Liaison", member_id="liaison")
    source = write_state(states, good)
    store.register("host-a", "thread-a", source, "liaison")
    broken = copy.deepcopy(good)
    broken["session"]["invitation"]["target"]["threadId"] = "other"
    source.write_text(json.dumps(broken), encoding="utf-8")
    assert_error("INVALID_PAIRING", lambda: store.read("host-a", "thread-a"))


def test_detached_liaison_is_inactive(registry):
    store, states, _ = registry
    value = state(role="Liaison", member_id="liaison")
    source = write_state(states, value)
    store.register("host-a", "thread-a", source, "liaison")
    value["members"][1]["binding"] = {"status": "unbound"}
    value["session"]["invitation"] = None
    source.write_text(json.dumps(value), encoding="utf-8")
    assert store.read("host-a", "thread-a")["status"] == "inactive"


def test_register_is_idempotent_but_conflict_cannot_overwrite(registry):
    store, states, index = registry
    source = write_state(states, state())
    first = store.register("host-a", "thread-a", source, "manager")
    content = index.read_bytes()
    assert store.register("host-a", "thread-a", source, "manager") == first
    assert index.read_bytes() == content
    other = write_state(states, state(), "other.json")
    assert_error("REGISTRATION_CONFLICT",
                 lambda: store.register("host-a", "thread-a", other, "manager"))
    assert index.read_bytes() == content


def test_register_rejects_inactive_member(registry):
    store, states, _ = registry
    value = state()
    value["members"][0]["lifecycle"] = "exited"
    source = write_state(states, value)
    assert_error("REGISTRATION_INACTIVE",
                 lambda: store.register("host-a", "thread-a", source, "manager"))


def test_register_rejects_unknown_or_wrong_identity(registry):
    store, states, _ = registry
    source = write_state(states, state())
    assert_error("MEMBER_NOT_FOUND",
                 lambda: store.register("host-a", "thread-a", source, "worker"))
    assert_error("IDENTITY_MISMATCH",
                 lambda: store.register("host-a", "inherited-parent", source, "manager"))


def test_read_errors_for_missing_or_corrupt_registered_state(registry):
    store, states, _ = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    source.unlink()
    assert_error("STATE_MISSING", lambda: store.read("host-a", "thread-a"))
    source.write_text("{", encoding="utf-8")
    assert_error("STATE_CORRUPT", lambda: store.read("host-a", "thread-a"))


def test_read_errors_for_missing_or_corrupt_index(tmp_path):
    states = tmp_path / "states"
    states.mkdir()
    missing = ContextRegistry(index_path=tmp_path / "missing.json", state_roots=[states])
    assert_error("INDEX_MISSING", lambda: missing.read("host", "thread"))
    corrupt_path = tmp_path / "corrupt.json"
    corrupt_path.write_text("[]", encoding="utf-8")
    corrupt = ContextRegistry(index_path=corrupt_path, state_roots=[states])
    assert_error("INDEX_CORRUPT", lambda: corrupt.read("host", "thread"))


def test_explicit_setup_never_overwrites_existing_index(tmp_path):
    index = tmp_path / "index.json"
    initialize_index(index)
    before = index.read_bytes()
    assert_error("INDEX_EXISTS", lambda: initialize_index(index))
    assert index.read_bytes() == before


def test_state_path_must_be_below_configured_root(registry, tmp_path):
    store, _, _ = registry
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps(state()), encoding="utf-8")
    assert_error("STATE_OUTSIDE_ROOTS",
                 lambda: store.register("host-a", "thread-a", outside, "manager"))


def test_read_has_no_state_or_directory_side_effects(registry):
    store, states, index = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in (source, index)}
    listing = sorted(p.name for p in index.parent.iterdir())
    store.read("host-a", "thread-a")
    assert sorted(p.name for p in index.parent.iterdir()) == listing
    assert {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in (source, index)} == before


def test_empty_or_environment_derived_identifiers_are_not_accepted(registry, monkeypatch):
    store, states, _ = registry
    source = write_state(states, state())
    monkeypatch.setenv("CODEX_THREAD_ID", "thread-a")
    assert_error("INVALID_IDENTITY", lambda: store.read("host-a", ""))
    assert_error("INVALID_IDENTITY", lambda: store.register("host-a", "", source, "manager"))


def test_missing_binding_is_inactive_not_null(registry):
    store, states, _ = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    changed = state()
    changed["members"][0]["binding"] = {
        "status": "missing", "hostId": "host-a", "threadId": "thread-a"
    }
    source.write_text(json.dumps(changed), encoding="utf-8")
    assert_error("IDENTITY_UNAVAILABLE", lambda: store.read("host-a", "thread-a"))


@pytest.mark.parametrize(("field", "value"), [("schemaVersion", True), ("version", False)])
def test_boolean_versions_are_corrupt(registry, field, value):
    store, states, _ = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    changed = state()
    changed[field] = value
    source.write_text(json.dumps(changed), encoding="utf-8")
    assert_error("STATE_CORRUPT", lambda: store.read("host-a", "thread-a"))


def test_confirmed_liaison_does_not_expire_after_confirmation(registry):
    store, states, _ = registry
    value = state(role="Liaison", member_id="liaison")
    value["session"]["invitation"]["expiresAt"] = "2026-09-10T00:02:30.000Z"
    source = write_state(states, value)
    assert store.register("host-a", "thread-a", source, "liaison")["status"] == "active"


@pytest.mark.parametrize("bad", ["pending:123", "client-new-thread:123", "has space", "x" * 129])
def test_identity_rules_match_node_runtime(registry, bad):
    store, _, _ = registry
    assert_error("INVALID_IDENTITY", lambda: store.read("host-a", bad))


@pytest.mark.parametrize("binding", [
    {"status": "creating"},
    {"status": "unbound", "pendingId": "unexpected"},
    {"status": "bound", "hostId": "host-a", "threadId": "thread-a", "pendingId": "x"},
])
def test_invalid_pending_binding_shape_is_corrupt(registry, binding):
    store, states, _ = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    changed = state()
    changed["members"][0]["binding"] = binding
    source.write_text(json.dumps(changed), encoding="utf-8")
    assert_error("STATE_CORRUPT", lambda: store.read("host-a", "thread-a"))


def test_valid_creating_binding_is_inactive(registry):
    store, states, _ = registry
    source = write_state(states, state())
    store.register("host-a", "thread-a", source, "manager")
    changed = state()
    changed["members"][0]["binding"] = {"status": "creating", "pendingId": "pending:child"}
    source.write_text(json.dumps(changed), encoding="utf-8")
    assert store.read("host-a", "thread-a")["reason"] == "creating"


def test_liaison_remains_active_if_manager_later_exits(registry):
    store, states, _ = registry
    value = state(role="Liaison", member_id="liaison")
    source = write_state(states, value)
    store.register("host-a", "thread-a", source, "liaison")
    value["members"][0]["lifecycle"] = "exited"
    value["version"] = 3
    value["updatedAt"] = "2026-09-10T00:03:00.000Z"
    value["events"].append({"id": "exit-manager", "type": "exitMember", "actor": "manager",
        "at": value["updatedAt"], "source": {"kind": "manual", "ref": "test"}})
    source.write_text(json.dumps(value), encoding="utf-8")
    assert store.read("host-a", "thread-a")["status"] == "active"


def test_liaison_confirmation_must_have_occurred_before_expiry(registry):
    store, states, _ = registry
    value = state(role="Liaison", member_id="liaison")
    value["session"]["invitation"]["expiresAt"] = "2026-09-10T00:01:30.000Z"
    source = write_state(states, value)
    assert_error("INVALID_PAIRING",
                 lambda: store.register("host-a", "thread-a", source, "liaison"))


@pytest.mark.parametrize("mutation", [
    lambda s: s["team"].update(id="x" * 129),
    lambda s: s["members"].append(copy.deepcopy(s["members"][0])),
    lambda s: s["members"].append({"id": "manager-2", "name": "Manager 2", "role": "Manager",
        "lifecycle": "active", "binding": {"status": "unbound"}}),
])
def test_role_projection_rejects_invalid_team_or_role_cardinality(registry, mutation):
    store, states, _ = registry
    value = state()
    mutation(value)
    source = write_state(states, value)
    assert_error("STATE_CORRUPT",
                 lambda: store.register("host-a", "thread-a", source, "manager"))


def test_liaison_rejects_a_revoked_invitation_reintroduced_as_current(registry):
    store, states, _ = registry
    value = state(role="Liaison", member_id="liaison")
    detached = copy.deepcopy(value["session"]["invitation"])
    value["version"] = 3
    value["updatedAt"] = "2026-09-10T00:03:00.000Z"
    value["events"].append({"id": "detach-1", "type": "detachLiaison", "actor": "manager",
        "at": value["updatedAt"], "source": {"kind": "manual", "ref": "test"},
        "summary": "detached", "detachedInvitation": detached})
    source = write_state(states, value)
    assert_error("INVALID_PAIRING",
                 lambda: store.register("host-a", "thread-a", source, "liaison"))


def test_liaison_rejects_noncanonical_confirmation_timestamp(registry):
    store, states, _ = registry
    value = state(role="Liaison", member_id="liaison")
    value["session"]["invitation"]["confirmedAt"] = "2026-09-10T00:02:00"
    value["events"][1]["at"] = "2026-09-10T00:02:00"
    source = write_state(states, value)
    assert_error("INVALID_PAIRING",
                 lambda: store.register("host-a", "thread-a", source, "liaison"))


def _node_validation_rejects(value):
    script = """
import fs from 'node:fs';
import {validate} from './src/runtime.mjs';
const value = JSON.parse(fs.readFileSync(0, 'utf8'));
try { validate(value); } catch (error) { process.stderr.write(String(error.message)); process.exit(7); }
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(value), text=True, capture_output=True, check=False,
    )
    assert result.returncode == 7, result.stderr


@pytest.mark.parametrize(("variant", "expected_code"), [
    ("invalid_pairing_ids", "STATE_CORRUPT"),
    ("duplicate_confirmation_id", "STATE_CORRUPT"),
    ("non_utc_confirmation_time", "INVALID_PAIRING"),
])
def test_liaison_pairing_rejects_node_invalid_audit_references(registry, variant, expected_code):
    store, states, _ = registry
    value = state(role="Liaison", member_id="liaison")
    invitation = value["session"]["invitation"]
    if variant == "invalid_pairing_ids":
        invitation["id"] = value["events"][0]["id"] = "invalid invite id"
        invitation["confirmationId"] = value["events"][1]["id"] = "invalid confirmation id"
    elif variant == "duplicate_confirmation_id":
        value["version"] = 3
        value["updatedAt"] = "2026-09-10T00:03:00.000Z"
        value["events"].append({
            "id": invitation["confirmationId"], "type": "registerWorker", "actor": "manager",
            "at": value["updatedAt"], "source": {"kind": "manual", "ref": "test"},
        })
    else:
        invitation["confirmedAt"] = "2026-09-10T01:02:00.000+01:00"
        value["events"][1]["at"] = invitation["confirmedAt"]

    _node_validation_rejects(value)
    source = write_state(states, value)
    assert_error(expected_code,
                 lambda: store.register("host-a", "thread-a", source, "liaison"))


def test_concurrent_registration_does_not_lose_updates(registry):
    store, states, index = registry
    registrations = []
    for number in range(12):
        host, thread, member_id = f"host-{number}", f"thread-{number}", f"worker-{number}"
        source = write_state(states, state(host=host, thread=thread, role="Worker",
                                           member_id=member_id), f"team-{number}.json")
        registrations.append((host, thread, source, member_id))
    with ThreadPoolExecutor(max_workers=12) as executor:
        results = list(executor.map(lambda args: store.register(*args), registrations))
    assert len(results) == 12
    assert len(json.loads(index.read_text(encoding="utf-8"))["entries"]) == 12


def test_real_node_generated_state_is_compatible(tmp_path):
    source = tmp_path / "node-state.json"
    session_url = (Path(__file__).parents[2] / "src" / "session.mjs").resolve().as_uri()
    script = f"""
import {{start, attach, registerWorker}} from {session_url!r};
const path=process.argv[1], source={{kind:'fixture',ref:'python-compatibility-test'}};
await start(path,{{teamId:'node-team',name:'Node team',caller:{{hostId:'local',threadId:'manager'}},source}},'2026-09-10T00:00:00.000Z');
await attach(path,{{mode:'invite',id:'invite',caller:{{hostId:'local',threadId:'manager'}},target:{{hostId:'local',threadId:'liaison'}},at:'2026-09-10T00:01:00.000Z',expiresAt:'2026-09-10T00:20:00.000Z',source}},0);
await attach(path,{{mode:'confirm',id:'confirm',caller:{{hostId:'local',threadId:'liaison'}},invitationId:'invite',invitationVersion:1,at:'2026-09-10T00:02:00.000Z',source}},1);
await registerWorker(path,{{id:'worker-registration',caller:{{hostId:'local',threadId:'manager'}},memberId:'worker',name:'Worker',binding:{{hostId:'local',threadId:'worker'}},at:'2026-09-10T00:03:00.000Z',source}},2);
"""
    subprocess.run(["node", "--input-type=module", "-e", script, str(source)], check=True)
    index = tmp_path / "index.json"
    initialize_index(index)
    store = ContextRegistry(index_path=index, state_roots=[source.parent])
    capsule = store.register("local", "liaison", source, "liaison")
    assert capsule["role"] == "Liaison"
    assert capsule["sourceVersion"] == 3
    store.register("local", "worker", source, "worker")
    runtime_url = (Path(__file__).parents[2] / "src" / "store.mjs").resolve().as_uri()
    exit_script = f"""
import {{transact}} from {runtime_url!r};
await transact(process.argv[1],3,{{id:'exit-worker',type:'exitMember',actor:'manager',memberId:'worker',at:'2026-09-10T00:04:00.000Z',source:{{kind:'fixture',ref:'python-compatibility-test'}}}});
"""
    subprocess.run(["node", "--input-type=module", "-e", exit_script, str(source)], check=True)
    inactive = store.read("local", "worker")
    assert inactive["status"] == "inactive"
    assert inactive["reason"] == "exited"
    assert inactive["sourceVersion"] == 4
