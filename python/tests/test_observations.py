from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from codex_team_context.core import ContextError
import codex_team_context.observations as observations_module
import codex_team_context.server as server_module
from codex_team_context.observations import ObservationRecorder, configure_observations, observed_call
from codex_team_context.server import _classify_read, create_server
from codex_team_context.team_registry import TeamRegistry, initialize_registry


def bootstrap_request():
    return {"action": "bootstrap", "operation_id": "boot", "team_id": "team-a", "team_name": "Team A",
            "member_id": "manager", "name": "Manager", "authorization_ref": "approved"}


def member_request(operation_id, member_id, role, revision):
    value = {"action": "register_member", "operation_id": operation_id, "team_id": "team-a",
             "expected_revision": revision, "member_id": member_id, "name": member_id,
             "role": role, "target_host_id": f"host-{member_id}", "target_thread_id": f"thread-{member_id}",
             "authorization_ref": "approved"}
    if role == "Liaison":
        value["consent_ref"] = "consented"
    return value


@pytest.fixture
def populated_registry(tmp_path: Path):
    path = tmp_path / "registry.json"
    initialize_registry(path)
    registry = TeamRegistry(registry_path=path)
    registry.manage("host-manager", "thread-manager", bootstrap_request())
    registry.manage("host-manager", "thread-manager", member_request("worker", "worker", "Worker", 1))
    registry.manage("host-manager", "thread-manager", member_request("liaison", "liaison", "Liaison", 2))
    registry.manage("host-manager", "thread-manager", {
        "action": "exit_member", "operation_id": "exit", "team_id": "team-a", "expected_revision": 3,
        "member_id": "worker", "authorization_ref": "approved",
    })
    return registry, path


def identity(member="manager", role="Manager", status="active", team="team-a"):
    return {"registryId": "registry", "teamId": team, "memberId": member, "role": role,
            "hostId": f"host-{member}", "threadId": f"thread-{member}", "memberStatus": status,
            "policyRevision": 2, "identitySource": "registry-at-call-start"}


def events(root: Path):
    return [json.loads(path.read_text(encoding="utf-8")) for path in root.glob("*/*.json")]


def test_observation_configuration_is_default_off_and_rejects_unsafe_combinations(tmp_path: Path):
    registry = tmp_path / "registry.json"
    assert configure_observations(root=None, observed_teams=None, runtime_revision=None, registry_mode=True) is None
    bad = [
        {"observation_root": tmp_path / "out"},
        {"observed_teams": ["team-a"]},
        {"runtime_revision": "runtime-1"},
        {"observation_root": "relative", "observed_teams": ["team-a"]},
        {"observation_root": tmp_path / "out", "observed_teams": []},
        {"observation_root": tmp_path / "out", "observed_teams": ["bad team"]},
    ]
    for kwargs in bad:
        with pytest.raises(ContextError) as caught:
            create_server(registry_path=registry, **kwargs)
        assert caught.value.code == "INVALID_OBSERVATION_CONFIG"
    with pytest.raises(ContextError) as caught:
        create_server(index_path=tmp_path / "index.json", state_roots=[tmp_path],
                      observation_root=tmp_path / "out", observed_teams=["team-a"])
    assert caught.value.code == "INVALID_OBSERVATION_CONFIG"
    assert not (tmp_path / "out").exists()


def test_registry_observation_identity_projects_exact_active_and_exited_roles_without_writes(populated_registry):
    registry, path = populated_registry
    before = path.read_bytes()
    projected = [
        registry.observation_identity("host-manager", "thread-manager"),
        registry.observation_identity("host-liaison", "thread-liaison"),
        registry.observation_identity("host-worker", "thread-worker"),
    ]
    assert [(item["role"], item["memberStatus"]) for item in projected] == [
        ("Manager", "active"), ("Liaison", "active"), ("Worker", "exited")]
    assert all(item["identitySource"] == "registry-at-call-start" and item["policyRevision"] == 2 for item in projected)
    assert registry.observation_identity("unknown", "unknown") is None
    assert path.read_bytes() == before


