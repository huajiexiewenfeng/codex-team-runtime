import asyncio
import json
import subprocess
import sys
import os
from pathlib import Path
import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters
from codex_team_context.dispatch import DispatchService,validate_request
from codex_team_context.core import ContextError
from codex_team_context.notice_process import invoke_notice_process
from codex_team_context.team_registry import TeamRegistry,initialize_registry
import test_registry_cutover as cutover

ROOT=Path(__file__).resolve().parents[2]
NODE=cutover.NODE

@pytest.fixture
def dispatch_team(tmp_path):
    registry_path=(tmp_path/'registry.json').resolve();state_path=(tmp_path/'state.json').resolve()
    initialize_registry(registry_path)
    state=json.loads(cutover.legacy_bytes());state['team']['source']['kind']='manual'
    for event in state['events']:event['source']['kind']='manual'
    raw=json.dumps(state).encode();state_path.write_bytes(raw)
    registry=TeamRegistry(registry_path=registry_path,node_executable=NODE,runtime_root=ROOT)
    registry.manage('fixture-host','fixture-manager',cutover.adoption_request(state_path,raw))
    for i,member in enumerate(['manager','worker']):
        capsule=registry.read('fixture-host','fixture-'+member)
        registry.manage('fixture-host','fixture-manager',{'action':'confirm_ready','operation_id':'ready-'+member,'team_id':'legacy-team','expected_revision':i+1,'member_id':member,'receipt':capsule['onboardingReceipt'],'evidence_ref':'synthetic'})
    script=f"""
import {{readState,transact}} from {json.dumps((ROOT/'src/store.mjs').as_uri())};
import {{freezeDispatchBrief}} from {json.dumps((ROOT/'src/dispatch-runtime.mjs').as_uri())};
const path={json.dumps(str(state_path))},options={{python:{json.dumps(sys.executable)}}},at='2026-10-01T00:00:00.000Z',caller={{hostId:'fixture-host',threadId:'fixture-manager'}},source={{kind:'manual',ref:'synthetic'}};
let s=await readState(path,options);
s=await transact(path,s.version,{{id:'open',type:'openRound',actor:'manager',at,source,roundId:'r',title:'Round'}},options);
const brief={{schemaVersion:1,teamId:'legacy-team',roundId:'r',taskId:'t',text:'Exact synthetic E04 body 中文',scope:'Authorized fixture',materialRefs:['synthetic'],authorizationRef:'synthetic-authority',dependencyRef:'synthetic-prerequisites',actor:caller}};
const {{briefRef}}=await freezeDispatchBrief(path,brief,options);
s=await transact(path,s.version,{{id:'enqueue',type:'enqueue',actor:'manager',caller,at,source:{{kind:'manual',ref:briefRef}},roundId:'r',taskId:'t',title:'Task',workerId:'worker',required:true,assignedAt:null}},options);
console.log(briefRef);
"""
    result=subprocess.run([str(NODE),'--input-type=module','-e',script],check=True,capture_output=True,text=True,encoding='utf-8')
    common=dict(actor_host_id='fixture-host',actor_thread_id='fixture-manager',team_id='legacy-team',round_id='r',task_id='t',worker_id='worker',reason='before_dispatch')
    request=dict(**common,action='prepare',operation_id='p1',enqueue_event_id='enqueue',brief_ref=result.stdout.strip(),admission={'native':{'host_id':'fixture-host','thread_id':'fixture-worker','status':'idle','evidence_ref':'synthetic-idle'}},baseline={'outcome':'not-attempted','evidence_ref':'synthetic-unsent'})
    return registry,registry_path,state_path,common,request

def test_real_bridge_first_attempt_result_replay_and_registry_reads(dispatch_team):
    registry,path,state,common,request=dispatch_team
    original=json.loads(state.read_text());service=DispatchService(registry)
    p=service.handle(request);assert p.get('sendNow') is True,p
    assert p['sourceVersion']==original['version']+1
    assert 'hostRequest' not in service.handle(request)
    registry.read('fixture-host','fixture-manager')
    result=dict(**common,action='result',operation_id='r1',attempt_id=p['attemptId'],result={'outcome':'accepted','evidence_ref':'synthetic-acceptance','summary':'Accepted'})
    assert service.handle(result)['status']=='recorded'
    assert service.handle(result)['replayed'] is True
    status=service.handle(dict(**common,action='status',operation_id='p1',include_content=True))
    assert status['delivery']=='delivered' and status['brief']['text']=='Exact synthetic E04 body 中文'
    assert not list(state.parent.glob('*.lock'))

