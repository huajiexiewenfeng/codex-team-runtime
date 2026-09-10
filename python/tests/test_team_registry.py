import copy
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from codex_team_context.core import ContextError
import codex_team_context.team_registry as team_registry_module
from codex_team_context.team_registry import TeamRegistry, initialize_registry


def bootstrap_request(operation_id="op-bootstrap"):
    return {
        "action": "bootstrap",
        "operation_id": operation_id,
        "team_id": "team-a",
        "team_name": "Team A",
        "member_id": "manager",
        "name": "Manager",
        "authorization_ref": "user-approved:1",
    }


def member_request(
    operation_id="op-member",
    *,
    member_id="worker",
    role="Worker",
    host_id="host-worker",
    thread_id="thread-worker",
    revision=1,
):
    request = {
        "action": "register_member",
        "operation_id": operation_id,
        "team_id": "team-a",
        "expected_revision": revision,
        "member_id": member_id,
        "name": member_id.title(),
        "role": role,
        "target_host_id": host_id,
        "target_thread_id": thread_id,
        "authorization_ref": "manager-approved:1",
    }
    if role == "Liaison":
        request["consent_ref"] = "target-consented:1"
    return request


@pytest.fixture
def registry(tmp_path):
    path = tmp_path / "registry.json"
    initialize_registry(path)
    return TeamRegistry(registry_path=path), path


def assert_error(code, function):
    with pytest.raises(ContextError) as caught:
        function()
    assert caught.value.code == code


def bootstrap(store):
    return store.manage("host-manager", "thread-manager", bootstrap_request())


def test_initialize_bootstrap_and_manager_capsule(registry):
    store, path = registry
    initial = json.loads(path.read_text(encoding="utf-8"))
    assert set(initial) == {"schemaVersion", "registryId", "policyRevision", "teams", "operations"}
    assert initial["schemaVersion"] == 2
    assert initial["policyRevision"] == 1
    assert initial["teams"] == [] and initial["operations"] == []

    receipt = bootstrap(store)
    assert receipt == {
        "operationId": "op-bootstrap", "teamId": "team-a", "teamRevision": 1,
        "memberId": "manager", "outcome": "bootstrapped",
    }
    capsule = store.read("host-manager", "thread-manager")
    assert capsule["status"] == "active"
    assert capsule["registryId"] == initial["registryId"]
    assert capsule["team"] == {"id": "team-a", "name": "Team A", "revision": 1}
    assert capsule["member"]["role"] == "Manager"
    assert capsule["leader"]["memberId"] == "manager"
    assert capsule["onboarding"]["status"] == "pending"
    assert capsule["executionIntegration"] == "not-connected"
    assert capsule["dispatchAllowed"] is False
    assert capsule["sharedRules"]
    assert capsule["roleDuties"]
    assert isinstance(capsule["onboardingReceipt"], str)
    rules = " ".join(capsule["sharedRules"])
    assert "first onboarding" in rules
    assert "foreground continuation or context loss" in rules
    assert "before delivery, receipt, or acceptance" in rules
    assert "ask the user" in rules and "never elect" in rules
    assert "Maintain team and member registration" in " ".join(capsule["roleDuties"])


def test_initialization_is_explicit_and_never_overwrites(tmp_path):
    missing_parent = tmp_path / "missing" / "registry.json"
    assert_error("REGISTRY_PARENT_MISSING", lambda: initialize_registry(missing_parent))
    path = tmp_path / "registry.json"
    initialize_registry(path)
    before = path.read_bytes()
    assert_error("REGISTRY_EXISTS", lambda: initialize_registry(path))
    assert path.read_bytes() == before