def test_recorder_writes_concurrent_immutable_allowlisted_events_without_sensitive_payloads(tmp_path: Path):
    root = tmp_path / "observations"
    recorder = ObservationRecorder(root, ["team-a"], runtime_revision="runtime-operator")
    sentinel = "SECRET_REQUEST_CAPSULE_PROMPT_NAME"

    def invoke(index):
        return observed_call(recorder, lambda: identity(member=f"worker-{index}", role="Worker"),
                             "team_context.manage", "manual", lambda: {"sentinel": sentinel}, lambda _: "success")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(invoke, range(24)))
    assert all(result == {"sentinel": sentinel} for result in results)
    stored = events(root)
    assert len(stored) == 24 and len({item["eventId"] for item in stored}) == 24
    expected = {"schemaVersion", "eventId", "startedAt", "completedAt", "durationMs", "tool", "registryId",
                "teamId", "memberId", "role", "hostId", "threadId", "memberStatus", "identitySource",
                "reason", "reasonSource", "outcome", "errorCode", "policyRevision", "runtimeRevision",
                "runtimeRevisionSource"}
    assert all(set(item) == expected for item in stored)
    assert all(item["reasonSource"] == "agent-declared" and item["runtimeRevisionSource"] == "operator-declared" for item in stored)
    assert all(item["durationMs"] >= 0 and item["memberStatus"] == "active" for item in stored)
    assert sentinel not in "".join(path.read_text(encoding="utf-8") for path in root.glob("*/*.json"))
    assert not list(root.glob("**/*.tmp"))


def test_unknown_identity_and_nonallowlisted_team_write_nothing(tmp_path: Path):
    for name, provider in [("unknown", lambda: None), ("other", lambda: identity(team="team-b"))]:
        root = tmp_path / name
        recorder = ObservationRecorder(root, ["team-a"])
        assert observed_call(recorder, provider, "team_context.read", "unknown", lambda: None,
                             lambda _: "matched") is None
        assert not root.exists()
    root = tmp_path / "disabled"
    assert observed_call(None, lambda: (_ for _ in ()).throw(AssertionError("identity lookup ran")),
                         "team_context.read", "unknown", lambda: "old-result", lambda _: "matched") == "old-result"
    assert not root.exists()


def test_registered_identity_whose_read_disappears_is_recorded_as_unmatched(tmp_path: Path):
    root = tmp_path / "observations"
    result = observed_call(
        ObservationRecorder(root, ["team-a"]), lambda: identity(),
        "team_context.read", "resume", lambda: None, _classify_read,
    )
    assert result is None
    assert events(root)[0]["outcome"] == "unmatched"


def test_errors_and_observation_failures_never_change_business_semantics(tmp_path: Path, monkeypatch, capsys):
    root = tmp_path / "observations"
    recorder = ObservationRecorder(root, ["team-a"])
    with pytest.raises(ContextError) as caught:
        observed_call(recorder, lambda: identity(), "team_context.manage", "before_dispatch",
                      lambda: (_ for _ in ()).throw(ContextError("SAFE_ERROR", "SECRET ERROR BODY")),
                      lambda _: "success")
    assert caught.value.code == "SAFE_ERROR"
    stored = events(root)
    assert stored[0]["outcome"] == "error" and stored[0]["errorCode"] == "SAFE_ERROR"
    assert "SECRET ERROR BODY" not in json.dumps(stored)

    monkeypatch.setattr(recorder, "_publish", lambda event: (_ for _ in ()).throw(OSError("SECRET WRITE")))
    assert observed_call(recorder, lambda: identity(), "team_context.read", "unknown", lambda: {"status": "active"},
                         lambda value: "matched") == {"status": "active"}
    assert capsys.readouterr().err.strip() == "OBSERVATION_WRITE_FAILED"

    with pytest.raises(RuntimeError, match="BUSINESS SENTINEL"):
        observed_call(ObservationRecorder(tmp_path / "unexpected", ["team-a"]), lambda: identity(),
                      "team_context.startup", "resume",
                      lambda: (_ for _ in ()).throw(RuntimeError("BUSINESS SENTINEL")), lambda _: "success")
    assert events(tmp_path / "unexpected")[0]["outcome"] == "unexpected_error"