def test_real_stdio_discovery_closed_schema_and_metadata(dispatch_team):
    registry,path,state,common,request=dispatch_team;observations=path.parent/'observations'
    async def scenario():
        params=StdioServerParameters(command=sys.executable,args=['-m','codex_team_context.server','serve','--registry',str(path),'--node-executable',str(NODE),'--runtime-root',str(ROOT),'--observation-root',str(observations),'--observe-team','legacy-team'])
        async with Client(params) as client:
            catalog={t.name:t for t in (await client.list_tools()).tools}
            assert len(catalog)==7
            assert catalog['team_context.dispatch_status'].annotations.read_only_hint is True
            assert catalog['team_context.dispatch'].input_schema['additionalProperties'] is False
            assert (await client.call_tool('team_context.dispatch',{**request,'admission':None})).is_error
            p=await client.call_tool('team_context.dispatch',request);assert not p.is_error,p
            status=await client.call_tool('team_context.dispatch_status',{**common,'operation_id':'p1'})
            assert json.loads(status.content[0].text)['sendNow'] is False
            assert (await client.call_tool('team_context.dispatch_status',{**common,'action':'status'})).is_error
    asyncio.run(scenario())
    events=[json.loads(p.read_text()) for p in observations.glob('*/*.json')]
    assert {e['dispatch']['action'] for e in events}=={'prepare','status'}
    assert 'Exact synthetic E04 body' not in json.dumps(events)
    assert all(e['dispatch']['requestBytes']>0 for e in events)

@pytest.mark.parametrize('change',[{'statePath':'bad'},{'baseline':None},{'admission':None},{'operation_id':'../bad'},{'include_content':True},{'baseline':{'outcome':'not-attempted','evidence_ref':'x','extra':True}}])
def test_dispatch_rejects_invalid_fields(change):
    r=dict(action='prepare',actor_host_id='h',actor_thread_id='m',team_id='t',round_id='r',task_id='task',worker_id='w',reason='before_dispatch',operation_id='p',enqueue_event_id='q',brief_ref='e04-brief:sha256:'+'a'*64)
    with pytest.raises(ContextError):validate_request({**r,**change})

def test_worker_cannot_dispatch_and_status_does_not_cleanup_lock(dispatch_team):
    registry,path,state,common,request=dispatch_team;service=DispatchService(registry)
    with pytest.raises(ContextError):service.handle({**request,'actor_thread_id':'fixture-worker'})
    lock=Path(str(state)+'.lock');lock.write_text('unknown-owner')
    response=service.handle(dict(**common,action='status'))
    assert response['sendNow'] is False and lock.read_text()=='unknown-owner'

def test_cancel_denied_and_late_acceptance_hold_real_bridge(dispatch_team):
    registry,path,state,common,request=dispatch_team;service=DispatchService(registry)
    p=service.handle(request)
    r=dict(**common,action='result',operation_id='denied',attempt_id=p['attemptId'],result={'outcome':'denied','evidence_ref':'synthetic-denial','summary':'Denied'})
    assert service.handle(r)['status']=='recorded'
    cancel=dict(**common,action='cancel',operation_id='cancel',attempt_id=p['attemptId'],cancellation={'authorization_ref':'synthetic-withdrawal','reason':'withdraw','nonreceipt_evidence_ref':'synthetic-all-not-received','execution_evidence_ref':'synthetic-no-inflight'})
    assert service.handle(cancel)['reasonCode']=='CANCELLED_UNDELIVERED'
    r.update(operation_id='late',result={'outcome':'accepted','evidence_ref':'synthetic-contradiction','summary':'Late receipt'})
    assert service.handle(r)['reasonCode']=='DELIVERY_CONFLICT'
    registry.read('fixture-host','fixture-manager')
    assert service.handle(dict(**common,action='status'))['dispatchHold']

@pytest.mark.parametrize('point',['object','state'])
def test_real_process_timeout_on_e04_commit_boundaries(dispatch_team,point):
    registry,path,state,common,request=dispatch_team;token='d'*32
    script=f"""
import {{dispatchRuntime}} from {json.dumps((ROOT/'src/dispatch-runtime.mjs').as_uri())};
import {{saveObject}} from {json.dumps((ROOT/'src/dispatch-objects.mjs').as_uri())};
import {{atomicWrite}} from {json.dumps((ROOT/'src/store.mjs').as_uri())};
import {{ownedLocks}} from {json.dumps((ROOT/'src/notice-adapter.mjs').as_uri())};
let input='';for await(const chunk of process.stdin)input+=chunk;
const options={{lockRunner:ownedLocks('{token}')}};
const pause=()=>new Promise(resolve=>setTimeout(resolve,30000));
if('{point}'==='object')options.saveObject=async(...args)=>{{const ref=await saveObject(...args);await pause();return ref;}};
else options.writeState=async(...args)=>{{await atomicWrite(...args);await pause();}};
await dispatchRuntime({{...JSON.parse(input),options}});
"""
    envelope={'statePath':str(state),'registryPath':str(path),'request':request}
    env=os.environ.copy();env['CODEX_TEAM_CONTEXT_PYTHON']=sys.executable
    response=invoke_notice_process([str(NODE),'--input-type=module','-e',script],json.dumps(envelope).encode(),env,token,{str(state)+'.lock',str(path)+'.lock'},timeout=3)
    assert response['reasonCode']=='BRIDGE_TIMEOUT' and response['executionEnded'] is True,response
    assert response['mutationUnknown'] is True and 'hostRequest' not in response
    if os.name=='nt':assert not list(state.parent.glob('*.lock'))
    status=DispatchService(registry).handle(dict(**common,action='status',operation_id='p1'))
    if point=='object':assert status['operationCommitted'] is False
    else:assert status['recorded'] is True and status['sendNow'] is False
