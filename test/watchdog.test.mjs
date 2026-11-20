import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoState } from '../src/demo.mjs';
import { createState, evolve } from '../src/runtime.mjs';
import { inspectWatchdog, executionFor, digest } from '../src/watchdog-checker.mjs';
import { configureWatchdog, checkWatchdog, watchdogStatus, startWatchdogService } from '../src/watchdog-runtime.mjs';
import { fixtureWatchdogAdapter } from '../src/watchdog-adapter.mjs';
import { queueReminderRequest, probeWatchdogQueue, enqueueWatchdogQueue } from '../src/watchdog-queue.mjs';
import { prepareSubmissionNotice } from '../src/submission-notice.mjs';
import { run } from '../src/cli.mjs';
const at='2026-09-05T04:00:00.000Z';
async function fixture(t,state=demoState()) {
 const dir=await mkdtemp(join(tmpdir(),'watchdog-p0-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'team.json');await writeFile(path,JSON.stringify(state));return {dir,path:await realpath(path),state};
}
function submitted() {
 let s=demoState();const task=s.tasks.find(t=>t.id==='T-2');
 // Current demo task is reviewing: return to real submitted via supported rework.
 for(const [type,actor] of [['rework','manager'],['submit','worker-02']])s=evolve(s,{id:`extra-${type}`,type,actor,taskId:task.id,roundId:task.roundId,summary:'fixture',source:{kind:'fixture',ref:'fixture'},at:type==='rework'?'2026-09-05T01:01:00.000Z':'2026-09-05T01:02:00.000Z'},s.version);
 return s;
}
test('checker scopes to current pending ledger, ignores reviewing and silence; no host claims',()=>{
 const s=demoState(),r=inspectWatchdog(s,at);assert.deepEqual(r.anomalies.map(a=>a.taskId),['T-3']);assert.equal(r.hostEvidence,'unknown');assert.equal(r.programModelTokens,0);
 const next=submitted(),row=inspectWatchdog(next,at).anomalies.find(a=>a.taskId==='T-2');assert.equal(row.executionId,'extra-rework');assert.equal(executionFor(next,next.tasks[1]),'extra-rework');
});
test('default enabled is separate from running; off persists across new work and checks',async t=>{
 const f=await fixture(t);assert.equal((await watchdogStatus(f.path)).enabled,true);assert.equal((await watchdogStatus(f.path)).monitoring,false);
 await configureWatchdog(f.path,false);await writeFile(f.path,JSON.stringify(submitted()));
 const result=await checkWatchdog(f.path,{at});assert.equal(result.phase,'disabled');assert.equal(result.counters.checks,0);assert.equal((await watchdogStatus(f.path)).enabled,false);
});
test('sleeping without unfinished work, pure checker has no model or host adapter calls',async t=>{
 const s=demoState(),empty=createState({teamId:'empty',name:'empty',source:s.team.source,members:s.members},'2026-09-05T00:00:00.000Z');
 const f=await fixture(t,empty);let calls=0;const result=await checkWatchdog(f.path,{at,adapter:fixtureWatchdogAdapter(()=>{calls++;})});
 assert.equal(result.phase,'sleeping');assert.equal(calls,0);assert.equal(result.programModelTokens,0);
});
test('durable merged send, restart/dedupe/evidence revision do not resend',async t=>{
 const f=await fixture(t,submitted());let sends=0;const adapter=fixtureWatchdogAdapter(async()=>{sends++;return {outcome:'queued',queueId:'q-1'};});
 const a=await checkWatchdog(f.path,{at,adapter});assert.equal(sends,1);assert.equal(a.attempts[0].keys.length,2);assert.equal(a.counters.confirmedDelivery,0);assert.equal(a.modelWakeups,'unknown');
 const b=await checkWatchdog(f.path,{at,adapter});assert.equal(sends,1);assert.equal(b.anomalies[0].evidenceRevision,1);assert.equal(b.attempts[0].outcome,'queued');
});
test('concurrent triggers cannot duplicate sends and business locks stay free',async t=>{
 const f=await fixture(t);let sends=0;
 const adapter=fixtureWatchdogAdapter(async()=>{sends++;return {outcome:'queued'};});
 const results=await Promise.allSettled([checkWatchdog(f.path,{at,adapter}),checkWatchdog(f.path,{at,adapter})]);
 assert.equal(sends,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'EEXIST');
 await writeFile(f.path+'.lock','business busy');const r=await checkWatchdog(f.path,{at});assert.notEqual(r.phase,'fault');
});
test('unknown send and persisted intent survive restart without resend',async t=>{
 const f=await fixture(t);let sends=0;const adapter=fixtureWatchdogAdapter(async()=>{sends++;throw new Error('timeout');});
 await checkWatchdog(f.path,{at,adapter});await checkWatchdog(f.path,{at,adapter});assert.equal(sends,1);
 const path=join(f.path+'.watchdog','state.json'),s=JSON.parse(await readFile(path,'utf8'));s.attempts[0].outcome='intent';s.anomalies[0].delivery='intent';await writeFile(path,JSON.stringify(s));
 const r=await checkWatchdog(f.path,{at,adapter});assert.equal(sends,1);assert.equal(r.attempts[0].outcome,'unknown');assert.equal(r.anomalies[0].delivery,'unknown');
});
test('unverified adapter and notLoaded observations cannot send or imply failure',async t=>{
 const f=await fixture(t);let sends=0;const adapter={capability:{status:'safe',nonInterrupting:true},enqueue:()=>sends++};
 const r=await checkWatchdog(f.path,{at,adapter});assert.equal(sends,0);assert.equal(r.anomalies[0].delivery,'pending');assert.equal(r.hostEvidence,'unknown');
 const s=demoState();s.tasks[3].observations[0].summary='notLoaded turn/completed ended';const q=inspectWatchdog(s,at);assert.equal(q.anomalies.some(a=>a.taskId==='T-4'),false);
});
test('fixture adapter cannot deliver production/manual source',async t=>{
 const s=demoState();s.team.source={kind:'manual',ref:'manual'};const f=await fixture(t,s);let sends=0;
 await checkWatchdog(f.path,{at,adapter:fixtureWatchdogAdapter(()=>sends++)});assert.equal(sends,0);
});
test('notice missing remains unknown; current tracked nonreceipt is a bounded anomaly, old submission ignored',async t=>{
 const f=await fixture(t,submitted());let r=await checkWatchdog(f.path,{at});assert.equal(r.anomalies.some(a=>a.type==='notice-not-delivered'),false);
 const caller={hostId:'fixture-host',threadId:'fixture-worker-02'},notice=prepareSubmissionNotice(f.state,caller,'T-2').notice;
 const ledger={schemaVersion:1,statePath:f.path,teamId:f.state.team.id,version:1,entries:[{notice,trackedAt:'2026-09-05T01:03:00.000Z',baseline:{outcome:'not-attempted',evidence:{kind:'observation',ref:'fixture',detail:'fixture'}},attempts:[]}]};
 await writeFile(f.path+'.submission-notices.json',JSON.stringify(ledger));r=await checkWatchdog(f.path,{at});assert.equal(r.anomalies.filter(a=>a.active&&a.type==='notice-not-delivered').length,1);
 ledger.entries[0].notice.submissionId='stale-submit';await writeFile(f.path+'.submission-notices.json',JSON.stringify(ledger));r=await checkWatchdog(f.path,{at});assert.equal(r.anomalies.filter(a=>a.active&&a.type==='notice-not-delivered').length,0);
});
test('business state, Registry/notice/inbox bytes never change, even on monitor errors',async t=>{
 const f=await fixture(t);const paths=[f.path,join(f.dir,'registry.json'),f.path+'.submission-notices.json',f.path+'.manager-inbox.json'];
 for(const p of paths.slice(1))await writeFile(p,'unreadable fixture sentinel');const before=await Promise.all(paths.map(p=>readFile(p)));
 const r=await checkWatchdog(f.path,{at});assert.equal(r.phase,'fault');assert.equal(r.lastFault.code,'MONITOR_UNAVAILABLE');
 const after=await Promise.all(paths.map(p=>readFile(p)));after.forEach((value,i)=>assert.deepEqual(value,before[i]));
 assert.equal(r.anomalies.length,0);
});
test('multi-team foreground service owns one lease per team, releases on close, never auto-steals',async t=>{
 const a=await fixture(t),b=await fixture(t);await configureWatchdog(a.path,false);await configureWatchdog(b.path,false);
 const service=await startWatchdogService([a.path,b.path]);t.after(()=>service.close());assert.equal((await watchdogStatus(a.path)).process.status,'running');
 await assert.rejects(startWatchdogService([a.path]),{code:'EEXIST'});await service.close();assert.equal((await watchdogStatus(a.path)).process.status,'not-running');
 await writeFile(join(a.path+'.watchdog','service.lock'),JSON.stringify({pid:2147483647}));await assert.rejects(startWatchdogService([a.path]),{code:'EEXIST'});assert.equal((await watchdogStatus(a.path)).monitoring,false);
});
test('CLI has thin management commands; check does not enable off',async t=>{
 const f=await fixture(t);const result=[];await run(['watchdog-off',f.path],x=>result.push(JSON.parse(x)));await run(['watchdog-check',f.path],x=>result.push(JSON.parse(x)));assert.equal(result[1].enabled,false);assert.equal(result[1].phase,'disabled');
});
test('queue candidate probes exact binary only; safe arguments and no resume; production gate fail closed',async t=>{
 const f=await fixture(t);const calls=[];const runner=async(_exe,args,options)=>{calls.push(args);assert.equal(options.shell,false);return {stdout:args[0]==='--version'?'codex-cli fixture':'Usage: codex queue --thread <THREAD> --message <TEXT>'};};
 const probe=await probeWatchdogQueue(process.execPath,{runner});assert.equal(probe.commandAvailable,true);assert.equal(probe.productionApproved,false);assert.deepEqual(calls,[['--version'],['queue','--help']]);
 const request=queueReminderRequest(f.state,inspectWatchdog(f.state,at).anomalies);assert.equal(request.args.includes('--resume'),false);assert.equal(request.args.length,5);
 await assert.rejects(enqueueWatchdogQueue(probe,request,{runner}),/PENDING_HOST_VALIDATION/);assert.equal(calls.length,2);
});
import { nextWatchdogDelay, createWatchdogSchedule } from '../src/watchdog-schedule.mjs';
import { validateWatchdogStore } from '../src/watchdog-store-contract.mjs';
import { fixtureWatchdogHost } from '../src/watchdog-host.mjs';
import { createWatchdogInputReader } from '../src/watchdog-input.mjs';
import { EventEmitter } from 'node:events';
import { wireServiceShutdown } from '../src/cli.mjs';
const fakeTimers={setTimeout:()=>({}),clearTimeout:()=>{}};
const noWatch=()=>{const w=new EventEmitter();w.close=()=>{};return w;};
test('per-team deadlines isolate active, sleeping, disabled and faulting cadence; full 15min backoff',async t=>{
 const a=await fixture(t),b=await fixture(t),c=await fixture(t),d=await fixture(t);
 const s=demoState(),empty=createState({teamId:'empty',name:'empty',source:s.team.source,members:s.members},'2026-09-05T00:00:00.000Z');await writeFile(b.path,JSON.stringify(empty));await configureWatchdog(c.path,false);await writeFile(d.path+'.submission-notices.json','bad');
 let now=Date.parse(at);const counts=new Map();
 const service=await startWatchdogService([a.path,b.path,c.path,d.path],{clock:()=>now,timers:fakeTimers,watchFactory:noWatch,onCheck:s=>counts.set(s.statePath,(counts.get(s.statePath)??0)+1)});t.after(()=>service.close());
 for(let i=1;i<=4;i++){now=Date.parse(at)+i*60000;await service.runDue();}
 assert.equal(counts.get(a.path),5);assert.equal(counts.get(b.path),1);assert.equal(counts.get(c.path),1);assert.equal(counts.get(d.path),2);
 now=Date.parse(at)+300000;await service.runDue();assert.equal(counts.get(b.path),2);assert.equal(counts.get(c.path),2);
 assert.equal(nextWatchdogDelay({phase:'fault',failures:10}),900000);
 const schedule=createWatchdogSchedule(['a','b'],0);const first=schedule.due(0);first.forEach(x=>schedule.finish(x.id,x.generation,0,x.id==='a'?60000:300000));assert.deepEqual(schedule.due(60000).map(x=>x.id),['a']);schedule.wake('b',61000);assert.deepEqual(schedule.due(61000).map(x=>x.id),['a','b']);await service.close();
});
test('sleeping and disabled teams never query host; ordinary objects cannot assert host trust',async t=>{
 let reads=0;const hostAdapter=fixtureWatchdogHost(()=>{reads++;return [];});
 const base=demoState(),empty=createState({teamId:'empty',name:'empty',source:base.team.source,members:base.members},'2026-09-05T00:00:00.000Z');const f=await fixture(t,empty);
 await checkWatchdog(f.path,{at,hostAdapter});await configureWatchdog(f.path,false);await checkWatchdog(f.path,{at,hostAdapter});assert.equal(reads,0);
 const g=await fixture(t);const result=await checkWatchdog(g.path,{at,hostAdapter:{readSummary:()=>{reads++;return [];}}});assert.equal(result.hostEvidence,'unknown');assert.equal(reads,0);
});
test('fixture host requires exact current execution, binding, chronology and grace; old turn ignored',async t=>{
 const f=await fixture(t),task=f.state.tasks[3],executionId=executionFor(f.state,task);let current=executionId;
 const hostAdapter=fixtureWatchdogHost(()=>[{taskId:task.id,executionId:current,dispatchEventId:current,hostId:'fixture-host',threadId:'fixture-worker-04',turnId:'turn-exact',status:'completed',startedAt:'2026-09-05T00:30:00.000Z',completedAt:'2026-09-05T03:58:00.000Z',observedAt:'2026-09-05T03:59:00.000Z'}]);
 let r=await checkWatchdog(f.path,{at,hostAdapter});assert.equal(r.anomalies.filter(a=>a.active&&a.type==='ended-without-submission').length,1);assert.equal(r.hostEvidence,'fixture');
 current='old-execution';r=await checkWatchdog(f.path,{at,hostAdapter});assert.equal(r.anomalies.filter(a=>a.active&&a.type==='ended-without-submission').length,0);
 const manual=structuredClone(f.state);manual.team.source={kind:'manual',ref:'manual'};await writeFile(f.path,JSON.stringify(manual));r=await checkWatchdog(f.path,{at,hostAdapter});assert.equal(r.hostEvidence,'unknown');
});
test('queued/unknown tracking survives business completion instead of full sleep or pruning',async t=>{
 const f=await fixture(t);await checkWatchdog(f.path,{at,adapter:fixtureWatchdogAdapter(async()=>({outcome:'queued'}))});
 let s=f.state;let minute=0;
 for(const task of s.tasks.filter(t=>!['approved','cancelled'].includes(t.status))) {
  const steps=task.status==='blocked'?['unblock','submit','review','approve']:task.status==='reviewing'?['approve']:['submit','review','approve'];
  for(const type of steps)s=evolve(s,{id:`close-${++minute}`,type,actor:type==='submit'?task.workerId:'manager',taskId:task.id,roundId:task.roundId,at:new Date(Date.parse('2026-09-05T02:00:00.000Z')+minute*1000).toISOString(),source:{kind:'fixture',ref:'fixture'},...(type!=='review'?{summary:'fixture'}:{}),...(type==='approve'?{evidence:['fixture']}: {})},s.version);
 }
 await writeFile(f.path,JSON.stringify(s));const r=await checkWatchdog(f.path,{at});assert.equal(r.phase,'reconciling');assert.equal(r.attempts[0].outcome,'queued');assert.equal(r.anomalies.some(a=>a.delivery==='queued'),true);
});
test('store/policy/time corruption fails closed and explicit off still works',async t=>{
 const f=await fixture(t);await checkWatchdog(f.path,{at});
 await assert.rejects(checkWatchdog(f.path,{at:'bad'}),/canonical/);await assert.rejects(checkWatchdog(f.path,{at,policy:{pendingMs:-1}}),/policy/);await assert.rejects(checkWatchdog(f.path,{at:'2026-09-05T03:59:00.000Z'}),/backwards/);
 const path=join(f.path+'.watchdog','state.json'),s=JSON.parse(await readFile(path,'utf8'));s.counters.checks=-1;await writeFile(path,JSON.stringify(s));await assert.rejects(checkWatchdog(f.path,{at}),/invalid/);
 const off=await configureWatchdog(f.path,false);assert.equal(off.enabled,false);assert.deepEqual(JSON.parse(await readFile(join(f.path+'.watchdog','config.json'),'utf8')),{schemaVersion:1,enabled:false});
});
test('capacity preserves unresolved evidence and refuses extra rows rather than unbounded growth',async t=>{
 const f=await fixture(t);let r=await checkWatchdog(f.path,{at,policy:{pendingMs:0,endGraceMs:0,cooldownMs:0,hourlyLimit:4,historyLimit:1,activeLimit:1}});assert.equal(r.anomalies.length,1);
 const submittedState=submitted();await writeFile(f.path,JSON.stringify(submittedState));r=await checkWatchdog(f.path,{at,policy:{pendingMs:0,endGraceMs:0,cooldownMs:0,hourlyLimit:4,historyLimit:1,activeLimit:1}});assert.equal(r.capacityExceeded,true);assert.equal(r.anomalies.length,1);
 const corrupt=structuredClone(r);corrupt.attempts=Array.from({length:1001},()=>({}));assert.throws(()=>validateWatchdogStore(corrupt,f.path),/invalid/);
});
test('status is compact by default; stale/reused PID and mismatched owner cannot look online',async t=>{
 const f=await fixture(t);await checkWatchdog(f.path,{at});let now=Date.parse(at);
 const service=await startWatchdogService([f.path],{clock:()=>now,timers:fakeTimers,watchFactory:noWatch});t.after(()=>service.close());
 let r=await watchdogStatus(f.path,{at});assert.equal(r.monitoring,true);assert.equal(r.attempts,undefined);assert.equal(r.anomalies,undefined);assert.equal(r.current.length,1);
 r=await watchdogStatus(f.path,{at:'2026-09-05T04:03:00.000Z'});assert.equal(r.monitoring,false);assert.equal(r.process.status,'unknown-or-stale-lock');
 const heartbeat=join(f.path+'.watchdog','heartbeat.json'),hb=JSON.parse(await readFile(heartbeat,'utf8'));hb.ownerToken='wrong-owner';await writeFile(heartbeat,JSON.stringify(hb));assert.equal((await watchdogStatus(f.path,{at})).monitoring,false);
 assert.equal((await watchdogStatus(f.path,{at,detail:true})).anomalies.length,1);await service.close();
});
test('normal CLI signal wiring invokes idempotent close and releases service leases',async t=>{
 const f=await fixture(t);await configureWatchdog(f.path,false);const service=await startWatchdogService([f.path]);const signal=new EventEmitter();const unwire=wireServiceShutdown(service,signal);t.after(unwire);signal.emit('SIGTERM');await service.close();
 // close can race the signal; ensure the first close's asynchronous release ends.
 await new Promise(resolve=>setImmediate(resolve));assert.equal((await watchdogStatus(f.path)).process.status,'not-running');
});
test('raw source refs and observations never appear in reminders or status',async t=>{
 const state=demoState();state.events.find(e=>e.type==='block').source.ref='PRIVATE_BODY_TOKEN';const f=await fixture(t,state);const r=await checkWatchdog(f.path,{at});assert.equal(JSON.stringify(r.anomalies).includes('PRIVATE_BODY_TOKEN'),false);assert.equal(JSON.stringify(await watchdogStatus(f.path)).includes('PRIVATE_BODY_TOKEN'),false);
});
test('submitted or reviewing while original native turn is running is legal, never a host conflict',async t=>{
 const f=await fixture(t,submitted()),task=f.state.tasks[1],executionId=executionFor(f.state,task);
 const hostAdapter=fixtureWatchdogHost(()=>[{taskId:task.id,executionId,dispatchEventId:executionId,hostId:'fixture-host',threadId:'fixture-worker-02',turnId:'turn-finishing-notice',status:'running',startedAt:'2026-09-05T01:01:00.000Z',observedAt:'2026-09-05T03:59:00.000Z'}]);
 const r=await checkWatchdog(f.path,{at,hostAdapter});assert.equal(r.anomalies.some(a=>a.type==='same-execution-host-conflict'),false);assert.equal(r.unsupportedChecks.includes('same-execution-host-conflict'),true);
});
