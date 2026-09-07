import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { run } from '../src/cli.mjs';
import { readState, initialize, transact } from '../src/store.mjs';
import { demoState } from '../src/demo.mjs';

const m={hostId:'fixture-host',threadId:'fixture-manager'}, l={hostId:'fixture-host',threadId:'fixture-liaison'};
const source={kind:'fixture',ref:'session-lifecycle-tests'};
const at='2026-09-05T00:00:00.000Z', invited='2026-09-05T00:01:00.000Z', confirmed='2026-09-05T00:02:00.000Z', later='2026-09-05T00:03:00.000Z';
const invitation=()=>({mode:'invite',id:'invite-1',caller:m,target:l,at:invited,expiresAt:'2026-09-05T00:10:00.000Z',source});
const confirmation=()=>({mode:'confirm',id:'confirm-1',caller:l,invitationId:'invite-1',invitationVersion:1,at:confirmed,source});
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'session-lifecycle-'));
 t.after(async()=>{const target=await realpath(dir); assert.equal(dirname(target),await realpath(tmpdir())); assert.ok(basename(target).startsWith('session-lifecycle-')); await rm(target,{recursive:true,force:true});});
 const path=join(dir,'state.json'); let seq=0;
 const json=async value=>{const file=join(dir,`request-${seq++}.json`); await writeFile(file,JSON.stringify(value)); return file;};
 const start=async(caller=m)=>run(['start',await json({teamId:'fixture-team',name:'Fixture team',caller,source}),path,at],()=>{});
 const attach=async(request,version)=>run(['attach',path,await json(request),String(version)],()=>{});
 const resume=async(caller=m,round=null)=>{let result;const args=['resume',path,await json(caller),later];if(round)args.push(round);await run(args,v=>{result=JSON.parse(v);});return result;};
 return {dir,path,json,start,attach,resume};
}
async function unchanged(f,action,pattern) {const before=await readFile(f.path,'utf8');await assert.rejects(action,pattern);assert.equal(await readFile(f.path,'utf8'),before);}

