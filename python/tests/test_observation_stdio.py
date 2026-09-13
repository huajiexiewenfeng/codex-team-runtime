from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from codex_team_context.team_registry import TeamRegistry, initialize_registry
from test_observations import bootstrap_request, events, member_request
from test_registry_cutover import NODE, ROOT, linked


def params(registry: Path, root: Path, *extra: str, observed_team: str = "team-a") -> StdioServerParameters:
    return StdioServerParameters(command=sys.executable, args=[
        "-B", "-m", "codex_team_context.server", "serve", "--registry", str(registry),
        "--observation-root", str(root.resolve()), "--observe-team", observed_team, "--runtime-revision", "runtime-test",
        *extra,
    ])


def value(result):
    assert len(result.content) == 1 and result.content[0].type == "text"
    return json.loads(result.content[0].text)


def prepared(tmp_path: Path):
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
    return path


def test_real_stdio_read_and_manage_preserve_contract_and_record_bounded_results(tmp_path: Path):
    registry, root = prepared(tmp_path), tmp_path / "observations"

    async def scenario():
        async with Client(params(registry, root), mode="legacy") as client:
            catalog = {tool.name: tool for tool in (await client.list_tools()).tools}
            assert catalog["team_context.read"].input_schema["required"] == ["host_id", "thread_id"]
            assert catalog["team_context.manage"].input_schema["required"] == ["actor_host_id", "actor_thread_id", "request"]
            for tool in catalog.values():
                assert "declared reasons are not independently verified" in tool.description.lower()
                assert len(tool.description) <= 600
            assert catalog["team_context.read"].input_schema["properties"]["reason"]["enum"]

            manager = await client.call_tool("team_context.read", {"host_id": "host-manager", "thread_id": "thread-manager", "reason": "resume"})
            liaison = await client.call_tool("team_context.read", {"host_id": "host-liaison", "thread_id": "thread-liaison", "reason": "post_compaction"})
            worker = await client.call_tool("team_context.read", {"host_id": "host-worker", "thread_id": "thread-worker"})
            unknown = await client.call_tool("team_context.read", {"host_id": "missing", "thread_id": "missing", "reason": "manual"})
            assert [value(item)["member"]["role"] for item in (manager, liaison, worker)] == ["Manager", "Liaison", "Worker"]
            assert value(worker)["status"] == "inactive" and value(unknown) is None

            success = await client.call_tool("team_context.manage", {"actor_host_id": "host-manager", "actor_thread_id": "thread-manager", "reason": "before_dispatch", "request": member_request("worker-two", "worker-two", "Worker", 4)})
            error = await client.call_tool("team_context.manage", {"actor_host_id": "host-manager", "actor_thread_id": "thread-manager", "reason": "before_review", "request": {"action": "unknown"}})
            assert value(success)["outcome"] == "registered"
            assert error.is_error is True and value(error)["code"] == "INVALID_REQUEST"

            before = len(events(root))
            invalid = await client.call_tool("team_context.read", {"host_id": "host-manager", "thread_id": "thread-manager", "reason": "invented"})
            assert invalid.is_error is True
            assert len(events(root)) == before

    asyncio.run(scenario())
    stored = events(root)
    assert len(stored) == 5
    assert Counter((item["role"], item["memberStatus"], item["outcome"]) for item in stored) == Counter([
        ("Manager", "active", "matched"), ("Liaison", "active", "matched"),
        ("Worker", "exited", "inactive"), ("Manager", "active", "success"),
        ("Manager", "active", "error"),
    ])
    error = next(item for item in stored if item["outcome"] == "error")
    success = next(item for item in stored if item["outcome"] == "success")
    assert error["errorCode"] == "INVALID_REQUEST" and success["errorCode"] is None
    assert all(item["runtimeRevision"] == "runtime-test" and item["runtimeRevisionSource"] == "operator-declared" for item in stored)


def test_real_stdio_does_not_record_first_bootstrap_or_unknown_and_nonallowlisted_identities(tmp_path: Path):
    registry, root = tmp_path / "registry.json", tmp_path / "observations"
    initialize_registry(registry)

    async def scenario():
        async with Client(params(registry, root), mode="legacy") as client:
            unknown = await client.call_tool("team_context.read", {"host_id": "none", "thread_id": "none"})
            boot = await client.call_tool("team_context.manage", {"actor_host_id": "host-manager", "actor_thread_id": "thread-manager", "request": bootstrap_request()})
            assert value(unknown) is None and value(boot)["outcome"] == "bootstrapped"
    asyncio.run(scenario())
    assert not root.exists()

    other_root = tmp_path / "other-observations"
    async def other_team():
        other = StdioServerParameters(command=sys.executable, args=[
            "-B", "-m", "codex_team_context.server", "serve", "--registry", str(registry),
            "--observation-root", str(other_root.resolve()), "--observe-team", "team-b"])
        async with Client(other, mode="legacy") as client:
            assert value(await client.call_tool("team_context.read", {"host_id": "host-manager", "thread_id": "thread-manager"}))["member"]["role"] == "Manager"
    asyncio.run(other_team())
    assert not other_root.exists()


def test_real_stdio_startup_records_success_with_outer_reason(linked, tmp_path: Path):
    registry_object, registry, _, _, adoption = linked
    registry_object.manage("fixture-host", "fixture-manager", adoption)
    root = tmp_path / "startup-observations"

    async def scenario():
        async with Client(params(registry, root, "--node-executable", str(NODE), "--runtime-root", str(ROOT), observed_team="legacy-team"), mode="legacy") as client:
            listed = {tool.name: tool for tool in (await client.list_tools()).tools}
            assert listed["team_context.startup"].input_schema["required"] == ["actor_host_id", "actor_thread_id", "request"]
            result = await client.call_tool("team_context.startup", {"actor_host_id": "fixture-host", "actor_thread_id": "fixture-manager", "reason": "onboarding", "request": {"action": "plan"}})
            assert not result.is_error
    asyncio.run(scenario())
    stored = events(root)
    assert len(stored) == 1 and stored[0]["tool"] == "team_context.startup"
    assert stored[0]["reason"] == "onboarding" and stored[0]["outcome"] == "success"
