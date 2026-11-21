import { mkdir, readFile, realpath, open, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { watch } from 'node:fs';
import { readState, atomicWrite } from './store.mjs';
import { withFileLocks } from './registry-projection.mjs';
import { loadLedger, lastResult } from './submission-recovery.mjs';
import { inspectWatchdog, reconcileWatchdog, timestamp, digest, watchdogPolicy,validateWatchdogPolicy } from './watchdog-checker.mjs';
import {validateWatchdogStore,STORE_LIMITS} from './watchdog-store-contract.mjs';
import {readWatchdogInputs,createWatchdogInputReader} from './watchdog-input.mjs';
import {inspectWatchdogHost,watchdogExecutionCapability} from './watchdog-host.mjs';
import {createWatchdogSchedule,nextWatchdogDelay,watchdogIntervals} from './watchdog-schedule.mjs';
import { unavailableWatchdogAdapter, watchdogAdapterAllowed } from './watchdog-adapter.mjs';
import {watchdogDeploymentAllowed,watchdogRegisteredStateMatches} from './watchdog-deployment.mjs';
import {applyWatchdogCutover} from './watchdog-cutover.mjs';
const inc=(s,key)=>s.counters[key]=Math.min(Number.MAX_SAFE_INTEGER,s.counters[key]+1);
async function paths(statePath) {
 const state=await realpath(statePath),directory=state+'.watchdog';
 await mkdir(directory,{recursive:true});
 // Do not follow a redirected sidecar into business data or another team's store.
 if(await realpath(directory)!==directory)throw new Error('Watchdog sidecar must not be redirected');
 return {state,directory,data:join(directory,'state.json'),lock:join(directory,'transaction.lock'),lease:join(directory,'service.lock'),heartbeat:join(directory,'heartbeat.json'),config:join(directory,'config.json')};
}
const initial=state=>({schemaVersion:1,statePath:state,teamId:null,enabled:true,anomalies:[],attempts:[],lastCheckedAt:null,lastFault:null,failures:0,phase:'unmonitored',hostEvidence:'unknown',counters:{checks:0,detected:0,attempts:0,confirmedDelivery:0,confirmedWakeups:0,completedReminderTurns:0,interruptedReminderTurns:0},modelWakeups:'unknown',programModelTokens:0});
async function load(p) {
 let value;try{if((await stat(p.data)).size>STORE_LIMITS.bytes)throw new Error('Watchdog store too large');value=JSON.parse(await readFile(p.data,'utf8'));}catch(e){if(e.code==='ENOENT')value=initial(p.state);else throw e;}
 try {if((await stat(p.config)).size>4096)throw new Error('Invalid Watchdog config size');const config=JSON.parse(await readFile(p.config,'utf8'));if(config.schemaVersion!==1||typeof config.enabled!=='boolean'||Object.keys(config).length!==2)throw new Error('Invalid Watchdog config');value.enabled=config.enabled;}catch(e){if(e.code!=='ENOENT')throw e;}
 value.counters.completedReminderTurns??=0;value.counters.interruptedReminderTurns??=0;
 return validateWatchdogStore(value,p.state);
}
const save=(p,s)=>{validateWatchdogStore(s,p.state);const content=JSON.stringify(s,null,2)+'\n';if(Buffer.byteLength(content)>STORE_LIMITS.bytes)throw new Error('Watchdog store too large');return atomicWrite(p.data,content);};
export async function configureWatchdog(statePath, enabled) {
 if(typeof enabled!=='boolean')throw new Error('enabled must be boolean');const p=await paths(statePath);
 return withFileLocks([p.lock],async()=>{
  // A corrupt diagnostic store must not prevent explicit disable.
  let s;try{s=await load(p);}catch(error){if(enabled)throw error;s=initial(p.state);s.lastFault={at:new Date().toISOString(),code:'MONITOR_UNAVAILABLE'};}
  s.enabled=enabled;s.phase=enabled?'unmonitored':'disabled';await atomicWrite(p.config,JSON.stringify({schemaVersion:1,enabled})+'\n');return s;
 });
}
async function processAlive(p,at) {
 try {
  const lease=JSON.parse(await readFile(p.lease,'utf8')),heartbeat=JSON.parse(await readFile(p.heartbeat,'utf8'));
  if(!Number.isSafeInteger(lease.pid)||lease.pid<=0||typeof lease.ownerToken!=='string'||lease.ownerToken!==heartbeat.ownerToken||heartbeat.pid!==lease.pid||timestamp(at)-timestamp(heartbeat.at)<0||timestamp(at)-timestamp(heartbeat.at)>watchdogIntervals.heartbeatFreshMs)throw new Error('Stale or mismatched heartbeat');
  timestamp(lease.startedAt);process.kill(lease.pid,0);return {status:'running',pid:lease.pid,lastHeartbeatAt:heartbeat.at,assurance:'matching-owner-recent-heartbeat'};
 }
 catch(e){return {status:e.code==='ENOENT'?'not-running':'unknown-or-stale-lock'};}
}
export async function watchdogStatus(statePath,{at=new Date().toISOString(),detail=false}={}) {
 timestamp(at);const p=await paths(statePath),s=await load(p),processState=await processAlive(p,at);
 const common={executionCapability:s.hostEvidence==='desktop'?{status:'verified',scope:'local Desktop initial E04',unsupportedChecks:['same-execution-host-conflict']}:watchdogExecutionCapability,enabled:s.enabled,phase:s.enabled?s.phase:'disabled',process:processState,monitoring:s.enabled&&processState.status==='running',deliveryCapability:s.deploymentCapability?{status:s.deploymentCapability,scope:'explicit tested-local-queue reminders'}:unavailableWatchdogAdapter.capability};
 if(detail)return {...s,...common};
 return {...common,teamId:s.teamId,lastCheckedAt:s.lastCheckedAt,lastFault:s.lastFault,counters:s.counters,modelWakeups:s.modelWakeups,programModelTokens:s.programModelTokens,hostEvidence:s.hostEvidence,unsupportedChecks:s.unsupportedChecks??['ended-without-submission','same-execution-host-conflict'],capacityExceeded:s.capacityExceeded??false,
  counts:{active:s.anomalies.filter(a=>a.active).length,pending:s.anomalies.filter(a=>a.active&&a.delivery==='pending').length,unresolvedDeliveries:s.attempts.filter(a=>['intent','unknown','queued','consumed'].includes(a.outcome)).length},
  cutover:s.cutover??null,counterSemantics:'cumulative historically observed confirmations; later ambiguity may downgrade current receipts',
  currentReceiptCounts:{unknown:s.attempts.filter(a=>a.outcome==='unknown').length,completed:s.attempts.filter(a=>a.outcome==='completed').length},
  current:s.anomalies.filter(a=>a.active).slice(0,20).map(a=>({taskId:a.taskId,executionId:a.executionId,type:a.type,delivery:a.delivery,evidenceRevision:a.evidenceRevision})),deliveryReason:s.deliveryReason??null};
}
export async function checkWatchdog(statePath,{at=new Date().toISOString(),adapter=unavailableWatchdogAdapter,deployment=null,hostAdapter=null,policy=watchdogPolicy,readOptions={},inputReader=readWatchdogInputs,deliveryMode='check-and-send',requireCutover=false,capabilityMode=null,expectedRegistration=null}={}) {
 if(!['check-and-send','reconcile-only'].includes(deliveryMode))throw new Error('Invalid Watchdog delivery mode');
 timestamp(at);validateWatchdogPolicy(policy);const p=await paths(statePath);
 return withFileLocks([p.lock],async()=>{
  let s=await load(p);if(!s.enabled)return {...s,phase:'disabled'};
  if(s.lastObservedAt&&at<s.lastObservedAt||s.lastCheckedAt&&at<s.lastCheckedAt)throw new Error('Watchdog time moved backwards');
  s.lastObservedAt=at;
  try {
   const {state,notices}=await inputReader(p.state,readOptions);
   if(expectedRegistration&&!watchdogRegisteredStateMatches(expectedRegistration,state))throw new Error('Registered Manager identity mismatch');
   const deployed=deployment!==null&&watchdogDeploymentAllowed(deployment,p.state,state);
   if(deployment&&!deployed)throw new Error('Deployment identity mismatch');
   if(s.teamId!==null&&s.teamId!==state.team.id)throw new Error('Watchdog team binding changed');
   s.teamId=state.team.id;
   let inspection=inspectWatchdog(state,at,policy);
   const host=await inspectWatchdogHost(state,hostAdapter,at,policy,p.state);
   inspection.hostEvidence=host.status;inspection.anomalies.push(...host.anomalies);
   if(['fixture','desktop'].includes(host.status))inspection.unsupportedChecks=['same-execution-host-conflict'];
   for(const task of state.tasks.filter(t=>t.status==='submitted')) {
    const submit=state.events.findLast(e=>e.taskId===task.id&&e.roundId===task.roundId&&e.type==='submit');
    const entries=notices.entries.filter(e=>e.notice.taskId===task.id&&e.notice.roundId===task.roundId&&e.notice.submissionId===submit?.id);
    if(entries.length>1)throw new Error('Duplicate current notice');
    const entry=entries[0],outcome=entry?(entry.attempts.length?lastResult(entry.attempts.at(-1)):entry.baseline.outcome):'unknown';
    if(entry&&['not-attempted','policy-denied','transient-not-delivered'].includes(outcome)&&timestamp(at)-timestamp(entry.trackedAt)>=policy.pendingMs) {
     const executionId=state.events.findLast(e=>e.taskId===task.id&&e.roundId===task.roundId&&['assign','startTask','rework'].includes(e.type))?.id;
     if(executionId){const evidence={notificationId:entry.notice.notificationId,submissionId:submit.id,outcome,ref:`notice:${entry.notice.notificationId}`};inspection.anomalies.push({key:digest([state.team.id,task.id,executionId,'notice-not-delivered']),teamId:state.team.id,taskId:task.id,executionId,type:'notice-not-delivered',evidence,evidenceHash:digest(evidence),assurance:'caller-assessed-notice-ledger'});}
    }
   }
   if(requireCutover){
    const cutover=await applyWatchdogCutover(p.state,state,inspection,at);inspection=cutover.inspection;s.cutover=cutover.summary;
    for(const row of s.anomalies)if(!cutover.eligibleTaskIds.has(row.taskId)){row.active=false;row.suppressedByCutover=true;}
   }
   if(capabilityMode==='observe-only')s.deploymentCapability='observe-only';
   s=reconcileWatchdog(s,inspection,at,policy);s.lastFault=null;s.failures=0;
   // A persisted intent after any crash has an unknown outcome; never resend it.
   for(const a of s.attempts)if(a.outcome==='intent')a.outcome='unknown';
   for(const a of s.anomalies)if(a.delivery==='intent')a.delivery='unknown';
   // Legacy attempts have no receipt identity: retain unknown, never invent one.
   if(deployed){
    const linked=s.attempts.filter(a=>a.receiptAttemptId&&a.outcome!=='not-sent'&&(inspection.hasWork||['intent','unknown','queued','consumed'].includes(a.outcome)));
    const ordered=[...linked].sort((a,b)=>(a.lastReceiptCheckedAt??'').localeCompare(b.lastReceiptCheckedAt??'')).slice(0,20);
    for(const a of ordered){
     a.lastReceiptCheckedAt=at;
     const receipt=await deployment.reconcile({receiptAttemptId:a.receiptAttemptId,state,at,taskId:a.taskId,executionId:a.executionId});
     a.receiptStatus=receipt.receiptStatus;
     a.outcome=({'turn-completed':'completed','turn-interrupted':'interrupted',consumed:'consumed'})[receipt.receiptStatus]??'unknown';
     if(['consumed','completed','interrupted'].includes(a.outcome)&&!a.consumptionCounted){inc(s,'confirmedDelivery');inc(s,'confirmedWakeups');a.consumptionCounted=true;}
     if(a.outcome==='completed'&&!a.completionCounted){inc(s,'completedReminderTurns');a.completionCounted=true;}
     if(a.outcome==='interrupted'&&!a.interruptionCounted){inc(s,'interruptedReminderTurns');a.interruptionCounted=true;}
     for(const row of s.anomalies.filter(row=>a.keys.includes(row.key)))row.delivery=a.outcome;
    }
    s.deploymentCapability=deployment.fixtureOnly?'fixture-only':deployment.config.mode==='queue-profile'&&deployment.validationStatus().status!=='verified'?'queue-profile-registered':'tested-local-queue-reminders';
   }
   let pending=s.anomalies.filter(a=>a.active&&a.delivery==='pending').slice(0,20);
   // One receipt's current context is exact: combine only one task/execution.
   if(deployed&&pending.length)pending=pending.filter(a=>a.taskId===pending[0].taskId&&a.executionId===pending[0].executionId).slice(0,2);
   s.deliveryReason=capabilityMode==='observe-only'?'observe-only-no-exact-queue-profile':(deployed?deployment:adapter).capability?.reason??'unverified-adapter';
   if(deliveryMode==='check-and-send'&&pending.length&&(deployed||watchdogAdapterAllowed(adapter,state))) {
    const sent=s.attempts.filter(a=>a.outcome!=='not-sent'),recent=sent.filter(a=>timestamp(at)-timestamp(a.at)<3600_000);
    const last=sent.at(-1);
    if(s.attempts.length>=1000||recent.length>=policy.hourlyLimit||last&&timestamp(at)-timestamp(last.at)<policy.cooldownMs)s.deliveryReason='rate-limited-or-capacity';
    else {
     // Read again immediately before intent; changed business evidence cancels this
     // check. This is ledger validation, NOT a claim of host race safety.
     const fresh=await readState(p.state,readOptions);
     const freshNotices=await loadLedger(p.state+'.submission-notices.json',p.state,state.team.id);
     const freshHost=await inspectWatchdogHost(fresh,hostAdapter,at,policy,p.state);
     if(digest(fresh)!==digest(state)||digest(freshNotices)!==digest(notices)||digest(freshHost)!==digest(host)){s.deliveryReason='source-changed';await save(p,s);return s;}
     const keys=pending.map(a=>a.key),id=digest([s.teamId,keys,s.attempts.length,at]);
     const attempt={id,at,keys,outcome:'intent'};s.attempts.push(attempt);
     for(const a of pending)a.delivery='intent';inc(s,'attempts');await save(p,s);
     let result;
     if(deployed){
      let prepared;
      try{prepared=await deployment.prepare({watchdogAttemptId:id,anomalies:pending,state:fresh,at});}
      catch(error){attempt.outcome='not-sent';for(const a of pending)a.delivery='pending';throw error;}
      Object.assign(attempt,{receiptAttemptId:prepared.attemptId,taskId:pending[0].taskId,executionId:pending[0].executionId,receiptStatus:'unknown'});await save(p,s);
      const guard=async()=>{
       const enabled=(await load(p)).enabled,current=await readState(p.state,readOptions);
       if(!enabled||!watchdogDeploymentAllowed(deployment,p.state,current)||digest(current)!==digest(fresh))return false;
       const currentNotices=await loadLedger(p.state+'.submission-notices.json',p.state,current.team.id);
       if(digest(currentNotices)!==digest(freshNotices))return false;
       if(!pending.some(row=>row.assurance==='desktop-e04-envelope'))return true;
       const lastHost=await inspectWatchdogHost(current,hostAdapter,new Date(Math.max(Date.now(),timestamp(at))).toISOString(),policy,p.state);
       const sameEvidence=pending.filter(row=>row.assurance==='desktop-e04-envelope').every(row=>lastHost.anomalies.some(candidate=>candidate.key===row.key&&candidate.evidenceHash===row.evidenceHash));
       return sameEvidence&&digest(await readState(p.state,readOptions))===digest(current);
      };
      result=await deployment.send({receiptAttemptId:prepared.attemptId,state:fresh,at,guard});
     }else try{result=await adapter.enqueue({id,teamId:s.teamId,items:pending.map(a=>({taskId:a.taskId,executionId:a.executionId,type:a.type,evidence:a.evidence})),instruction:'Recheck current ledger and Watchdog enabled state before acting; no automatic dispatch or repair.'});}catch{result={outcome:'unknown'};}
     // Acceptance/exit 0 is not consumption, delivery, wakeup or handling.
     attempt.outcome=result?.outcome==='not-sent'?'not-sent':result?.outcome==='queued'?'queued':'unknown';
     if(attempt.outcome==='queued'&&typeof result.queueId==='string')attempt.queueId=result.queueId.slice(0,256);
     for(const a of pending)a.delivery=attempt.outcome==='not-sent'?'pending':attempt.outcome;
     s.deliveryReason=attempt.outcome==='not-sent'?'known-not-sent-before-marker-pending':attempt.outcome==='queued'?'queued-consumption-unconfirmed':'delivery-unknown-reconcile-before-retry';
    }
   }
   // Keep unresolved attempts and at least an hour's rate-limit history.
   // Linked receipt history is retained for duplicate detection; capacity stops
   // further sends, never discards an unknown to manufacture recovery.
   s.attempts=s.attempts.filter((a,i)=>a.receiptAttemptId||['intent','unknown','queued','consumed'].includes(a.outcome)||i>=s.attempts.length-policy.historyLimit||timestamp(at)-timestamp(a.at)<3600_000);
   s.phase=inspection.hasWork||s.anomalies.some(a=>a.active)?'watching':s.attempts.some(a=>['intent','unknown','queued','consumed'].includes(a.outcome))?'reconciling':'sleeping';
   await save(p,s);return s;
  } catch(error) {
   s.lastFault={at,code:'MONITOR_UNAVAILABLE'};s.failures=Math.min(10,s.failures+1);s.phase='fault';inc(s,'checks');await save(p,s);return s;
  }
 });
}

// Explicit foreground service only: no install, autostart, daemon or host config.
// One process can own multiple teams. Canonical per-team leases also prevent a
// second manifest/process monitoring the same team under a different root.
export async function startWatchdogService(statePaths,{
 readOptions={},onCheck=()=>{},clock=()=>Date.now(),deployment=null,
 timers={setTimeout,clearTimeout},watchFactory=watch,intervals=watchdogIntervals,
}={}) {
 for(const k of ['activeMs','sleepMs','maxBackoffMs','heartbeatMs','heartbeatFreshMs'])if(!Number.isSafeInteger(intervals[k])||intervals[k]<1000||intervals[k]>86400000)throw new Error('Invalid Watchdog intervals');
 if(!Array.isArray(statePaths)||!statePaths.length||statePaths.length>100)throw new Error('Expected 1..100 team state paths');
 const currentTime=()=>{const n=clock();if(!Number.isSafeInteger(n)||n<0||n>8640000000000000)throw new Error('Invalid Watchdog clock');return n;};
 const teams=await Promise.all(statePaths.map(paths));
 if(new Set(teams.map(p=>p.state)).size!==teams.length)throw new Error('Duplicate team path');
 const leases=[],watchers=[],ownerToken=randomUUID(),startedAt=new Date(currentTime()).toISOString();
 const schedule=createWatchdogSchedule(teams.map(p=>p.state),currentTime()),inputReader=createWatchdogInputReader();
 let closed=false,timer=null,heartbeatTimer=null,heartbeatRunning=null,running=null,nextHeartbeat=currentTime(),closePromise=null;
 async function release(){for(const {p,handle} of leases.reverse()){await handle.close();await unlink(p.lease);await unlink(p.heartbeat).catch(e=>{if(e.code!=='ENOENT')throw e;});}leases.length=0;}
 try {
  for(const p of [...teams].sort((a,b)=>a.state.localeCompare(b.state))) {
   const handle=await open(p.lease,'wx');leases.push({p,handle});await handle.writeFile(JSON.stringify({pid:process.pid,startedAt,ownerToken}));await handle.sync();
  }
 } catch(e){await release();throw e;}
 function arm(){
  timers.clearTimeout(timer);if(closed)return;
  const now=currentTime(),delay=Math.min(schedule.delay(now),Math.max(0,nextHeartbeat-now));
  timer=timers.setTimeout(()=>{void runDue().catch(()=>{if(!closed){nextHeartbeat=currentTime()+watchdogIntervals.heartbeatMs;arm();}});},delay);
 }
 async function heartbeatLoop(){if(closed)return;heartbeatRunning=(async()=>{try{const at=new Date(currentTime()).toISOString();for(const {p} of leases)await atomicWrite(p.heartbeat,JSON.stringify({pid:process.pid,ownerToken,at})+'\n');nextHeartbeat=currentTime()+watchdogIntervals.heartbeatMs;}catch{}})();try{await heartbeatRunning;}finally{heartbeatRunning=null;}if(!closed)heartbeatTimer=timers.setTimeout(()=>{void heartbeatLoop();},watchdogIntervals.heartbeatMs);}
 async function runDue(){
  if(closed)return;if(running)return running;timers.clearTimeout(timer);
  running=(async()=>{
   const now=currentTime();
   if(now>=nextHeartbeat){
    for(const {p} of leases)await atomicWrite(p.heartbeat,JSON.stringify({pid:process.pid,ownerToken,at:new Date(now).toISOString()})+'\n');
    nextHeartbeat=now+watchdogIntervals.heartbeatMs;
   }
   await Promise.allSettled(schedule.due(now).map(async due=>{
    if(closed)return;let delay=watchdogIntervals.activeMs;
    try {
     const result=await checkWatchdog(due.id,{at:new Date(currentTime()).toISOString(),readOptions,inputReader,deployment:deployment?.adapterFor(due.id)??null,requireCutover:deployment?.requireCutover??false,capabilityMode:deployment?.modeFor?.(due.id)??null,expectedRegistration:deployment?.registrationFor?.(due.id)??null});
     delay=nextWatchdogDelay(result,intervals);try{onCheck(result);}catch{}
    } catch{}
    schedule.finish(due.id,due.generation,currentTime(),delay);
   }));
  })();
  try{await running;}finally{running=null;arm();}
 }
 for(const p of teams) {
  // Filter filenames: persistence must not wake the service itself.
  for(const [target,names] of [[dirname(p.state),new Set([basename(p.state),basename(p.state)+'.submission-notices.json'])],[p.directory,new Set(['config.json'])]]) {
   try {const w=watchFactory(target,(_event,name)=>{if(!closed&&name&&names.has(String(name))){schedule.wake(p.state,currentTime()+100);arm();}});w.on('error',()=>{});watchers.push(w);}catch{}
  }
 }
 await heartbeatLoop();try{await runDue();}catch(e){closed=true;timers.clearTimeout(heartbeatTimer);for(const w of watchers)w.close();await release();throw e;}
 return {
  // Deterministic seam: only due teams run; never force host calls or extra scans.
  runDue,
  close:()=>{if(closePromise)return closePromise;closed=true;closePromise=(async()=>{timers.clearTimeout(timer);timers.clearTimeout(heartbeatTimer);for(const w of watchers)w.close();if(heartbeatRunning)await heartbeatRunning;if(running)await running;await release();})();return closePromise;},
 };
}
