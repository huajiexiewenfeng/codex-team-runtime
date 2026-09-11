import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { start, attach, resume } from '../src/session.mjs';

const caller={hostId:'fixture-host',threadId:'fixture-manager'};
const liaison={hostId:'fixture-host',threadId:'fixture-liaison'};
const source={kind:'fixture',ref:'session-start-ids-tests'};
const at='2026-09-05T00:00:00.000Z';
const request=patch=>({teamId:'fixture-team',name:'Fixture team',caller,source,...patch});
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'session-start-ids-'));
 t.after(async()=>{const target=await realpath(dir);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('session-start-ids-'));await rm(target,{recursive:true,force:true});});
 return join(dir,'state.json');
}

test('start defaults each omitted role ID independently',async t=>{
 for(const [patch,ids] of [[{},['manager','liaison']],[{managerMemberId:'team-a-manager'},['team-a-manager','liaison']],[{liaisonMemberId:'team-a-liaison'},['manager','team-a-liaison']]]) {
  const state=await start(await fixture(t),request(patch),at);
  assert.deepEqual(state.members.map(m=>m.id),ids);
 }
});

test('custom start IDs keep roles, caller binding and two-sided attach authority',async t=>{
 const path=await fixture(t);
 const state=await start(path,request({managerMemberId:'team-b-manager',liaisonMemberId:'team-b-liaison'}),at);
 assert.deepEqual(state.members,[
  {id:'team-b-manager',name:'Manager',role:'Manager',lifecycle:'active',binding:{status:'bound',...caller}},
  {id:'team-b-liaison',name:'Liaison',role:'Liaison',lifecycle:'active',binding:{status:'unbound'}}
 ]);
 assert.equal(state.session.invitation,null);
 assert.deepEqual(state.rounds,[]);
 assert.equal((await resume(path,caller,at)).memberId,'team-b-manager');
 await assert.rejects(resume(path,liaison,at),/Caller is not an active bound member/);
 const invited=await attach(path,{mode:'invite',id:'invite-1',caller,target:liaison,at,expiresAt:'2026-09-05T00:10:00.000Z',source},0);
 assert.equal(invited.session.invitation.managerId,'team-b-manager');
 assert.equal(invited.session.invitation.liaisonId,'team-b-liaison');
 await attach(path,{mode:'confirm',id:'confirm-1',caller:liaison,invitationId:'invite-1',invitationVersion:1,at,source},1);
 assert.equal((await resume(path,liaison,at)).memberId,'team-b-liaison');
});

test('start rejects duplicate and invalid supplied role IDs before writing state',async t=>{
 for(const patch of [{managerMemberId:'same',liaisonMemberId:'same'},{managerMemberId:'liaison'},{liaisonMemberId:'manager'},...['managerMemberId','liaisonMemberId'].flatMap(key=>['','bad id','../bad','x'.repeat(129),null,42,{},[]].map(value=>({[key]:value})))]) {
  const path=await fixture(t);
  await assert.rejects(start(path,request(patch),at),/Duplicate member|Invalid identifier|Expected nonempty text/);
  await assert.rejects(readFile(path),{code:'ENOENT'});
 }
});

test('custom IDs cannot bypass unknown-field, caller or overwrite validation',async t=>{
 const path=await fixture(t), custom=request({managerMemberId:'team-c-manager',liaisonMemberId:'team-c-liaison'});
 await assert.rejects(start(path,{...custom,extra:true},at),/Unknown request field/);
 await assert.rejects(start(path,{...custom,caller:{...caller,verified:true}},at));
 await assert.rejects(readFile(path),{code:'ENOENT'});
 await start(path,custom,at);
 const before=await readFile(path,'utf8');
 await assert.rejects(start(path,{...custom,managerMemberId:'replacement-manager'},at),{code:'EEXIST'});
 assert.equal(await readFile(path,'utf8'),before);
});
