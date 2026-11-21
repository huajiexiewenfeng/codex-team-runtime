import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {demoState} from '../src/demo.mjs';
import {createState,evolve} from '../src/runtime.mjs';
import {checkWatchdog,watchdogStatus} from '../src/watchdog-runtime.mjs';
import {fixtureWatchdogHost,inspectWatchdogHost} from '../src/watchdog-host.mjs';
import {fixtureWatchdogAdapter} from '../src/watchdog-adapter.mjs';
const at='2026-11-20T00:06:00.000Z',source={kind:'fixture',ref:'synthetic execution evidence boundary; no real host'};
const now=(s)=>'2026-11-20T'+s+'.000Z';
function state(){
 const d=demoState();let s=createState({teamId:'synthetic-execution',name:'Offline',source,members:d.members},now('00:00:00'));
 for(const e of [{id:'round',type:'openRound',roundId:'r',title:'Offline'},
  {id:'execution',type:'assign',roundId:'r',taskId:'task',workerId:'worker-04',title:'Offline',required:true,assignedAt:now('00:02:00')}])
  s=evolve(s,{actor:'manager',at:e.type==='assign'?now('00:02:00'):now('00:01:00'),source,...e},s.version);
 return s;
}
function fact(extra={}){return {taskId:'task',executionId:'execution',dispatchEventId:'execution',hostId:'fixture-host',threadId:'fixture-worker-04',turnId:'synthetic-native-turn',
 status:'completed',startedAt:now('00:02:00'),completedAt:now('00:04:00'),observedAt:now('00:05:00'),...extra};}
