import { timestamp, digest } from './watchdog-checker.mjs';
export const STORE_LIMITS=Object.freeze({bytes:16*1024*1024,anomalies:2000,attempts:1000});
const fail=()=>{throw new Error('Watchdog store invalid');};
const check=ok=>{if(!ok)fail();};
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const closed=(v,keys)=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)));
export function validateWatchdogStore(value,statePath) {
 closed(value,['schemaVersion','statePath','teamId','enabled','anomalies','attempts','lastCheckedAt','lastFault','failures','phase','hostEvidence','counters','modelWakeups','programModelTokens','cursor','unsupportedChecks','capacityExceeded','deliveryReason','lastObservedAt','deploymentCapability','cutover']);
 check(value.schemaVersion===1&&value.statePath===statePath&&(value.teamId===null||id(value.teamId))&&typeof value.enabled==='boolean');
 check(['unmonitored','disabled','watching','sleeping','reconciling','fault'].includes(value.phase)&&['unknown','fixture'].includes(value.hostEvidence));
 check(value.programModelTokens===0&&value.modelWakeups==='unknown');
 check(integer(value.failures)&&value.failures<=10);closed(value.counters,['checks','detected','attempts','confirmedDelivery','confirmedWakeups','completedReminderTurns','interruptedReminderTurns']);
 for(const key of ['checks','detected','attempts','confirmedDelivery','confirmedWakeups'])check(integer(value.counters[key]));
 for(const key of ['completedReminderTurns','interruptedReminderTurns'])if(value.counters[key]!==undefined)check(integer(value.counters[key]));
 if(value.deploymentCapability!==undefined)check(['fixture-only','tested-local-queue-reminders','observe-only','queue-profile-registered'].includes(value.deploymentCapability));
 if(value.cutover!==undefined){closed(value.cutover,['policy','createdAt','sourceVersion','eventCount','excludedExistingTasks','newEligibleTasks']);check(value.cutover.policy==='newtasks-only');timestamp(value.cutover.createdAt);for(const k of ['sourceVersion','eventCount','excludedExistingTasks','newEligibleTasks'])check(integer(value.cutover[k]));}
 if(value.lastCheckedAt!==null)timestamp(value.lastCheckedAt);
 if(value.lastObservedAt!==undefined)timestamp(value.lastObservedAt);
 if(value.lastFault!==null){closed(value.lastFault,['at','code']);timestamp(value.lastFault.at);check(value.lastFault.code==='MONITOR_UNAVAILABLE');}
 if(value.cursor){closed(value.cursor,['version','updatedAt']);check(integer(value.cursor.version));timestamp(value.cursor.updatedAt);}
 if(value.unsupportedChecks!==undefined)check(Array.isArray(value.unsupportedChecks)&&value.unsupportedChecks.length<=4&&value.unsupportedChecks.every(x=>['ended-without-submission','same-execution-host-conflict'].includes(x)));
 if(value.deliveryReason!==undefined)check(typeof value.deliveryReason==='string'&&value.deliveryReason.length<=256);
 if(value.capacityExceeded!==undefined)check(typeof value.capacityExceeded==='boolean');
 check(Array.isArray(value.anomalies)&&value.anomalies.length<=STORE_LIMITS.anomalies&&Array.isArray(value.attempts)&&value.attempts.length<=STORE_LIMITS.attempts);
 const keys=new Set(),attempts=new Set();
 for(const a of value.anomalies){
  closed(a,['key','teamId','taskId','executionId','type','evidence','evidenceHash','assurance','active','firstSeenAt','evidenceRevision','delivery','resolvedAt','suppressedByCutover']);
  if(a.suppressedByCutover!==undefined)check(a.suppressedByCutover===true&&!a.active);
  check(hex(a.key)&&!keys.has(a.key)&&a.teamId===value.teamId&&id(a.taskId)&&id(a.executionId));keys.add(a.key);
  check(['submission-unhandled','blocker-unhandled','notice-not-delivered','ended-without-submission','same-execution-host-conflict'].includes(a.type));
  check(a.key===digest([a.teamId,a.taskId,a.executionId,a.type])&&hex(a.evidenceHash)&&a.evidenceHash===digest(a.evidence));
  check(a.evidence&&typeof a.evidence==='object'&&!Array.isArray(a.evidence)&&Buffer.byteLength(JSON.stringify(a.evidence))<=12000);
  check(['recorded-ledger','caller-assessed-notice-ledger','fixture-host'].includes(a.assurance));
  check(typeof a.active==='boolean'&&integer(a.evidenceRevision)&&a.evidenceRevision>=1&&['pending','intent','queued','unknown','consumed','completed','interrupted'].includes(a.delivery));
  timestamp(a.firstSeenAt);if(a.resolvedAt!==undefined){timestamp(a.resolvedAt);check(!a.active&&a.resolvedAt>=a.firstSeenAt);}
 }
 for(const a of value.attempts){
  closed(a,['id','at','keys','outcome','queueId','receiptAttemptId','taskId','executionId','receiptStatus','consumptionCounted','completionCounted','interruptionCounted','lastReceiptCheckedAt']);timestamp(a.at);
  check(hex(a.id)&&!attempts.has(a.id)&&Array.isArray(a.keys)&&a.keys.length>=1&&a.keys.length<=20&&new Set(a.keys).size===a.keys.length);attempts.add(a.id);
  check(a.keys.every(k=>keys.has(k))&&['intent','queued','unknown','not-sent','consumed','completed','interrupted'].includes(a.outcome));
  if(a.receiptAttemptId!==undefined){check(id(a.receiptAttemptId)&&id(a.taskId)&&id(a.executionId)&&['unknown','consumed','turn-completed','turn-interrupted'].includes(a.receiptStatus));}
  for(const k of ['consumptionCounted','completionCounted','interruptionCounted'])if(a[k]!==undefined)check(typeof a[k]==='boolean');
  if(a.lastReceiptCheckedAt!==undefined)timestamp(a.lastReceiptCheckedAt);
  if(a.queueId!==undefined)check(typeof a.queueId==='string'&&a.queueId.length>0&&a.queueId.length<=256);
 }
 return value;
}
