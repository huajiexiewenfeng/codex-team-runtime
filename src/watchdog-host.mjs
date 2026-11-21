import {readDispatchExecutionEnd} from './watchdog-dispatch-execution.mjs';
import {taskProgress} from './progress-summary.mjs';
import { timestamp,executionFor,digest } from './watchdog-checker.mjs';
// No public object/JSON flag can authenticate native task-to-turn evidence.
// Current send receipts identify a thread only. Reminder queue correlations
// authenticate their own Manager reminder, not a Worker's business execution.
export const watchdogExecutionCapability=Object.freeze({
 status:'unavailable',reason:'no-verified-task-turn-provider',
 unsupportedChecks:Object.freeze(['ended-without-submission','same-execution-host-conflict'])
});
const fixtures=new WeakSet();
export function fixtureWatchdogHost(readSummary) {
 if(typeof readSummary!=='function')throw new Error('Fixture summary reader required');
 const adapter=Object.freeze({readSummary});fixtures.add(adapter);return adapter;
}
// Trusted integration boundary. There is no production registration in this
// candidate: JSON records, source.kind and caller assertions cannot authenticate
// a host. Only registered fixture adapters may exercise these checks offline.
export async function inspectWatchdogHost(state,adapter,at,policy,statePath=null) {
 const base={status:'unknown',anomalies:[],queried:false};
 const active=state.tasks.filter(t=>['executing','rework','submitted','reviewing'].includes(t.status)&&state.rounds.some(r=>r.id===t.roundId&&r.status==='open'));
 if(!active.length)return {...base,reason:'no-current-execution'};
 if(!adapter)return statePath?inspectDesktop(active,statePath,state,at,policy,base):{...base,reason:'no-verified-task-turn-provider'};
 if(!fixtures.has(adapter))return {...base,reason:'unregistered-execution-evidence'};
 if(state.team.source.kind!=='fixture'||!state.events.every(e=>e.source.kind==='fixture'))return {...base,reason:'fixture-evidence-is-not-production'};
 try{return await inspectFixtureHost(state,adapter,at,policy,active);}
 catch{return {...base,queried:true,reason:'execution-evidence-missing-ambiguous-or-unavailable'};}
}
async function inspectDesktop(active,path,state,at,policy,base) {
 if(state.schemaVersion!==2||state.team.source.kind==='fixture')return base;
 const anomalies=[];
 let verified=false;
 for(const task of active) {
  if(!['executing','rework'].includes(task.status))continue;
  const executionId=executionFor(state,task);
  if(!executionId||!withoutReceipt(state,task,executionId))continue;
  const fact=await readDispatchExecutionEnd(path,state,task,executionId,at);
  if(!fact)continue;
  verified=true;
  if(timestamp(at)-timestamp(fact.completedAt)<policy.endGraceMs)continue;
  const type='ended-without-submission',evidence={...fact,eventId:executionId,status:'completed'};
  anomalies.push({key:digest([state.team.id,task.id,executionId,type]),teamId:state.team.id,taskId:task.id,
    executionId,type,evidence,evidenceHash:digest(evidence),assurance:'desktop-e04-envelope'});
 }
 return verified?{status:'desktop',anomalies,queried:true}:{...base,reason:'no-verified-task-turn-provider'};
}
function withoutReceipt(state,task,executionId) {
 const index=state.events.findIndex(e=>e.id===executionId);
 return index>=0&&!taskProgress(state,task).blocker&&!state.events.slice(index+1)
  .some(e=>e.taskId===task.id&&e.roundId===task.roundId&&e.type==='submit');
}
async function inspectFixtureHost(state,adapter,at,policy,active) {

 const facts=await adapter.readSummary(active.map(t=>({teamId:state.team.id,taskId:t.id,executionId:executionFor(state,t)})));
 if(!Array.isArray(facts)||facts.length>1000)throw new Error('Invalid fixture host summary');
 const anomalies=[],seen=new Set();
 for(const f of facts) {
  if(!f||typeof f!=='object'||Array.isArray(f)||!['taskId','executionId','hostId','threadId','turnId','status','observedAt','startedAt','dispatchEventId'].every(k=>Object.hasOwn(f,k))||Object.keys(f).some(k=>!['taskId','executionId','hostId','threadId','turnId','status','observedAt','startedAt','completedAt','dispatchEventId'].includes(k)))throw new Error('Invalid fixture host fact');
  const task=active.find(t=>t.id===f.taskId);if(!task)continue;
  const executionId=executionFor(state,task),round=state.rounds.find(r=>r.id===task.roundId),worker=state.members.find(m=>m.id===task.workerId),old=round.members.find(m=>m.id===task.workerId);
  const execution=state.events.find(e=>e.id===executionId);
  // Exact current task/execution and matching current/historical Worker binding.
  // A generic thread completion or a notLoaded observation cannot pass this gate.
  if(f.executionId!==executionId||f.dispatchEventId!==executionId||!worker||worker.binding.status!=='bound'||old?.binding.status!=='bound'||worker.lifecycle!=='active'||old.lifecycle!=='active'||digest(worker.binding)!==digest(old.binding)||f.hostId!==worker.binding.hostId||f.threadId!==worker.binding.threadId)continue;
  if(typeof f.turnId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(f.turnId)||seen.has(f.taskId))throw new Error('Ambiguous fixture host execution');seen.add(f.taskId);
  const observed=timestamp(f.observedAt),started=timestamp(f.startedAt),now=timestamp(at);
  if(observed>now||now-observed>180_000||started<timestamp(execution.at)||started>observed)continue;
  if(!['completed','running','notLoaded','unknown'].includes(f.status))throw new Error('Invalid fixture host status');
  let type=null;
  if(f.status==='completed') {
   const completed=timestamp(f.completedAt);
   if(completed<started||completed>observed||now-completed<policy.endGraceMs)continue;
   if(['executing','rework'].includes(task.status))type='ended-without-submission';
  }
  // submitted/reviewing and native running are compatible: the Worker may
  // still be recording its notification or closing its turn. No conflict rule
  // exists without a narrower violated execution contract.
  // reportBlocker is deliberately not a task state transition. Reuse the
  // existing current-blocker projection instead of calling executing "silent".
  if(type&&!withoutReceipt(state,task,executionId))type=null;
  if(type){const evidence={turnId:f.turnId,eventId:executionId,status:f.status,startedAt:f.startedAt,...(f.status==='completed'?{completedAt:f.completedAt}:{}),ref:`host-turn:${f.turnId}`};anomalies.push({key:digest([state.team.id,task.id,executionId,type]),teamId:state.team.id,taskId:task.id,executionId,type,evidence,evidenceHash:digest(evidence),assurance:'fixture-host'});}
 }
 return {status:'fixture',anomalies,queried:true};
}