async function fixture(t,s=state()){
 const root=await mkdtemp(join(tmpdir(),'watchdog-execution-p0-'));t.after(async()=>{const target=await realpath(root);assert.equal(dirname(target),await realpath(tmpdir()));assert.match(basename(target),/^watchdog-execution-p0-/);await rm(target,{recursive:true,force:true,maxRetries:3});});
 const path=join(root,'state.json');await writeFile(path,JSON.stringify(s));return {path,s};
}
const ended=r=>r.anomalies.filter(a=>a.active&&a.type==='ended-without-submission');
const host=rows=>fixtureWatchdogHost(async()=>rows);
test('production CLI reports the unavailable causal provider without inspecting native threads',async t=>{
 const s=state();s.team.source={kind:'manual',ref:'synthetic manual ledger, not business data'};for(const e of s.events)e.source={...s.team.source};
 const f=await fixture(t,s),before=await readFile(f.path);
 const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'watchdog-check',f.path],{windowsHide:true,encoding:'utf8'});
 const r=JSON.parse(stdout);assert.equal(r.hostEvidence,'unknown');assert.equal(r.executionCapability.status,'unavailable');assert.equal(r.current.length,0);
 assert.ok((await readFile(f.path)).equals(before));
});
test('production/manual ledger cannot promote synthesized exact IDs or fixture facts',async t=>{
 const s=state();s.team.source={kind:'manual',ref:'synthetic manual only'};for(const e of s.events)e.source={...s.team.source};
 const f=await fixture(t,s);let calls=0;
 const r=await checkWatchdog(f.path,{at,hostAdapter:fixtureWatchdogHost(()=>{calls++;return [fact()];})});
 assert.equal(calls,0);assert.equal(r.hostEvidence,'unknown');assert.equal(ended(r).length,0);
 assert.equal((await watchdogStatus(f.path,{at})).executionCapability.reason,'no-verified-task-turn-provider');
});
test('ordinary JSON/fact provider cannot grant production association, even with safe=true',async t=>{
 const f=await fixture(t);let calls=0;
 const r=await checkWatchdog(f.path,{at,hostAdapter:{production:true,safe:true,readSummary:()=>{calls++;return [fact()];}}});
 assert.equal(calls,0);assert.equal(r.hostEvidence,'unknown');assert.equal(ended(r).length,0);
});
test('fixture-only positive uses existing detector/dedupe across a fresh adapter/restart',async t=>{
 const f=await fixture(t),before=await readFile(f.path);let sends=0;
 const adapter=fixtureWatchdogAdapter(async()=>{sends++;return {outcome:'queued'};});
 const a=await checkWatchdog(f.path,{at,hostAdapter:host([fact()]),adapter});assert.equal(ended(a).length,1);assert.equal(a.hostEvidence,'fixture');assert.equal(sends,1);
 const b=await checkWatchdog(f.path,{at,hostAdapter:host([fact()]),adapter});assert.equal(ended(b).length,1);assert.equal(sends,1);
 assert.ok((await readFile(f.path)).equals(before));
});
test('late submission resolves fixture detection without another native reminder',async t=>{
 const f=await fixture(t);let sends=0;const adapter=fixtureWatchdogAdapter(async()=>{sends++;return {outcome:'queued'};});
 await checkWatchdog(f.path,{at,hostAdapter:host([fact()]),adapter});
 const s=evolve(f.s,{id:'late-submit',type:'submit',actor:'worker-04',at:now('00:06:10'),source,roundId:'r',taskId:'task',summary:'late recorded receipt'},f.s.version);
 await writeFile(f.path,JSON.stringify(s));const r=await checkWatchdog(f.path,{at:now('00:07:00'),hostAdapter:host([fact()]),adapter});
 assert.equal(ended(r).length,0);assert.equal(sends,1);assert.equal(s.tasks[0].status,'submitted');
});
test('worker blocker is already a receipt even though task status remains executing',async t=>{
 let s=state();s=evolve(s,{id:'blocker',type:'reportBlocker',actor:'worker-04',caller:{hostId:'fixture-host',threadId:'fixture-worker-04'},roundId:'r',taskId:'task',at:now('00:04:10'),source,summary:'need dependency',blocker:{who:'Manager',reason:'dependency missing',needs:'verified input',evidenceRef:'synthetic:blocker-receipt'}},s.version);
 assert.equal(s.tasks[0].status,'executing');
 const f=await fixture(t,s),r=await checkWatchdog(f.path,{at,hostAdapter:host([fact()])});assert.equal(ended(r).length,0);
});
test('grace, stale observations, notLoaded and missing terminal facts never imply an ended execution',async t=>{
 for(const extra of [{completedAt:now('00:05:30')},{observedAt:now('00:02:00')},{status:'notLoaded'},{status:'unknown'},{completedAt:undefined},{turnId:undefined}]){
  const f=await fixture(t),r=await checkWatchdog(f.path,{at,hostAdapter:host([fact(extra)])});assert.equal(ended(r).length,0);assert.notEqual(r.phase,'fault');
 }
});
test('wrong execution, dispatch event, target and rebound binding never borrow a completion',async t=>{
 for(const extra of [{executionId:'old'},{dispatchEventId:'old'},{hostId:'other'},{threadId:'other'}]){
  const f=await fixture(t),r=await checkWatchdog(f.path,{at,hostAdapter:host([fact(extra)])});assert.equal(ended(r).length,0);
 }
 const s=state();s.members.find(m=>m.id==='worker-04').binding.threadId='rebound';const f=await fixture(t,s),r=await checkWatchdog(f.path,{at,hostAdapter:host([fact()])});assert.equal(ended(r).length,0);
});
test('rework never reuses previous execution; fixture-only current rework without receipt is detectable',async t=>{
 let s=state();
 for(const e of [{id:'submit',type:'submit',actor:'worker-04',summary:'first',at:now('00:03:00')},{id:'review',type:'review',at:now('00:03:10')},{id:'rework',type:'rework',summary:'revise',at:now('00:04:00')}])
  s=evolve(s,{actor:'manager',roundId:'r',taskId:'task',source,...e},s.version);
 const f=await fixture(t,s);assert.equal(ended(await checkWatchdog(f.path,{at,hostAdapter:host([fact()])})).length,0);
 const exact=fact({executionId:'rework',dispatchEventId:'rework',startedAt:now('00:04:00'),completedAt:now('00:04:30')});
 assert.equal(ended(await checkWatchdog(f.path,{at,hostAdapter:host([exact])})).length,1);
});
test('submitted plus running is compatible, no same-execution conflict rule is invented',async t=>{
 const s=evolve(state(),{id:'submit',type:'submit',actor:'worker-04',roundId:'r',taskId:'task',source,at:now('00:04:00'),summary:'done, closing notification'},state().version);
 const f=await fixture(t,s),r=await checkWatchdog(f.path,{at,hostAdapter:host([fact({status:'running'})])});assert.equal(ended(r).length,0);assert.equal(r.anomalies.some(a=>a.type==='same-execution-host-conflict'),false);assert.ok(r.unsupportedChecks.includes('same-execution-host-conflict'));
});
test('duplicate or contradictory facts are unknown rather than an exception or a host-conflict alarm',async t=>{
 for(const rows of [[fact(),fact()],[fact(),fact({status:'running'})],[fact(),{}]]){
  const f=await fixture(t),r=await checkWatchdog(f.path,{at,hostAdapter:host(rows)});assert.equal(r.hostEvidence,'unknown');assert.equal(ended(r).length,0);assert.notEqual(r.phase,'fault');
 }
});
test('host reader failure does not suppress independent ledger monitoring or block Worker submission',async t=>{
 const f=await fixture(t);const r=await checkWatchdog(f.path,{at,hostAdapter:fixtureWatchdogHost(()=>{throw Error('synthetic observation failure');})});assert.notEqual(r.phase,'fault');assert.equal(r.hostEvidence,'unknown');
 const ledger=await fixture(t,demoState()),stillMonitored=await checkWatchdog(ledger.path,{at,hostAdapter:fixtureWatchdogHost(()=>{throw Error('synthetic reader failure');})});assert.ok(stillMonitored.anomalies.some(a=>a.active&&a.type==='blocker-unhandled'));
 const next=evolve(f.s,{id:'submit',type:'submit',actor:'worker-04',at:now('00:06:10'),source,roundId:'r',taskId:'task',summary:'normal submission'},f.s.version);await writeFile(f.path,JSON.stringify(next));assert.equal(next.tasks[0].status,'submitted');
});
test('evidence reader cannot mutate the business snapshot used by the checker',async t=>{
 const f=await fixture(t),s=f.s,before=JSON.stringify(s);
 await inspectWatchdogHost(s,fixtureWatchdogHost(rows=>{rows[0].taskId='forged';return [];}),at,{endGraceMs:60000});
 assert.equal(JSON.stringify(s),before);
});
