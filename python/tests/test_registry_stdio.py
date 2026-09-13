from __future__ import annotations

import asyncio
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from codex_team_context.core import ContextError
from codex_team_context.server import create_server


def _server_params(registry: Path, *, pid_file: Path | None = None) -> StdioServerParameters:
    args = ["-m", "codex_team_context.server", "serve", "--registry", str(registry)]
    if pid_file is not None:
        launcher = (
            "import os,runpy,sys;"
            f"open({str(pid_file)!r},'w',encoding='ascii').write(str(os.getpid()));"
            "sys.argv=['codex-team-context',*sys.argv[1:]];"
            "runpy.run_module('codex_team_context.server',run_name='__main__')"
        )
        args = ["-c", launcher, *args[2:]]
    return StdioServerParameters(
        command=sys.executable,
        args=args,
    )


def _text_json(result):
    assert len(result.content) == 1
    assert result.content[0].type == "text"
    return json.loads(result.content[0].text)


def _manage(client: Client, actor: tuple[str, str], request: object):
    return client.call_tool(
        "team_context.manage",
        {"actor_host_id": actor[0], "actor_thread_id": actor[1], "request": request},
    )


def _pid_exists(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if handle:
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    return False


def test_create_server_requires_one_valid_path_mode(tmp_path: Path) -> None:
    registry = tmp_path / "registry.json"
    index = tmp_path / "index.json"

    invalid_calls = [
        {},
        {"registry_path": registry, "index_path": index},
        {"registry_path": registry, "state_roots": [tmp_path]},
        {"index_path": index},
        {"index_path": index, "state_roots": []},
    ]
    for kwargs in invalid_calls:
        with pytest.raises(ContextError) as raised:
            create_server(**kwargs)
        assert raised.value.as_dict()["code"] == "INVALID_MODE"


def test_registry_init_cli_creates_new_file_and_rejects_invalid_modes(tmp_path: Path) -> None:
    registry = tmp_path / "registry.json"
    base = [sys.executable, "-m", "codex_team_context.server"]

    created = subprocess.run(
        [*base, "init", "--registry", str(registry)], text=True, capture_output=True, check=False
    )
    duplicate = subprocess.run(
        [*base, "init", "--registry", str(registry)], text=True, capture_output=True, check=False
    )
    both = subprocess.run(
        [*base, "init", "--registry", str(registry), "--index", str(tmp_path / "i.json")],
        text=True,
        capture_output=True,
        check=False,
    )
    roots_with_registry = subprocess.run(
        [*base, "serve", "--registry", str(registry), "--state-root", str(tmp_path)],
        text=True,
        capture_output=True,
        check=False,
    )
    index_without_roots = subprocess.run(
        [*base, "serve", "--index", str(tmp_path / "i.json")],
        text=True,
        capture_output=True,
        check=False,
    )

    assert created.returncode == 0, created.stderr
    payload = json.loads(registry.read_text(encoding="utf-8"))
    assert payload["schemaVersion"] == 2
    assert payload["teams"] == []
    assert duplicate.returncode != 0
    assert json.loads(duplicate.stderr)["code"] == "REGISTRY_EXISTS"
    assert json.loads(both.stderr)["code"] == "INVALID_MODE"
    assert json.loads(roots_with_registry.stderr)["code"] == "INVALID_MODE"
    assert json.loads(index_without_roots.stderr)["code"] == "INVALID_MODE"


def test_registry_real_stdio_lifecycle_and_authorization(tmp_path: Path) -> None:
    registry = tmp_path / "registry.json"
    initialized = subprocess.run(
        [sys.executable, "-m", "codex_team_context.server", "init", "--registry", str(registry)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert initialized.returncode == 0, initialized.stderr

    manager = ("host-manager", "thread-manager")
    worker = ("host-worker", "thread-worker")

    async def exercise() -> None:
        async with Client(_server_params(registry), mode="legacy") as client:
            assert client.instructions is None
            listed = await client.list_tools()
            tools = {tool.name: tool for tool in listed.tools}
            assert set(tools) == {"team_context.read", "team_context.manage"}
            assert tools["team_context.read"].annotations.read_only_hint is True
            assert tools["team_context.manage"].annotations.read_only_hint is False
            assert tools["team_context.manage"].annotations.destructive_hint is True
            assert tools["team_context.manage"].annotations.idempotent_hint is True
            read_description = tools["team_context.read"].description.lower()
            assert all(
                word in read_description
                for word in ("registered", "role", "team", "leader", "null")
            )
            assert "before continuing team work after context compaction" in read_description
            assert "loss of role context" in read_description
            assert all(role in read_description for role in ("manager", "liaison", "worker"))
            assert "verified current" in read_description
            assert "never a parent's" in read_description
            assert "no registration or work authorization" in read_description
            assert "do not poll" in read_description
            assert len(read_description) <= 600
            assert tools["team_context.read"].input_schema["required"] == [
                "host_id",
                "thread_id",
            ]
            assert tools["team_context.manage"].input_schema["required"] == [
                "actor_host_id",
                "actor_thread_id",
                "request",
            ]

            unknown = await client.call_tool(
                "team_context.read", {"host_id": "host-none", "thread_id": "thread-none"}
            )
            assert unknown.is_error is False
            assert len(unknown.content) == 1
            assert unknown.content[0].text == "null"

            bootstrapped = await _manage(client, manager, {
                "action": "bootstrap",
                "operation_id": "op-bootstrap",
                "team_id": "team-a",
                "team_name": "Team A",
                "member_id": "manager-a",
                "name": "Manager A",
                "authorization_ref": "approved:bootstrap",
            })
            assert bootstrapped.is_error is False
            assert _text_json(bootstrapped) == {
                "operationId": "op-bootstrap",
                "teamId": "team-a",
                "teamRevision": 1,
                "memberId": "manager-a",
                "outcome": "bootstrapped",
            }

            manager_read = await client.call_tool(
                "team_context.read", {"host_id": manager[0], "thread_id": manager[1]}
            )
            manager_capsule = _text_json(manager_read)
            assert manager_capsule["member"]["role"] == "Manager"
            assert manager_capsule["team"]["revision"] == 1

            registered = await _manage(client, manager, {
                "action": "register_member",
                "operation_id": "op-register-worker",
                "team_id": "team-a",
                "expected_revision": 1,
                "member_id": "worker-a",
                "name": "Worker A",
                "role": "Worker",
                "target_host_id": worker[0],
                "target_thread_id": worker[1],
                "authorization_ref": "approved:worker",
            })
            assert registered.is_error is False
            assert _text_json(registered)["outcome"] == "registered"

            worker_read = await client.call_tool(
                "team_context.read", {"host_id": worker[0], "thread_id": worker[1]}
            )
            worker_capsule = _text_json(worker_read)
            assert worker_capsule["member"]["role"] == "Worker"
            assert worker_capsule["team"]["revision"] == 2
            assert worker_capsule["leader"]["hostId"] == manager[0]
            assert worker_capsule["leader"]["threadId"] == manager[1]
            assert worker_capsule["onboarding"]["status"] == "pending"
            assert worker_capsule["onboardingReceipt"].startswith("v2:")

            denied = await _manage(client, worker, {
                "action": "exit_member",
                "operation_id": "op-worker-denied",
                "team_id": "team-a",
                "expected_revision": 2,
                "member_id": "manager-a",
                "authorization_ref": "not-authorized",
            })
            assert denied.is_error is True
            assert _text_json(denied)["code"] == "MANAGER_REQUIRED"

            confirmed = await _manage(client, manager, {
                "action": "confirm_ready",
                "operation_id": "op-confirm-worker",
                "team_id": "team-a",
                "expected_revision": 2,
                "member_id": "worker-a",
                "receipt": worker_capsule["onboardingReceipt"],
                "evidence_ref": "evidence:onboarding",
            })
            assert confirmed.is_error is False
            assert _text_json(confirmed)["outcome"] == "ready"

            ready = await client.call_tool(
                "team_context.read", {"host_id": worker[0], "thread_id": worker[1]}
            )
            ready_capsule = _text_json(ready)
            assert ready_capsule["onboarding"]["status"] == "ready"
            assert ready_capsule["executionIntegration"] == "not-connected"
            assert ready_capsule["dispatchAllowed"] is False

    asyncio.run(exercise())


def test_registry_stdio_returns_pure_json_core_errors(tmp_path: Path) -> None:
    missing = tmp_path / "missing.json"

    async def exercise_missing() -> None:
        async with Client(_server_params(missing), mode="legacy") as client:
            result = await client.call_tool(
                "team_context.read", {"host_id": "host-a", "thread_id": "thread-a"}
            )
            assert result.is_error is True
            assert _text_json(result)["code"] == "REGISTRY_MISSING"

    asyncio.run(exercise_missing())

    registry = tmp_path / "registry.json"
    subprocess.run(
        [sys.executable, "-m", "codex_team_context.server", "init", "--registry", str(registry)],
        text=True,
        capture_output=True,
        check=True,
    )

    async def exercise_invalid_requests() -> None:
        async with Client(_server_params(registry), mode="legacy") as client:
            malformed = await _manage(client, ("host-a", "thread-a"), {})
            unknown_action = await _manage(client, ("host-a", "thread-a"), {
                "action": "invent",
                "operation_id": "op-invent",
            })
            non_scalar_action = await _manage(client, ("host-a", "thread-a"), {
                "action": {"name": "bootstrap"},
                "operation_id": "op-object-action",
            })
            unknown_field = await _manage(client, ("host-a", "thread-a"), {
                "action": "bootstrap",
                "operation_id": "op-bootstrap",
                "team_id": "team-a",
                "team_name": "Team A",
                "member_id": "manager-a",
                "name": "Manager A",
                "authorization_ref": "approved",
                "extra": True,
            })
            for result in (malformed, unknown_action, non_scalar_action, unknown_field):
                assert result.is_error is True
                assert len(result.content) == 1
                assert set(_text_json(result)) == {"code", "message"}
                assert _text_json(result)["code"] == "INVALID_REQUEST"

    asyncio.run(exercise_invalid_requests())


def test_registry_stdio_sdk_validation_failures_do_not_mutate_registry(tmp_path: Path) -> None:
    registry = tmp_path / "registry.json"
    subprocess.run(
        [sys.executable, "-m", "codex_team_context.server", "init", "--registry", str(registry)],
        text=True,
        capture_output=True,
        check=True,
    )
    before = registry.read_bytes()

    async def assert_native_failure(client: Client, arguments: dict) -> None:
        try:
            result = await client.call_tool("team_context.manage", arguments)
        except Exception as exc:
            assert str(exc).strip()
            return
        assert result.is_error is True
        assert result.content
        texts = [content.text for content in result.content if content.type == "text"]
        assert texts and all(text.strip() and text.strip() != "null" for text in texts)

    async def exercise() -> None:
        async with Client(_server_params(registry), mode="legacy") as client:
            await assert_native_failure(client, {
                "actor_host_id": "host-manager",
                "actor_thread_id": "thread-manager",
            })
            await assert_native_failure(client, {
                "actor_host_id": 7,
                "actor_thread_id": "thread-manager",
                "request": {},
            })
            await assert_native_failure(client, {
                "actor_host_id": "host-manager",
                "actor_thread_id": ["thread-manager"],
                "request": {},
            })
            still_connected = await client.call_tool(
                "team_context.read",
                {"host_id": "host-none", "thread_id": "thread-none"},
            )
            assert still_connected.is_error is False
            assert len(still_connected.content) == 1
            assert still_connected.content[0].type == "text"
            assert still_connected.content[0].text == "null"

    asyncio.run(exercise())
    assert registry.read_bytes() == before


def test_registry_stdio_client_exit_reaps_server_process(tmp_path: Path) -> None:
    registry = tmp_path / "registry.json"
    subprocess.run(
        [sys.executable, "-m", "codex_team_context.server", "init", "--registry", str(registry)],
        text=True,
        capture_output=True,
        check=True,
    )
    pid_file = tmp_path / "registry-server.pid"

    async def connect_once() -> None:
        async with Client(_server_params(registry, pid_file=pid_file), mode="legacy"):
            for _ in range(100):
                if pid_file.exists():
                    return
                await asyncio.sleep(0.01)
            raise AssertionError("registry server process did not report its pid")

    asyncio.run(connect_once())
    pid = int(pid_file.read_text(encoding="ascii"))
    for _ in range(100):
        if not _pid_exists(pid):
            break
        time.sleep(0.01)
    assert not _pid_exists(pid), f"registry stdio server process {pid} leaked after client exit"
