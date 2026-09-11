from __future__ import annotations

import asyncio
import json
import sys

from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from test_registry_cutover import NODE, ROOT
from test_startup_recovery import startup  # noqa: F401 - shared isolated fixture


def value(result):
    assert not result.is_error, result
    assert len(result.content) == 1
    return json.loads(result.content[0].text)


def test_separate_stdio_connections_recover_receipt_without_native_listing(startup):
    _, registry, registry_path, state_path = startup
    original = registry_path.read_bytes(), state_path.read_bytes()
    params = StdioServerParameters(command=sys.executable, args=[
        "-B", "-m", "codex_team_context.server", "serve", "--registry", str(registry_path),
        "--node-executable", str(NODE), "--runtime-root", str(ROOT)])
    common = {"actor_host_id": "local", "actor_thread_id": "manager-thread"}

    async def scenario():
        async with Client(params) as client:
            listed = await client.list_tools()
            catalog = {t.name: t for t in listed.tools}
            assert set(catalog) == {"team_context.read", "team_context.manage", "team_context.startup"}
            assert catalog["team_context.startup"].annotations.destructive_hint is False
            value(await client.call_tool("team_context.startup", {**common, "request": {
                "action": "prepare", "operation_id": "op-worker", "team_id": "team", "member_id": "worker",
                "role": "Worker", "target_host_id": "local", "state_path": str(state_path.resolve()),
                "authorization_ref": "fixture:user-authorized"}}))
            claimed = value(await client.call_tool("team_context.startup", {**common, "request": {
                "action": "claim", "operation_id": "op-worker"}}))
            assert claimed["claimed"] is True
        # A child task need not be listed or have a readable final reply. It only
        # needs the authorized startup tool and its externally checked identity.
        async with Client(params) as child:
            result = value(await child.call_tool("team_context.startup", {
                "actor_host_id": "local", "actor_thread_id": "worker-thread", "request": {
                    "action": "receipt", "operation_id": "op-worker", "team_id": "team", "member_id": "worker",
                    "role": "Worker", "evidence_ref": "fixture:own-native-read"}}))
            assert result["registered"] is False
            assert value(await child.call_tool("team_context.read", {"host_id": "local", "thread_id": "worker-thread"})) is None
        async with Client(params) as recovered:
            plans = value(await recovered.call_tool("team_context.startup", {**common, "request": {"action": "plan"}}))
            assert plans["operations"][0]["candidates"][0]["threadId"] == "worker-thread"
            assert plans["operations"][0]["stage"] == "verify_identity"
            denied = await recovered.call_tool("team_context.startup", {**common, "request": {"action": "unknown"}})
            assert denied.is_error is True
    asyncio.run(scenario())
    assert registry.read("local", "worker-thread") is None
    assert (registry_path.read_bytes(), state_path.read_bytes()) == original