@pytest.mark.parametrize("failure", ["dump", "fsync", "publish"])
def test_initialization_failure_leaves_no_target_and_is_retryable(
    tmp_path, monkeypatch, failure
):
    path = tmp_path / "registry.json"
    unrelated = tmp_path / ".registry.json.unrelated.tmp"
    unrelated.write_bytes(b"keep")
    real_dump = team_registry_module.json.dump
    real_fsync = team_registry_module.os.fsync
    real_link = team_registry_module.os.link

    if failure == "dump":
        def fail_dump(value, stream, **kwargs):
            stream.write('{"partial":')
            raise OSError("injected dump failure")

        monkeypatch.setattr(team_registry_module.json, "dump", fail_dump)
    elif failure == "fsync":
        monkeypatch.setattr(
            team_registry_module.os, "fsync",
            lambda descriptor: (_ for _ in ()).throw(OSError("injected fsync failure")),
        )
    else:
        monkeypatch.setattr(
            team_registry_module.os, "link",
            lambda source, target: (_ for _ in ()).throw(OSError("injected publish failure")),
            raising=False,
        )

    assert_error("REGISTRY_WRITE_FAILED", lambda: initialize_registry(path))
    assert not path.exists()
    assert unrelated.read_bytes() == b"keep"
    assert list(tmp_path.glob(".registry.json.*.tmp")) == [unrelated]

    monkeypatch.setattr(team_registry_module.json, "dump", real_dump)
    monkeypatch.setattr(team_registry_module.os, "fsync", real_fsync)
    monkeypatch.setattr(team_registry_module.os, "link", real_link, raising=False)
    initialize_registry(path)
    assert json.loads(path.read_text(encoding="utf-8"))["schemaVersion"] == 2
    assert unrelated.read_bytes() == b"keep"


def test_initialization_publish_preserves_an_existing_target(tmp_path):
    path = tmp_path / "registry.json"
    path.write_bytes(b"existing bytes")
    assert_error("REGISTRY_EXISTS", lambda: initialize_registry(path))
    assert path.read_bytes() == b"existing bytes"
    assert not list(tmp_path.glob(".registry.json.*.tmp"))


def test_unknown_read_is_byte_stable_and_invalid_identity_errors(registry):
    store, path = registry
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    assert store.read("host-missing", "thread-missing") is None
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
    for invalid in ("", "has space", "pending:123", "client-new-thread:123", "x" * 129):
        assert_error("INVALID_IDENTITY", lambda invalid=invalid: store.read("host", invalid))


def test_worker_and_liaison_receive_same_team_leader_rules_and_role_duties(registry):
    store, _ = registry
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    store.manage("host-manager", "thread-manager", member_request(
        "op-liaison", member_id="liaison", role="Liaison",
        host_id="host-liaison", thread_id="thread-liaison", revision=2,
    ))
    capsules = [
        store.read("host-manager", "thread-manager"),
        store.read("host-worker", "thread-worker"),
        store.read("host-liaison", "thread-liaison"),
    ]
    assert [c["member"]["role"] for c in capsules] == ["Manager", "Worker", "Liaison"]
    assert len({json.dumps(c["team"], sort_keys=True) for c in capsules}) == 1
    assert len({json.dumps(c["leader"], sort_keys=True) for c in capsules}) == 1
    assert len({tuple(c["sharedRules"]) for c in capsules}) == 1
    assert all(c["dispatchAllowed"] is False for c in capsules)
    assert capsules[0]["teamMembers"] == [
        {"memberId": "manager", "name": "Manager", "role": "Manager",
         "lifecycle": "active", "hostId": "host-manager", "threadId": "thread-manager",
         "onboardingStatus": "pending"},
        {"memberId": "worker", "name": "Worker", "role": "Worker",
         "lifecycle": "active", "hostId": "host-worker", "threadId": "thread-worker",
         "onboardingStatus": "pending"},
        {"memberId": "liaison", "name": "Liaison", "role": "Liaison",
         "lifecycle": "active", "hostId": "host-liaison", "threadId": "thread-liaison",
         "onboardingStatus": "pending"},
    ]
    assert "teamMembers" not in capsules[1]
    assert "teamMembers" not in capsules[2]


