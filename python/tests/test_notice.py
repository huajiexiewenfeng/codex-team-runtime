from __future__ import annotations
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters
from codex_team_context.notice import NoticeService, validate_request, strict_json
from codex_team_context.notice_process import invoke_notice_process, cleanup_owned
from codex_team_context.core import ContextError
from codex_team_context.team_registry import TeamRegistry, initialize_registry
from codex_team_context.server import create_server
import test_registry_cutover as cutover

NODE = cutover.NODE
ROOT = Path(__file__).resolve().parents[2]

@pytest.fixture
def notice_team(tmp_path):
    registry_path = (tmp_path/'registry.json').resolve()
    state_path = (tmp_path/'state.json').resolve()
    initialize_registry(registry_path)
    # Entirely synthetic delivery source; no native send is performed by tests.
    state = json.loads(cutover.legacy_bytes())
    state['team']['source']['kind'] = 'manual'
    for event in state['events']:
        event['source']['kind'] = 'manual'
    raw = json.dumps(state).encode();state_path.write_bytes(raw)
    registry=TeamRegistry(registry_path=registry_path,node_executable=NODE,runtime_root=ROOT)
    registry.manage('fixture-host','fixture-manager',cutover.adoption_request(state_path,raw))
    for i, member in enumerate(['manager','worker']):
        capsule=registry.read('fixture-host','fixture-'+member)
        registry.manage('fixture-host','fixture-manager',{'action':'confirm_ready','operation_id':'ready-'+member,'team_id':'legacy-team','expected_revision':i+1,'member_id':member,'receipt':capsule['onboardingReceipt'],'evidence_ref':'synthetic-receipt'})
    script=f"""
import {{readState,transact}} from {json.dumps((ROOT/'src/store.mjs').as_uri())};
const path={json.dumps(str(state_path))},options={{python:{json.dumps(sys.executable)}}};
let s=await readState(path,options);
const at='2026-10-01T00:00:00.000Z',source={{kind:'manual',ref:'synthetic-no-send'}};
for(const event of [{{id:'open',type:'openRound',roundId:'r',title:'Round'}},
 {{id:'assign',type:'assign',roundId:'r',taskId:'t',title:'Task',workerId:'worker',required:true,assignedAt:at,caller:{{hostId:'fixture-host',threadId:'fixture-manager'}}}},
 {{id:'submission-1',type:'submit',roundId:'r',taskId:'t',summary:'Exact synthetic delivery.',actor:'worker'}}])
 s=await transact(path,s.version,{{actor:'manager',at,source,...event}},options);
"""
    subprocess.run([str(NODE),'--input-type=module','-e',script],check=True,capture_output=True)
    request=dict(action='prepare',actor_host_id='fixture-host',actor_thread_id='fixture-worker',team_id='legacy-team',task_id='t',submission_id='submission-1',reason='before_delivery',operation_id='prepare-1',baseline=dict(outcome='not-attempted',evidence=dict(kind='observation',ref='submission-1',detail='Synthetic verified baseline')))
    return registry,registry_path,state_path,request

def test_real_three_layer_bridge_and_recovery(notice_team):
    registry,registry_path,state_path,request=notice_team
    before=(registry_path.read_bytes(),state_path.read_bytes())
    service=NoticeService(registry)
    prepared=service.handle(request)
    assert prepared['status']=='ready_to_send',prepared
    replay=NoticeService(registry).handle(request)
    assert replay['attemptId']==prepared['attemptId'] and 'hostRequest' not in replay
    result={k:v for k,v in request.items() if k!='baseline'}
    result.update(action='result',operation_id='result-1',attempt_id=prepared['attemptId'],result={'outcome':'accepted','evidence':{'kind':'host-result','ref':'synthetic-native-call','detail':'Synthetic host acceptance'}})
    assert service.handle(result)['status']=='recorded'
    assert service.handle(result)['replayed'] is True
    status={k:v for k,v in request.items() if k not in ['baseline','operation_id']}
    status.update(action='status',prepare_operation_id='prepare-1')
    restored=service.handle(status)
    assert restored['notificationOutcome']=='accepted' and 'hostRequest' not in restored
    assert (registry_path.read_bytes(),state_path.read_bytes())==before
    assert not list(state_path.parent.glob('*.lock'))

