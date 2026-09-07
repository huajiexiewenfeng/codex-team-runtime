import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {run} from '../src/cli.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as session from '../src/session.mjs';
import {evolve,validate} from '../src/runtime.mjs';
import {transact} from '../src/store.mjs';
const at=n=>new Date(Date.UTC(2026,8,7,0,n)).toISOString();
const m={hostId:'fixture-host',threadId:'manager'},old={hostId:'fixture-host',threadId:'old-liaison'},next={hostId:'fixture-host',threadId:'new-liaison'};
const source={kind:'fixture',ref:'synthetic-detach-test'};
const request={id:'detach-1',caller:m,invitationId:'invite-1',invitationVersion:1,at:at(4),summary:'Correct explicit pairing',source};
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'team-detach-')),path=join(dir,'state.json');try{
 await session.start(path,{teamId:'team',name:'Team',caller:m,source},at(0));
 await session.attach(path,{mode:'invite',id:'invite-1',caller:m,target:old,at:at(1),expiresAt:at(30),source},0);
 await session.attach(path,{mode:'confirm',id:'confirm-1',caller:old,invitationId:'invite-1',invitationVersion:1,at:at(2),source},1);
 const state=await transact(path,2,{id:'off',type:'reports',actor:'manager',enabled:false,at:at(3),source});await fn(path,state);
}finally{await rm(dir,{recursive:true,force:true});}}
const detach=(...args)=>{assert.equal(typeof session.detach,'function','detach capability missing');return session.detach(...args);};
test('detach preserves audit and reporting; requires a fresh invitation and target self-confirmation',()=>fixture(async(path,state)=>{
 const s=await detach(path,request,3);assert.equal(s.version,4);assert.equal(s.session.invitation,null);assert.deepEqual(s.reporting,state.reporting);
 assert.deepEqual(s.events.slice(0,3),state.events);assert.deepEqual(s.events.at(-1).detachedInvitation,state.session.invitation);
 assert.equal(s.members.find(x=>x.role==='Liaison').binding.status,'unbound');
 await assert.rejects(session.resume(path,old,at(5)));await assert.rejects(session.attach(path,{mode:'confirm',id:'old-again',caller:old,invitationId:'invite-1',invitationVersion:1,at:at(5),source},4));
 await session.attach(path,{mode:'invite',id:'invite-2',caller:m,target:next,at:at(5),expiresAt:at(30),source},4);
 await assert.rejects(session.attach(path,{mode:'confirm',id:'wrong-confirm',caller:old,invitationId:'invite-2',invitationVersion:5,at:at(6),source},5));
 await session.attach(path,{mode:'confirm',id:'confirm-2',caller:next,invitationId:'invite-2',invitationVersion:5,at:at(6),source},5);
 assert.equal((await session.resume(path,next,at(7))).role,'Liaison');await assert.rejects(session.resume(path,old,at(7)));
}));
test('wrong callers, invitations, versions, duplicate detach and reporting on preserve bytes',()=>fixture(async(path,state)=>{
 const before=await readFile(path,'utf8');
 for(const [r,v] of [[{...request,caller:old},3],[{...request,invitationId:'other'},3],[{...request,invitationVersion:2},3],[request,2],[{...request,unexpected:true},3]]){await assert.rejects(async()=>detach(path,r,v));assert.equal(await readFile(path,'utf8'),before);}
 await detach(path,request,3);const after=await readFile(path,'utf8');await assert.rejects(async()=>detach(path,{...request,id:'repeat'},4));assert.equal(await readFile(path,'utf8'),after);
 const enabled=evolve(state,{id:'on',type:'reports',actor:'manager',enabled:true,at:at(4),source},3);
 assert.throws(()=>evolve(enabled,{...request,type:'detachLiaison',actor:'manager',at:at(5)},4),/report/i);
}));
test('concurrent detach has one winner and revoked invitation cannot be restored by malformed import',()=>fixture(async(path,state)=>{
 assert.equal(typeof session.detach,'function');const results=await Promise.allSettled([session.detach(path,request,3),session.detach(path,{...request,id:'competing'},3)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const s=JSON.parse(await readFile(path,'utf8'));assert.equal(s.version,4);
 const corrupt=structuredClone(s);corrupt.session.invitation=state.session.invitation;corrupt.members=state.members;assert.throws(()=>validate(corrupt));
 const missing=structuredClone(s);delete missing.events.at(-1).detachedInvitation;assert.throws(()=>validate(missing));
}));
test('open rounds reject detach; closed history stays frozen and exited roles are not revived',()=>fixture(async(path,state)=>{
 let s=state;const apply=e=>{s=evolve(s,{id:`event-${s.version}`,actor:'manager',at:at(4),source,...e},s.version);};
 apply({type:'registerWorker',caller:m,memberId:'w',name:'Worker',binding:{hostId:'fixture-host',threadId:'worker'}});
 apply({type:'openRound',roundId:'round',title:'Historical round'});
 assert.throws(()=>evolve(s,{...request,type:'detachLiaison',actor:'manager'},s.version),/open rounds/);
 apply({type:'assign',roundId:'round',taskId:'task',title:'Task',workerId:'w',required:true,assignedAt:at(4)});
 for(const e of [{type:'submit',actor:'w',summary:'submitted'},{type:'review'},{type:'approve',summary:'accepted',evidence:['fixture']}])apply({roundId:'round',taskId:'task',...e});apply({type:'closeRound',roundId:'round'});
 const before=structuredClone(s),detached=evolve(s,{...request,type:'detachLiaison',actor:'manager',at:at(5)},s.version);
 assert.deepEqual(detached.rounds,before.rounds);assert.deepEqual(detached.tasks,before.tasks);
 for(const memberId of ['manager','liaison']){const exited=evolve(s,{id:`exit-${memberId}`,type:'exitMember',actor:'manager',memberId,at:at(5),source},s.version);assert.throws(()=>evolve(exited,{...request,type:'detachLiaison',actor:'manager',at:at(6)},exited.version));}
}));
test('detach CLI performs versioned operation and rejects malformed arguments',()=>fixture(async(path)=>{
 const file=path+'.request.json';await writeFile(file,JSON.stringify(request));let output;
 await run(['detach',path,file,'3'],v=>{output=v;});assert.match(output,/version 4/);
 assert.equal(JSON.parse(await readFile(path,'utf8')).session.invitation,null);
 for(const args of [[],[path,file],[path,file,'no'],[path,file,'4','extra']])await assert.rejects(run(['detach',...args],()=>{}),/detach/);
}));