def test_exact_manager_authority_actor_team_and_request_shapes(registry):
    store, _ = registry
    bootstrap(store)
    request = member_request()
    assert_error("MANAGER_REQUIRED", lambda: store.manage("other-host", "other-thread", request))
    wrong_team = copy.deepcopy(request)
    wrong_team["team_id"] = "team-b"
    assert_error("TEAM_NOT_FOUND", lambda: store.manage("host-manager", "thread-manager", wrong_team))
    extra = copy.deepcopy(request)
    extra["unexpected"] = True
    assert_error("INVALID_REQUEST", lambda: store.manage("host-manager", "thread-manager", extra))
    missing = copy.deepcopy(request)
    del missing["name"]
    assert_error("INVALID_REQUEST", lambda: store.manage("host-manager", "thread-manager", missing))


@pytest.mark.parametrize("field,value", [
    ("action", []),
    ("role", {}),
])
def test_unhashable_request_enums_return_context_error_without_writes(registry, field, value):
    store, path = registry
    bootstrap(store)
    request = member_request()
    request[field] = value
    before = path.read_bytes()
    assert_error("INVALID_REQUEST", lambda: store.manage("host-manager", "thread-manager", request))
    assert path.read_bytes() == before


def test_bootstrap_actor_is_manager_target_and_registry_allows_multiple_teams(registry):
    store, _ = registry
    bootstrap(store)
    second = bootstrap_request("op-team-b")
    second.update(team_id="team-b", team_name="Team B", member_id="boss", name="Boss")
    result = store.manage("host-b", "thread-b", second)
    assert result["memberId"] == "boss"
    assert store.read("host-b", "thread-b")["member"]["role"] == "Manager"
    conflict = bootstrap_request("op-conflict")
    conflict.update(team_id="team-c", member_id="another-manager")
    assert_error("IDENTITY_CONFLICT", lambda: store.manage("host-manager", "thread-manager", conflict))


def test_registration_rejects_roles_conflicts_and_missing_liaison_consent(registry):
    store, _ = registry
    bootstrap(store)
    assert_error("INVALID_REQUEST", lambda: store.manage(
        "host-manager", "thread-manager", member_request(role="Manager")))
    liaison = member_request(member_id="liaison", role="Liaison")
    del liaison["consent_ref"]
    assert_error("INVALID_REQUEST", lambda: store.manage("host-manager", "thread-manager", liaison))
    store.manage("host-manager", "thread-manager", member_request())
    duplicate_id = member_request("op-duplicate", host_id="host-other", thread_id="thread-other", revision=2)
    assert_error("MEMBER_CONFLICT", lambda: store.manage("host-manager", "thread-manager", duplicate_id))
    duplicate_binding = member_request("op-binding", member_id="worker-2", revision=2)
    assert_error("IDENTITY_CONFLICT", lambda: store.manage("host-manager", "thread-manager", duplicate_binding))


def test_exited_member_identity_and_binding_cannot_be_reused(registry):
    store, _ = registry
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    store.manage("host-manager", "thread-manager", {
        "action": "exit_member", "operation_id": "op-exit", "team_id": "team-a",
        "expected_revision": 2, "member_id": "worker", "authorization_ref": "approved:exit",
    })
    same_member = member_request(
        "op-reuse-member", host_id="host-new", thread_id="thread-new", revision=3)
    assert_error("MEMBER_CONFLICT", lambda: store.manage(
        "host-manager", "thread-manager", same_member))
    same_binding = member_request(
        "op-reuse-binding", member_id="new-worker", revision=3)
    assert_error("IDENTITY_CONFLICT", lambda: store.manage(
        "host-manager", "thread-manager", same_binding))


def test_confirmation_checks_complete_member_receipt_and_evidence(registry):
    store, _ = registry
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    capsule = store.read("host-worker", "thread-worker")
    request = {
        "action": "confirm_ready", "operation_id": "op-ready", "team_id": "team-a",
        "expected_revision": 2, "member_id": "worker",
        "receipt": capsule["onboardingReceipt"], "evidence_ref": "reply:1",
    }
    result = store.manage("host-manager", "thread-manager", request)
    assert result["outcome"] == "ready"
    assert store.read("host-worker", "thread-worker")["onboarding"] == {
        "status": "ready", "evidenceRef": "reply:1",
    }


