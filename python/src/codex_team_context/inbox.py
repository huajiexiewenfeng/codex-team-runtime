"""E05 trusted, bounded bridge. Never sends or falls back to native messaging."""
from __future__ import annotations
import json
import os
import re
import sys
import uuid
from pathlib import Path
from .core import ContextError
from .notice import strict_json, REASONS
from .notice_process import invoke_notice_process
from .runtime_link import canonical_absolute

MAX_REQUEST = 65536
MAX_RESPONSE = 65536
COMMON = {'action', 'actor_host_id', 'actor_thread_id', 'team_id', 'reason'}
FIELDS = {
    'post': {'operation_id', 'message'},
    'checkpoint': {'operation_id', 'run_id', 'expected_control_revision', 'trigger', 'limit', 'continuation', 'transition', 'expected_work_id', 'human_ref', 'effect_result'},
    'claim': {'operation_id', 'run_id', 'generation', 'expected_control_revision', 'expected_work_id', 'checkpoint_id', 'item_id', 'payload_seq', 'boundary_ref'},
    'start_review': {'operation_id', 'run_id', 'generation', 'claim_id', 'expected_state_version'},
    'resolve': {'operation_id', 'run_id', 'generation', 'expected_control_revision', 'expected_work_id', 'item_id', 'claim_id', 'checkpoint_id', 'disposition', 'reason_ref', 'decision_event_id', 'defer', 'human_ref'},
    'control': {'operation_id', 'command', 'expected_control_revision', 'expected_absent', 'expected_state_version', 'team_revision', 'authorization_ref', 'mode', 'protocol_loaded', 'run_id', 'generation', 'expected_work_id', 'claim_id', 'recovery'},
    'status': {'operation_id', 'item_id', 'work_id', 'limit'},
}

def validate_request(value):
    def check(ok, code='INVALID_REQUEST'):
        if not ok:
            raise ContextError(code, code)
    if isinstance(value, str):
        try:
            raw_size = len(value.encode('utf-8', errors='strict'))
        except UnicodeError:
            raise ContextError('INVALID_REQUEST', 'Invalid Unicode')
        check(raw_size <= MAX_REQUEST, 'PAYLOAD_TOO_LARGE')
        try:
            request = strict_json(value)
        except (ValueError, RecursionError):
            raise ContextError('INVALID_REQUEST', 'Invalid or duplicate-key JSON')
    else:
        request = value
    def depth(v, level=0):
        check(level <= 32, 'JSON_DEPTH_LIMIT')
        if isinstance(v, dict):
            check(all(isinstance(k, str) and k not in {'__proto__', 'prototype', 'constructor'} for k in v))
            for k, x in v.items():
                depth(k, level + 1)
                depth(x, level + 1)
        elif isinstance(v, list):
            for x in v:
                depth(x, level + 1)
    depth(request)
    check(isinstance(request, dict) and isinstance(request.get('action'), str) and request['action'] in FIELDS)
    action = request['action']
    if isinstance(value, str) and action == 'post':
        check(len(value.encode('utf-8', errors='strict')) <= 16384, 'PAYLOAD_TOO_LARGE')
    check(COMMON <= request.keys() <= COMMON | FIELDS[action])
    for k in ('actor_host_id', 'actor_thread_id', 'team_id'):
        check(isinstance(request[k], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', request[k]) is not None)
    check(isinstance(request['reason'], str) and request['reason'] in REASONS)
    if action != 'status':
        check(isinstance(request.get('operation_id'), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', request['operation_id']) is not None)
    try:
        payload = json.dumps(request, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8', errors='strict')
    except (ValueError, TypeError, UnicodeError):
        raise ContextError('INVALID_REQUEST', 'Invalid JSON/Unicode')
    check(len(payload) <= (16384 if action == 'post' else MAX_REQUEST), 'PAYLOAD_TOO_LARGE')
    return request

class InboxService:
    def __init__(self, registry, runtime_revision=None):
        self.registry = registry
        self.runtime_revision = runtime_revision or 'unversioned'

    def handle(self, request):
        r = validate_request(request)
        value = self.registry._validated(self.registry._store.read())
        located = self.registry._member_by_identity(value, r['actor_host_id'], r['actor_thread_id'])
        if located is None:
            raise ContextError('UNREGISTERED', 'Caller is not registered')
        team, member = located
        roles = {'Worker'} if r['action'] == 'post' else {'Manager', 'Worker'} if r['action'] == 'status' else {'Manager'}
        if team['id'] != r['team_id'] or member['lifecycle'] != 'active' or member['role'] not in roles:
            raise ContextError('IDENTITY_CONFLICT', 'Caller/team/role mismatch')
        leader = self.registry._member(team, team['leaderMemberId'])
        if self.registry._effective_onboarding_status(value, team, member, leader) != 'ready' or not team.get('runtime'):
            raise ContextError('TEAM_NOT_CONNECTED', 'Current ready linked membership required')
        node, root = self.registry._trusted_runtime()
        state = canonical_absolute(team['runtime']['statePath'], 'statePath')
        adapter = root / 'src' / 'manager-inbox-adapter.mjs'
        if not adapter.is_file():
            raise ContextError('RUNTIME_UNAVAILABLE', 'E05 is not installed in the trusted runtime')
        token = uuid.uuid4().hex
        envelope = {'statePath': str(state), 'registryPath': str(self.registry.registry_path), 'request': r,
                    'runtimeRevision': self.runtime_revision, 'executionToken': token}
        raw = json.dumps(envelope, ensure_ascii=False, allow_nan=False).encode('utf-8')
        env = os.environ.copy()
        env['CODEX_TEAM_CONTEXT_PYTHON'] = str(Path(sys.executable).resolve())
        paths = {str(self.registry.registry_path) + '.lock', str(state) + '.lock', str(state) + '.manager-inbox.json.lock'}
        # Status takes the same guard. All operations emit exact token/PID lock
        # ownership, so timeout cleanup uses this invocation's allowed E05 paths.
        result = invoke_notice_process([str(node), str(adapter)], raw, env, token, paths, read_only=False)
        if result.get('nextAction') == 'notice_status':
            result['nextAction'] = 'inbox_status'
        wire = json.dumps({'content': [{'type': 'text', 'text': json.dumps(result, ensure_ascii=False)}], 'isError': result.get('status') == 'error'}, ensure_ascii=False).encode('utf-8')
        if len(wire) > MAX_RESPONSE:
            raise ContextError('PAYLOAD_TOO_LARGE', 'E05 response exceeds wrapped limit')
        return result
