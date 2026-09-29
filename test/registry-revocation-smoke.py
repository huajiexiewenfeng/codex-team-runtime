"""Isolated real Python Registry / Node bridge smoke; no real team paths."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(sys.argv[1]).resolve()
node = Path('C:/Program Files/nodejs/node.exe')
from codex_team_context.team_registry import TeamRegistry, initialize_registry
from codex_team_context.team_policy import onboarding_receipt
from codex_team_context.core import ContextError

with tempfile.TemporaryDirectory(prefix='registry-revoke-') as tmp:
    directory = Path(tmp).resolve()
    state_path, registry_path = directory / 'state.json', directory / 'registry.json'
    script = '''
import {createState,evolve} from RUNTIME;
const source={kind:'fixture',ref:'user-revocation'},caller={hostId:'fixture',threadId:'manager'};
let s=createState({teamId:'team',name:'Team',source,members:[['m','Manager','manager'],['l','Liaison','liaison'],['w','Worker','old'],['n','Worker','new']].map(([id,role,threadId])=>({id,name:id,role,lifecycle:'active',binding:{status:'bound',hostId:'fixture',threadId}}))},'2026-09-25T00:00:00.000Z');
s.members.find(m=>m.id==='l').binding={status:'unbound'};
s=evolve(s,{id:'invite',type:'attachInvite',actor:'m',caller,at:'2026-09-25T00:00:00.000Z',source,target:{hostId:'fixture',threadId:'liaison'},expiresAt:'2026-09-25T00:10:00.000Z'},0);
s=evolve(s,{id:'confirm',type:'attachConfirm',actor:'l',caller:{hostId:'fixture',threadId:'liaison'},at:'2026-09-25T00:00:00.000Z',source,invitationId:'invite',invitationVersion:1},1);
for(const [type,data] of [['openRound',{roundId:'r',title:'Round'}],['assign',{roundId:'r',taskId:'old-task',title:'Old',workerId:'w',required:true,assignedAt:'2026-09-25T00:04:00.000Z'}],['enqueue',{caller,roundId:'r',taskId:'new-task',title:'New',workerId:'n',required:true,assignedAt:null}]])s=evolve(s,{id:`e${s.version}`,type,actor:'m',at:new Date(Date.UTC(2026,8,25,0,s.version+1)).toISOString(),source,...data},s.version);
console.log(JSON.stringify(s));
'''.replace('RUNTIME', json.dumps((root/'src/runtime.mjs').as_uri()))
    raw = subprocess.check_output([str(node), '--input-type=module', '-e', script])
    state_path.write_bytes(raw)
    state = json.loads(raw)
    initialize_registry(registry_path)
    registry = TeamRegistry(registry_path=registry_path,node_executable=node,runtime_root=root)
    registry.manage('fixture','manager',dict(action='adopt_legacy',operation_id='migration',team_id='team',team_name='Team',member_id='m',state_path=str(state_path),expected_state_version=5,expected_state_sha256=hashlib.sha256(raw).hexdigest(),members=state['members'],authorization_ref='user-adoption',consent_ref='liaison-consent'))
    for member_id in ['m','l','w','n']:
        data=registry._store.read(); team=data['teams'][0]
        member=next(m for m in team['members'] if m['id']==member_id)
        leader=next(m for m in team['members'] if m['id']=='m')
        receipt=onboarding_receipt(data['registryId'],team,member,leader,registry.policy_revision)
        registry.manage('fixture','manager',dict(action='confirm_ready',operation_id='ready-'+member_id,team_id='team',expected_revision=team['revision'],member_id=member_id,receipt=receipt,evidence_ref='fixture-receipt'))
    rev=registry._store.read()['teams'][0]['revision']
    exit_request=dict(action='exit_member',operation_id='exit',team_id='team',expected_revision=rev,member_id='w',authorization_ref='user-revocation')
    try: registry.manage('fixture','manager',exit_request)
    except ContextError as e: assert e.code=='RUNTIME_REJECTED' and 'open round' in str(e)
    else: raise AssertionError('Ordinary exit protection missing')
    request=dict(id='revoke',caller=dict(hostId='fixture',threadId='manager'),at='2026-09-25T00:06:00.000Z',source=dict(kind='fixture',ref='user-revocation'),summary='Revoke with unknown execution',revocation=dict(teamId='team',memberId='w',worker=dict(hostId='fixture',threadId='old'),taskIds=['old-task'],handoffTaskIds=['new-task'],authorizationRef='user-revocation',intent='revoke-and-exit',execution='unknown',wipRef='fixture-wip'))
    req_path=directory/'request.json';req_path.write_text(json.dumps(request),encoding='utf8')
    env={**os.environ,'CODEX_TEAM_CONTEXT_PYTHON':sys.executable}
    command=[str(node),str(root/'src/cli.mjs'),'revoke-worker',str(state_path),str(req_path),'5']
    assert json.loads(subprocess.check_output(command,env=env))['replayed'] is False
    # Simulate failure between the two durable phases; old writes are already fenced.
    assert json.loads(subprocess.check_output(command,env=env))['replayed'] is True
    before=registry._store.read()
    try: registry.manage('fixture','old',exit_request)
    except ContextError as e: assert e.code=='MANAGER_REQUIRED'
    else: raise AssertionError('Non-manager exit allowed')
    assert registry._store.read()==before
    original_replace=registry._store._replace
    def fail_replace(value):
        raise RuntimeError('fixture injected Registry persistence failure')
    registry._store._replace=fail_replace
    try: registry.manage('fixture','manager',exit_request)
    except RuntimeError: pass
    else: raise AssertionError('Fault injection did not fire')
    registry._store._replace=original_replace
    assert registry._store.read()==before
    assert json.loads(subprocess.check_output(command,env=env))['replayed'] is True
    result=registry.manage('fixture','manager',exit_request)
    assert result['outcome']=='exited'
    assert registry.manage('fixture','manager',exit_request)==result
    assert json.loads(subprocess.check_output(command,env=env))['replayed'] is True
    current=registry._store.read()['teams'][0]
    assert next(m for m in current['members'] if m['id']=='w')['lifecycle']=='exited'
    state=json.loads(state_path.read_text())
    assert state['rounds'][0]['status']=='open'
    assert next(m for m in state['rounds'][0]['members'] if m['id']=='w')['lifecycle']=='active'
    assert state['tasks'][0]['status']=='cancelled' and state['tasks'][1]['status']=='queued'
    assert registry.read('fixture','old') is not None
    print('PASS: real Registry bridge, normal exit protection, scoped revocation, interrupted phase replay, non-manager rejection, exit replay, history, read compatibility')