@pytest.mark.parametrize('extra',[{'statePath':'bad'}, {'baseline':None}, {'operation_id':'x/../../y'}, {'include_content':True}])
def test_invalid_prepare_fields_are_rejected(extra):
    request=dict(action='prepare',actor_host_id='h',actor_thread_id='w',team_id='t',task_id='task',submission_id='s',reason='before_delivery',operation_id='p',**{})
    request.update(extra)
    with pytest.raises(ContextError):validate_request(request)

def test_strict_json_rejects_duplicates_and_nan():
    for text in ['{"a":1,"a":2}', '{"a":NaN}']:
        with pytest.raises(ValueError):strict_json(text)

def test_real_mcp_discovery_closed_input_and_normal_path(notice_team):
    registry,path,state,request=notice_team
    observations=path.parent/'observations'
    async def scenario():
        params=StdioServerParameters(command=sys.executable,args=['-m','codex_team_context.server','serve','--registry',str(path),'--node-executable',str(NODE),'--runtime-root',str(ROOT),'--observation-root',str(observations),'--observe-team','legacy-team'])
        async with Client(params) as client:
            tools=(await client.list_tools()).tools
            by_name={t.name:t for t in tools}
            assert by_name['team_context.notice_status'].annotations.read_only_hint is True
            assert by_name['team_context.notice'].annotations.read_only_hint is False
            assert by_name['team_context.notice'].input_schema['additionalProperties'] is False
            bad=await client.call_tool('team_context.notice',{**request,'baseline':None})
            assert bad.is_error
            good=await client.call_tool('team_context.notice',request)
            assert not good.is_error,good
            decoded=json.loads(good.content[0].text)
            assert decoded['sendNow'] is True
            status={k:v for k,v in request.items() if k not in ['action','operation_id','baseline']}
            status['prepare_operation_id']='prepare-1'
            read=await client.call_tool('team_context.notice_status',status)
            assert not read.is_error,read
            assert json.loads(read.content[0].text)['attemptId']==decoded['attemptId']
    asyncio.run(scenario())
    events=[json.loads(p.read_text(encoding='utf-8')) for p in observations.glob('*/*.json')]
    assert {e['notice']['action'] for e in events} == {'prepare','status'}
    assert all(e['notice']['taskId']=='t' and e['notice']['requestBytes']>0 for e in events)
    assert all(e['notice']['responseBytes']>0 for e in events)
    stored=json.dumps(events)
    assert 'Exact synthetic delivery.' not in stored and 'Synthetic verified baseline' not in stored
    assert 'hostRequest' not in stored and 'prompt' not in stored

def test_timeout_stops_child_and_recovers_owned_windows_lock(tmp_path):
    lock=str((tmp_path/'owned.lock').resolve());token='a'*32
    script=f"""
import fs from 'node:fs';
import {{spawn}} from 'node:child_process';
const owner={{token:'{token}',nonce:'test-nonce',pid:process.pid,path:{json.dumps(lock)}}};
fs.writeFileSync(owner.path,JSON.stringify(owner),{{flag:'wx'}});
fs.writeSync(2,JSON.stringify({{e03Lock:owner}})+'\\n');
setTimeout(()=>fs.writeFileSync({json.dumps(str(tmp_path/'late'))},'bad'),2000);
spawn(process.execPath,['-e',{json.dumps("setTimeout(()=>require('fs').writeFileSync("+json.dumps(str(tmp_path/'grandchild-late'))+",'bad'),2000)")}],{{stdio:'inherit'}});
"""
    out=invoke_notice_process([str(NODE),'--input-type=module','-e',script],b'',os.environ.copy(),token,{lock},timeout=.4)
    assert out['reasonCode']=='BRIDGE_TIMEOUT',out
    assert out['executionEnded'] is True
    if os.name=='nt':assert out['cleanupStatus']=='complete' and not Path(lock).exists()
    assert not (tmp_path/'late').exists()
    assert not (tmp_path/'grandchild-late').exists()

