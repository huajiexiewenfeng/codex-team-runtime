import json
from pathlib import Path

import pytest

from codex_team_context.core import ContextError
from codex_team_context.observations import configure_observations, observed_call
from test_observations import identity, events


def setup(tmp_path):
    config = tmp_path / 'observation.json'
    root = tmp_path / 'events'
    recorder = configure_observations(root=root, observed_teams=None,
        runtime_revision=None, registry_mode=True, config_path=config)
    return config, root, recorder


def write_config(path, teams):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'schemaVersion': 1, 'observedTeams': teams}), encoding='utf-8')
    temporary.replace(path)


def call(recorder, team='team-a', operation=lambda: 'ok'):
    return observed_call(recorder, lambda: identity(team=team),
        'team_context.read', 'manual', operation, lambda _: 'matched')


def test_same_recorder_add_remove_disable_and_recover(tmp_path):
    config, root, recorder = setup(tmp_path)
    assert call(recorder) == 'ok'  # Missing configuration starts disabled.
    assert not events(root)
    write_config(config, ['team-a'])
    call(recorder)
    call(recorder, 'team-b')
    assert len(events(root)) == 1
    write_config(config, ['team-b'])
    call(recorder)
    call(recorder, 'team-b')
    assert len(events(root)) == 2
    write_config(config, [])
    call(recorder, 'team-b')
    assert len(events(root)) == 2
    write_config(config, ['team-a'])
    call(recorder)
    assert len(events(root)) == 3


@pytest.mark.parametrize('bad', [b'{', b'\xff', b'{}', b'[]',
    b'{"schemaVersion":true,"observedTeams":["team-a"]}',
    b'{"schemaVersion":1,"observedTeams":["*"]}',
    b'{"schemaVersion":1,"observedTeams":["team-a"],"extra":1}',
    b'{"schemaVersion":1,"observedTeams":["team-a"],"observedTeams":[]}',
    b' ' * 65537], ids=['broken', 'utf8', 'missing', 'array', 'bool-version',
                       'wildcard', 'extra', 'duplicate-key', 'oversized'])
def test_invalid_reload_fails_closed_without_stale_allowlist(tmp_path, bad):
    config, root, recorder = setup(tmp_path)
    write_config(config, ['team-a'])
    call(recorder)
    config.write_bytes(bad)
    assert call(recorder) == 'ok'
    assert len(events(root)) == 1
    config.unlink()
    assert call(recorder) == 'ok'
    assert len(events(root)) == 1
    write_config(config, ['team-a'])
    call(recorder)
    assert len(events(root)) == 2


def test_changes_during_call_do_not_retroactively_enable_or_ignore_disable(tmp_path):
    config, root, recorder = setup(tmp_path)
    write_config(config, [])
    call(recorder, operation=lambda: write_config(config, ['team-a']))
    assert not events(root)
    call(recorder, operation=lambda: write_config(config, []))
    assert not events(root)


def test_config_path_rejects_ambiguous_or_invalid_startup(tmp_path):
    for change in ({'observed_teams': ['team-a']}, {'config_path': Path('relative')},
                   {'root': None}, {'registry_mode': False}):
        kwargs = dict(root=tmp_path / 'out', observed_teams=None,
                      runtime_revision=None, registry_mode=True, config_path=tmp_path / 'config.json')
        kwargs.update(change)
        with pytest.raises(ContextError) as exc:
            configure_observations(**kwargs)
        assert exc.value.code == 'INVALID_OBSERVATION_CONFIG'
