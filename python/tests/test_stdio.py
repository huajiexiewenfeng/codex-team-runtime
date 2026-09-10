from __future__ import annotations

import asyncio
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from codex_team_context.core import ContextRegistry


def _write_state(path: Path, *, lifecycle: str = "active") -> None:
    state = {
        "schemaVersion": 1,
        "version": 0,
        "events": [],
        "team": {"id": "team-a"},
        "members": [
            {
                "id": "manager-a",
                "role": "Manager",
                "lifecycle": lifecycle,
                "binding": {
                    "status": "bound",
                    "hostId": "local",
                    "threadId": "thread-a",
                },
            },
            {
                "id": "liaison-a",
                "role": "Liaison",
                "lifecycle": "active",
                "binding": {"status": "unbound"},
            },
        ],
    }
    path.write_text(json.dumps(state), encoding="utf-8")


def _server_params(index: Path, state_root: Path, *, pid_file: Path | None = None) -> StdioServerParameters:
    args = ["-m", "codex_team_context.server", "serve", "--index", str(index)]
    args.extend(["--state-root", str(state_root)])
    if pid_file is None:
        return StdioServerParameters(command=sys.executable, args=args)

    launcher = (
        "import os,runpy,sys;"
        f"open({str(pid_file)!r},'w',encoding='ascii').write(str(os.getpid()));"
        "sys.argv=['codex-team-context',*sys.argv[1:]];"
        "runpy.run_module('codex_team_context.server',run_name='__main__')"
    )
    return StdioServerParameters(command=sys.executable, args=["-c", launcher, *args[2:]])


def _text_json(result):
    assert len(result.content) == 1
    assert result.content[0].type == "text"
    return json.loads(result.content[0].text)


def _pid_exists(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True
    process_query_limited_information = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(process_query_limited_information, False, pid)
    if handle:
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    return False


def test_init_cli_creates_new_index_and_refuses_overwrite(tmp_path: Path) -> None:
    index = tmp_path / "context-index.json"
    command = [sys.executable, "-m", "codex_team_context.server", "init", "--index", str(index)]

    created = subprocess.run(command, text=True, capture_output=True, check=False)
    duplicate = subprocess.run(command, text=True, capture_output=True, check=False)

    assert created.returncode == 0, created.stderr
    assert json.loads(index.read_text(encoding="utf-8")) == {"schemaVersion": 1, "entries": []}
    assert duplicate.returncode != 0
    assert "INDEX_EXISTS" in duplicate.stderr


def test_real_stdio_round_trip_exposes_only_bounded_tools(tmp_path: Path) -> None:
    index = tmp_path / "context-index.json"
    index.write_text('{"schemaVersion":1,"entries":[]}\n', encoding="utf-8")
    state = tmp_path / "state.json"
    _write_state(state)
    ContextRegistry(index_path=index, state_roots=[tmp_path]).register(
        "local", "thread-a", state, "manager-a"
    )

    async def exercise() -> None:
        async with Client(_server_params(index, tmp_path), mode="legacy") as client:
            assert client.instructions is None
            listed = await client.list_tools()
            tools = {tool.name: tool for tool in listed.tools}
            assert set(tools) == {"team_context.read"}
            assert tools["team_context.read"].annotations.read_only_hint is True
            assert tools["team_context.read"].input_schema["required"] == ["host_id", "thread_id"]

            missing = await client.call_tool(
                "team_context.read", {"host_id": "local", "thread_id": "unknown"}
            )
            assert missing.is_error is False
            assert _text_json(missing) is None

            active = await client.call_tool(
                "team_context.read", {"host_id": "local", "thread_id": "thread-a"}
            )
            assert active.is_error is False
            assert _text_json(active)["role"] == "Manager"

            _write_state(state, lifecycle="exited")
            inactive = await client.call_tool(
                "team_context.read", {"host_id": "local", "thread_id": "thread-a"}
            )
            assert inactive.is_error is False
            assert _text_json(inactive)["status"] == "inactive"

            invalid = await client.call_tool(
                "team_context.read", {"host_id": "", "thread_id": "thread-a"}
            )
            assert invalid.is_error is True
            error = _text_json(invalid)
            assert error["code"] == "INVALID_IDENTITY"
            assert isinstance(error["message"], str) and error["message"]

    asyncio.run(exercise())


def test_stdio_client_exit_reaps_server_process(tmp_path: Path) -> None:
    index = tmp_path / "context-index.json"
    index.write_text('{"schemaVersion":1,"entries":[]}\n', encoding="utf-8")
    pid_file = tmp_path / "server.pid"

    async def connect_once() -> None:
        async with Client(_server_params(index, tmp_path, pid_file=pid_file), mode="legacy"):
            for _ in range(100):
                if pid_file.exists():
                    return
                await asyncio.sleep(0.01)
            raise AssertionError("server process did not report its pid")

    asyncio.run(connect_once())
    pid = int(pid_file.read_text(encoding="ascii"))
    for _ in range(100):
        if not _pid_exists(pid):
            break
        time.sleep(0.01)
    assert not _pid_exists(pid), f"stdio server process {pid} leaked after client exit"