def test_foreign_and_stale_onboarding_receipts_are_rejected(registry):
    store, _ = registry
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    worker = store.read("host-worker", "thread-worker")
    manager = store.read("host-manager", "thread-manager")
    base = {
        "action": "confirm_ready", "operation_id": "op-ready", "team_id": "team-a",
        "expected_revision": 2, "member_id": "worker", "evidence_ref": "reply:1",
    }
    assert_error("RECEIPT_MISMATCH", lambda: store.manage(
        "host-manager", "thread-manager", {**base, "receipt": manager["onboardingReceipt"]}))
    assert_error("INVALID_REQUEST", lambda: store.manage(
        "host-manager", "thread-manager", {**base, "receipt": worker["onboardingReceipt"] + "x"}))


@pytest.mark.parametrize("receipt", ["v2:\u00e9" + "0" * 63, "v2:" + "A" * 64, "not-a-receipt"])
def test_malformed_confirmation_receipts_are_request_errors_without_writes(registry, receipt):
    store, path = registry
    bootstrap(store)
    before = path.read_bytes()
    request = {
        "action": "confirm_ready", "operation_id": "op-ready", "team_id": "team-a",
        "expected_revision": 1, "member_id": "manager", "receipt": receipt,
        "evidence_ref": "reply:1",
    }
    assert_error("INVALID_REQUEST", lambda: store.manage(
        "host-manager", "thread-manager", request))
    assert path.read_bytes() == before


def test_valid_format_foreign_confirmation_receipt_is_a_mismatch(registry):
    store, path = registry
    bootstrap(store)
    before = path.read_bytes()
    request = {
        "action": "confirm_ready", "operation_id": "op-ready", "team_id": "team-a",
        "expected_revision": 1, "member_id": "manager", "receipt": "v2:" + "0" * 64,
        "evidence_ref": "reply:1",
    }
    assert_error("RECEIPT_MISMATCH", lambda: store.manage(
        "host-manager", "thread-manager", request))
    assert path.read_bytes() == before


def test_unrelated_member_addition_does_not_stale_receipt(registry):
    store, _ = registry
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    receipt = store.read("host-worker", "thread-worker")["onboardingReceipt"]
    store.manage("host-manager", "thread-manager", member_request(
        "op-other", member_id="worker-2", host_id="host-2", thread_id="thread-2", revision=2))
    result = store.manage("host-manager", "thread-manager", {
        "action": "confirm_ready", "operation_id": "op-ready", "team_id": "team-a",
        "expected_revision": 3, "member_id": "worker", "receipt": receipt,
        "evidence_ref": "reply:1",
    })
    assert result["outcome"] == "ready"


def test_exit_is_retained_and_read_does_not_require_live_leader(registry):
    store, _ = registry
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    store.manage("host-manager", "thread-manager", {
        "action": "exit_member", "operation_id": "op-exit-worker", "team_id": "team-a",
        "expected_revision": 2, "member_id": "worker", "authorization_ref": "approved:exit",
    })
    inactive = store.read("host-worker", "thread-worker")
    assert inactive["status"] == "inactive" and inactive["reason"] == "exited"
    assert "sharedRules" not in inactive and "roleDuties" not in inactive
    store.manage("host-manager", "thread-manager", member_request(
        "op-active-worker", member_id="active-worker", host_id="host-active",
        thread_id="thread-active", revision=3,
    ))
    store.manage("host-manager", "thread-manager", {
        "action": "exit_member", "operation_id": "op-exit-manager", "team_id": "team-a",
        "expected_revision": 4, "member_id": "manager", "authorization_ref": "approved:exit",
    })
    active = store.read("host-active", "thread-active")
    assert active["status"] == "active" and active["leader"]["lifecycle"] == "exited"
    inactive_manager = store.read("host-manager", "thread-manager")
    assert inactive_manager["status"] == "inactive" and "teamMembers" not in inactive_manager


