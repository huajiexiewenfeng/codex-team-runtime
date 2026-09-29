"""Isolated real Registry recovery CLI: no production state writes."""
import hashlib,json,os,subprocess,sys,tempfile
from pathlib import Path
from codex_team_context.team_registry import TeamRegistry,initialize_registry
from codex_team_context.team_policy import onboarding_receipt
root=Path(sys.argv[1]).resolve()
node='C:/Program Files/nodejs/node.exe'
with tempfile.TemporaryDirectory(prefix='clock-recovery-') as tmp:
 d=Path(tmp); sp=d/'state.json'; rp=d/'registry.json'
 script='''
import {createState,evolve} from RUNTIME;
const source={kind:'fixture',ref:'clock'},caller={hostId:'fixture',threadId:'m'};
let s=createState({teamId:'clock',name:'Clock',source,members:[['m','Manager'],['l','Liaison'],['w','Worker']].map(([id,role])=>({id,role,name:id,lifecycle:'active',binding:{status:'bound',hostId:'fixture',threadId:id}}))},'2026-09-25T00:00:00.000Z');
s.members[1].binding={status:'unbound'};
s=evolve(s,{id:'invite',type:'attachInvite',actor:'m',caller,at:s.updatedAt,source,target:{hostId:'fixture',threadId:'l'},expiresAt:'2026-09-25T00:10:00.000Z'},0);
s=evolve(s,{id:'confirm',type:'attachConfirm',actor:'l',caller:{hostId:'fixture',threadId:'l'},at:s.updatedAt,source,invitationId:'invite',invitationVersion:1},1);
s=evolve(s,{id:'round',type:'openRound',actor:'m',at:s.updatedAt,source,roundId:'r',title:'R'},2);
s=evolve(s,{id:'assign',type:'assign',actor:'m',at:s.updatedAt,source,roundId:'r',taskId:'t',title:'T',workerId:'w',required:true,assignedAt:s.updatedAt},3);
const now=Date.now()+86400000,ev={id:'bad-submit',type:'submit',actor:'w',at:new Date(now).toISOString(),source,roundId:'r',taskId:'t',summary:'final'};
s=evolve(s,ev,4,{nowMs:now});console.log(JSON.stringify({s,ev}));
'''.replace('RUNTIME',json.dumps((root/'src/runtime.mjs').as_uri()))
 data=json.loads(subprocess.check_output([node,'--input-type=module','-e',script]));raw=json.dumps(data['s']).encode();sp.write_bytes(raw)
 ep=d/'event.json';ep.write_text(json.dumps(data['ev']),encoding='utf8')
 initialize_registry(rp);registry=TeamRegistry(registry_path=rp,node_executable=Path(node),runtime_root=root)
 registry.manage('fixture','m',dict(action='adopt_legacy',operation_id='adopt',team_id='clock',team_name='Clock',member_id='m',state_path=str(sp),expected_state_version=5,expected_state_sha256=hashlib.sha256(raw).hexdigest(),members=data['s']['members'],authorization_ref='fixture',consent_ref='fixture'))
 for mid in ['m','l','w']:
  r=registry._store.read();t=r['teams'][0];m=next(m for m in t['members'] if m['id']==mid);leader=next(m for m in t['members'] if m['id']=='m')
  registry.manage('fixture','m',dict(action='confirm_ready',operation_id='ready-'+mid,team_id='clock',expected_revision=t['revision'],member_id=mid,receipt=onboarding_receipt(r['registryId'],t,m,leader,registry.policy_revision),evidence_ref='fixture'))
 env={**os.environ,'CODEX_TEAM_CONTEXT_PYTHON':sys.executable}
 projection='import {readState} from '+json.dumps((root/'src/store.mjs').as_uri())+';console.log(JSON.stringify(await readState('+json.dumps(str(sp))+')));'
 sp.write_bytes(subprocess.check_output([node,'--input-type=module','-e',projection],env=env))
 before=sp.read_bytes();regbefore=rp.read_bytes();req=d/'request.json'
 req.write_text(json.dumps(dict(statePath=str(sp),expectedVersion=5,expectedSha256=hashlib.sha256(before).hexdigest(),caller=dict(hostId='fixture',threadId='m'),eventId='bad-submit',operationId='repair',originalEventPath=str(ep))),encoding='utf8')
 env={**os.environ,'CODEX_TEAM_CONTEXT_PYTHON':sys.executable}
 cli=[node,str(root/'scripts/recover-final-submit-clock.mjs')]
 subprocess.check_output(cli+['plan',str(req),str(d/'bundle')],env=env)
 assert sp.read_bytes()==before and rp.read_bytes()==regbefore
 manifest=d/'bundle/manifest.json';candidate=d/'bundle/candidate-state.json';saved=candidate.read_bytes()
 candidate.write_bytes(saved+b' ')
 bad=subprocess.run(cli+['apply',str(manifest)],env=env,capture_output=True)
 assert bad.returncode!=0 and sp.read_bytes()==before
 candidate.write_bytes(saved)
 # State CAS rejects even a byte-only concurrent alteration.
 sp.write_bytes(before+b' ')
 bad=subprocess.run(cli+['apply',str(manifest)],env=env,capture_output=True)
 assert bad.returncode!=0 and sp.read_bytes()==before+b' '
 sp.write_bytes(before)
 subprocess.check_output(cli+['apply',str(manifest)],env=env)
 after=sp.read_bytes();assert after==saved
 subprocess.check_output(cli+['apply',str(manifest)],env=env)
 assert sp.read_bytes()==after and rp.read_bytes()==regbefore
 assert json.loads(after)['version']==6 and json.loads(after)['tasks'][0]['status']=='submitted'
 assert (d/'bundle/original-state.json').read_bytes()==before
 print('PASS: linked Registry dry-run no mutation, artifact tamper rejection, state CAS rejection, apply, exact replay, retained original bytes, unchanged Registry')
