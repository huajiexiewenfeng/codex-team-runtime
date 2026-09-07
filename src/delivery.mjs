import {validate,validateCaller} from './runtime.mjs';
import {readState,transact} from './store.mjs';
import {deliveryState} from './delivery-state.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const same=(a,b)=>a.hostId===b.hostId&&a.threadId===b.threadId;
function managerFor(state,caller){validate(state);validateCaller(caller);const m=state.members.find(m=>m.role==='Manager');check(m.lifecycle==='active'&&m.binding.status==='bound'&&same(m.binding,caller),'Delivery requires active bound Manager');return m;}
async function writeDelivery(path,request,expectedVersion,type){
 const fields=['id','caller','at','source','roundId','taskId','attemptId','summary',...(type==='deliveryCheck'?['outcome']:[])];
 check(request&&typeof request==='object'&&!Array.isArray(request)&&Object.keys(request).every(k=>fields.includes(k)),'Unknown delivery request field');
 check(Number.isSafeInteger(expectedVersion)&&expectedVersion>=0,'Invalid expectedVersion');
 const state=await readState(path),actor=managerFor(state,request.caller);
 return transact(path,expectedVersion,{...request,type,actor:actor.id});
}
export const checkDelivery=(path,request,expectedVersion)=>writeDelivery(path,request,expectedVersion,'deliveryCheck');
export const claimDelivery=(path,request,expectedVersion)=>writeDelivery(path,request,expectedVersion,'deliveryClaim');
export function planDelivery(state,caller,taskId){
 managerFor(state,caller);const task=state.tasks.find(t=>t.id===taskId);check(task,'Task missing');
 const round=state.rounds.find(r=>r.id===task.roundId),historical=round.members.find(m=>m.id===task.workerId),worker=state.members.find(m=>m.id===task.workerId);
 const delivery=deliveryState(state,task);
 let decision='no-action';
 if(round.status==='open'&&!['approved','cancelled','queued'].includes(task.status)){
  check(worker?.role==='Worker'&&worker.lifecycle==='active'&&worker.binding.status==='bound'&&same(worker.binding,historical.binding),'Worker binding identity changed');validateCaller({hostId:worker.binding.hostId,threadId:worker.binding.threadId});
  decision=task.status!=='executing'||task.observations.length||task.stages.some(p=>!['queued','executing'].includes(p.status))?'supervise':!delivery.attemptId?'unavailable':delivery.status==='delivered'?'supervise':delivery.status==='not-delivered'?'ready-to-claim':'reconcile';
  if(decision==='ready-to-claim'&&state.tasks.some(t=>t.id!==task.id&&t.workerId===task.workerId&&!['queued','approved','cancelled'].includes(t.status)))decision='held';
 }
 return {sourceVersion:state.version,sourceUpdatedAt:state.updatedAt,taskId,workerId:task.workerId,identityAssurance:'caller-declared',delivery,decision,readOnly:true,executed:false,hostRequest:null,requiresNativeEvidence:true};
}
