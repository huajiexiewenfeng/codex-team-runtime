from __future__ import annotations
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
import pytest
from codex_team_context.inbox import InboxService, validate_request
from codex_team_context.core import ContextError
from codex_team_context.server import create_server
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters
from codex_team_context.notice_process import invoke_notice_process
from test_notice import notice_team, NODE, ROOT

def request(action, operation_id=None, **extra):
    return dict(action=action, actor_host_id='fixture-host', actor_thread_id='fixture-manager', team_id='legacy-team', reason='manual', **({'operation_id': operation_id} if operation_id else {}), **extra)

def initialized(notice_team):
    registry, rp, sp, _ = notice_team
    service = InboxService(registry)
    state = json.loads(sp.read_text())
    revision = registry._store.read()['teams'][0]['revision']
    result = service.handle(request('control', 'init', command='init', authorization_ref='isolated explicit owner grant', expected_absent=True, expected_state_version=state['version'], team_revision=revision))
    assert result['status'] == 'initialized', result
    return service, rp, sp, result

def test_real_python_node_cli_bridge_and_observe_defaults(notice_team, tmp_path):
    service, rp, sp, init = initialized(notice_team)
    before = sp.read_bytes()
    status = service.handle(request('status', operation_id='init'))
    assert status['operation']['response']['inboxVersion'] == init['inboxVersion']
    cp = service.handle(request('checkpoint', 'shadow-check', run_id='run', expected_control_revision=init['controlRevision'], trigger='step_complete'))
    assert cp['status'] == 'shadow-checkpoint' and cp['consumer'] is None
    assert cp['items'][0]['submissionId'] == 'submission-1'
    assert sp.read_bytes() == before
    assert not Path(str(sp)+'.submission-notices.json').exists()
    input_file = tmp_path/'closed-request.json'
    input_file.write_text(json.dumps(request('status')), encoding='utf-8')
    env = os.environ.copy()
    env['CODEX_TEAM_CONTEXT_PYTHON'] = sys.executable
    result = subprocess.run([str(NODE), str(ROOT/'src/cli.mjs'), 'inbox-status', str(sp), str(input_file)], capture_output=True, text=True, encoding='utf-8', env=env, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['mode'] == 'observe'

def test_three_layer_queue_first_full_review_and_no_native_send(notice_team):
    service, rp, sp, init = initialized(notice_team)
    loaded = [{'member_id': name, 'binding_revision': 1, 'evidence_ref': 'synthetic explicit loaded handoff'} for name in ['manager', 'worker']]
    mode = service.handle(request('control', 'mode', command='set_mode', authorization_ref='fixture opt-in', expected_control_revision=init['controlRevision'], mode='queue_first', protocol_loaded=loaded))
    resume = service.handle(request('control', 'resume', command='resume_claims', authorization_ref='fixture', expected_control_revision=mode['controlRevision']))
    cp = service.handle(request('checkpoint', 'cp', run_id='run', expected_control_revision=resume['controlRevision'], trigger='resume'))
    item = cp['items'][0]
    claim = service.handle(request('claim', 'claim', run_id='run', generation=cp['consumer']['generation'], expected_control_revision=cp['controlRevision'], expected_work_id=None, checkpoint_id='cp', item_id=item['itemId'], payload_seq=item['payloadSeq'], boundary_ref='safe fixture step'))
    review = service.handle(request('start_review', 'review', run_id='run', generation=claim['claim']['generation'], claim_id=claim['claim']['id'], expected_state_version=json.loads(sp.read_text())['version']))
    assert review['status'] == 'review-started', review
    assert json.loads(sp.read_text())['tasks'][0]['status'] == 'reviewing'
    replay = service.handle(request('start_review', 'review', run_id='run', generation=claim['claim']['generation'], claim_id=claim['claim']['id'], expected_state_version=review['sourceVersion']-1))
    assert replay['replayed'] and replay['businessEventId'] == review['businessEventId']
    assert not Path(str(sp)+'.submission-notices.json').exists()
    assert review['hostActionExecuted'] is False

def test_raw_schema_duplicate_unknown_role_depth_and_core_nested_boundary(notice_team):
    service, rp, sp, init = initialized(notice_team)
    for value in ['{"action":"status","action":"control"}', json.dumps({**request('status'), 'path': str(sp)}), json.dumps({**request('status'), 'x': json.loads('['*40+'0'+']'*40)})]:
        with pytest.raises(ContextError):
            validate_request(value)
    for reason in [[], {}, 1, None]:
        with pytest.raises(ContextError, match='INVALID_REQUEST'):
            validate_request({**request('status'), 'reason': reason})
    with pytest.raises(ContextError):
        service.handle({**request('control', 'worker-mode', command='pause_claims', authorization_ref='bad role', expected_control_revision=init['controlRevision']), 'actor_thread_id': 'fixture-worker'})
    before = Path(str(sp)+'.manager-inbox.json').read_bytes()
    rejected = service.handle(request('control', 'bad-inner', command='pause_claims', authorization_ref='fixture', expected_control_revision=init['controlRevision'], recovery={'arbitrary_command': 'never run'}))
    assert rejected['status'] == 'error' and rejected['reasonCode'] == 'INVALID_REQUEST'
    assert Path(str(sp)+'.manager-inbox.json').read_bytes() == before

def test_tool_discovery_and_call_uses_raw_closed_request_no_extra_path(notice_team):
    registry, rp, sp, _ = notice_team
    server = create_server(registry_path=rp, node_executable=NODE, runtime_root=ROOT)
    tools = asyncio.run(server.list_tools())
    by_name = {t.name: t for t in tools}
    assert {'team_context.inbox', 'team_context.inbox_status'} <= by_name.keys()
    assert by_name['team_context.inbox_status'].annotations.read_only_hint
    assert by_name['team_context.inbox'].input_schema['additionalProperties'] is False
    async def calls():
        good = await server.call_tool('team_context.inbox_status', {'request_json': json.dumps(request('status'))})
        value = json.loads(good.content[0].text)
        assert value['status'] == 'uninitialized' and value['mode'] == 'legacy'
        with pytest.raises(Exception):
            await server.call_tool('team_context.inbox_status', {'request_json': json.dumps(request('status')), 'path': str(sp)})
        with pytest.raises(Exception):
            await server.call_tool('team_context.inbox_status', {'request_json': json.dumps(request('control', 'wrong', command='init'))})
    asyncio.run(calls())

def test_status_owned_lock_paths_and_bridge_failure_no_native_fallback(notice_team, monkeypatch):
    registry, rp, sp, _ = notice_team
    observed = []
    def failed(command, payload, env, token, paths, **kwargs):
        observed.append((command, paths, kwargs, json.loads(payload)))
        return {'status': 'error', 'reasonCode': 'BRIDGE_TIMEOUT', 'hostActionExecuted': False, 'nextAction': 'notice_status'}
    monkeypatch.setattr('codex_team_context.inbox.invoke_notice_process', failed)
    result = InboxService(registry).handle(request('status'))
    assert result['reasonCode'] == 'BRIDGE_TIMEOUT' and result['nextAction'] == 'inbox_status'
    assert len(observed) == 1
    command, paths, kwargs, envelope = observed[0]
    assert command[-1].endswith('manager-inbox-adapter.mjs')
    assert paths == {str(rp)+'.lock', str(sp)+'.lock', str(sp)+'.manager-inbox.json.lock'}
    assert kwargs['read_only'] is False  # even status guard has owned cleanup
    assert not any('submission-notices' in p for p in paths)
    assert set(envelope) == {'statePath','registryPath','request','runtimeRevision','executionToken'}

def test_real_escaped_response_budget_and_operation_recovery_through_python(notice_team):
    service, rp, sp, init = initialized(notice_team)
    mode = service.handle(request('control', 'mode', command='set_mode', authorization_ref='fixture', expected_control_revision=init['controlRevision'], mode='queue_first', protocol_loaded=[{'member_id':n,'binding_revision':1,'evidence_ref':'loaded fixture'} for n in ['manager','worker']]))
    resume = service.handle(request('control', 'resume', command='resume_claims', authorization_ref='fixture', expected_control_revision=mode['controlRevision']))
    for n in range(3):
        message = dict(kind='stage',message_id='large-'+str(n),round_id='r',task_id='t',step_id='step',producer_seq=n,summary='\\'*1800,evidence=[{'kind':'artifact','ref':'\\'*500} for _ in range(8)])
        assert service.handle({**request('post','large-post-'+str(n),message=message),'actor_thread_id':'fixture-worker'})['status']=='enqueued'
    cp = service.handle(request('checkpoint','large-cp',run_id='run',expected_control_revision=resume['controlRevision'],trigger='step_complete',limit=8))
    assert cp['status']=='checkpoint' and cp['hasMore'] and len(cp['items'])<4
    original = service.handle(request('status',operation_id='large-cp'))
    assert original['operation']['response']==cp
    for value in [cp, original]:
        wire = json.dumps({'content':[{'type':'text','text':json.dumps(value,ensure_ascii=False)}],'isError':False},ensure_ascii=False).encode()
        assert len(wire)<65536

def test_actual_stdio_tools_no_side_effect_status_and_raw_schema(notice_team):
    registry,rp,sp,_=notice_team
    async def scenario():
        params=StdioServerParameters(command=sys.executable,args=['-B','-m','codex_team_context.server','serve','--registry',str(rp),'--node-executable',str(NODE),'--runtime-root',str(ROOT)])
        async with Client(params) as client:
            names={t.name for t in (await client.list_tools()).tools}
            assert {'team_context.inbox','team_context.inbox_status'}<=names
            before=sp.read_bytes()
            result=await client.call_tool('team_context.inbox_status',{'request_json':json.dumps(request('status'))})
            assert not result.is_error and json.loads(result.content[0].text)['mode']=='legacy'
            bad=await client.call_tool('team_context.inbox_status',{'request_json':'{"action":"status","action":"post"}'})
            assert bad.is_error
            assert sp.read_bytes()==before and not Path(str(sp)+'.manager-inbox.json').exists()
    asyncio.run(scenario())

def test_real_status_timeout_cleans_only_proven_owned_e05_locks(notice_team,monkeypatch,tmp_path):
    registry,rp,sp,_=notice_team
    foreign=tmp_path/'foreign.lock';foreign.write_text('unrelated untouched lock')
    captures=[]
    def timeout(command,payload,env,token,paths,**kwargs):
        script='import {ownedLocks} from '+json.dumps((ROOT/'src/notice-adapter.mjs').as_uri())+'; await ownedLocks('+json.dumps(token)+')('+json.dumps(sorted(paths))+',async()=>{await new Promise(r=>setTimeout(r,3000));});'
        result=invoke_notice_process([str(NODE),'--input-type=module','-e',script],b'',env,token,paths,timeout=.4,read_only=False)
        captures.append((result,paths))
        return result
    monkeypatch.setattr('codex_team_context.inbox.invoke_notice_process',timeout)
    result=InboxService(registry).handle(request('status'))
    assert result['reasonCode']=='BRIDGE_TIMEOUT' and result['executionEnded'] and result['cleanupStatus']=='complete'
    assert all(not Path(p).exists() for p in captures[0][1])
    assert foreign.read_text()=='unrelated untouched lock'
