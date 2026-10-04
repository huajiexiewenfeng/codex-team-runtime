from __future__ import annotations

import asyncio
import json
import shutil
import sys
from pathlib import Path

import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from codex_team_context.core import ContextError
from codex_team_context.runtime_revision import resolve_runtime_revision
from codex_team_context.team_registry import initialize_registry
from test_dispatch import dispatch_team
from test_notice import notice_team
from test_registry_cutover import NODE, ROOT


REVISION = "a" * 40


def installation(tmp_path, **changes):
    root = tmp_path / "installed" / "companion"
    root.mkdir(parents=True)
    data = {"runtimeRoot": str(root), "revision": REVISION, "sourceDirty": False}
    data.update(changes)
    metadata = root.parent / "installation.json"
    metadata.write_text(json.dumps(data), encoding="utf-8")
    return root, metadata


@pytest.mark.parametrize("changes,expected", [
    ({}, REVISION),
    ({"revision": "b" * 64}, "b" * 64),
    ({"localPatch": "e04-local-20261003"}, REVISION + "+e04-local-20261003"),
    ({"sourceDirty": True}, REVISION + "+dirty"),
    ({"sourceDirty": True, "localPatch": "declared-patch"}, REVISION + "+declared-patch+dirty"),
    ({"sourceDirty": "false"}, None),
    ({"sourceDirty": None}, None),
    ({"localPatch": "bad\nlabel"}, None),
    ({"localPatch": "x" * 129}, None),
    ({"localPatch": False}, None),
    ({"revision": "main"}, None),
    ({"revision": "a" * 39}, None),
    ({"revision": "A" * 40}, None),
    ({"revision": "a" * 40 + "\n"}, None),
    ({"runtimeRoot": "companion"}, None),
    ({"runtimeRoot": None}, None),
])
def test_bounded_installation_declarations(tmp_path, changes, expected):
    root, _ = installation(tmp_path, **changes)
    assert resolve_runtime_revision(root) == expected


@pytest.mark.parametrize("raw", ["{bad", "[]", "{}", "x" * 65537,
    '{"revision":"a","revision":"b"}',
    '\ud800'], ids=["malformed", "array", "empty-object", "oversized", "duplicate-key", "invalid-utf8"])
def test_bad_metadata_stays_unknown(tmp_path, raw):
    root, metadata = installation(tmp_path)
    metadata.write_bytes(raw.encode("utf-8", errors="surrogatepass"))
    assert resolve_runtime_revision(root) is None


def test_missing_metadata_unknown_dirty_and_exact_path_match(tmp_path):
    root, metadata = installation(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    # No ancestor/sibling search and no accepting another installation's root.
    assert resolve_runtime_revision(other) is None
    data = json.loads(metadata.read_text())
    data["runtimeRoot"] = str(other)
    metadata.write_text(json.dumps(data))
    assert resolve_runtime_revision(root) is None
    data["runtimeRoot"] = str(root / ".." / "companion")
    metadata.write_text(json.dumps(data))
    assert resolve_runtime_revision(root) == REVISION
    del data["sourceDirty"]
    metadata.write_text(json.dumps(data))
    assert resolve_runtime_revision(root) is None
    metadata.unlink()
    assert resolve_runtime_revision(root) is None
    metadata.mkdir()
    assert resolve_runtime_revision(root) is None
    assert resolve_runtime_revision(None) is None
    assert resolve_runtime_revision(tmp_path / "missing") is None


def test_unreadable_metadata_is_diagnostic_only(tmp_path, monkeypatch):
    root, _ = installation(tmp_path)
    def denied(*args, **kwargs):
        raise PermissionError("unreadable")
    monkeypatch.setattr(Path, "open", denied)
    assert resolve_runtime_revision(root) is None
    # Explicit config wins without touching metadata.
    assert resolve_runtime_revision(root, "operator-override") == "operator-override"


@pytest.mark.parametrize("label", ["", " ", "x" * 513, "bad\nlabel", "\ud800", 42])
def test_invalid_explicit_configuration_is_rejected(label):
    with pytest.raises(ContextError) as caught:
        resolve_runtime_revision(None, label)
    assert caught.value.code == "INVALID_RUNTIME_CONFIG"


@pytest.mark.parametrize("explicit", [None, "operator-override"])
def test_installed_server_starts_and_discovers_without_observation_options(tmp_path, explicit):
    root, _ = installation(tmp_path)
    registry = tmp_path / "registry.json"
    initialize_registry(registry)
    async def scenario():
        args = ["-B", "-m", "codex_team_context.server", "serve", "--registry", str(registry),
                "--node-executable", str(NODE), "--runtime-root", str(root)]
        if explicit is not None:
            args += ["--runtime-revision", explicit]
        async with Client(StdioServerParameters(command=sys.executable, args=args)) as client:
            assert len((await client.list_tools()).tools) == 7
            result = await client.call_tool("team_context.read", {"host_id": "none", "thread_id": "none"})
            assert not result.is_error and json.loads(result.content[0].text) is None
    asyncio.run(scenario())
    assert not (tmp_path / "observations").exists()


@pytest.mark.parametrize("tool", ["notice", "dispatch"])
@pytest.mark.parametrize("mode", ["patched", "dirty", "explicit"])
def test_real_stdio_bridges_and_observations_share_resolved_revision(tmp_path, request, tool, mode):
    team = request.getfixturevalue(tool + "_team")
    _, registry, _, *rest = team
    prepare = rest[-1]
    root, metadata = installation(tmp_path, localPatch="e04-local-20261003", sourceDirty=mode == "dirty")
    # Synthetic installed layout, not the user's global runtime.
    shutil.copytree(ROOT / "src", root / "src")
    observations = tmp_path / "observations"
    expected = REVISION + "+e04-local-20261003" + ("+dirty" if mode == "dirty" else "")
    async def scenario():
        args = ["-B", "-m", "codex_team_context.server", "serve", "--registry", str(registry),
                "--node-executable", str(NODE), "--runtime-root", str(root),
                "--observation-root", str(observations), "--observe-team", "legacy-team"]
        if mode == "explicit":
            args += ["--runtime-revision", "operator-override"]
        async with Client(StdioServerParameters(command=sys.executable, args=args)) as client:
            result = await client.call_tool("team_context." + tool, prepare)
            assert not result.is_error, result
            data = json.loads(result.content[0].text)
            assert data["sendNow"] is True
            assert data["runtimeRevision"] == ("operator-override" if mode == "explicit" else expected)
            # Precise status reads retain the same diagnostics; never a second send.
            status = {k: v for k, v in prepare.items() if k not in {
                "action", "operation_id", "baseline", "enqueue_event_id", "brief_ref", "admission"}}
            status["prepare_operation_id" if tool == "notice" else "operation_id"] = prepare["operation_id"]
            read = await client.call_tool("team_context." + tool + "_status", status)
            assert not read.is_error, read
            assert json.loads(read.content[0].text)["runtimeRevision"] == data["runtimeRevision"]
    asyncio.run(scenario())
    events = [json.loads(p.read_text(encoding="utf-8")) for p in observations.glob("*/*.json")]
    assert len(events) == 2
    assert all(e["runtimeRevision"] == ("operator-override" if mode == "explicit" else expected) for e in events)
    assert all(e["runtimeRevisionSource"] == "operator-declared" for e in events)
    assert json.loads(metadata.read_text())["sourceDirty"] == (mode == "dirty")
