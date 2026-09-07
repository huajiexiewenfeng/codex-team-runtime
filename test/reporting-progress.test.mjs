import test from 'node:test';
import assert from 'node:assert/strict';
import { createState,evolve } from '../src/runtime.mjs';
import { createReportingLedger,evolveReporting } from '../src/reporting.mjs';
import { run } from '../src/cli.mjs';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const api=await import('../src/reporting-progress.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const at=n=>new Date(Date.UTC(2026,8,7,0,n)).toISOString();
const m={hostId:'fixture-host',threadId:'fixture-manager'},l={hostId:'fixture-host',threadId:'fixture-liaison'};
const source={kind:'manual',ref:'offline-progress-contract'};
const taskIds=['submitted','blocked','accepted','unknown'];
function fixture(){
 let state=createState({teamId:'test',name:'Test',source,members:[{id:'m',name:'Manager',role:'Manager',lifecycle:'active',binding:{status:'bound',...m}},{id:'l',name:'Liaison',role:'Liaison',lifecycle:'active',binding:{status:'unbound'}},...taskIds.map(id=>({id:`w-${id}`,name:`Worker ${id}`,role:'Worker',lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:`fixture-worker-${id}`}}))]},at(0));
 const apply=e=>{state=evolve(state,{id:`e-${state.version}`,actor:'m',at:at(1),source,...e},state.version);};
 apply({type:'attachInvite',caller:m,target:l,expiresAt:at(5)});apply({type:'attachConfirm',actor:'l',caller:l,invitationId:'e-0',invitationVersion:1});apply({type:'openRound',roundId:'r',title:'Round'});
 for(const id of taskIds)apply({type:'assign',roundId:'r',taskId:id,title:id,workerId:`w-${id}`,required:true,assignedAt:id==='unknown'?null:at(1)});
 apply({type:'submit',actor:'w-submitted',roundId:'r',taskId:'submitted',summary:'ready'});
 apply({type:'block',roundId:'r',taskId:'blocked',summary:'needs input'});
 apply({type:'submit',actor:'w-accepted',roundId:'r',taskId:'accepted',summary:'ready'});apply({type:'review',roundId:'r',taskId:'accepted'});apply({type:'approve',roundId:'r',taskId:'accepted',summary:'verified',evidence:['offline']});
 let ledger=createReportingLedger(state,m,at(2));
 for(const e of [{id:'p',type:'prepare',at:at(3),expiresAt:at(10)},{id:'d',type:'dispatch',at:at(4),operationId:'p'},{id:'r',type:'record',at:at(5),observedAt:at(5),operationId:'p',owner:{memberId:'l',...l},automationId:'automation',outcome:'running'}])ledger=evolveReporting(ledger,state,m,{...e,source:{kind:'host-observation',evidenceRef:'offline-declared-observation'}},ledger.version);
 return {state,ledger};
}
function report(state,ledger,caller=l){assert.equal(typeof api.prepareProgressReport,'function','progress report capability missing');return api.prepareProgressReport(state,ledger,caller,'automation',at(20));}
test('progress report separates acceptance, waiting and blocking and preserves elapsed unknown',()=>{
 const {state,ledger}=fixture(),before=structuredClone({state,ledger}),r=report(state,ledger);
 assert.equal(r.delivery,'not-sent');assert.equal(r.gate.allowProgressReport,true);
 assert.deepEqual(r.report.counts,{total:4,approved:1,awaitingReview:1,blocked:1,cancelled:0});
 assert.equal(r.report.tasks.find(t=>t.id==='unknown').elapsedMs,null);
 assert.equal(r.report.tasks.find(t=>t.id==='blocked').elapsedMs,19*60000);
 assert.equal(r.report.tasks.find(t=>t.id==='blocked').blockReason,'needs input');
 assert.equal(r.report.tasks.find(t=>t.id==='accepted').elapsedMs,0);
 assert.equal(r.report.tasks.find(t=>t.id==='submitted').freshness,'unknown');
 assert.match(r.text,/待验收 1/);assert.match(r.text,/耗时未知/);assert.deepEqual({state,ledger},before);
});
test('denied gate produces no report body and wrong owner is rejected',()=>{
 let {state,ledger}=fixture();state=evolve(state,{id:'off',type:'reports',actor:'m',at:at(6),source,enabled:false},state.version);
 const r=report(state,ledger);assert.equal(r.report,null);assert.equal(r.text,null);assert.equal(r.gate.reason,'reports-disabled');assert.throws(()=>report(state,ledger,m));
});
test('only open rounds contribute to current report',()=>{
 let {state,ledger}=fixture();
 const apply=e=>{state=evolve(state,{id:`late-${state.version}`,actor:'m',at:at(7),source,...e},state.version);};
 apply({type:'openRound',roundId:'old',title:'Old'});apply({type:'assign',roundId:'old',taskId:'old-task',title:'Old task',workerId:'w-accepted',required:true,assignedAt:at(7)});
 for(const e of [{type:'submit',actor:'w-accepted',summary:'ready'},{type:'review'},{type:'approve',summary:'accepted',evidence:['offline']}])apply({roundId:'old',taskId:'old-task',...e});apply({type:'closeRound',roundId:'old'});
 const r=report(state,ledger);assert.deepEqual(r.report.rounds.map(x=>x.id),['r']);assert.equal(r.report.counts.total,4);assert(!r.text.includes('Old task'));
});
test('queued progress has queue phase duration but no execution elapsed',()=>{
 let {state,ledger}=fixture();
 state=evolve(state,{id:'queued',type:'enqueue',actor:'m',caller:m,at:at(6),source,roundId:'r',taskId:'queued',title:'Queued task',workerId:'w-submitted',required:true,assignedAt:null},state.version);
 const before=structuredClone({state,ledger}),r=report(state,ledger),task=r.report.tasks.find(t=>t.id==='queued');
 assert.equal(task.status,'queued');assert.equal(task.elapsedMs,null);assert.equal(task.phaseElapsedMs,14*60000);
 assert.match(r.text,/Queued task：排队中；总耗时 耗时未知；当前阶段 14分0秒/);
 assert.deepEqual({state,ledger},before);
});
test('cancelled tasks remain visible without inflating accepted progress',()=>{
 let {state,ledger}=fixture();state=evolve(state,{id:'q',type:'enqueue',actor:'m',caller:m,at:at(6),source,roundId:'r',taskId:'q',title:'Withdrawn task',workerId:'w-submitted',required:true,assignedAt:null},state.version);
 state=evolve(state,{id:'c',type:'cancelQueued',actor:'m',caller:m,at:at(7),source,roundId:'r',taskId:'q',summary:'User withdrew it'},state.version);
 const r=report(state,ledger);assert.equal(r.report.counts.cancelled,1);assert.equal(r.report.counts.approved,1);assert.match(r.text,/已取消 1/);assert.match(r.text,/Withdrawn task：已取消/);assert.equal(r.report.tasks.find(t=>t.id==='q').elapsedMs,null);
});
test('progress CLI reads actual files without writes and rejects invalid arguments',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'team-progress-'));
 try{
  const {state,ledger}=fixture(),files=['state','ledger','caller'].map(n=>join(dir,n+'.json'));
  await Promise.all([state,ledger,l].map((v,i)=>writeFile(files[i],JSON.stringify(v))));
  const before=await Promise.all(files.map(p=>readFile(p,'utf8')));
  let output;await run(['reporting-progress',...files,'automation',at(20)],v=>{output=JSON.parse(v);});
  assert.equal(output.report.counts.awaitingReview,1);assert.equal(output.delivery,'not-sent');
  assert.deepEqual(await Promise.all(files.map(p=>readFile(p,'utf8'))),before);
  for(const args of [[],files,[...files,'automation',at(20),'extra']])await assert.rejects(run(['reporting-progress',...args],()=>{}),/reporting-progress/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