test('start creates only local Manager/unbound Liaison and refuses overwrite or another Manager',async t=>{
 const f=await fixture(t);await f.start();const s=await readState(f.path);
 assert.equal(s.version,0);assert.equal(s.members.length,2);assert.deepEqual(s.members[0].binding,{status:'bound',...m});assert.equal(s.members[1].binding.status,'unbound');assert.equal(s.session.invitation,null);assert.equal(s.reporting.actual,'unknown');
 await unchanged(f,()=>f.start());await unchanged(f,()=>f.start({...m,threadId:'fixture-other'}));
});
test('two-sided attach needs Manager invite and matching Liaison confirmation; neither step starts work',async t=>{
 const f=await fixture(t);await f.start();await f.attach(invitation(),0);
 let s=await readState(f.path);assert.equal(s.version,1);assert.equal(s.members[1].binding.status,'unbound');
 await assert.rejects(f.resume(l));await f.attach(confirmation(),1);s=await readState(f.path);
 assert.equal(s.version,2);assert.deepEqual(s.members[1].binding,{status:'bound',...l});assert.equal(s.session.invitation.confirmationId,'confirm-1');assert.deepEqual(s.rounds,[]);assert.equal(s.reporting.desired,'stopped');
 const resumed=await f.resume(l);assert.equal(resumed.role,'Liaison');assert.equal(resumed.identityAssurance,'caller-declared');assert.equal(resumed.hostCapabilities.heartbeat,'unknown');
});
test('attach rejects wrong host/thread, stale invitation version, unknown invitation and replay unchanged',async t=>{
 const f=await fixture(t);await f.start();await f.attach(invitation(),0);
 for(const patch of [{caller:{...l,hostId:'wrong'}},{caller:{...l,threadId:'wrong'}},{invitationVersion:0},{invitationId:'other'}]) await unchanged(f,()=>f.attach({...confirmation(),...patch},1));
 await f.attach(confirmation(),1);await unchanged(f,()=>f.attach(confirmation(),2));await unchanged(f,()=>f.attach({...invitation(),id:'invite-2',at:later},2));
});
test('expired or superseded invite cannot confirm and stale writers cannot overwrite',async t=>{
 const f=await fixture(t);await f.start();await f.attach(invitation(),0);
 await unchanged(f,()=>f.attach({...confirmation(),at:invitation().expiresAt},1));
 await f.attach({...invitation(),id:'invite-2',at:confirmed},1);
 await unchanged(f,()=>f.attach({...confirmation(),at:later},2));
 await unchanged(f,()=>f.attach({...confirmation(),invitationId:'invite-2',invitationVersion:2,at:later},1),/Version conflict/);
});
test('only matching active Manager can invite; pending and unknown callers cannot resume or start',async t=>{
 const f=await fixture(t);await f.start();
 await unchanged(f,()=>f.attach({...invitation(),caller:l},0));
 for(const caller of [{...m,pendingId:'pending-1'},{hostId:'fixture-host',threadId:'client-new-thread:123'},{hostId:'fixture-host'},{...m,verified:true}]) {await unchanged(f,()=>f.resume(caller));}
 await unchanged(f,()=>f.resume({...m,threadId:'unknown'}));
 const g=await fixture(t);await assert.rejects(g.start({hostId:'fixture-host',pendingId:'pending-1'}));await assert.rejects(readFile(g.path),{code:'ENOENT'});
});
test('open round forbids pairing and runtime binding cannot bypass two-sided consent',async t=>{
 const f=await fixture(t);await f.start();
 await unchanged(f,()=>transact(f.path,0,{id:'bypass',type:'bindMember',actor:'manager',at:invited,source,memberId:'liaison',binding:{status:'bound',...l}}));
 await register(f);
 await transact(f.path,1,{id:'open',type:'openRound',actor:'manager',at:invited,source,roundId:'r1',title:'Open'});
 await unchanged(f,()=>f.attach({...invitation(),at:confirmed},2));
});
async function register(f,patch={},version=0) {
 const request={id:'register-1',caller:m,memberId:'worker-1',name:'Fixture Worker',binding:{hostId:'fixture-host',threadId:'fixture-worker'},at:invited,source,...patch};
 return run(['register-worker',f.path,await f.json(request),String(version)],()=>{});
}
test('session start can register Worker and complete a real local task lifecycle',async t=>{
 const f=await fixture(t);await f.start();
 await unchanged(f,()=>transact(f.path,0,{id:'empty',type:'openRound',actor:'manager',at:invited,source,roundId:'r1',title:'No workers'}),/Worker/);
 await register(f);let state=await readState(f.path);assert.equal(state.members.length,3);assert.equal(state.members[2].role,'Worker');
 const events=[
  {type:'openRound',roundId:'r1',title:'Work'},
  {type:'assign',roundId:'r1',taskId:'t1',title:'Fixture delivery',workerId:'worker-1',required:true,assignedAt:confirmed},
  {type:'submit',actor:'worker-1',roundId:'r1',taskId:'t1',summary:'Submitted'},
  {type:'review',roundId:'r1',taskId:'t1'},
  {type:'approve',roundId:'r1',taskId:'t1',summary:'Accepted',evidence:['fixture-tested']},
  {type:'closeRound',roundId:'r1'}
 ];
 for(const [i,event] of events.entries())state=await transact(f.path,state.version,{id:`work-${i}`,actor:'manager',at:confirmed,source,...event});
 assert.equal(state.rounds[0].status,'closed');assert.equal(state.reporting.actual,'unknown');
});
test('Worker registration rejects foreign caller, conflicting identity, replay and active rounds',async t=>{
 const f=await fixture(t);await f.start();
 await unchanged(f,()=>register(f,{caller:l}));await unchanged(f,()=>register(f,{binding:m}));
 await unchanged(f,()=>register(f,{binding:{hostId:'fixture-host',pendingId:'pending'}}));
 await register(f);await unchanged(f,()=>register(f,{},1));
 await transact(f.path,1,{id:'open',type:'openRound',actor:'manager',at:confirmed,source,roundId:'r1',title:'Work'});
 await unchanged(f,()=>register(f,{id:'register-2',memberId:'worker-2',binding:{hostId:'fixture-host',threadId:'fixture-worker-2'},at:later},2));
});
test('exited Manager or Liaison cannot resume or attach and Liaison cannot approve or dispatch',async t=>{
 const f=await fixture(t);await f.start();await f.attach(invitation(),0);await f.attach(confirmation(),1);
 await unchanged(f,()=>transact(f.path,2,{id:'bad-open',type:'openRound',actor:'liaison',at:later,source,roundId:'r',title:'Denied'}),/Manager action required/);
 await transact(f.path,2,{id:'exit-l',type:'exitMember',actor:'manager',at:later,source,memberId:'liaison'});
 await unchanged(f,()=>f.resume(l));await unchanged(f,()=>f.attach({...confirmation(),id:'again',at:later},3));
 await transact(f.path,3,{id:'exit-m',type:'exitMember',actor:'manager',at:later,source,memberId:'manager'});
 await unchanged(f,()=>f.resume(m));
});
test('legacy states remain readable and historical resume does not mutate bytes or bindings',async t=>{
 const f=await fixture(t);const old=demoState();await initialize(f.path,old);const before=await readFile(f.path,'utf8');
 const oldManager=old.members.find(x=>x.role==='Manager').binding;const caller={hostId:oldManager.hostId,threadId:oldManager.threadId};
 let output;await run(['resume',f.path,await f.json(caller),'2026-09-05T01:00:00.000Z','round-demo'],v=>{output=JSON.parse(v);});
 assert.equal(output.role,'Manager');assert.equal(output.snapshot.roundId,'round-demo');assert.deepEqual(output.snapshot.members,old.rounds[0].members);assert.equal(await readFile(f.path,'utf8'),before);assert.equal(Object.hasOwn(await readState(f.path),'session'),false);
});
test('concurrent invitations serialize via existing lock/version and only one is recorded',async t=>{
 const f=await fixture(t);await f.start();const results=await Promise.allSettled([f.attach(invitation(),0),f.attach({...invitation(),id:'invite-2'},0)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const s=await readState(f.path);assert.equal(s.version,1);assert.equal(s.events.length,1);
 assert.ok(!(await readdir(f.dir)).some(x=>x.endsWith('.lock')||x.endsWith('.tmp')));
});
test('confirmation without invite, exited pending roles and conflicting target are rejected',async t=>{
 const f=await fixture(t);await f.start();
 await unchanged(f,()=>f.attach(confirmation(),0));
 await unchanged(f,()=>f.attach({...invitation(),target:m},0));
 await f.attach(invitation(),0);
 await transact(f.path,1,{id:'exit-pending',type:'exitMember',actor:'manager',at:confirmed,source,memberId:'liaison'});
 await unchanged(f,()=>f.attach({...confirmation(),at:later},2));
 await unchanged(f,()=>f.attach({...invitation(),id:'invite-again',at:later},2));
});
test('confirmed pairing cannot grant Liaison Manager permissions or mutate history during resume',async t=>{
 const f=await fixture(t);await f.start();await f.attach(invitation(),0);await f.attach(confirmation(),1);
 await unchanged(f,()=>transact(f.path,2,{id:'approve-denied',type:'approve',actor:'liaison',at:later,source,roundId:'missing',taskId:'missing',summary:'No',evidence:['fixture']}),/Manager action required/);
 const before=await readFile(f.path,'utf8');await f.resume(m);await f.resume(l);assert.equal(await readFile(f.path,'utf8'),before);
 const state=await readState(f.path);state.session.invitation.issuedVersion=2;await writeFile(f.path,JSON.stringify(state));
 await assert.rejects(readState(f.path),/Invitation audit mismatch/);
});