def test_operation_replay_precedes_stale_check_but_changed_payload_conflicts(registry):
    store, path = registry
    bootstrap(store)
    request = member_request()
    first = store.manage("host-manager", "thread-manager", request)
    before = path.read_bytes()
    assert store.manage("host-manager", "thread-manager", copy.deepcopy(request)) == first
    assert path.read_bytes() == before
    changed = copy.deepcopy(request)
    changed["name"] = "Changed"
    assert_error("OPERATION_CONFLICT", lambda: store.manage("host-manager", "thread-manager", changed))
    assert_error("OPERATION_CONFLICT", lambda: store.manage("other", "actor", request))


@pytest.mark.parametrize("replacement", [True, 1.0])
def test_numeric_lookalikes_are_not_identical_operation_replays(registry, replacement):
    store, path = registry
    bootstrap(store)
    request = member_request()
    store.manage("host-manager", "thread-manager", request)
    changed = copy.deepcopy(request)
    changed["expected_revision"] = replacement
    before = path.read_bytes()
    assert_error("INVALID_REQUEST", lambda: store.manage("host-manager", "thread-manager", changed))
    assert path.read_bytes() == before


def test_restart_preserves_capsules_and_receipts(registry):
    store, path = registry
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    first = store.read("host-worker", "thread-worker")
    restarted = TeamRegistry(registry_path=path)
    assert restarted.read("host-worker", "thread-worker") == first


def test_old_policy_registry_is_readable_but_ready_member_requires_reconfirmation(
    registry, monkeypatch
):
    store, path = registry
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    old_capsule = store.read("host-worker", "thread-worker")
    store.manage("host-manager", "thread-manager", {
        "action": "confirm_ready", "operation_id": "op-ready-v1", "team_id": "team-a",
        "expected_revision": 2, "member_id": "worker",
        "receipt": old_capsule["onboardingReceipt"], "evidence_ref": "reply:v1",
    })
    before = path.read_bytes()

    monkeypatch.setattr(team_registry_module, "POLICY_REVISION", 2)
    upgraded = TeamRegistry(registry_path=path)
    current = upgraded.read("host-worker", "thread-worker")
    assert path.read_bytes() == before
    assert current["policyRevision"] == 2
    assert current["onboarding"] == {"status": "pending", "evidenceRef": None}
    assert current["onboardingReceipt"] != old_capsule["onboardingReceipt"]
    upgraded.manage("host-manager", "thread-manager", {
        "action": "confirm_ready", "operation_id": "op-ready-v2", "team_id": "team-a",
        "expected_revision": 3, "member_id": "worker",
        "receipt": current["onboardingReceipt"], "evidence_ref": "reply:v2",
    })
    assert upgraded.read("host-worker", "thread-worker")["onboarding"] == {
        "status": "ready", "evidenceRef": "reply:v2",
    }


def test_two_concurrent_same_revision_writes_have_one_winner(registry):
    store, _ = registry
    bootstrap(store)
    requests = [
        member_request("op-a", member_id="a", host_id="host-a", thread_id="thread-a"),
        member_request("op-b", member_id="b", host_id="host-b", thread_id="thread-b"),
    ]

    def run(request):
        try:
            return store.manage("host-manager", "thread-manager", request)
        except ContextError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(run, requests))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert results.count("REVISION_CONFLICT") == 1


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=True),
    lambda value: value.update(policyRevision=0),
    lambda value: value["teams"].append({"id": "broken"}),
    lambda value: value.update(operations={}),
])
def test_malformed_stored_records_are_rejected(registry, mutation):
    store, path = registry
    value = json.loads(path.read_text(encoding="utf-8"))
    mutation(value)
    path.write_text(json.dumps(value), encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: store.read("host", "thread"))


