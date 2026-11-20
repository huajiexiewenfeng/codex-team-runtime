import { createHash } from 'node:crypto';
import { validate } from './runtime.mjs';

export const watchdogPolicy = Object.freeze({pendingMs:30*60_000, endGraceMs:60_000, cooldownMs:15*60_000, hourlyLimit:4, historyLimit:100, activeLimit:1000});
export function validateWatchdogPolicy(policy) {
 if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).length!==Object.keys(watchdogPolicy).length||Object.keys(policy).some(k=>!Object.hasOwn(watchdogPolicy,k)))throw new Error('Invalid Watchdog policy fields');
 for(const [key,value] of Object.entries(policy)) {
  const max=key.endsWith('Ms')?30*86400_000:key==='hourlyLimit'?24:1000;
  const min=key.endsWith('Ms')?0:1;
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error('Invalid Watchdog policy value');
 }
 return policy;
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function timestamp(at) {
 if(typeof at!=='string'||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)throw new Error('Watchdog requires canonical UTC time');
 return Date.parse(at);
}
export function executionFor(state, task) {
 // A rework event is a distinct ledger execution; observations do not define one.
 return state.events.findLast(e=>e.taskId===task.id&&e.roundId===task.roundId&&['assign','startTask','rework'].includes(e.type))?.id??null;
}
export function inspectWatchdog(state, at, policy=watchdogPolicy) {
 validate(state);validateWatchdogPolicy(policy);const now=timestamp(at), anomalies=[];
 if(now<Date.parse(state.updatedAt))throw new Error('Watchdog time precedes state');
 const active=state.tasks.filter(t=>!['approved','cancelled'].includes(t.status)&&state.rounds.some(r=>r.id===t.roundId&&r.status==='open'));
 for(const task of active) {
  const executionId=executionFor(state,task);if(!executionId)continue;
  const event=state.events.findLast(e=>e.taskId===task.id&&e.roundId===task.roundId&&({submitted:['submit'],blocked:['block','reportBlocker']}[task.status]??[]).includes(e.type));
  if(!event||now-Date.parse(event.at)<policy.pendingMs)continue;
  const type=task.status==='blocked'?'blocker-unhandled':'submission-unhandled';
  const key=digest([state.team.id,task.id,executionId,type]);
  const evidence={eventId:event.id,status:task.status,at:event.at,ref:`ledger:event:${event.id}`};
  anomalies.push({key,teamId:state.team.id,taskId:task.id,executionId,type,evidence,evidenceHash:digest(evidence),assurance:'recorded-ledger'});
 }
 return {sourceVersion:state.version,sourceUpdatedAt:state.updatedAt,hasWork:active.length>0,anomalies,
  hostEvidence:'unknown',unsupportedChecks:['ended-without-submission','same-execution-host-conflict'],programModelTokens:0};
}

export function reconcileWatchdog(previous, inspection, at, policy=watchdogPolicy) {
 timestamp(at);validateWatchdogPolicy(policy);const next=structuredClone(previous),current=new Set(inspection.anomalies.map(a=>a.key));
 for(const row of next.anomalies)if(row.active&&!current.has(row.key)){row.active=false;row.resolvedAt=at;}
 for(const anomaly of inspection.anomalies) {
  let row=next.anomalies.find(a=>a.key===anomaly.key);
  if(!row) {
   if(next.anomalies.filter(a=>a.active).length>=policy.activeLimit||next.anomalies.length>=2000){next.capacityExceeded=true;continue;}
   next.anomalies.push({...anomaly,active:true,firstSeenAt:at,evidenceRevision:1,delivery:'pending'});
   next.counters.detected=Math.min(Number.MAX_SAFE_INTEGER,next.counters.detected+1);
  } else {
   if(row.evidenceHash!==anomaly.evidenceHash){Object.assign(row,anomaly);row.evidenceRevision++;}
   row.active=true;delete row.resolvedAt;
   // Even changed evidence or reappearance cannot silently reset a send intent.
  }
 }
 const historical=next.anomalies.filter(a=>!a.active).slice(-policy.historyLimit);
 // Undecided sends must survive pruning, even after resolution.
 const referenced=new Set(next.attempts.filter(a=>a.receiptAttemptId).flatMap(a=>a.keys));
 next.anomalies=next.anomalies.filter(a=>a.active||referenced.has(a.key)||['intent','unknown','queued','consumed'].includes(a.delivery)||historical.includes(a));
 next.lastCheckedAt=at;next.cursor={version:inspection.sourceVersion,updatedAt:inspection.sourceUpdatedAt};
 next.phase=inspection.hasWork||next.anomalies.some(a=>a.active)?'watching':next.attempts.some(a=>['intent','unknown','queued','consumed'].includes(a.outcome))?'reconciling':'sleeping';
 next.counters.checks=Math.min(Number.MAX_SAFE_INTEGER,next.counters.checks+1);
 next.hostEvidence=inspection.hostEvidence;next.unsupportedChecks=inspection.unsupportedChecks;
 return next;
}
