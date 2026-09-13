import asyncio
import sys

from mcp.client import Client
from mcp.client.stdio import StdioServerParameters
from test_observation_stdio import prepared, value
from test_observation_reload import write_config
from test_observations import events


def test_one_stdio_process_reloads_allowlist_without_changing_read_result(tmp_path):
    registry = prepared(tmp_path)
    before = registry.read_bytes()
    root, config = tmp_path / 'events', tmp_path / 'config.json'
    write_config(config, [])
    params = StdioServerParameters(command=sys.executable, args=[
        '-B', '-m', 'codex_team_context.server', 'serve', '--registry', str(registry),
        '--observation-root', str(root), '--observation-config', str(config)])

    async def scenario():
        async with Client(params, mode='legacy') as client:
            async def read():
                result = await client.call_tool('team_context.read', {
                    'host_id': 'host-manager', 'thread_id': 'thread-manager', 'reason': 'manual'})
                assert not result.is_error
                return value(result)
            baseline = await read()
            assert not events(root)
            write_config(config, ['team-a'])
            assert await read() == baseline
            assert len(events(root)) == 1
            write_config(config, [])
            assert await read() == baseline
            assert len(events(root)) == 1
            config.write_text('{broken', encoding='utf-8')
            assert await read() == baseline
            assert len(events(root)) == 1
            write_config(config, ['team-a'])
            assert await read() == baseline
            assert len(events(root)) == 2
    asyncio.run(scenario())
    assert registry.read_bytes() == before