def test_unknown_and_replaced_locks_are_never_deleted(tmp_path):
    lock=(tmp_path/'unknown.lock').resolve();lock.write_text('')
    assert cleanup_owned(b'','a'*32,{str(lock)})=='required' and lock.exists()
    owner=dict(token='a'*32,nonce='original',pid=123,path=str(lock))
    lock.write_text(json.dumps({**owner,'nonce':'replacement'}))
    reports=(json.dumps({'e03Lock':owner})+'\n').encode()
    assert cleanup_owned(reports,'a'*32,{str(lock)})=='required'
    assert json.loads(lock.read_text())['nonce']=='replacement'
    lock.write_text(json.dumps(owner))
    assert cleanup_owned(reports,'a'*32,{str(lock)},read_only=True)=='required' and lock.exists()

def test_timeout_after_commit_keeps_ledger_and_only_cleans_owned_lock(tmp_path):
    lock=str((tmp_path/'owned.lock').resolve());ledger=tmp_path/'ledger.json';token='b'*32
    script=f"""
import fs from 'node:fs';
const owner={{token:'{token}',nonce:'commit-nonce',pid:process.pid,path:{json.dumps(lock)}}};
fs.writeFileSync(owner.path,JSON.stringify(owner),{{flag:'wx'}});fs.writeSync(2,JSON.stringify({{e03Lock:owner}})+'\\n');
fs.writeFileSync({json.dumps(str(ledger)+'.tmp')},'{{"committed":true}}');fs.renameSync({json.dumps(str(ledger)+'.tmp')},{json.dumps(str(ledger))});
setTimeout(()=>{{}},5000);
"""
    result=invoke_notice_process([str(NODE),'--input-type=module','-e',script],b'',os.environ.copy(),token,{lock},timeout=.4)
    assert result['mutationUnknown'] is True and result['executionEnded'] is True
    assert json.loads(ledger.read_text())=={'committed':True}

def test_bridge_bad_json_and_oversized_output_are_explicit(tmp_path):
    for script,code in [("process.stdout.write('bad')",'RUNTIME_UNAVAILABLE'),("process.stdout.write('x'.repeat(1048577))",'PAYLOAD_TOO_LARGE')]:
        result=invoke_notice_process([str(NODE),'-e',script],b'',os.environ.copy(),'c'*32,set())
        assert result['reasonCode']==code


def test_abnormal_exit_after_commit_cleans_owned_lock_without_send_permission(tmp_path):
    lock=str((tmp_path/'owned.lock').resolve());token='d'*32
    script=f"""
import fs from 'node:fs';
const owner={{token:'{token}',nonce:'crash',pid:process.pid,path:{json.dumps(lock)}}};
fs.writeFileSync(owner.path,JSON.stringify(owner),{{flag:'wx'}});
fs.writeSync(2,JSON.stringify({{e03Lock:owner}})+'\\n');
process.stdout.write(JSON.stringify({{hostActionExecuted:false,sendNow:true}}));
process.exitCode=1;
"""
    result=invoke_notice_process([str(NODE),'--input-type=module','-e',script],b'',os.environ.copy(),token,{lock})
    assert result['reasonCode']=='RUNTIME_UNAVAILABLE' and result['mutationUnknown'] is True
    assert result['executionEnded'] is True and 'sendNow' not in result
    if os.name=='nt':assert result['cleanupStatus']=='complete' and not Path(lock).exists()