def test_identity_lookup_failure_only_reports_a_bounded_gap_and_still_runs_business(tmp_path: Path, capsys):
    root = tmp_path / "observations"
    result = observed_call(ObservationRecorder(root, ["team-a"]),
                           lambda: (_ for _ in ()).throw(ContextError("REGISTRY_CORRUPT", "SECRET REGISTRY PATH")),
                           "team_context.read", "unknown", lambda: "business-result", lambda _: "matched")
    assert result == "business-result"
    assert capsys.readouterr().err.strip() == "OBSERVATION_IDENTITY_UNAVAILABLE"
    assert not root.exists()


def test_unsafe_error_codes_are_replaced_and_all_observation_failures_are_isolated(tmp_path: Path, monkeypatch, capsys):
    unsafe = ObservationRecorder(tmp_path / "unsafe", ["team-a"])
    with pytest.raises(ContextError) as caught:
        observed_call(unsafe, lambda: identity(), "team_context.manage", "manual",
                      lambda: (_ for _ in ()).throw(ContextError("bad code with SECRET", "body")),
                      lambda _: "success")
    assert caught.value.code == "bad code with SECRET"
    assert events(tmp_path / "unsafe")[0]["errorCode"] == "UNKNOWN_ERROR"
    assert "SECRET" not in json.dumps(events(tmp_path / "unsafe"))

    broken = ObservationRecorder(tmp_path / "broken", ["team-a"])
    monkeypatch.setattr(broken, "record", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("recorder failed")))
    assert observed_call(broken, lambda: identity(), "team_context.read", "manual", lambda: "original",
                         lambda _: "matched") == "original"
    assert "OBSERVATION_WRITE_FAILED" in capsys.readouterr().err

    classifier = ObservationRecorder(tmp_path / "classifier", ["team-a"])
    assert observed_call(classifier, lambda: identity(), "team_context.read", "manual", lambda: "original",
                         lambda _: (_ for _ in ()).throw(RuntimeError("classifier failed"))) == "original"
    assert "OBSERVATION_WRITE_FAILED" in capsys.readouterr().err

    with pytest.raises(ValueError, match="original failure"):
        observed_call(broken, lambda: identity(), "team_context.startup", "manual",
                      lambda: (_ for _ in ()).throw(ValueError("original failure")), lambda _: "success")
    assert "OBSERVATION_WRITE_FAILED" in capsys.readouterr().err

    monkeypatch.setattr(observations_module, "print", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("stderr failed")), raising=False)
    assert observed_call(ObservationRecorder(tmp_path / "warning", ["team-a"]),
                         lambda: (_ for _ in ()).throw(RuntimeError("identity failed")),
                         "team_context.read", "manual", lambda: "still-original", lambda _: "matched") == "still-original"

    failed_begin = ObservationRecorder(tmp_path / "begin", ["team-a"])
    monkeypatch.setattr(failed_begin, "begin", lambda: (_ for _ in ()).throw(RuntimeError("begin failed")))
    assert observed_call(failed_begin, lambda: identity(), "team_context.read", "manual",
                         lambda: "begin-original", lambda _: "matched") == "begin-original"


def test_main_rejects_observation_flags_in_legacy_index_mode_before_stdio(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setattr(server_module.MCPServer, "run", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("stdio entered")))
    result = server_module.main([
        "serve", "--index", str(tmp_path / "index.json"), "--state-root", str(tmp_path),
        "--observation-root", str((tmp_path / "observations").resolve()), "--observe-team", "team-a",
    ])
    assert result == 1
    assert json.loads(capsys.readouterr().err)["code"] == "INVALID_OBSERVATION_CONFIG"
    assert not (tmp_path / "observations").exists()
