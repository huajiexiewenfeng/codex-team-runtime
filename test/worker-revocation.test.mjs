import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,evolve,validate,snapshot} from '../src/runtime.mjs';
import {adaptRegistryRequest} from '../src/registry-adapter.mjs';
import {planDispatch} from '../src/scheduling.mjs';
import {render} from '../src/render.mjs';
import {planSupervision} from '../src/supervision.mjs';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeRevocation} from '../src/revocation-command.mjs';
const at=n=>new Date(Date.UTC(2026,8,25,0,n)).toISOString();
const caller={hostId:'fixture',threadId:'manager'},source={kind:'fixture',ref:'explicit-user-revocation'};
function setup(){
 let s=createState({teamId:'team',name:'Team',source,members:[['m','Manager','manager'],['l','Liaison','liaison'],['w','Worker','old'],['n','Worker','new']].map(([id,role,threadId])=>({id,name:id,role,lifecycle:'active',binding:{status:'bound',hostId:'fixture',threadId}}))},at(0));
 for(const [type,data] of [['openRound',{roundId:'r',title:'Round'}],['assign',{roundId:'r',taskId:'old-task',title:'Old work',workerId:'w',required:true,assignedAt:at(2)}],['enqueue',{caller,roundId:'r',taskId:'new-task',title:'Replacement',workerId:'n',required:true,assignedAt:null}]])s=evolve(s,{id:`e${s.version}`,type,actor:'m',at:at(s.version+1),source,...data},s.version);
 s.schemaVersion=2;s.registry={registryId:'registry',registryPath:join(tmpdir(),'fixture-registry.json'),teamId:'team',migrationId:'migration',sourceSha256:'0'.repeat(64),sourceVersion:3,phase:'active',teamRevision:1,readyMemberIds:['m','l','w','n']};
 return s;
}
const request=()=>({id:'revoke-1',type:'revokeWorker',actor:'m',caller,at:at(4),source,summary:'User revoked old Worker; WIP retained; processes unknown',revocation:{teamId:'team',memberId:'w',worker:{hostId:'fixture',threadId:'old'},taskIds:['old-task'],handoffTaskIds:['new-task'],authorizationRef:source.ref,intent:'revoke-and-exit',execution:'unknown',wipRef:'fixture-wip'}});
test('explicit revocation needs no stop acknowledgement, preserves history and allows checked exit',()=>{
 const before=setup(),s=evolve(before,request(),before.version);
 assert.equal(s.tasks[0].status,'cancelled');assert.equal(s.tasks[0].acceptance,null);
 assert.deepEqual(s.rounds,before.rounds);assert.deepEqual(s.events.slice(0,-1),before.events);
 assert.equal(s.tasks[1].status,'queued');assert.equal(s.events.at(-1).revocation.execution,'unknown');
 assert.deepEqual(adaptRegistryRequest({action:'check_exit',state:s,memberId:'w'}),{allowed:true});
 assert.throws(()=>adaptRegistryRequest({action:'check_exit',state:before,memberId:'w'}),/open round/);
 assert.equal(snapshot(s,at(6)).tasks[0].status,'cancelled');
});
test('revoked Worker cannot submit or observe even before Registry exit; other member identity retained',()=>{
 const s=evolve(setup(),request(),3);
 for(const type of ['submit','observe'])assert.throws(()=>evolve(s,{id:type,type,actor:'w',at:at(5),source,roundId:'r',taskId:'old-task',summary:'late',...(type==='observe'?{observedAt:at(5),progress:true}:{})},s.version),/revoked/i);
 assert.throws(()=>planDispatch(s,caller,'w'),/revoked/i);
 assert.equal(s.members.find(m=>m.id==='n').lifecycle,'active');
});
test('unknown execution holds only selected handoff until Manager records isolation or stop evidence',()=>{
 let s=evolve(setup(),request(),3);
 assert.equal(planDispatch(s,caller,'n').decision,'held');
 const start={id:'start',type:'startTask',actor:'m',caller,at:at(6),source,roundId:'r',taskId:'new-task'};
 assert.throws(()=>evolve(s,start,s.version),/handoff/i);
 s=evolve(s,{id:'resolve',type:'resolveRevocation',actor:'m',caller,at:at(5),source,summary:'Separate workspace verified',revocationId:'revoke-1',disposition:'isolated',evidenceRef:'fixture-isolation'},s.version);
 s=evolve(s,start,s.version);assert.equal(s.tasks[1].status,'executing');assert.equal(s.events.find(e=>e.type==='revokeWorker').revocation.execution,'unknown');
});
test('reject non-Manager, wrong scope, missing authority, extra active work and stale versions',()=>{
 for(const change of [e=>e.actor='w',e=>e.caller.threadId='old',e=>e.revocation.teamId='other',e=>e.revocation.memberId='m',e=>e.revocation.worker.threadId='other',e=>e.revocation.authorizationRef='',e=>e.revocation.intent='exit',e=>e.revocation.execution='stopped',e=>e.revocation.taskIds=[],e=>e.revocation.handoffTaskIds=['old-task']]){
  const s=setup(),e=structuredClone(request());change(e);assert.throws(()=>evolve(s,e,s.version));
 }
 assert.throws(()=>evolve(setup(),request(),2),/Version conflict/);
});
test('revocation audit cannot disappear or change the cancelled task scope',()=>{
 const s=evolve(setup(),request(),3),bad=structuredClone(s);bad.events.at(-1).revocation.taskIds=[];assert.throws(()=>validate(bad));
});
test('risk is visible in selected-round Dashboard and supervision without claiming stopped',()=>{
 const s=evolve(setup(),request(),3),html=render(snapshot(s,at(6),'r'));
 assert.match(html,/已撤权 · 进程状态未知/);assert.match(html,/交接暂停/);assert.doesNotMatch(html,/已停止 · 未验收/);
 assert.equal(planSupervision(s,caller).taskChecks[0].nextAction,'resolve-handoff-execution-risk');
});
test('durable command replay survives phase boundary and rejects conflicting operation IDs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'revoke-fixture-')),path=join(dir,'state.json'),s=setup();
 s.schemaVersion=2;s.registry={registryId:'registry',registryPath:join(dir,'registry.json'),teamId:'team',migrationId:'migration',sourceSha256:'0'.repeat(64),sourceVersion:3,phase:'active',teamRevision:1,readyMemberIds:['m','l','w','n']};
 const projection={registryId:'registry',teamId:'team',teamRevision:1,migrationId:'migration',statePath:path,members:s.members,readyMemberIds:s.registry.readyMemberIds};
 const options={exporter:async()=>projection};await writeFile(path,JSON.stringify(s));
 const {actor,type,...req}=request();
 const concurrent=await Promise.allSettled([writeRevocation(path,req,3,type,options),writeRevocation(path,{...req,id:'competing'},3,type,options)]);
 assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
 // Either contender can win. Normalize the following replay to the persisted ID.
 const winning=JSON.parse(await readFile(path,'utf8')).events.at(-1);req.id=winning.id;
 const before=await readFile(path,'utf8');
 assert.deepEqual(await writeRevocation(path,req,3,type,options),{version:4,replayed:true});
 assert.equal(await readFile(path,'utf8'),before);
 await assert.rejects(writeRevocation(path,{...req,summary:'different'},4,type,options),/Operation ID conflict/);
 await assert.rejects(writeRevocation(path,{...req,id:'different'},3,type,options),/Version conflict/);
});
test('unknown dispatch stays unknown and previously submitted work cannot be force cancelled',()=>{
 const before=setup(),after=evolve(before,request(),3);
 assert.equal(snapshot(after,at(6)).tasks[0].delivery.status,'unknown');
 const submitted=evolve(before,{id:'sub',type:'submit',actor:'w',roundId:'r',taskId:'old-task',at:at(4),source,summary:'Submitted'},3);
 assert.throws(()=>evolve(submitted,{...request(),at:at(5)},4),/initial unsubmitted/);
});
test('a later handoff hold does not block independent earlier queued work',()=>{
 let s=setup();
 s=evolve(s,{id:'enqueue-extra',type:'enqueue',actor:'m',caller,at:at(4),source,roundId:'r',taskId:'held-later',title:'Later handoff',workerId:'n',required:true,assignedAt:null},3);
 const e=structuredClone(request());e.at=at(5);e.revocation.handoffTaskIds=['held-later'];s=evolve(s,e,4);
 assert.equal(planDispatch(s,caller,'n').decision,'ready');assert.equal(planDispatch(s,caller,'n').nextTaskId,'new-task');
});