@pytest.mark.parametrize("mutation", [
    lambda value: value["teams"][0]["members"][0].update(role=[]),
    lambda value: value["teams"][0]["members"][0].update(lifecycle={}),
    lambda value: value["teams"][0]["members"][0]["onboarding"].update(status=[]),
    lambda value: value["operations"][0]["request"].update(action=[]),
    lambda value: value["operations"][0]["result"].update(outcome=[]),
])
def test_unhashable_stored_enums_are_registry_corrupt(registry, mutation):
    store, path = registry
    bootstrap(store)
    value = json.loads(path.read_text(encoding="utf-8"))
    mutation(value)
    path.write_text(json.dumps(value), encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: store.read("host-manager", "thread-manager"))


@pytest.mark.parametrize("mutation", [
    lambda operation: operation["result"].update(teamId="different-team"),
    lambda operation: operation["result"].update(memberId="different-member"),
    lambda operation: operation["result"].update(outcome="ready"),
    lambda operation: operation["result"].update(operationId="different-op"),
])
def test_malformed_stored_operation_relationships_are_rejected(registry, mutation):
    store, path = registry
    bootstrap(store)
    value = json.loads(path.read_text(encoding="utf-8"))
    mutation(value["operations"][0])
    path.write_text(json.dumps(value), encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: store.read("host-manager", "thread-manager"))


def _registry_with_ordered_history(store, path):
    bootstrap(store)
    store.manage("host-manager", "thread-manager", member_request())
    worker = store.read("host-worker", "thread-worker")
    store.manage("host-manager", "thread-manager", {
        "action": "confirm_ready", "operation_id": "op-ready", "team_id": "team-a",
        "expected_revision": 2, "member_id": "worker",
        "receipt": worker["onboardingReceipt"], "evidence_ref": "reply:1",
    })
    store.manage("host-manager", "thread-manager", {
        "action": "exit_member", "operation_id": "op-exit", "team_id": "team-a",
        "expected_revision": 3, "member_id": "worker", "authorization_ref": "approved:exit",
    })
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("mutation", [
    lambda value: value["operations"][0]["actor"].update(threadId="tampered"),
    lambda value: value["operations"][0]["result"].update(teamRevision=999),
    lambda value: value["operations"][1]["actor"].update(hostId="tampered"),
    lambda value: value["operations"][1]["request"].update(expected_revision=9),
    lambda value: value["operations"][1]["result"].update(teamRevision=999),
    lambda value: (
        value["operations"][1]["request"].update(team_id="ghost-team"),
        value["operations"][1]["result"].update(teamId="ghost-team"),
    ),
    lambda value: (
        value["operations"][2]["request"].update(member_id="ghost"),
        value["operations"][2]["result"].update(memberId="ghost"),
    ),
    lambda value: value["teams"][0]["members"][1].update(name="Tampered"),
    lambda value: value["operations"].pop(1),
])
def test_ordered_history_must_reconstruct_the_persisted_team_state(registry, mutation):
    store, path = registry
    value = _registry_with_ordered_history(store, path)
    mutation(value)
    path.write_text(json.dumps(value), encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: store.read("host-manager", "thread-manager"))


def test_malformed_stored_confirmed_receipt_is_rejected(registry):
    store, path = registry
    bootstrap(store)
    capsule = store.read("host-manager", "thread-manager")
    store.manage("host-manager", "thread-manager", {
        "action": "confirm_ready", "operation_id": "op-ready", "team_id": "team-a",
        "expected_revision": 1, "member_id": "manager",
        "receipt": capsule["onboardingReceipt"], "evidence_ref": "reply:1",
    })
    value = json.loads(path.read_text(encoding="utf-8"))
    value["teams"][0]["members"][0]["onboarding"]["confirmedReceipt"] = "not-a-receipt"
    path.write_text(json.dumps(value), encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: store.read("host-manager", "thread-manager"))


def test_missing_and_invalid_json_registry_are_errors(tmp_path):
    missing = TeamRegistry(registry_path=tmp_path / "missing.json")
    assert_error("REGISTRY_MISSING", lambda: missing.read("host", "thread"))
    path = tmp_path / "bad.json"
    path.write_text("{", encoding="utf-8")
    assert_error("REGISTRY_CORRUPT", lambda: TeamRegistry(registry_path=path).read("host", "thread"))
